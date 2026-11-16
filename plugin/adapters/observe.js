/**
 * 读取记账（SPEC §9）。监听 `tools/result`。
 *
 * **为什么用 `tools/result` 而不是 `presentationMeta`**：
 * `presentationMeta` 是给自己注册的工具用的；`read` 是**宿主的**工具，
 * 我们只能旁观事件，不能改它的输出。
 *
 * 关键点（SPEC §9.1）：
 * 1. `isError` 要排除 —— 读失败（文件不存在、不是普通文件）不算"读过"。
 * 2. `at` 用 `seq` 不用时间戳 —— 可回放，且与 coach-mode 一致。
 * 3. 只记 `docs/`，不记 `graveyard` / `outside`。
 */

import { isSubagentSession, shouldActivate } from '../core/scope.js'
import { recordLastWriter } from './last-writer.js'

/** 会触发**记账**的工具名（只有 read 算"读过"）。 */
const READ_TOOLS = new Set(['read'])

/**
 * 会触发**重扫**的工具名（D2 的修法）。
 *
 * 为什么 `write` / `edit` 也要触发：模型新建一份 `docs/x.md` 之后，
 * 如果没有人重扫，这份文档就**既不在索引、也不在门禁视野里** ——
 * 索引看不到它（新会话不知道有这份必读），门禁也拦不住它（`knownOf` 为 false → 放行）。
 * 修之前只有 `read` 触发重扫，而「刚新建、还没读过」正是最常见的时序。
 *
 * SPEC §6.3 的降级要求是「每次 `tools/result` 后重扫受影响的文件」——
 * 这里按工具名收敛到「会改 `docs/` 的那几个」，比全量重扫便宜。
 */
const MUTATING_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'apply_patch'])

/**
 * 组装 `tools/result` 监听器。
 *
 * @param {object} deps
 * @param {object} deps.config
 * @param {() => object} deps.registry
 * @param {() => object} deps.probe
 * @param {(absPath: string) => string} deps.classify
 * @param {(path: string, session: object) => string} deps.resolvePath
 * @param {object} [deps.logger]
 * @returns {(exec: object, result: object) => void}
 */
export function createObserver(deps) {
  const { config, registry, probe, classify, resolvePath, logger } = deps

  return function dddObserve(exec, result) {
    const session = exec?.agent?.session

    // ---- 入口第一句：**要不要干活**。
    const info = typeof probe === 'function' ? probe(session) : {}
    const activated = shouldActivate({
      hasMarker: info.hasMarker === true,
      hasProjectRoot: info.projectRoot !== undefined,
      isSubagent: isSubagentSession(session),
      requireMarker: config.requireMarker,
      excludeSubagents: config.excludeSubagents,
    })
    if (!activated) return

    const name = exec?.name
    if (typeof name !== 'string') return

    const reg = typeof registry === 'function' ? registry(session) : registry
    if (reg === undefined || reg === null) return

    // ---- 写类工具：命中 docs/ 就触发重扫（D2）。
    // 无论成功失败都扫：写失败也可能是「文件被外部创建了」。
    if (MUTATING_TOOLS.has(name)) {
      try {
        const raw = exec?.arguments?.file_path ?? exec?.arguments?.path
        if (typeof raw === 'string' && raw.trim() !== '') {
          const abs = typeof resolvePath === 'function' ? resolvePath(raw, session) : raw
          if (classify(abs, session) === 'doc') {
            // D3（M1.5，`P10`）：记一次 lastWriter 到 `_artifacts/`。
            // **不写回 frontmatter**（写回会改指纹 → 触发"必须重读" → 成本爆炸）。
            // **不 await**：审计线索不能拖住工具返回。
            if (result?.isError !== true) {
              void recordLastWriter({
                absPath: abs,
                projectRoot: info.projectRoot,
                session,
                seq: exec?.seq,
                tool: name,
                fs: deps.fs,
                ensureDir: deps.ensureDir,
                logger,
              })

              // ---- 2026-11-15 M2.7：记「本会话自己写过」----
              //
              // 只记**成功**的写：被门禁拒 / edit 没匹配上都不代表内容变过，
              // 记了会让模型凭空获得一次"自己写过"的豁免。
              //
              // 用途：`doc_mark` / `edit` 的门禁用它跳过"自己刚改的指纹"那种无意义重读
              // （`tools/doc-mark.js` 第 4 步 + `core/gate.js` 的 selfWritten 分支）。
              //
              // ---- 2026-11-15 M2.8：**必须挪到 rescan 之后** ----
              //
              // 顺序曾经是"先记 selfWrite，再 void rescan()"。那样有问题：
              // `noteSelfWrite` 要存"写完那一刻的指纹"，而那一刻注册表里还是**旧文本**
              // （`entry.text` 没更新），算出来的指纹是**改写前**的版本。
              // 于是 `isSelfWritten` 一比对就永远不相等 → 豁免静默失效
              //（而且不报错，只是"总是要重读"—— 正是我们要修的那个现象）。
              //
              // 现在：先 `rescan()`（拿到磁盘新指纹）→ **等它落定**再 `noteSelfWrite`。
              // ⚠️ `rescan` 是 async。这里不 `await`（`tools/result` 是同步钩子），
              //    改为"等它的 Promise 落地再记账"。重扫本身 2~3 ms/轮，可接受。
              //    `recordLastWriter` 仍然**完全不 await**（审计线索不该拖住返回）。
              const noteAfterScan = () => {
                if (typeof reg.noteSelfWrite !== 'function') return
                try {
                  reg.noteSelfWrite(abs, session)
                  // ---- 2026-11-15 M2.8（用户拍板 Q2「要放宽」）：**自己写完 = 读过** ----
                  //
                  // 用户原话：
                  // > 插件时不时就要 AI 严苛地去按某个规则做，一不小心就碰壁。
                  //
                  // 实测（8 轮）：24 次"你读过的是旧版"拒绝里，**12 次（50%）**是
                  // "上一次写同一份文件的，就是模型自己"。它没读过别人的东西 ——
                  // 它刚亲手写了那一行。
                  //
                  // 语义依据（这是**诚实**的，不是偷懒）：
                  //   `edit`/`write` 的 `old_string` 必须在磁盘上逐字匹配才会成功
                  //   （`core/roles.js` 的 APPEND_ONLY 判据就建立在这个事实上）。
                  //   也就是说：**写成功本身证明了模型与磁盘一致** ——
                  //   它拿到的正文就是它刚写下去的那一版。
                  //
                  // ⇒ 写成功后，把 readSet 更新成**写入后的真实指纹**，
                  //   与 `noteSelfWrite` 同源（都取 rescan 之后的条目指纹）。
                  //
                  // ⚠️ 与"必须先读"那条判据**不冲突**：这里只在**已经写成功**之后调用，
                  //    而写成功本身就要求过门禁。所以它不会变成"免读卡"。
                  // ⚠️ 只在写**成功**时走这条路（外层 `result?.isError !== true` 已保证）。
                  if (typeof reg.markRead === 'function') {
                    reg.markRead(abs, session, undefined, undefined)
                  }
                } catch (error) {
                  logger?.debug?.(`[ddd] 记录 selfWrite 失败：${error?.message ?? error}`)
                }
              }
              // rescan 失败也要记：重扫失败不该让"我写过"这个事实消失。
              // 指纹可能因此不准 → `isSelfWritten` 比对不上 → 退回严格行为（安全方向）。
              const pending = typeof reg.rescan === 'function' ? reg.rescan() : undefined
              if (pending !== null && typeof pending?.then === 'function') {
                pending.then(noteAfterScan, noteAfterScan)
              } else {
                noteAfterScan()
              }
            }
          }
        }
      } catch (error) {
        logger?.debug?.(`[ddd] 写后重扫失败：${error?.message ?? error}`)
      }
      return
    }

    if (!READ_TOOLS.has(name)) return

    // 失败不算读过。
    if (result?.isError === true) return

    const filePath = exec?.arguments?.file_path
    if (typeof filePath !== 'string' || filePath.trim() === '') return

    try {
      const abs = typeof resolvePath === 'function' ? resolvePath(filePath, session) : filePath
      if (classify(abs, session) !== 'doc') return

      // ---- 2026-11-15 M2.8（用户拍板）：**片段读改为"累计覆盖"** ----
      //
      // ---- 历史（三次反转，必须留住）----
      //
      // ① 最初：片段读被当成全文 → 记下**片段指纹** → 之后写被拒，报错还说
      //    "你读过的是旧版"（误导）。见 `_m27/minExp.mjs`。
      // ② M2.7 A 方案：片段读**完全不记账**（上面那段注释）。安全，但代价是
      //    "分两段读完"永远不算读过。
      // ③ 现在（M2.8）：**按区间累计**。同一版本内，读过的行区间拼起来覆盖了
      //    全文，就算"读过"；否则仍然不记账。
      //
      // ---- 为什么要从 ② 改成 ③ ----
      //
      // 用户 2026-11-15：
      // > 插件时不时就要 AI 严苛地去按某个规则做，一不小心就碰壁，
      // > 然后导致工作量增大，很可能没法专注于工作项目本身了。
      //
      // 实测（第 26 轮 `session-b5657ffd` seq 133 / seq 156）：
      //   · AI 用 `read(offset=66, limit=30)` 读了交接的尾部（它想确认 §5 的措辞）；
      //   · 内容它**确实看到了**；
      //   · 但 `edit` 仍然被拒 —— 因为"片段读不算读过"；
      //   · 于是它整份重读一次（seq 138），白花一步。
      //
      // ② 的安全性来自"**不假装看过**"。③ 保住了这一点：
      // 只有**真的覆盖全文**才算读过，只是允许"分几次覆盖"。
      //
      // ⚠️ **不安全的做法（明确不做）**：像旧实现那样把片段正文当全文、
      //    算出片段指纹写进 readSet。那会让 `read(offset=53)` 把
      //    "你改完没重读"这个正确拒绝**推开**（`_m27/minExp.mjs`）。
      //    ③ 只在**覆盖完整**时才写 readSet，且写的是**磁盘全文的真实指纹**。
      const partial = partialReadOf(result)
      if (partial) {
        const covered = notePartialCoverage({
          absPath: abs,
          session,
          result,
          seq: exec?.seq ?? exec?.token,
          reg,
          logger,
        })
        if (covered !== true) {
          logger?.debug?.(`[ddd] 片段读，尚未覆盖全文，不记账：${abs}`)
          return
        }
        logger?.debug?.(`[ddd] 片段读累计完成覆盖，按整份读过记账：${abs}`)
        // 落下去走下面的整份记账路径（用注册表里的磁盘全文，不是片段）。
        const ok = reg.markRead(abs, session, exec?.seq ?? exec?.token, undefined)
        if (ok !== true) void reg.rescan()
        return
      }

      // **同步记账**（门禁也是同步的，且模型常「读完立刻改」）。
      // 指纹从 read 的返回内容里算 —— 那是模型真正看到的字节，不用再读一次盘。
      const ok = reg.markRead(abs, session, exec?.seq ?? exec?.token, textFromReadResult(result))
      if (ok === true) {
        logger?.debug?.(`[ddd] 记账：${abs}`)
      } else {
        // 读到了一份注册表里还没有的文档。
        // D3：`markRead` 已经把它记进「待补记队列」，重扫完成后会补上。
        // 这里仍然触发一次重扫，让它尽快入册。
        void reg.rescan()
      }
    } catch (error) {
      logger?.warn?.(`[ddd] 记账失败：${error?.message ?? error}`)
    }
  }
}

/**
 * 片段读的**区间覆盖**记账（M2.8）。
 *
 * 目的：允许"分几次把一份文档读完"，但不允许"只看了几行就算读过"。
 *
 * ---- 怎么判"读完了" ----
 *
 * 每次片段读拿到一个闭区间 `[start, end]`（来自信封的行号）。
 * 按**版本**（磁盘指纹）累积这些区间，合并后若覆盖 `1..totalLines`，就算读完。
 *
 * ⚠️ **版本一变就清空**：文件被改过之后，之前读过的区间**不再代表当前内容**。
 * 这正是旧实现（把片段当全文）最危险的地方 —— 它在改完之后仍然让人"读过"。
 *
 * @returns {boolean} 是否已覆盖全文（true = 可以按整份读过记账）
 */
function notePartialCoverage(input) {
  const { absPath, session, result, reg, logger } = input
  try {
    const parsed = envelopeOf(result)
    if (parsed === undefined) return false

    const start = parsed.startsAtLineNo
    if (typeof start !== 'number' || !Number.isFinite(start) || start < 1) return false

    // 信封里能拿到的行号范围 + 总行数
    const range = lineRangeOf(parsed.body, start)
    if (range === undefined) return false
    const { from, to, total } = range
    if (typeof total !== 'number' || !Number.isFinite(total) || total < 1) return false

    // 取**磁盘当前**版本号。拿不到就不累积（宁可多要一次重读）。
    //
    // ⚠️ 用 `entryByPath` 直接取条目指纹，**不要**走 `fingerprintOf(id)` ——
    //    第 26 轮那个 bug 就是"以为 `fingerprintOf` 是注册表方法，
    //    实际是导入的纯函数"。这里一律用条目对象上的字段。
    const entry = typeof reg.entryByPath === 'function' ? reg.entryByPath(absPath) : undefined
    const current = typeof entry?.fingerprint === 'string' ? entry.fingerprint : undefined
    if (typeof current !== 'string' || current === '') return false

    const key = `${session?.id ?? ''}|${absPath}`
    let record = PARTIAL_COVERAGE.get(key)
    if (record === undefined || record.version !== current) {
      // 版本变了 / 第一次读 → 开一个新的累积窗口
      record = { version: current, ranges: [], total }
      PARTIAL_COVERAGE.set(key, record)
    }
    record.total = Math.max(record.total ?? 0, total)
    record.ranges.push([from, to])

    const merged = mergeRanges(record.ranges)
    const covered = merged.length === 1 && merged[0][0] <= 1 && merged[0][1] >= record.total
    if (covered) {
      PARTIAL_COVERAGE.delete(key)
      logger?.debug?.(`[ddd] 片段读已覆盖全文（${merged[0][0]}..${merged[0][1]} / ${record.total}）：${absPath}`)
    }
    return covered
  } catch (error) {
    logger?.debug?.(`[ddd] 片段覆盖统计失败（不影响门禁）：${error?.message ?? error}`)
    return false
  }
}

/** 片段读区间累积表。键 = `sessionId|absPath`，值 = `{version, ranges, total}`。 */
const PARTIAL_COVERAGE = new Map()

/**
 * 从信封正文里算出行号区间与总行数。
 *
 * 信封有两种 footer：
 *   · `(Showing lines 39-50 of 58)` → 区间 `39..50`，总数 58
 *   · `(End of file - total 58 lines)` → 区间到 total
 *
 * @param {string} body 信封 `<content>` 内的原文（带 `N: ` 前缀）
 * @param {number} start 首行行号
 * @returns {{from: number, to: number, total: number} | undefined}
 */
function lineRangeOf(body, start) {
  const shown = /\(Showing lines (\d+)-(\d+) of (\d+)\)/.exec(body)
  if (shown !== null) {
    return { from: Number(shown[1]), to: Number(shown[2]), total: Number(shown[3]) }
  }
  const eof = /\(End of file - total (\d+) lines\)/.exec(body)
  if (eof !== null) {
    const total = Number(eof[1])
    // 首行是第 1 行 → 这是整份读，不算片段；调用方不会走到这里。
    // 否则片段一直读到末尾：区间 = start..total
    return { from: start, to: total, total }
  }
  return undefined
}

/**
 * 合并闭区间（按起点排序后合并重叠/相邻）。
 * @param {Array<[number, number]>} ranges
 * @returns {Array<[number, number]>}
 */
function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const out = []
  for (const [from, to] of sorted) {
    const last = out[out.length - 1]
    if (last !== undefined && from <= last[1] + 1) {
      last[1] = Math.max(last[1], to)
    } else {
      out.push([from, to])
    }
  }
  return out
}

/**
 * 从 `read` 的返回里抽出**全文**正文。抽不出全文就返回 `undefined`。
 *
 * `dsh-tool-fs` 的 read 结果是固定信封：
 *
 * ```text
 * <path>...</path>
 * <type>file</type>
 * <content>
 * 1: 第一行
 * 2: 第二行
 * ...
 * (End of file - total N lines)
 * </content>
 * ```
 *
 * ---- 2026-11-15 M2.7：判据从「footer 像不像全文」改成「**首行是不是第 1 行**」----
 *
 * 旧判据只看 footer 是不是 `(End of file - total N lines)`。
 * 但 `read(offset=55, limit=15)` 读到文件末尾时，footer **也是** `End of file` ——
 * 于是它被判成"整份读完"，还原出的却是第 55~67 行，算出的是**片段指纹**。
 *
 * 那次错误比"没记录"更坏，实测（`_m27/minExp.mjs`）：
 *
 *   1. 完整读                → readSet = A
 *   2. 自己 edit 成功         → 注册表 = B，readSet 仍 A → 门禁**正确拒绝**
 *   3. read(offset=53) 读到末尾 → 片段正文被当成全文 →
 *      **注册表与 readSet 同时被改成片段指纹** → 两者相等 → 门禁**放行**
 *
 * ⇒ 一次片段读把"你改完没重读"这个正确拒绝**推开了**。而且开合取决于
 *    "中间有没有 pre-step 把注册表重算回磁盘全文" —— **纯时序运气**。
 *
 * 所以判据必须是：**信封第一行的行号是 1**（才是从文件开头读的）。
 * 加上 footer 存在（证明读到了末尾），两者同时成立才算全文。
 *
 * @param {object} result 工具结果 `{ content: [...] }`
 * @returns {string | undefined}
 */
export function textFromReadResult(result) {
  const parsed = envelopeOf(result)
  if (parsed === undefined) return undefined
  if (parsed.startsAtLineNo !== 1) return undefined // 不是从第 1 行开始 → 不是全文
  if (parsed.reachedEof !== true) return undefined // 没读到末尾 → 不是全文

  const lines = parsed.body
    .split('\n')
    .filter((line) => line !== '')
    .filter((line) => !/^\((?:End of file|Showing lines|Output capped)/.test(line.trim()))
    // 剥掉 `1: ` 这样的行号前缀（行号本身由 read 工具加，不属于文件内容）。
    .map((line) => line.replace(/^\s*\d+:\s?/, ''))
  return `${lines.join('\n')}\n`
}

/**
 * 拆 `read` 的结果信封，给出三个判据。
 *
 * **这是唯一的信封解析点**（M2.7 之前 `textFromReadResult` 与 `windowReadOf`
 * 各写一遍、两边都只看 footer —— 那个重复正是缺陷来源）。
 *
 * @param {object} result 工具结果 `{ content: [...] }`
 * @returns {{body: string, startsAtLineNo: number|undefined, reachedEof: boolean} | undefined}
 */
function envelopeOf(result) {
  const blocks = result?.content
  if (!Array.isArray(blocks)) return undefined
  const text = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
  if (text === '') return undefined

  const open = text.indexOf('<content>')
  const close = text.lastIndexOf('</content>')
  if (open < 0 || close < 0 || close <= open) return undefined

  const body = text.slice(open + '<content>'.length, close)
  // 首行形如 `1: ...` / ` 55: ...`（行号由 read 工具加）。
  const first = /^\s*(\d+):/.exec(body.replace(/^\s*\n/, ''))
  return {
    body,
    startsAtLineNo: first === null ? undefined : Number(first[1]),
    reachedEof: /\(End of file - total \d+ lines\)/.test(body),
  }
}

/**
 * 这次 read 是不是**没拿到全文**（片段读 / 没有正文）？
 *
 * ---- 2026-11-15 M2.7（用户拍板「停用窗口读记账」）----
 *
 * 调用方（`createObserver`）用它决定**要不要调 `markRead`**：
 *
 * | 情形 | 含义 | 该怎么处理 |
 * |---|---|---|
 * | 有 `<content>` 但不是全文（片段 / 被截断） | 模型只看了片段 | **完全不记账** |
 * | 压根没有 `<content>` | 宿主没给正文 | 退回旧行为（用注册表指纹），不拒模型 |
 *
 * **片段读完全不记账**（而不是"记一条空指纹"）的理由：
 *   - 记空指纹会让之后报「你读过的是旧版」——**误导**（它没读过全文，谈不上"旧版"）；
 *   - 不记账则报「必须先读它」——**准确**；
 *   - 且不记账**绝不会**破坏已有的完整读记录（这正是旧实现最坏的地方）。
 *
 * 与 `textFromReadResult` 共用 `envelopeOf`，**判据只有一处**。
 *
 * @param {object} result 工具结果 `{ content: [...] }`
 * @returns {boolean}
 */
export function partialReadOf(result) {
  const parsed = envelopeOf(result)
  // 没有信封 = 宿主没给正文 → **不是**片段读（不能因此拒掉模型）。
  if (parsed === undefined) return false
  return parsed.startsAtLineNo !== 1 || parsed.reachedEof !== true
}

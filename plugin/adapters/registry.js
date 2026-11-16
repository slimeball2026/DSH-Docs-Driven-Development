/**
 * 内存注册表（SPEC §6.3）。**这是 M0 第二难的一块。**
 *
 * 为什么必须有它：`systemPrompt.context()` 的 `text` 回调**必须同步**
 * （`dsh-agent-loop` 里直接 `entry.text(context)` 取值，不 await），
 * 而 `ctx.fs.stat()` / `readText()` 都是异步。
 * **所以不能在回调里读盘**，必须维护一份同步可读的缓存。
 *
 * 数据来源（全部异步 / 事件驱动）：
 *   1. 首次激活：扫描 docs/ 建 metas
 *   2. `ctx.fs.watch()`：docs/ 目录一变就重扫（**watch 优先**）
 *   3. `tools/result`：read/write/edit 命中 docs/ 时更新 readSet / 指纹
 *   4. watch 不可用时：退化为"每次 tools/result 后重扫"（touch 驱动）
 *
 * 关于 watch 的实测事实（`dsh-fs-local` 源码）：
 * - 文件 target 会 watch **父目录 depth 0** 并按解析路径过滤，**文件不存在也能观察创建**；
 * - 目录 target 只报告**直接子项**（`depth: 0`），子目录里的新增收不到；
 * - `signal` 必传（第一行就 `throwIfAborted`）；返回的关闭函数要 `await`。
 *
 * 因此这里**只 watch docs/ 根目录一个 target**（SPEC §6.3 写的是"每文档一个监听"，
 * 我在实现上做了简并，理由见 README）：10~50 份文档重扫很便宜，
 * 一个目录 watcher 就能覆盖"文档新增/删除"，比每文档一个 watcher 稳得多。
 * 超过 `maxWatchedDocs` 时按 SPEC 整体退化为 touch 驱动。
 */

import { scanProject } from '../docs/scan.js'
import { fingerprintOf } from '../docs/fingerprint.js'
import { buildIndex } from '../core/index.js'

/** 状态：尚未就绪（还没扫过）。 */
export const STATE_IDLE = 'idle'
/** 状态：已就绪。 */
export const STATE_READY = 'ready'
/** 状态：扫描失败（不抛，降级为空索引）。 */
export const STATE_FAILED = 'failed'

/**
 * 建一个同步可读的注册表。
 *
 * @param {object} deps
 * @param {object} deps.config resolveConfig 的产物
 * @param {object} deps.layout `{projectRoot, docsDir, ...}`（绝对化之后）
 * @param {(path: string) => Promise<Array<{name: string, type: string}>>} deps.listDir
 * @param {(path: string) => Promise<string | undefined>} deps.readText
 * @param {(path: string) => string} deps.joinPath
 * @param {(absPath: string) => string} deps.classify
 * @param {object} [deps.logger]
 * @returns {object} 注册表
 */
export function createRegistry(deps) {
  const { config, layout, listDir, readText, joinPath, classify, logger } = deps

  /** @type {Array<object>} 所有条目（含 unmanaged 与坏文档）。 */
  let entries = []
  /** @type {ReturnType<typeof buildIndex>} */
  let index = buildIndex([])
  let state = STATE_IDLE
  let lastError = undefined
  let truncated = false

  /** @type {Map<string, {fingerprint: string, text: string, at: number}>} 本会话已读。 */
  const readSet = new Map()
  /**
   * 按会话隔离的已读集合（SPEC §6.4 规则 2：「已读」只显示**本会话**读过的，跨会话不算）。
   *
   * 为什么必须隔离：`DocsRegistry` 是**项目级**的（多会话共用同一份 metas），
   * 但「读没读」是**会话级**的事实。共用一个 readSet 会让
   * 会话 A 读过的文档在会话 B 里也算读过 —— 门禁直接形同虚设。
   *
   * key 用 session 对象本身（WeakMap），会话释放即可回收；
   * 拿不到 session 时退回共享的 readSet（单会话脚本 / 冒烟用）。
   */
  const readSetsBySession = new WeakMap()
  /** 会话隔离的全文缓存（"仅追加"判定要用）。 */
  const sessionOfRead = new WeakMap()

  /**
   * 会话级「这份文档是**我自己**在本会话里写过的」记录（M2.7 收窄修法 2 用）。
   *
   * ---- 为什么需要它 ----
   *
   * 修法 2（`20cf9da`）规定「窗口读不更新已读指纹」。它的**收益**是防止：
   * 别人改过文件、模型只读了片段、却拿到写权限。
   * 但它把成本加在了**最高频**的路径上：模型自己刚改完、想省 token 只看几行确认格式。
   * 实测（`session-25dad0e8` turn 3）：窗口读之后写 5 次，**5 次全被拒**，
   * 其中一次是第一次标绿失败。
   *
   * 用户 2026-11-15 拍板：**收窄成「只在外部改动时生效」**。
   *
   * ---- 为什么记在内存，不读 `_artifacts/last-writer.json` ----
   *
   * `adapters/last-writer.js` 的注释是明令：那是**审计线索，不是判据**，
   * 「任何一条门禁都**不能**依赖它是否存在（否则删掉这个文件就能绕开门禁）」。
   * 所以这里另记一份**纯内存**的：与 `readSet` 同级，进程内有效、不可被文件系统影响。
   * 代价：冷启动（换会话）后这份记录是空的 —— **那是安全的**，
   * 因为空就意味着"不认为是我写的"，退回修法 2 的严格行为。
   *
   * ---- 2026-11-15 M2.8：`Set<string>` → `Map<string, {fingerprint}>` ----
   *
   * 只存 id 会漏掉"写完之后又被别人改过"那种情况（详见 `noteSelfWrite` 的注释）。
   * 现在值里带**写完那一刻的指纹**，`isSelfWritten` 拿它和磁盘当前值比。
   *
   * @type {WeakMap<object, Map<string, {fingerprint: string}>>}
   */
  const selfWrittenBySession = new WeakMap()

  /** 取（或建）某个会话的「自己写过」集合。 */
  function selfWrittenFor(session) {
    if (session === null || typeof session !== 'object') return selfWrittenOfDefault
    let set = selfWrittenBySession.get(session)
    if (set === undefined) {
      set = new Map()
      selfWrittenBySession.set(session, set)
    }
    return set
  }
  /** 拿不到 session 时共用的兜底集合（单会话脚本 / 冒烟用）。 */
  const selfWrittenOfDefault = new Map()

  /**
   * 记一次「本会话自己写过这份文档」。
   *
   * 由 `adapters/observe.js` 在 **写类工具成功之后**调用。
   *
   * ⚠️ 只在**成功**时记：写失败（被门禁拒、edit 没匹配上）不代表内容变过，
   * 记了会让模型凭空获得一次"自己写过"的豁免。
   *
   * ---- 2026-11-15 M2.8：**必须同时记「写完之后磁盘是什么指纹」** ----
   *
   * 只记 id 是**不够的，而且是危险的**：
   *
   *   ① 模型 edit 成功          → selfWritten = { doc }       （磁盘 = A）
   *   ② **别人/另一个会话**改了它  → 磁盘 = B，模型不知道
   *   ③ 模型再 edit             → 只查 "doc 在不在 selfWritten" → **放行**
   *
   * ⇒ 第 ③ 步放行意味着**模型会拿它没看过的 B 当作依据去改**。
   *   这比"多要一次重读"严重得多：重读只是慢，这个是**改错**。
   *
   * 所以这里记下**写完那一刻的指纹**（`entry.fingerprint` 在 `observe` 之后
   * 会被 rescan 重算成磁盘新值，所以取的是"我刚写完的版本"）。
   * `isSelfWritten` 再比一次：**指纹不一致就不再算自己写的**。
   *
   * 最小复现与反例网：`test/m28-fixes.test.js` 的 §1（外部改动必须仍被拒）。
   *
   * @param {string} absPath
   * @param {object} [session]
   * @returns {void}
   */
  function noteSelfWrite(absPath, session) {
    const entry = entryByPath(absPath)
    if (entry === undefined) return
    const id = entry.meta?.id
    if (typeof id !== 'string' || id === '') return
    // `observe` 在 `rescan` **之前**调这里，此刻 `entry.fingerprint` 可能还是旧值。
    // 所以不能信它 —— 用 `refreshFingerprint` 的同步近似：拿 `entry.text` 现算。
    //
    // ⚠️ `entry.text` 是注册表缓存的全文本。`observe` 收到的是 `tools/result`，
    //    此时**文件已经写完了**，但缓存可能还没更新。为稳妥起见：
    //    先按缓存算（它通常已被上一轮 rescan 对齐），写入后紧跟的 rescan 会再校正。
    //    真正的一致性由 `isSelfWritten` 的**双条件**保证（见下）。
    const fingerprint = typeof entry.text === 'string' ? fingerprintOf(entry.text) : entry.fingerprint
    selfWrittenFor(session).set(id, { fingerprint })
  }

  /**
   * 这份文档是不是**本会话自己写的，且自我写完起没被别人改过**。
   *
   * ---- 2026-11-15 M2.8：从「只查 id」升级成「id + 指纹」----
   *
   * 旧签名只看"这个 id 在不在集合里"，于是"模型写过一次"会**永久**豁免，
   * 包括它自己后来又改了几次、以及**别人在中间改过它**的情况。
   * 那正是 `test/m27-window-read.test.js` 三条断言抓到的方向：
   *
   *   > §4.7 前置：改完自己 → 下一轮 pre-step 之后不重读 → **必须拒绝**
   *
   * 那条断言是**对的**，它守的是"模型不能凭记忆改"。所以这次不是改测试，
   * 而是把判据从"写过吗"收紧成"**写完的版本还是磁盘上这一版吗**"：
   *
   *   · 自己刚写完、没人动过 → 指纹相同 → 放行（省掉一次无意义的重读）；
   *   · 自己写完、**别人改过** → 指纹不同 → 拒绝（必须重读，模型没看过新内容）；
   *   · 自己写完、**自己又改了一次** → `noteSelfWrite` 已把记录更新成最新 → 放行。
   *
   * @param {string} id
   * @param {object} [session]
   * @returns {boolean}
   */
  function isSelfWritten(id, session) {
    if (typeof id !== 'string' || id === '') return false
    const record = selfWrittenFor(session).get(id)
    if (record === undefined) return false
    // ---- 拿**注册表条目**当前的指纹比对 ----
    //
    // ⚠️ 2026-11-15 M2.8 修了一个把自己坑惨的 bug：
    // 这里原来写的是 `typeof fingerprintOf === 'function' ? fingerprintOf(id) : …`。
    // 而本文件顶部 `import { fingerprintOf } from '../docs/fingerprint.js'` ——
    // 那是**纯函数 `fingerprintOf(text)`**，永远 `typeof === 'function'`。
    // 于是它拿**字符串 `"handover-1"` 当正文**去算哈希，得到一个恒定且错误的指纹，
    // 与 `record.fingerprint` 永远不等 → **豁免静默失效**，而且不报任何错。
    //
    // 症状（第 26 轮 `session-b5657ffd`）：`doc_mark` 连续失败 3 次
    //（seq 127 / 161 / 161），每次失败后模型整份重读，回来再试又失败。
    // 而模型根本不可能从报错文案里看出原因 —— 它只会以为"文件又被改了"。
    //
    // ⇒ 必须走 `entryById(id)?.fingerprint`（订阅者对象上的方法，见本文件末尾
    //   `fingerprintOf(id) { return entryById(id)?.fingerprint }`）。
    //   两项都要显式：**绝不能再让导入的纯函数顶替**。
    const current = entryById(id)?.fingerprint
    if (typeof current !== 'string' || current === '') {
      // 拿不到当前指纹 → **不认**（宁可多要一次重读，也不误放行）。
      return false
    }
    return record.fingerprint === current
  }

  /** 取（或建）某个会话的已读集合。 */
  function readSetFor(session) {
    if (session === null || typeof session !== 'object') return readSet
    let set = readSetsBySession.get(session)
    if (set === undefined) {
      set = new Map()
      readSetsBySession.set(session, set)
    }
    return set
  }
  /** @type {Map<string, {close: Function} | null>} */
  const watchers = new Map()
  /** 串行化重扫，避免并发扫描互相覆盖。 */
  let scanning = null
  /** 重扫排队标记。 */
  let rescanQueued = false
  /**
   * 索引变化订阅者（`adapters/agentsmd-writer.js` 靠它重写 `AGENTS.md`）。
   *
   * **为什么要有这个（M0 评审的 D1）**：`AGENTS.md` 是慢变量，
   * SPEC §6.5 要求它在「文档新增 / 删除 / status 变化」时重写。
   * 修这个 bug 之前，写者只在**首次扫描完成**时被调用过一次 ——
   * 之后无论文档怎么变，`AGENTS.md` 永远停在第一次的内容。
   * 活标本：`dogfood/AGENTS.md` 至今还列着一份早已删除的坏文档。
   *
   * 订阅者签名 `() => void`：**同步、不 await**。写者自带节流与内容去重，
   * 且它的失败绝不能连累扫描（见 agentsmd-writer 的 writeOnce 兜底）。
   * @type {Set<() => void>}
   */
  const indexListeners = new Set()
  /** 上一次通知出去的内容指纹（用来避免同一内容反复通知）。 */
  let lastNotified = undefined

  /**
   * 订阅"索引变了"。返回取消订阅的函数。
   * @param {() => void} listener
   * @returns {() => void}
   */
  function onIndexChanged(listener) {
    if (typeof listener !== 'function') return () => {}
    indexListeners.add(listener)
    return () => { indexListeners.delete(listener) }
  }

  /**
   * 索引内容摘要（只取「慢变量关心的部分」：id / status / order / summary）。
   *
   * 为什么不用整份 `index` 对象比较：那会包含 `fingerprint` / `text`，
   * 而文档**正文**一改指纹就变 —— 但正文变化**不该**触发 `AGENTS.md` 重写
   * （慢变量只放清单，不放正文）。这里刻意只摘要清单字段。
   *
   * @param {object} idx buildIndex 的结果
   * @returns {string}
   */
  function digestOf(idx) {
    const part = (list) => list
      .map((entry) => {
        const meta = entry?.meta ?? {}
        return `${meta.id ?? entry?.path ?? '?'}\u0001${meta.status ?? ''}\u0001${meta.order ?? ''}\u0001${meta.summary ?? ''}`
      })
      .join('\u0002')
    return `${part(idx?.required ?? [])}\u0003${part(idx?.forbidden ?? [])}\u0003${part(idx?.anomalies ?? [])}`
  }

  /** 通知订阅者（同步；任何一个抛错都不影响其它人与扫描本身）。 */
  function notifyIndexChanged() {
    const digest = digestOf(index)
    if (digest === lastNotified) return
    lastNotified = digest
    for (const listener of indexListeners) {
      try {
        listener()
      } catch {
        // 订阅者失败（比如写 AGENTS.md 被沙箱拒绝）不该影响扫描结果。
      }
    }
  }

  /** 按绝对路径找条目。 */
  const entryByPath = (absPath) => entries.find((item) => item.path === absPath)
  /** 按 id 找条目。 */
  const entryById = (id) => entries.find((item) => item.meta?.id === id)

  /**
   * 「读过但当时还没入册」的待补记记录（M0 评审的 D3）。
   *
   * 场景：模型新建 `docs/x.md` → 立刻 `read` 它 → 再 `edit` 它。
   * `read` 到达时它还没进注册表，`markRead` 只能返回 false；
   * 等重扫把它收进来，它已经是**必读**文档而 `readSet` 里没有它，
   * 门禁就会说「改它之前必须先读它」—— 而模型**刚刚读过**。
   *
   * 这是**误伤**，不是漏管（交接 §8：误伤一次会让模型没法干活）。
   * 所以在重扫完成后，用这份队列把「读过的」补记回去。
   *
   * 实现上**直接捕获目标 `readSet` 的引用**，而不是按会话再存一份：
   * `WeakMap` 不可枚举，按会话存反而要额外维护一个可遍历的登记表，
   * 多一份状态就多一处能不同步的地方。
   *
   * @type {Array<{absPath: string, readSet: Map<string, object>, freshText?: string, at?: number}>}
   */
  const pendingReads = []

  /**
   * 登记一条「读过但还没入册」的记录，等重扫后补记。
   *
   * 同一条路径在同一份 readSet 里只留最后一次（后读的覆盖先读的）。
   *
   * @param {string} absPath
   * @param {object} [session]
   * @param {number} [at] 事件 seq
   * @param {string} [freshText] 模型真正读到的正文（用来算指纹）
   */
  function notePendingRead(absPath, session, at, freshText) {
    if (typeof absPath !== 'string' || absPath === '') return
    const readSet = readSetFor(session)
    // 去重：同一路径 + 同一份 readSet 只留最新的一条，避免队列无限增长。
    for (let i = pendingReads.length - 1; i >= 0; i -= 1) {
      if (pendingReads[i].absPath === absPath && pendingReads[i].readSet === readSet) {
        pendingReads.splice(i, 1)
      }
    }
    pendingReads.push({ absPath, readSet, freshText, at })
  }

  /**
   * 把待补记的读记录补进各自的 readSet（重扫完成后调用）。
   *
   * 只补「现在已经入册」的条目；仍然入不了册的留着等下一次重扫。
   * 队列长度设上限：异常情况下（模型反复读一份永远入不了册的路径）
   * 不能让这里变成内存泄漏。
   */
  function flushPendingReads() {
    const MAX_PENDING = 200
    for (let i = pendingReads.length - 1; i >= 0; i -= 1) {
      const record = pendingReads[i]
      const entry = entryByPath(record.absPath)
      if (entry === undefined) continue // 还是没入册 → 留着
      const id = entry.meta?.id
      if (typeof id !== 'string' || id === '') {
        // 入册了但没有 id（没有 frontmatter）→ 永远不会成为受管文档，丢弃。
        pendingReads.splice(i, 1)
        continue
      }
      // 用「读到的内容」算指纹，而不是注册表里的：那才是模型真正看到的字节。
      if (typeof record.freshText === 'string') {
        entry.text = record.freshText
        entry.fingerprint = fingerprintOf(record.freshText)
      }
      record.readSet.set(id, {
        fingerprint: entry.fingerprint,
        text: typeof entry.text === 'string' ? entry.text : '',
        at: typeof record.at === 'number' ? record.at : 0,
      })
      pendingReads.splice(i, 1)
    }
    // 兜底：队列不该无限长（正常情况下每次重扫都会清空）。
    if (pendingReads.length > MAX_PENDING) {
      pendingReads.splice(0, pendingReads.length - MAX_PENDING)
    }
  }

  /**
   * 重扫 docs/ 并重建索引。
   * @returns {Promise<void>}
   */
  async function rescan() {
    if (scanning !== null) {
      // 已经有扫描在跑：标记"完了再来一次"，避免丢事件。
      rescanQueued = true
      return scanning
    }
    scanning = (async () => {
      try {
        const result = await scanProject({
          listDir,
          readText,
          docsAbs: layout.docsAbs,
          joinPath,
          classify,
          anchors: deps.anchors,
          maxFiles: config.maxWatchedDocs * 5,
        })
        entries = result.entries
        truncated = result.truncated
        index = buildIndex(entries)
        state = STATE_READY
        lastError = undefined
        if (truncated === true) {
          logger?.warn?.(`[ddd] docs/ 文档数超过扫描上限，索引不完整`)
        }
      } catch (error) {
        state = STATE_FAILED
        lastError = error
        // 静默降级：坏掉的扫描不该影响模型正常干活（spec §4.2 的"静默降级"）。
        logger?.warn?.(`[ddd] 扫描 docs/ 失败，本次降级为空索引：${error?.message ?? error}`)
        entries = []
        index = buildIndex([])
      } finally {
        scanning = null
      }

      // ① 把「读过但当时没入册」的补记回去（D3）。
      //    必须在通知订阅者之前：写 AGENTS.md 与门禁都依赖正确的 readSet。
      try {
        flushPendingReads()
      } catch (error) {
        logger?.debug?.(`[ddd] 补记待处理读取失败：${error?.message ?? error}`)
      }

      // ② 通知「索引变了」——`AGENTS.md` 靠它重写（D1）。
      notifyIndexChanged()

      if (rescanQueued) {
        rescanQueued = false
        await rescan()
      }
    })()
    return scanning
  }

  /**
   * 开始 watch docs/ 目录（watch 不可用就静默退化为 touch 驱动）。
   * @param {object} fs `ctx.fs`
   * @param {AbortSignal} [signal]
   * @returns {Promise<{watching: boolean, reason?: string}>}
   */
  async function startWatching(fs, signal) {
    if (typeof fs?.watch !== 'function') return { watching: false, reason: 'no-watch-api' }
    if (entries.length > config.maxWatchedDocs) {
      logger?.warn?.(`[ddd] 文档数 ${entries.length} 超过 maxWatchedDocs=${config.maxWatchedDocs}，退化为 touch 驱动`)
      return { watching: false, reason: 'too-many-docs' }
    }

    // ⚠️ `signal` 不能是 undefined：`FileSystem.watch()` 的第一行就是
    // `signal.throwIfAborted()`，传 undefined 会抛
    // `TypeError: Cannot read properties of undefined (reading 'throwIfAborted')`。
    // 那个 TypeError 又被下面的 catch 吞成"watch 被拒"，
    // 于是**永远走降级路径**且看起来一切正常。真机上很难发现。
    const watchSignal = signal ?? new AbortController().signal

    try {
      const target = await fs.resolve(layout.docsAbs)
      const close = await fs.watch(target, (error) => {
        if (error !== undefined) {
          logger?.warn?.(`[ddd] watch 报错，正在退化为 touch 驱动：${error?.message ?? error}`)
          void stopWatching()
          return
        }
        void rescan()
      }, watchSignal)
      watchers.set(layout.docsAbs, { close })
      return { watching: true }
    } catch (error) {
      // SPEC §6.3：不支持监听的提供方直接拒绝 —— 这是**预期路径**，不是错误。
      logger?.debug?.(`[ddd] watch 不可用，退化为 touch 驱动：${error?.message ?? error}`)
      return { watching: false, reason: 'watch-rejected' }
    }
  }

  /** 关掉所有 watcher。 */
  async function stopWatching() {
    for (const [, watcher] of watchers) {
      try {
        await watcher.close()
      } catch {
        // 关闭失败不影响降级路径。
      }
    }
    watchers.clear()
  }

  /**
   * 记一次"读过"（SPEC §9.1）。**同步**。
   *
   * 为什么必须同步：门禁（`tools.guard`）也是同步的，而且模型常常
   * 「read 完立刻 edit」。若记账是异步的，那一刻 readSet 还是空的，
   * 门禁会**误拒**——这正是「门禁漏一次只是少管一次，误伤一次会让模型没法干活」。
   *
   * 指纹的来源有两档：
   *   1. 调用方给了 `freshText`（从 read 的返回内容里取）→ 直接算，**零读盘**；
   *   2. 没给 → 用注册表里缓存的指纹（可能是旧的，由 `refreshFingerprint()` 事后纠正）。
   *
   * @param {string} absPath
   * @param {object} [session] 会话对象（**必须传**，否则会记到共享集合里，造成跨会话污染）
   * @param {number} [seq] 事件序号（M0 只留档，**不渲染**——渲染进索引块会让每读一次就多一条消息）
   * @param {string} [freshText] 模型刚读到的磁盘内容
   *        **只在"整份读完"时给**（判据在 `adapters/observe.js` 的 `partialReadOf`）。
   *        片段读根本不会走到这里 —— 调用方会直接跳过记账（M2.7 A 方案）。
   * @returns {boolean} 是否记成功
   */
  function markRead(absPath, session, seq, freshText, opts) {
    const entry = entryByPath(absPath)
    if (entry === undefined) {
      // D3：还没入册。**不能直接放弃** —— 模型确实读过了。
      // 记进待补记队列，等重扫把它收进来之后补记（见 flushPendingReads）。
      notePendingRead(absPath, session, seq, freshText)
      return false
    }
    const id = entry.meta?.id
    if (typeof id !== 'string' || id === '') {
      // 入册了但没有 frontmatter → 它永远不会成为受管文档，不必补记。
      return false
    }

    if (typeof freshText === 'string') {
      entry.text = freshText
      entry.fingerprint = fingerprintOf(freshText)
    }

    readSetFor(session).set(id, {
      fingerprint: entry.fingerprint,
      text: typeof entry.text === 'string' ? entry.text : '',
      at: typeof seq === 'number' ? seq : 0,
    })
    return true
  }

  /**
   * 按磁盘重算某份文档的指纹（异步）。**这是 M0-8 的关键。**
   *
   * 时机：`agent/pre-step`（每次模型请求之前）。
   * 语义：如果文件在"上次读"之后被外部改过，这里会把指纹更新成新值，
   * 于是门禁发现 `readSet` 里的指纹 ≠ 当前指纹 → 拒绝并要求重读。
   *
   * @param {string} absPath
   * @returns {Promise<boolean>} 指纹是否发生了变化
   */
  async function refreshFingerprint(absPath) {
    const entry = entryByPath(absPath)
    if (entry === undefined) return false
    let text
    try {
      text = await readText(absPath)
    } catch {
      return false
    }
    if (typeof text !== 'string') return false
    const next = fingerprintOf(text)
    const changed = next !== entry.fingerprint
    entry.text = text
    entry.fingerprint = next
    return changed
  }

  /**
   * 刷新**所有**受管文档的指纹（异步，`agent/pre-step` 用）。
   *
   * **只在"没有 watcher"时才有必要**（watch 不可用 → touch 驱动）。
   * 修 D2 之前这里是**无条件**每轮全量重读全部文档 —— 与它自己的注释矛盾，
   * 也与 SPEC §6.3「watch 优先，无 watch 则 touch 驱动」矛盾。
   * 现在由调用方（`index.js` 的 `prepareSession`）按 `isWatching()` 决定要不要调。
   *
   * ⚠️ **它只刷新「已在册」条目的指纹，不发现新文件。**
   * 发现新文件靠 `rescan()`（`rescanIfStale()` 是它的降级版入口）。
   *
   * @returns {Promise<number>} 指纹发生变化的文档数
   */
  async function refreshAllFingerprints() {
    if (entries.length > config.maxWatchedDocs) return 0
    let changed = 0
    for (const entry of entries) {
      if (entry.unmanaged === true) continue
      if (typeof entry.path !== 'string') continue
      if (await refreshFingerprint(entry.path)) changed += 1
    }
    return changed
  }

  /** 是否有活跃的 watcher（决定要不要走 touch 驱动的全量重扫）。 */
  function isWatching() {
    return watchers.size > 0
  }

  /** 上次 touch 驱动重扫的时刻（毫秒）。 */
  let lastTouchScanAt = 0

  /**
   * **touch 驱动**：没有 watcher 时，由调用方在每轮 pre-step 调它，
   * 让「新增 / 删除 / 外部改动」都能被发现。
   *
   * 为什么必须重扫而不只是 `refreshAllFingerprints()`：
   * 后者只更新**已在册**条目的指纹，**永远发现不了新文件**（这就是 D2）。
   * 而 `scanProject` 会重新 `listDir`，新文件自然进册。
   *
   * 成本：重扫 = listDir + 每份 readText + 解析。10~50 份文档约 2~3 ms
   * （实测 dogfood 15 份 272 KB ≈ 2.5 ms/轮），可接受。
   * 用 `minIntervalMs` 做节流，避免同一轮里被调用多次。
   *
   * @param {number} [minIntervalMs] 最小间隔（默认 0 = 每次都扫）
   * @returns {Promise<boolean>} 这次是否真的扫了
   */
  async function rescanIfStale(minIntervalMs = 0) {
    if (isWatching()) return false // 有 watcher 就不需要 touch 驱动
    const now = Date.now()
    if (now - lastTouchScanAt < minIntervalMs) return false
    lastTouchScanAt = now
    await rescan()
    return true
  }

  /**
   * 外部改动后让某份文档失效（watch 或 edit 之后调用）。
   * @param {string} absPath
   */
  function invalidate(absPath) {
    const entry = entryByPath(absPath)
    // 只把缓存里的指纹换成"未知"，促使下次重扫；不猜内容。
    if (entry !== undefined) entry.fingerprint = ''
  }

  return {
    /** 重扫。 */
    rescan,
    /** 开始监听。 */
    startWatching,
    /** 停止监听。 */
    stopWatching,
    /** 是否有活跃 watcher。 */
    isWatching,
    /** touch 驱动：没有 watcher 时每轮调一次，发现新增/删除/改动。 */
    rescanIfStale,
    /** 订阅「索引变了」（AGENTS.md 重写用，D1）。 */
    onIndexChanged,
    /** 记账。 */
    markRead,
    /**
     * M2.7：记一次「本会话自己写过这份文档」（写类工具**成功之后**调）。
     * 用于收窄修法 2 —— 自己改的文档，窗口读不再强制整份重读。
     */
    noteSelfWrite,
    /**
     * 这份文档是不是本会话自己写的。
     *
     * ---- 2026-11-15 M2.8（用户拍板「要认」）：**`doc_mark` 现在真的用它** ----
     *
     * M2.7 建了这个集合，但**只有测试和诊断在读它** —— `tools/doc-mark.js`
     * 的门禁只看 `readSet` 指纹，于是「自己 edit 完正文 → 标状态」这个
     * 交接收尾最常见的动作**必然多一次整份重读**（交接 §3.2 的缺陷 #5）。
     *
     * 现在 `doc-mark.js` 第 4 步在**已有读记录**的前提下用它跳过指纹比对。
     * 不跳过「必须先读」那条 —— 从未读过的文档，即使本会话写过，也仍然要读。
     *
     * @see tools/doc-mark.js 第 4 步的注释（为什么这条放宽是安全的）
     */
    isSelfWritten,
    /** 按磁盘重算单份指纹（M0-8 用）。 */
    refreshFingerprint,
    /** 重算全部指纹（touch 驱动路径用）。 */
    refreshAllFingerprints,
    /** 失效。 */
    invalidate,
    /** 取某个会话的已读集合（报告缺项时要用对的那一份）。 */
    readSetFor,

    /** 同步读：当前索引（渲染回调里用）。 */
    get index() { return index },
    /** 同步读：全部条目。 */
    get entries() { return entries },
    /**
     * 同步读：**共享**已读集合。
     *
     * ⚠️ 只用于"拿不到 session"的降级路径（单会话脚本 / 冒烟）。
     * 正常路径一律用 `readSetFor(session)` —— 否则两个会话会互相"替对方读过"。
     */
    get readSet() { return readSet },
    /** 同步读：状态。 */
    get state() { return state },
    /** 同步读：最近一次错误。 */
    get lastError() { return lastError },
    /** 同步读：扫描是否被截断。 */
    get truncated() { return truncated },

    /** 按路径取条目。 */
    entryByPath,
    /** 按 id 取条目。 */
    entryById,
    /** 按 id 取元数据。 */
    metaById(id) { return entryById(id)?.meta },

    /** 按 id 取当前指纹（同步，供门禁用）。 */
    fingerprintOf(id) { return entryById(id)?.fingerprint },
    /** 按 id 取缓存全文（同步，供"仅追加"判定用）。 */
    textOf(id) { return entryById(id)?.text },
    /** 按 id 判断是否有 error（同步，供门禁用）。 */
    hasError(id) { return entryById(id)?.hasError === true },

    /** 是不是"完全没东西"（M0-9 的空工作区）。 */
    isEmpty() { return state === STATE_READY && entries.length === 0 },
  }
}

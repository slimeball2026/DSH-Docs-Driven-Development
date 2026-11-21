/**
 * 门禁裁决（SPEC §7.1 / §7.3 / §7.4）。
 *
 * **纯函数，同步，无 IO。**
 *
 * 为什么必须同步：`ctx.tools.guard()` 的回调是同步的
 * （`checkGuards` 直接 `guard(exec)` 取值，不 await），所以裁决里**不能读盘**。
 * 所有需要的信息都从注册表的内存缓存里取。
 *
 * 裁决顺序（每一条都能在 SPEC 找到出处）：
 *   1. 没有路径参数 → 放行（§7.1）
 *   2. 坟场 → 拒绝，**连 read 也拒**（§8.1）
 *   3. 不是 doc → 放行（§7.1 的核心：R1 按路径拦，不按工具名）
 *   4. 有 error 的文档 → 允许读、拒绝写（§5.4）
 *   5. 按 role 查写权限（§7.3）
 *   6. 必读未读完 → 拒绝，理由列出缺哪几份（§7.4）
 *   7. 指纹变了 = 读的是旧版 → 拒绝，理由指出 v3/v5（§9.3）
 */

import {
  ALLOW,
  APPEND_ONLY,
  DENY,
  EDIT,
  WRITE,
  denyMessage,
  isAppendOnly,
  policyFor,
} from './roles.js'

/** 门禁结论。 */
export const GATE_ALLOW = 'allow'
export const GATE_DENY = 'deny'

/** 读取类工具名（**永不拦**——读是放行条件本身）。 */
export const READ_TOOLS = Object.freeze(['read', 'read_image', 'glob', 'grep', 'listDir'])

/**
 * 求 frontmatter 块在原文里的字符区间（`[start, end)`）。
 *
 * **纯函数，零 IO。** 给 N1b 的「只改元数据」判定用（P2 = a）。
 *
 * 区间**含起止两行 `---` 以及结束行之后的换行**：
 * 这样「把 `verifiedAgainst:\n  dsh: 0.2.2` 换成 `verifiedAgainst: {"dsh":"0.2.2"}`」
 * 会被判成落在块内 —— 它确实只动了 frontmatter。
 *
 * 为什么不用 `core/frontmatterEdit.js` 的 `locateFrontmatter`：
 * 那一个返回的是**行数组**，不返回字符偏移；而 gate 要判的是
 * 「`old_string` 的匹配位置在不在块内」，必须按字符比。
 * 两处逻辑重复一点，但**语义不同**（一个为了改写，一个为了判定），
 * 硬合并会让其中一方被迫接受另一方的假设。
 *
 * @param {string} text 整份文件文本（可带 BOM）
 * @returns {{start: number, end: number} | undefined} 没有 frontmatter 块时返回 undefined
 */
export function frontmatterSpan(text) {
  const source = typeof text === 'string' ? text : ''
  if (source === '') return undefined

  const bom = source.charCodeAt(0) === 0xfeff ? 1 : 0
  const src = bom === 1 ? source.slice(1) : source

  // 第一行必须**只有** `---`（前后空白不算）。
  const firstEol = src.indexOf('\n')
  const firstLine = (firstEol < 0 ? src : src.slice(0, firstEol)).replace(/\r$/, '')
  if (firstLine.trim() !== '---') return undefined

  let cursor = firstEol < 0 ? src.length : firstEol + 1
  while (cursor <= src.length) {
    const nextEol = src.indexOf('\n', cursor)
    const lineEnd = nextEol < 0 ? src.length : nextEol
    const line = src.slice(cursor, lineEnd).replace(/\r$/, '')
    const trimmed = line.trim()
    // 与 `docs/frontmatter.js` 一致：`---` 与 `...` 都是结束标记。
    if (trimmed === '---' || trimmed === '...') {
      const blockEnd = nextEol < 0 ? src.length : nextEol + 1
      return { start: bom, end: bom + blockEnd }
    }
    if (nextEol < 0) return undefined
    cursor = nextEol + 1
  }
  return undefined
}

/**
 * 这次 `edit` 的**替换区间是否完全落在 frontmatter 块内**（N1b / P2 = a）。
 *
 * 判据（三条同时成立）：
 *   1. 原文有可识别的 frontmatter 块；
 *   2. `old_string` 非空，且在原文里**至少匹配到一次**；
 *   3. 每一次匹配（`replace_all` 时是全部，否则只看第一次）都落在块区间内。
 *
 * ⚠️ **为什么必须逐字符判，而不是"含 `role:` 就算"**：
 * 那会让「把正文里一句话改成 `role: spec`」也被放行 —— 而正文才是文档的内容。
 * 本判据只认**位置**，不认**文本长什么样**，所以不会被措辞骗过。
 *
 * 已知边界（**如实记账，不假装没有**）：
 * 若 `new_string` 里自带一行 `---`，frontmatter 会被提前截断，
 * 块尾那部分元数据会"漏"成正文。这不构成对正文的**改写**（原有正文字节不变），
 * 但会让文档结构变怪 —— 改坏了自己要负责，插件不替它兜。
 *
 * @param {object} input
 * @param {string} input.text 原文
 * @param {string} input.oldString
 * @param {string} input.newString
 * @param {boolean} [input.replaceAll]
 * @returns {boolean}
 */
export function editTouchesOnlyFrontmatter(input) {
  const opts = input !== null && typeof input === 'object' ? input : {}
  const { text, oldString, newString, replaceAll } = opts

  if (typeof text !== 'string' || text === '') return false
  if (typeof oldString !== 'string' || oldString === '') return false
  if (typeof newString !== 'string') return false

  const span = frontmatterSpan(text)
  if (span === undefined) return false

  const positions = []
  let from = 0
  for (;;) {
    const index = text.indexOf(oldString, from)
    if (index < 0) break
    positions.push(index)
    if (replaceAll !== true) break
    // 空 `old_string` 已在上面挡掉，这里 `length >= 1`，不会死循环。
    from = index + oldString.length
  }
  if (positions.length === 0) return false

  return positions.every((index) => index >= span.start && index + oldString.length <= span.end)
}

/**
 * 从工具执行里取出目标路径（SPEC §7.2 的工具表）。
 *
 * `apply_patch` 没有单一路径参数，按 SPEC §7.2 的**保守策略**：
 * 抽不出或解析失败 → 放行并 warn。M0 不实现补丁解析（本机 `applyPatch: false`，
 * 且误拦会阻断正常施工，误放只是漏一次门禁）。
 *
 * @param {object} exec 工具执行快照 `{ name, arguments }`
 * @returns {string | undefined}
 */
export function pathArgOf(exec) {
  if (exec === null || typeof exec !== 'object') return undefined
  const args = exec.arguments
  if (args === null || typeof args !== 'object') return undefined
  const name = exec.name

  if (name === 'write' || name === 'edit' || name === 'read') {
    return typeof args.file_path === 'string' && args.file_path !== '' ? args.file_path : undefined
  }
  if (name === 'str_replace_editor') {
    // `command: view` 是读，不拦；其余（create / str_replace / insert）是写。
    if (args.command === 'view') return undefined
    return typeof args.path === 'string' && args.path !== '' ? args.path : undefined
  }
  return undefined
}

/**
 * 门禁裁决。
 *
 * @param {object} input
 * @param {string} input.toolName 工具名
 * @param {object} input.args 工具参数
 * @param {Array<object>} input.required 必读清单（buildIndex 的 required）
 * @param {Map<string, object>} input.readSet 本会话已读 `{ [id]: {fingerprint, text?} }`
 * @param {(id: string) => string} [input.currentFingerprint] 取当前指纹
 * @param {(absPath: string) => string} input.classify 路径判定（由适配层注入，core/ 不许碰内置模块）
 * @param {(id: string) => object | undefined} [input.metaOf] 按 id 取元数据
 * @param {(id: string) => string | undefined} [input.textOf] 按 id 取缓存全文（仅追加判定用）
 * @param {(absPath: string) => boolean} [input.unmanagedOf] 按**绝对路径**判「完全没有 frontmatter」（M1.5 / N1）
 * @param {(absPath: string) => string | undefined} [input.textOfPath] 按**绝对路径**取缓存全文（M1.5 / N1b）
 * @param {boolean} [input.gateEnabled] 总开关
 * @returns {{decision: 'allow'|'deny', reason?: string, warn?: string}}
 */
export function decideGate(input) {
  const opts = input !== null && typeof input === 'object' ? input : {}
  const allow = { decision: GATE_ALLOW }

  if (opts.gateEnabled === false) return allow

  const toolName = opts.toolName
  const args = opts.args !== null && typeof opts.args === 'object' ? opts.args : {}
  const path = pathArgOf({ name: toolName, arguments: args })
  if (path === undefined) return allow

  const classify = typeof opts.classify === 'function' ? opts.classify : undefined
  if (classify === undefined) return allow

  const kind = classify(path)

  // §8.1：坟场一律拒绝，**包括 read**。
  if (kind === 'graveyard') {
    return {
      decision: GATE_DENY,
      reason: '`_graveyard/` 是归档区，不参与施工。需要恢复请用 UI 的「还原」。',
    }
  }

  // §7.2：read 永不拦。
  if (toolName === 'read' || READ_TOOLS.includes(toolName)) return allow

  // R1 的核心：非 docs/ 一律放行（M0-3 靠这条保证不误伤 src/）。
  if (kind !== 'doc') return allow

  const meta = typeof opts.metaOf === 'function' ? opts.metaOf(path) : undefined
  const id = typeof meta?.id === 'string' && meta.id !== '' ? meta.id : undefined
  const action = toolName === 'write' ? WRITE : EDIT

  // 解析不出 id 的 docs/ 文档：要分**三种**情况，否则会误伤或锁死。
  //
  // M1.5 的 N1（阻塞级）就是这里只分了两种：
  //
  //   1. **注册表里根本没有它**（刚新建 / 扫描还没覆盖到）→ 放行。
  //      M0 起就是这样，不能动：插件自己的刷新延迟不该变成对模型的拒绝。
  //
  //   2. **`unmanaged`：完全没有 frontmatter**（文件不以 `---` 开头）→ **放行**。
  //      这是 M1.5 修 N1 的落点（`P1 = a`）。理由：
  //        - 它不进 `required` / `forbidden` / `anomalies` 任何一份清单
  //          （`core/index.js:57` 明确 `continue` 掉），写它**不破坏任何判据**；
  //        - M1 的拒绝文案是**空头支票**：它说「先补上 id / role / status 再改它」，
  //          而补字段只能用 `edit`/`write` —— 那两个正被这句同一句话拒掉。
  //          实测死锁：`_review/proj-a/docs/plain-note.md`，`read` 成功、`edit` 永久被拒。
  //        - 唯一的逃生通道是 `pwsh`，而那是**已登记的已知漏洞**。
  //          让一个已知漏洞承担"唯一出路"，性质就从"限制"变成"事故"。
  //
  //   3. **`broken`：有 `---` 但解析失败 / 字段非法**（进了 `anomalies`）→ 拒绝，
  //      但**必须允许"只改 frontmatter"的那种 edit**（见下面的 N1b 分支）。
  //      这一类是真坏了，绝不能整体放行。
  if (id === undefined) {
    const known = typeof opts.knownOf === 'function' ? opts.knownOf(path) : true
    // 情况 1：注册表不认识它。
    if (known !== true) return allow

    // 情况 2：明确是 unmanaged（完全不参与索引）→ 放行。
    // `unmanagedOf` 拿不到时**不猜**（保持 M1 的拒绝行为），避免接线漏掉后静默放宽门禁。
    if (typeof opts.unmanagedOf === 'function' && opts.unmanagedOf(path) === true) return allow

    // 情况 3：有 `---` 但坏了 → 拒绝；但若是"只改 frontmatter"的 edit，放行（N1b）。
    if (toolName === 'edit' && editTouchesOnlyFrontmatter({
      text: typeof opts.textOfPath === 'function' ? opts.textOfPath(path) : undefined,
      oldString: args.old_string,
      newString: args.new_string,
      replaceAll: args.replace_all === true,
    })) {
      return allow
    }

    return {
      decision: GATE_DENY,
      reason: `\`${path}\` 的 frontmatter 坏了（解析不出 id / role / status）。`
        + '**修法**：用 edit 只改 frontmatter 那一块（把坏字段改对），正文别动。'
        + '例：把 `verifiedAgainst:` 下面的缩进子键拍平成 `verifiedAgainst: {"dsh":"..."}`，'
        + '或把不合法的 `role` 改成合法值（spec / decision / evidence / handover / instruction / log / index / fact）。',
    }
  }

  const entry = { meta }
  const hasError = opts.errorOf?.(id) === true

  // §5.4：有 error 的文档读得到、写不得 —— 不能让它静默参与决策。
  //
  // ⚠️ **M1.5 的 N1b（高）：这里原来是一张空头支票。**
  // 它说「先把它的 frontmatter 修好」，但实战里 `role: bogus-role` 这类坏元数据
  // **没有任何插件内手段能修**：`edit` 被这句拒、`doc_mark` 只改 status 不改 role。
  // 实测：`doc_mark{status:draft}` 成功 → 再 `edit{role:spec}` 仍被同一句拒。
  //
  // 修法（`P2 = a`：**允许"只修元数据"的 edit**，不扩工具面 / 不违反 Q13）：
  // 当 `edit` 的替换区间**完全落在 frontmatter 块内**时放行 —— 那不可能改到正文，
  // 而"修好元数据"正是让这份文档从 `anomalies` 里出来的唯一办法。
  //
  // `write` 仍然拒绝：整体覆盖能把正文一起换掉，而它已经坏了一次，不该再给它这个机会。
  if (hasError) {
    if (toolName === 'edit' && editTouchesOnlyFrontmatter({
      text: typeof opts.textOfPath === 'function' ? opts.textOfPath(path) : undefined,
      oldString: args.old_string,
      newString: args.new_string,
      replaceAll: args.replace_all === true,
    })) {
      return allow
    }

    return {
      decision: GATE_DENY,
      reason: `\`${id}\` 的元数据有 error（见索引块的【文档异常】），不能这样改它。`
        + '**可行的修法只有一种**：用 edit 把 frontmatter 里出错的字段改对'
        + '（替换内容必须整段落在 `---` 块内，正文一个字节都不能动）。'
        + '不合法字段的允许值：role ∈ spec/decision/evidence/handover/instruction/log/index/fact，'
        + 'status ∈ authoritative/partial/superseded/sealed/void/draft，'
        + 'basis ∈ 实测/推断/未验证。用 read 看一眼【文档异常】说的规则号再改。',
    }
  }

  // §7.3：按 role 查写权限。
  let policy = policyFor(meta.role, action)
  // `instruction` 的例外：status: draft 时允许 write。
  if (meta.role === 'instruction' && meta.status === 'draft' && action === WRITE) {
    policy = ALLOW
  }
  // ---- 2026-11-14 M2.6：交接的 edit 已在 `core/roles.js` 里**彻底放开** ----
  //
  // 这里曾经有一条例外（只放开 `draft`），**已删除** —— 因为策略改成"任意状态都可 edit"，
  // 那条例外现在是 dead code。留着它会误导后来的人以为"还是只有 draft 能改"。
  //
  // 为什么要彻底放开（两次拍板的完整理由写在 `core/roles.js` 的 `handover` 那条：
  // 实测证明 AI 会在"还有东西要改"时就把交接标成 authoritative，
  // 随后哈希过时、锁死，于是陷入重写 + 数千字往返思考）。
  //
  // ⚠️ `write` 仍然拒绝 —— 那条例外**不能**顺手加，否则会绕过 `doc_new` 的 supersedes 链。

  if (policy === DENY) {
    return { decision: GATE_DENY, reason: denyMessage({ id, role: meta.role, action }) }
  }

  if (policy === APPEND_ONLY) {
    const cached = typeof opts.textOf === 'function' ? opts.textOf(id) : undefined
    const verdict = isAppendOnly({
      oldText: cached,
      oldString: args.old_string,
      newString: args.new_string,
      replaceAll: args.replace_all === true,
    })
    if (!verdict.append) {
      return {
        decision: GATE_DENY,
        reason: denyMessage({ id, role: meta.role, action, why: verdict.reason }),
      }
    }
    // 降级路径（没有缓存文本）放行但带 warn。
    if (typeof verdict.reason === 'string' && verdict.reason.startsWith('degenerate')) {
      return { decision: GATE_ALLOW, warn: `\`${id}\` 的追加判定降级放行：没有缓存文本。` }
    }
  }

  // §7.4 / §9.3：必读未读完，或读的是旧版 → 拒绝。
  const readSet = opts.readSet ?? new Map()
  const record = typeof readSet.get === 'function' ? readSet.get(id) : readSet[id]
  const current = typeof opts.currentFingerprint === 'function' ? opts.currentFingerprint(id) : undefined

  // ---- 2026-11-15 M2.8（用户拍板）：**`edit` 也要认 `selfWritten`** ----
  //
  // 缺陷现场（第 25 轮 `session-18b07bcb`，seq 123 → 128）：
  // ```
  // seq 123  edit ddd-25  ✅ 成功        ← 模型自己改的
  // seq 128  edit ddd-25  ❌ 你读过的是 v7203cc，磁盘已是 vddaac0
  // ```
  // 两次编辑是**同一个文件、同一个模型、同一轮**，中间没有任何外部改动。
  // 拒绝的真实原因只是"上一次 success 改了指纹" —— 而那个改动是**它自己做的**。
  //
  // M2.8 上一轮只把 `selfWritten` 接进了 `tools/doc-mark.js`，
  // **忘了接这里** —— 于是同一个缺陷在 `edit` 上原样活着。
  // 这正是交接 §4.5 说的"变异存活时先怀疑测试没跑到"的另一面：
  // **修一处不等于修一类**，`doc_mark` 和 `edit` 走的是两条独立路径。
  //
  // AI 自己的原话（`session-18b07bcb` seq 186 反馈第 2 条）：
  // > 门禁规则是"改过就变回未读，必须整份重读"。但**我自己刚写的改动，为什么还需要重读一遍？**
  // > 这一轮我改了 `read-order` 之后又被迫整份重读一次，改 `ddd-25` 之后又重读一次，
  // > 改的是我自己写的两行。
  //
  // ---- 为什么这条放宽是安全的（与 `doc_mark` 那条同一套论证）----
  //
  // `selfWritten` 是纯内存、会话级、**只在写类工具成功时**才记（`adapters/observe.js`）：
  //   · 被门禁拒 / `edit` 没匹配上 → 不记（内容没变）；
  //   · 别人 / 另一个会话 / 编辑器改的 → 不记（外部改动必须重读）；
  //   · 宿主重启 → 内存清空 → 退回严格行为。
  //
  // ⚠️ **但它不能延伸到"必读清单未读完"那条判据**（下面 `inRequired` 里 `record === undefined` 的分支）：
  //    "本会话写过"不等于"读过全文"。`selfWritten` 只豁免**指纹比对**，
  //    不豁免"必须先读"。反例网在 `test/m28-fixes.test.js`。
  const selfWritten = typeof opts.isSelfWritten === 'function' && opts.isSelfWritten(id) === true

  // 必读清单内的文档必须先读；不在必读清单（如 draft）不强制。
  const inRequired = Array.isArray(opts.required)
    && opts.required.some((item) => item?.meta?.id === id)

  if (inRequired) {
    if (record === undefined || record === null) {
      return { decision: GATE_DENY, reason: gateMessage(opts, id) }
    }
    if (!selfWritten && current !== undefined && record.fingerprint !== current) {
      return {
        decision: GATE_DENY,
        reason: `改 \`${id}\` 之前要先重读：你读过的是 v${short(record.fingerprint)}，`
          + `磁盘已是 v${short(current)}。用 read 工具重读它，然后再改。`,
      }
    }
  }

  // 读过了但磁盘变了（非必读的文档也要防"拿旧版当依据"）。
  if (inRequired === false && !selfWritten && record !== undefined && record !== null
    && current !== undefined && record.fingerprint !== current) {
    return {
      decision: GATE_DENY,
      reason: `改 \`${id}\` 之前要先重读：你读过的是 v${short(record.fingerprint)}，`
        + `磁盘已是 v${short(current)}。用 read 工具重读它，然后再改。`,
    }
  }

  return allow
}

/** 取指纹前 6 位（与 render.js 的版本号显示一致）。 */
function short(fingerprint) {
  return typeof fingerprint === 'string' ? fingerprint.slice(0, 6) : '??????'
}

/**
 * 构造「必读未读完」的拒绝文案（SPEC §7.4 三条要求）。
 * @param {object} opts decideGate 的入参
 * @param {string} id 目标文档 id
 * @returns {string}
 */
function gateMessage(_opts, id) {
  return `改 \`${id}\` 之前必须先读它（用 read 工具）。只需补读当前目标；其他参考文档按任务选择。`
}

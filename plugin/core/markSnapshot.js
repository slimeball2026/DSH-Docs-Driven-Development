/**
 * 标绿快照：**记录「标成 authoritative 那一刻，其它文档是什么版本」**
 * （M2.6 · 用户拍板方案 B）。
 *
 * ---- 为什么需要它（用户原话）----
 *
 * > 不该预设 AI 能预料到自己真的没东西要改。
 *
 * 这是核心矛盾。「标绿时机」那个问题的现有做法是**事前提醒**（"别过早标绿"），
 * 但它把判断责任压在「AI 能否准确预见未来」上 —— 实测（`session-916967d2`）
 * AI 自己承认：「七段结构全合规、健康度全过，**但有一句话在说假话**」。
 *
 * ⇒ 方案 B 的立场：**不要求 AI 预判，只做事实对账**。
 *
 *   标绿时把「此刻各文档的指纹」记下来 → 之后任何时候都能问
 *   「我标绿时 read-order 是 v3BC5014，现在是 vAFABB26 —— 我引用的它已经变了」。
 *
 * 报的是**可核对的事实**，不是"我觉得你可能忘了"。
 *
 * ---- 为什么存在 `_artifacts/` 而不是写进文档 ----
 *
 * 1. `_artifacts/` 门禁完全放行（`core/gate.js` 的 `if (kind !== 'doc') return allow`）；
 * 2. 它**不进索引、不进必读清单、不参与 H1–H7** —— 用户也确认："交接本来就处于会话末端，
 *    此时噪声不会影响工程质量"；
 * 3. 写进 frontmatter 会改 schema（现存文档全挂），写进正文会污染文档。
 *
 * ---- 纯函数边界 ----
 *
 * 本模块**零 IO**：拼路径、算差异都是纯函数，读写由调用方注入 `fs`。
 * 这样 `core/` 的分层纪律与单测都好办。
 */

/** 快照文件名（相对 `_artifacts/`）。 */
export const MARK_SNAPSHOT_FILE = 'ddd-mark-snapshots.json'

/**
 * 造一条快照记录。
 *
 * @param {object} input
 * @param {string} input.id 被标绿的文档 id
 * @param {string} input.status 标成的状态（只有 authoritative 需要快照，但这里不筛）
 * @param {number} [input.at] 时间戳（**只用于人看，不参与判据**）
 * @param {Array<{id: string, fingerprint: string}>} input.refs 其它文档的 id → 指纹
 * @returns {{id: string, status: string, at?: number, refs: Array<{id: string, fingerprint: string}>}}
 */
export function snapshotOf(input) {
  const opts = input !== null && typeof input === 'object' ? input : {}
  const refs = (Array.isArray(opts.refs) ? opts.refs : [])
    .filter((item) => item !== null && typeof item === 'object'
      && typeof item.id === 'string' && item.id !== ''
      && typeof item.fingerprint === 'string' && item.fingerprint !== '')
    // **排序**：让快照是确定性的（同样输入 → 同样字节），便于比对与测试。
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((item) => ({ id: item.id, fingerprint: item.fingerprint }))

  const record = {
    id: typeof opts.id === 'string' ? opts.id : '',
    status: typeof opts.status === 'string' ? opts.status : '',
    refs,
  }
  if (typeof opts.at === 'number' && Number.isFinite(opts.at)) record.at = opts.at
  return record
}

/**
 * 把新快照并进已有快照表。
 *
 * 规则：**同一份文档只保留最新一条**（它后来又被标绿过一次，旧的那份已经没人引用）。
 * 不同文档各自保留。
 *
 * @param {object|undefined} existing 已读到的快照表（坏输入按空处理）
 * @param {object} record `snapshotOf` 的产物
 * @returns {object} 新的快照表（**不修改入参**）
 */
export function mergeSnapshot(existing, record) {
  const base = existing !== null && typeof existing === 'object' && !Array.isArray(existing)
    ? existing
    : {}
  const next = { ...base }
  if (record === null || typeof record !== 'object' || typeof record.id !== 'string' || record.id === '') {
    return next
  }
  next[record.id] = record
  return next
}

/**
 * 对账：**标绿之后，它引用的文档变了没有**。
 *
 * @param {object|undefined} snapshots 快照表
 * @param {string} id 要查的文档 id
 * @param {(docId: string) => string|undefined} currentFingerprintOf 取当前指纹（未知返回 undefined）
 * @returns {Array<{id: string, was: string, now: string}>} 变化了的引用（空数组 = 没变或没快照）
 */
export function driftedRefsOf(snapshots, id, currentFingerprintOf) {
  if (snapshots === null || typeof snapshots !== 'object') return []
  const record = snapshots[id]
  if (record === null || typeof record !== 'object' || !Array.isArray(record.refs)) return []
  if (typeof currentFingerprintOf !== 'function') return []

  const drifted = []
  for (const ref of record.refs) {
    if (ref === null || typeof ref !== 'object') continue
    const now = currentFingerprintOf(ref.id)
    // 拿不到当前指纹（文档被删 / 被归档）→ **不算漂移**：
    // 那属于"引用悬空"，由别的判据（V5）负责，这里不重复报。
    if (typeof now !== 'string' || now === '') continue
    if (now !== ref.fingerprint) drifted.push({ id: ref.id, was: ref.fingerprint, now })
  }
  return drifted
}

/**
 * 把漂移结果渲染成一句模型可见的提醒（没有漂移返回空串）。
 *
 * ⚠️ 措辞纪律：这是**事实陈述**，不是指责。说"它在标绿后改过"，
 * 不说"你可能写错了" —— 因为改了也未必错，得由模型自己判断 §5 还准不准。
 *
 * @param {string} id
 * @param {Array<{id: string, was: string, now: string}>} drifted
 * @returns {string}
 */
export function driftMessageOf(id, drifted) {
  if (!Array.isArray(drifted) || drifted.length === 0) return ''
  const lines = drifted.map((item) => `  - \`${item.id}\`：标绿时 ${item.was.slice(0, 6)}，现在 ${item.now.slice(0, 6)}`)
  return `⚠️ \`${id}\` 标成 authoritative 之后，这些文档改过：\n${lines.join('\n')}\n`
    + '如果你在它正文里引用了这些文档的内容/哈希/状态，**那些引用可能已经过时**。'
    + '（核对一遍再决定要不要 `edit` —— 现在交接是允许改的。）'
}

/**
 * 找出正文里**含计数**的行（M2.9 · 第 35 轮实机反馈）。
 *
 * ---- 要解决什么 ----
 *
 * H-6 只报「`read-order` 从 v1f796a 变成了 vb25c2a」，**不说是哪句话过期了**。
 * 第 35 轮 `session-0a4d5b43` 的真实现场：`handover-1` 的 §5 写着
 *
 * > `glob docs/**` 实跑命中 **4/4 命中**
 *
 * 而用户归档 `instruction-2` 之后，实际只剩 3 份 —— 这句话**当场就假了**。
 * H-6 如实报了"`instruction-2` 改过"，但模型看到的只是两个指纹，
 * 无法把"它改过"和"我那句 4/4"联系起来。
 *
 * ---- 为什么只挑「含计数」的行 ----
 *
 * 漂移之后，**绝大多数引用仍然是对的**（"`read-order` 是入口索引"这种描述不会因为
 * 改一个标点就假）。真正会假的只有**把某个数字写死**的地方：份数、条数、行数、哈希。
 *
 * 全部列出来 = 噪音（交接几十行，列十几条等于没提示）。
 * 只列含数字的 = **少而准**，而且这正是 §4.1 反复教的那句「宁可写状态、别写计数」的反面。
 *
 * ---- 边界（刻意保守）----
 *
 * · **只报候选，不判对错** —— 它无法知道那个数字是不是真的过期了；
 * · **最多 5 条** —— 再多就没人看；
 * · **跳过代码块内**（``` 围栏里的是示例，不是断言）；
 * · **跳过 frontmatter**（`order: 10` 那种数字不是"引用"）。
 *
 * @param {string} text 文档全文（含 frontmatter）
 * @returns {string[]} 含计数的行（已 trim、去重、最多 5 条）
 */
export function countingLinesOf(text) {
  const source = typeof text === 'string' ? text : ''
  if (source === '') return []

  // 去掉 frontmatter：它里面的 `order: 10` / `archivedAt` 不是"引用"。
  const bodyStart = (() => {
    const firstEol = source.indexOf('\n')
    if (firstEol < 0) return 0
    if (source.slice(0, firstEol).replace(/\r$/, '').trim() !== '---') return 0
    const close = source.indexOf('\n---', firstEol)
    return close < 0 ? 0 : source.indexOf('\n', close + 1) + 1
  })()
  const body = source.slice(bodyStart)

  const out = []
  const seen = new Set()
  let inFence = false
  for (const raw of body.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(raw)) { inFence = !inFence; continue }
    if (inFence) continue
    const line = raw.trim()
    if (line === '') continue
    // ---- 标题行不算 ----
    //
    // `## §5 验收` 里的 `5` 是**章节号**，不是"引用某个数量"。
    // 我第一版没排它，于是每个标题都成了候选（`## §2`、`## §5`…），
    // 5 条配额立刻被标题占满 —— 真该看的那行反而列不出来。
    // （这个 bug 是 `test/m29-round35.test.js` 的"代码块"那条抓出来的。）
    if (/^#{1,6}\s/.test(line)) continue
    // 含数字才算候选。`N/M`、`N 份`、`N 条`、`N 行`、十六进制指纹都命中。
    if (!/\d/.test(line)) continue
    // 太长的行截断 —— 提示里要能一眼看完。
    const shown = line.length > 90 ? `${line.slice(0, 90)}…` : line
    if (seen.has(shown)) continue
    seen.add(shown)
    out.push(shown)
    if (out.length >= 5) break
  }
  return out
}

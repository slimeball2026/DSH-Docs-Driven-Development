/**
 * 从交接文档里取 `nextStep` 与 `basisDoc`（M2.3 收尾 · M2 最后一条遗留判据）。
 *
 * ---- 这两个字段是什么 ----
 *
 * 看板（`dashboard.tsx`）有这两行：
 *
 * | 行 | 含义 | 真源 |
 * |---|---|---|
 * | **下一步** | "接下来该干什么" | 交接文档的 §3「下一刀」 |
 * | **依据文档** | "这个结论建立在哪份文档的哪一节上" | 交接文档 §5「验收」里引用的文档 |
 *
 * 它们从 M2 起就一直**不显示** —— 因为 `buildSnapshot` 的入参没人填。
 * 本轮补上，但**绝不猜**：
 *
 * > 取不到就返回空串 / `null`，UI 就不显示那一行。
 * > 显示一个编造的"下一步"比不显示糟得多 —— 那会让人照着错的方向干活。
 *
 * ---- 为什么放在 `core/` ----
 *
 * `core/` 是**纯函数层**：零 IO、零时间、零随机、不 import 内置模块
 * （`test/decoupling.test.js` 钉着）。这个文件只做字符串处理，完全符合。
 *
 * ⚠️ **本文件必须是纯 JS**：Node 的类型剥离只处理 `.ts`，
 * 在 `.js` 里写 `interface` / `: string` 会直接 `SyntaxError`。
 *
 * ---- 与 H1–H7 的关系 ----
 *
 * **不改任何判据**。这里只是"读"交接文档的段落，
 * 复用 `parseHandoverSections` 的解析结果，对 H1–H7 的结论**一行影响都没有**。
 */

import { parseHandoverSections, splitSections } from './handover.js'

/**
 * @typedef {object} NextStepItem
 * @property {string} text 原样的条目文本（已去掉列表符号与多余空白）
 * @property {number} seq 它在 §3 里的序号（从 1 开始），用于稳定排序
 */

/**
 * @typedef {object} BasisDocRef
 * @property {string} id 文档 id（交接文档里写的那个，**不校验它真的存在**）
 * @property {string} section 章节号（`§4.2` → `4.2`）；没有就空串
 * @property {string} fingerprint 指纹（这里拿不到，恒为空串，由调用方回注册表补）
 */

/**
 * 这条是不是**已经做完**的（交接文档用删除线 / ✅ 标记完成）。
 *
 * @param {string} text 条目文本
 * @returns {boolean}
 */
function isDone(text) {
  if (text.includes('~~')) return true
  if (text.startsWith('✅')) return true
  if (text.startsWith('☑')) return true
  return false
}

/**
 * 从「下一刀」那一节里取出**可执行的条目**。
 *
 * 支持的写法（都是真实交接文档里出现过的）：
 *
 * ```md
 * ## 3. 下一刀
 * 1. **修 `_rv/mutate.mjs` 的 2 个 BAD-ANCHOR** —— 便宜，恢复两条覆盖
 * - 或者无序列表
 * | 顺序 | 任务 | 落点 |     ← 表格也认（取"任务"那一列）
 * ```
 *
 * ⚠️ **刻意排除的东西**（否则会把"已经做完的"当成"下一步"）：
 *   - 带 `~~删除线~~` 的条目（交接文档里用它标记"已完成"）；
 *   - 以 `✅` / `☑` 开头的条目；
 *   - 空条目；子标题（`### 5.1`）。
 *
 * @param {string} body 交接文档正文（含 frontmatter 也行，解析只认 `##`）
 * @returns {NextStepItem[]} 条目列表；没有「下一刀」这一节时返回空数组
 */
export function nextStepsOf(body) {
  const sections = parseHandoverSections(body)
  const section = sections?.next
  if (section === undefined || section.found !== true) return []

  const lines = String(section.text ?? '').split(/\r?\n/)
  /** @type {NextStepItem[]} */
  const items = []

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line === '') continue

    // 跳过标题（§3 下面可能有 `### 5.1` 这种子标题）。
    if (/^#{2,6}\s/.test(line)) continue

    // 表格：只取"任务"那一列，跳过表头与分隔行。
    if (/^\|.*\|$/.test(line)) {
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
      if (cells.length === 0) continue
      // 分隔行 `|---|---|`
      if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue
      // 表头：`| # | 任务 | 落点 |`
      if (/^(#|任务|项|顺序|序号|优先级)$/.test(cells[0]) || cells[0] === '') continue
      const text = cells.length >= 2 ? cells[1] : cells[0]
      if (text !== '' && !isDone(text)) items.push({ text, seq: items.length + 1 })
      continue
    }

    // 有序 / 无序列表
    const listMatch = /^(?:\d+[.)]|[-*+])\s+(.*)$/.exec(line)
    if (listMatch === null) continue
    const text = listMatch[1].trim()
    if (text === '' || isDone(text)) continue
    items.push({ text, seq: items.length + 1 })
  }

  return items
}

/**
 * 取 `nextStep`：**只取第一条未完成的**，因为看板那一行只显示一行。
 *
 * 为什么取第一条而不是拼接：看板是窄栏，拼三条会变成一坨；
 * 而且"下一刀"的语义本来就是**一件**事 —— 交接文档的 §3 按顺序排列，
 * 第一条就是最该先做的（这是 `交接-*.md` 的一贯写法）。
 *
 * @param {string} body 交接文档正文
 * @returns {string} 第一条未完成条目的文本；没有时返回**空串**（UI 据此不显示那一行）
 */
export function nextStepOf(body) {
  const [first] = nextStepsOf(body)
  return first === undefined ? '' : first.text
}

/**
 * 从交接文档里取 `basisDoc`：**它建立在哪份文档的哪一节上**。
 *
 * ---- 2026-11-14 演练复盘：这里曾经取错对象 ----
 *
 * 用户看到看板上「下一步」显示 `让用户确认 report.md 的表格格式…`，
 * 而「依据文档」也指向 `report` —— 他问：「依据文档是不是也在这句话里面？」
 *
 * 核实后：**是，而且那是错的**。旧实现扫**全文**第一个 `` `xxx.md` ``，
 * 而交接 §3 的"下一刀"里正好提到 `report.md`（**交付物**），
 * 于是 `report` 被当成了"依据文档"。
 *
 * 正确语义：**依据文档 = 这份交接的结论建立在哪些文档上**，
 * 它在交接里有两个正当来源：
 *
 *   1. **§5「验收」**里引用的文档（"详见 `SPEC-x.md` §4.2"）；
 *   2. **frontmatter 的 `basis` / `basisDoc`**（结构化的声明）。
 *
 * 所以现在：
 *   - **只扫 §5**（不扫 §3 / §1，那里提到 .md 多半是交付物或工具参数）；
 *   - 且**能通过 `knownIds` 校验的才算**（`report` 不在注册表里 → 不算依据）。
 *
 * ⚠️ **宁可不显示，也不显示错的**：找不到合格引用就返回 `null`，
 * UI 那一行不渲染。这与项目一贯的判据一致。
 *
 * @param {string} body 交接文档正文
 * @param {(id: string) => boolean} [knownIds] 判断某个 id 是不是**受管文档**（可选但强烈建议）
 * @returns {BasisDocRef|null} 引用；找不到合格的就返回 `null`
 */
export function basisDocOf(body, knownIds) {
  const text = String(body ?? '')
  const sections = parseHandoverSections(body)
  const acceptance = sections?.acceptance

  // 只看 §5。没有 §5 就没有可信的来源 —— 不退回全文扫。
  const scope = acceptance !== undefined && acceptance.found === true
    ? String(acceptance.text ?? '')
    : ''

  if (scope === '') return null

  const isKnown = typeof knownIds === 'function' ? knownIds : undefined

  // `\`xxx.md\`` 后面可选跟 `§1.2` / `#1.2` / `第二节`。
  const RE = /`([^`\n]+\.md)`\s*(?:[§#]\s*([0-9]+(?:\.[0-9]+)*)|(第[一二三四五六七八九十]+[节章]))?/g
  let match
  while ((match = RE.exec(scope)) !== null) {
    const rawId = match[1].trim()
    // 文档 id = 文件名去掉 `.md`，再去掉目录前缀。
    const base = rawId.replaceAll('\\', '/').split('/').pop() ?? rawId
    const id = base.replace(/\.md$/i, '')
    if (id === '') continue
    // ⚠️ 必须在注册表里（给了 knownIds 时）。`report` 是交付物，不该当依据。
    if (isKnown !== undefined && isKnown(id) !== true) continue
    const section = (match[2] ?? match[3] ?? '').trim()
    return { id, section, fingerprint: '' }
  }

  return null
}

/**
 * 把 `basisDoc` 的指纹补上（真源是注册表里那份文档的指纹）。
 *
 * **只在 id 能在注册表里找到时才补**；找不到就保持空串 ——
 * 那意味着"交接文档引用的那份文档不存在"，UI 会显示没有指纹的引用，
 * 而**不会**显示一个编造的指纹。
 *
 * @param {BasisDocRef|null} ref `basisDocOf` 的产物
 * @param {(id: string) => string} [fingerprintOf] 取某 id 当前指纹的函数
 * @returns {BasisDocRef|null} 补好指纹的引用；`ref` 为 null 时返回 null
 */
export function withFingerprint(ref, fingerprintOf) {
  if (ref === null) return null
  if (typeof fingerprintOf !== 'function') return ref
  let fingerprint = ''
  try {
    fingerprint = fingerprintOf(ref.id)
  } catch {
    fingerprint = ''
  }
  return { ...ref, fingerprint: typeof fingerprint === 'string' ? fingerprint : '' }
}

/**
 * 一次取齐两个字段（`index.js` 的装配点调这个）。
 *
 * @param {string} body 交接文档正文（通常是 `role: handover` 且 `order` 最小的那份）
 * @param {(id: string) => string} [fingerprintOf] 取指纹的函数（可选）
 * @param {(id: string) => boolean} [knownIds] 判断 id 是不是受管文档（可选但强烈建议）
 * @returns {{nextStep: string, basisDoc: BasisDocRef|null}} 两个都可能为空
 */
export function handoverPointersOf(body, fingerprintOf, knownIds) {
  return {
    nextStep: nextStepOf(body),
    basisDoc: withFingerprint(basisDocOf(body, knownIds), fingerprintOf),
  }
}

/**
 * 选**该读哪份交接文档**：`role: handover` 里 `order` 最小的那份。
 *
 * 与 `handoverMinOrder` 同一口径（只认 `role: handover`），
 * 但这里要的是**整条**（要读它的正文），所以返回 entry 而不是 order。
 *
 * ⚠️ 多份同 order 时按 id 字典序取第一个 —— 保证**稳定**
 * （同一份输入永远同一份输出）。
 *
 * @param {unknown} entries 注册表条目
 * @returns {object|undefined} 那份 entry；没有交接文档时返回 undefined
 */
export function primaryHandoverOf(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter((entry) => (
    entry?.meta?.role === 'handover' && typeof entry?.meta?.id === 'string' && entry.meta.id !== ''
  ))
  if (list.length === 0) return undefined

  const orderOf = (entry) => (
    typeof entry?.meta?.order === 'number' && Number.isFinite(entry.meta.order)
      ? entry.meta.order
      : Number.MAX_SAFE_INTEGER
  )

  return [...list].sort((a, b) => (
    orderOf(a) - orderOf(b) || String(a.meta.id).localeCompare(String(b.meta.id))
  ))[0]
}

/** 供调用方复用（避免再从 handover.js import 一次）。 */
export { splitSections }

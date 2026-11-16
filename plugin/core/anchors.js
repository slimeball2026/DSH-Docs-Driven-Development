/**
 * 「已验证锚点」字段的双名读取（M1.5 / **N3**）。
 *
 * **纯函数，零 IO / 零时间 / 零随机。**
 *
 * ---- 这个文件为什么存在 ----
 *
 * 同一个判据（"这份文档声明的环境锚点，与当前环境一致吗"）在**两个地方**都要用：
 *   - `docs/schema.js` 的 **V9**（扫描期，进 `anomalies`）；
 *   - `core/health.js` 的 **H-4**（`doc_health` 工具）。
 *
 * 而分层约束（`test/decoupling.test.js`）规定 **`core/` 不得依赖 `docs/`**，
 * 所以 `core/health.js` **不能** import `docs/schema.js` 的实现。
 *
 * 两处各写一份，正是 N3 这类"字段名不一致"最容易复发的形态
 * （M1 把 `verifiedAgainst` 拍平成 `verifiedDsh` 时，就是只有一处跟着改了）。
 * 所以共享实现放在 `core/`（依赖方向允许 `docs/ → core/`），两边都 import 它。
 *
 * ---- 为什么必须同时认两种形态（**这一条是跑出来的，不是设计出来的**）----
 *
 * 架构评审（"以此为准"）的附录 B1 与 §6 Q5 写的是：
 * ```
 * verifiedAgainst: { dsh: ..., bundle: ..., commit: ... }
 * ```
 * 实现却拍平成 `verifiedDsh` / `verifiedBundle` / `verifiedCommit` 三个平键。
 *
 * 后果（N3 的实测）：按架构评审写的文档，H-4 对它**永远静默通过** ——
 * 又一个"看起来严格但永远通过"。M1 已因同型问题被打回两次（H-3、H-4）。
 *
 * ⚠️ **真实数据形态与设计意图不同，这一点必须按实测写**：
 * 本插件的解析器**不支持块式嵌套**
 * （`verifiedAgainst:\n  dsh: ...` 直接报 `DOC_FM_UNSUPPORTED`），
 * 所以嵌套只能写成**流式 JSON** `verifiedAgainst: {"dsh":"0.0.1"}`。
 * 而 `docs/frontmatter.js` 对 `{...}` **没有专门分支**，它落到 CASE 1（标量），
 * 于是 `meta.verifiedAgainst` 是**字符串**，不是对象。
 *
 * 实测证据（`_m15/probe-n3.mjs`）：
 * ```
 * nested meta.verifiedAgainst = "{\"dsh\":\"0.0.1\",\"bundle\":\"0.0.1\",\"commit\":\"deadbee\"}"
 * nested: H-4 命中 0 条        ← 修 N3 之前
 * flat:   H-4 命中 3 条
 * ```
 *
 * 结论：**光看文档会以为它是对象，只有跑一遍才知道它是字符串。**
 * 所以这里三种形态都接。
 */

/**
 * 取一个「已验证锚点」的声明值。
 *
 * 查找顺序：
 *   1. 扁平字段（`verifiedDsh`）—— M1 的既有写法，**优先**（向后兼容）；
 *   2. 嵌套字段（`verifiedAgainst` 里的 `dsh`）—— 架构评审的写法；
 *      支持对象、JSON 字符串、数字三种形态。
 *
 * @param {object|null} meta frontmatter
 * @param {string} field 扁平字段名（如 `verifiedDsh`）
 * @param {string} shortName 嵌套里的键名（如 `dsh`）
 * @returns {string | undefined} 拿不到 / 解析不了 → undefined（**不猜**）
 */
export function declaredAnchorOf(meta, field, shortName) {
  if (meta === null || typeof meta !== 'object') return undefined

  const flat = meta[field]
  if (typeof flat === 'string' && flat !== '') return flat
  if (typeof flat === 'number' && Number.isFinite(flat)) return String(flat)

  const nested = meta.verifiedAgainst
  if (nested === null || nested === undefined) return undefined

  let record = nested
  if (typeof nested === 'string') {
    try {
      record = JSON.parse(nested)
    } catch {
      return undefined // 不是合法 JSON → 不猜
    }
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined

  const value = record[shortName]
  if (typeof value === 'string' && value !== '') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

/** 三个锚点的字段名对照表（两处判据共用，避免又各写一份）。 */
export const ANCHOR_FIELDS = Object.freeze([
  Object.freeze({ field: 'verifiedDsh', shortName: 'dsh', label: 'DSH 版本' }),
  Object.freeze({ field: 'verifiedBundle', shortName: 'bundle', label: '本插件版本' }),
  Object.freeze({ field: 'verifiedCommit', shortName: 'commit', label: 'git commit' }),
])

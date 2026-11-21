/** Registry → UI snapshot. No filesystem IO.
 * buildIndex supplies the complete valid reference directory and safety lists.
 * entryPointOf supplies the same current entry used by injection and AGENTS.
 * gate fields remain compatible reading statistics, not a global permission predicate.
 * generatedAt is UI freshness only and never enters model context.
 */

import { buildIndex } from '../core/index.js'
import { entryPointOf } from '../core/navigation.js'

/** 快照的 schema 版本。前端可以据此判断自己是不是在跟老 host 说话。 */
export const SNAPSHOT_VERSION = 1

/** 与 `core/roles.js` 的枚举保持一致（这里只用来排序，不用来校验）。 */
const ROLE_ORDER = Object.freeze([
  'index',
  'handover',
  'spec',
  'decision',
  'evidence',
  'instruction',
  'log',
  'fact',
])

/**
 * 角色在分组里的排序位。未知角色排在最后（不丢弃，只是排后面）。
 * @param {unknown} role
 * @returns {number}
 */
function roleRank(role) {
  const at = ROLE_ORDER.indexOf(/** @type {string} */ (role))
  return at < 0 ? ROLE_ORDER.length : at
}

/**
 * 安全取一个对象的字符串字段（不是字符串就给空串，不给占位）。
 * @param {unknown} value
 * @returns {string}
 */
function textOf(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * 把一条注册表条目折成 UI 需要的形状。
 *
 * ⚠️ **只取真源里有的字段**。`verifiedAt` 这类可能缺失的一律给 `null`，
 * 让 UI 知道"没有"而不是"是空字符串"。
 *
 * ⚠️ 「读过」的判据与 `core/render.js` 的 `readLines` 分支**逐字一致**：
 * 同一份 readSet + 指纹未变。这不是"UI 点了就算读" ——
 * readSet 是会话级的，只由 AI 的工具调用写入（R-5）。
 *
 * @param {object} entry 注册表条目
 * @param {Map<string, object>} readSet 该会话的已读集合
 * @param {(id: string) => string} [currentFingerprint] 取磁盘当前指纹
 * @returns {object}
 */
function entryShape(entry, readSet, currentFingerprint) {
  const meta = entry?.meta !== null && typeof entry?.meta === 'object' ? entry.meta : {}
  const id = textOf(meta.id)
  const record = id === '' ? undefined : readSet.get(id)
  // 与 render.js 同源：拿不到 currentFingerprint 就退回条目自带的指纹。
  const current = typeof currentFingerprint === 'function' ? currentFingerprint(id) : entry?.fingerprint

  return {
    id,
    role: textOf(meta.role),
    order: typeof meta.order === 'number' && Number.isFinite(meta.order) ? meta.order : null,
    status: textOf(meta.status),
    summary: textOf(meta.summary),
    title: textOf(meta.title),
    fingerprint: textOf(current),
    read: record !== undefined && record !== null && record.fingerprint === current,
    verifiedAt: textOf(meta.verifiedAt) === '' ? null : textOf(meta.verifiedAt),
    hasError: entry?.hasError === true,
  }
}

/**
 * 折成 §4.2 的快照。
 *
 * @param {object} input
 * @param {object[]} [input.entries] 注册表条目（`registry.entries`）
 * @param {Map<string, object>} [input.readSet] **该会话**的已读集合（`registry.readSetFor(session)`）
 * @param {(id: string) => string} [input.currentFingerprint] 取磁盘当前指纹
 * @param {string} input.sessionId **必需**：readSet 与预览地址都依赖它
 * @param {string} [input.projectRoot]
 * @param {number} [input.generatedAt] 只给 UI 判新鲜度，**不进索引块**
 * @param {object} [input.budget] `computeBudget()` 的结果（**字段是 `over`**）
 * @param {object[]} [input.deliverables]
 * @param {object[]} [input.graveyardCandidates]
 * @param {object[]} [input.graveyard]
 * @param {string} [input.project] = 【项目】行
 * @param {string} [input.slice] = 【施工】行（拿不到就空串）
 * @param {string} [input.nextStep]
 * @param {object|null} [input.basisDoc]
 * @returns {object}
 */
export function buildSnapshot(input) {
  const opts = input !== null && typeof input === 'object' ? input : {}
  const entries = Array.isArray(opts.entries) ? opts.entries : []
  const sessionId = textOf(opts.sessionId)
  const currentFingerprint = typeof opts.currentFingerprint === 'function'
    ? opts.currentFingerprint
    : undefined

  // 拿不到 sessionId 时**不编**一个假 id：`sessionId: ''` 让前端能明确判断
  // "这个 host 没给我会话"，而不是以为自己在看一个真实会话。
  const readSet = opts.readSet instanceof Map ? opts.readSet : new Map()

  // ⚠️ 三份清单**全部来自同一个真源函数**（与 `core/render.js` 同一个）。
  const index = buildIndex(entries)

  const requiredShaped = index.required
    .map((entry) => entryShape(entry, readSet, currentFingerprint))
    .filter((item) => item.id !== '')

  const readCount = requiredShaped.filter((item) => item.read === true).length
  const entryPoint = entryPointOf(entries)

  // 全量条目（图谱用）：按 role 分组、组内按 order 升序（SPEC §6.3）。
  // `unmanaged` 不进（它不受管，图谱里显示它只会制造噪音）。
  const all = entries
    .filter((entry) => entry?.unmanaged !== true && entry?.inGraveyard !== true)
    .map((entry) => entryShape(entry, readSet, currentFingerprint))
    .filter((item) => item.id !== '')
    .sort((a, b) => (
      roleRank(a.role) - roleRank(b.role)
      || (a.order ?? 0) - (b.order ?? 0)
      || a.id.localeCompare(b.id)
    ))

  // 禁止清单：**直接用 buildIndex 的结果**（它已经处理了 sealed 的优先级）。
  const forbidden = index.forbidden
    .map((entry) => {
      const shaped = entryShape(entry, readSet, currentFingerprint)
      return { id: shaped.id, summary: shaped.summary }
    })
    .filter((item) => item.id !== '')

  // 文档异常：同样用 buildIndex 的结果，文案取法与 `core/render.js` 一致
  // （第一条 level=error 的 message；没有就「元数据不合法」）。
  const anomalies = index.anomalies
    .map((entry) => {
      const shaped = entryShape(entry, readSet, currentFingerprint)
      const issues = Array.isArray(entry?.issues) ? entry.issues : []
      const first = issues.find((item) => item?.level === 'error')
      return {
        id: shaped.id,
        message: textOf(first?.message) === '' ? '元数据不合法' : textOf(first.message),
      }
    })
    .filter((item) => item.id !== '')

  const budgetRaw = opts.budget !== null && typeof opts.budget === 'object' ? opts.budget : null

  return {
    ok: true,
    version: SNAPSHOT_VERSION,
    projectRoot: textOf(opts.projectRoot),
    sessionId,
    // ⚠️ 只给 UI 判新鲜度。**这个字段绝不能进索引块**（M0-5）。
    generatedAt: typeof opts.generatedAt === 'number' && Number.isFinite(opts.generatedAt)
      ? opts.generatedAt
      : Date.now(),
    gate: {
      read: readCount,
      required: requiredShaped.length,
      ready: requiredShaped.length > 0 && readCount >= requiredShaped.length,
    },
    // 三个"取不到就空"的字段：**不猜**。
    project: textOf(opts.project),
    slice: textOf(opts.slice),
    nextStep: textOf(opts.nextStep),
    basisDoc: opts.basisDoc !== null && typeof opts.basisDoc === 'object'
      ? {
        id: textOf(opts.basisDoc.id),
        section: textOf(opts.basisDoc.section),
        fingerprint: textOf(opts.basisDoc.fingerprint),
      }
      : null,
    // ⚠️ `over`，不是 `overflow`（SPEC §4.2 订正 1）。
    budget: budgetRaw === null
      ? null
      : {
        required: typeof budgetRaw.count === 'number' ? budgetRaw.count : 0,
        tokens: typeof budgetRaw.tokens === 'number' ? budgetRaw.tokens : 0,
        limit: typeof budgetRaw.limit === 'number' ? budgetRaw.limit : 0,
        over: budgetRaw.over === true,
        overBy: typeof budgetRaw.overBy === 'number' ? budgetRaw.overBy : 0,
      },
    entryPoint: entryPoint ? entryShape(entryPoint, readSet, currentFingerprint) : null,
    navigationNotice: '实时目录为准；旧磁盘阅读清单可能过时。按任务选择依据，不要求先读完整个目录。',
    required: requiredShaped,
    all,
    forbidden,
    anomalies,
    deliverables: Array.isArray(opts.deliverables) ? opts.deliverables : [],
    graveyardCandidates: Array.isArray(opts.graveyardCandidates) ? opts.graveyardCandidates : [],
    graveyard: Array.isArray(opts.graveyard) ? opts.graveyard : [],
  }
}

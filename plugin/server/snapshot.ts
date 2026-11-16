/**
 * 注册表 → UI 快照（**纯函数**）。
 *
 * ---- 这个文件为什么是纯函数 ----
 *
 * SPEC §5.3-2：它必须是纯函数，才能进 `node --test`、不需要起 HTTP。
 * 于是 UI 的数据来源可以在**没有浏览器、没有 webServer、没有会话**的情况下被单测钉住。
 *
 * ---- 最重要的设计决定：**不复制判据，import 真源** ----
 *
 * 我第一版在这里**抄了一份**「必读 = handover + index」的判据。那是错的：
 *
 * 1. `core/index.js` 的 `buildIndex()` 才是真源 —— 它同时决定了
 *    required / forbidden / anomalies 三份清单，而且带**四条规则**
 *    （有 error 的进 anomalies 不进 required、`sealed` 进 forbidden、
 *    `unmanaged` 进不了任何清单、只有 `authoritative`/`partial` 才可执行）。
 * 2. 抄一份等于**埋一个静默漂移点**：那边一改，看板就和索引块对不上，
 *    而 M2-2 的判据恰恰是「看板的必读进度 = 索引块的 `【门禁】N/M`」。
 *    两边不同源，这条判据迟早会假绿。
 * 3. SPEC §8 开头写得很清楚：**M2 的每一条数据都要能追到它的真源**。
 *
 * 所以这里直接 `buildIndex(entries)`，与 `core/render.js` 用的是**同一个函数**。
 *
 * ---- 三条纪律（都是踩过的坑）----
 *
 * 1. **字段名是 `over`，不是 `overflow`**（SPEC §4.2 订正 1）。
 *    `core/budget.js` 返回的是 `over`。照第一版 SPEC 写会读到一个永远 `undefined`
 *    的字段 —— 症状是**看板永远不报警**，而且不报错。
 *
 * 2. **`sessionId` 是必需参数**（SPEC §4.2 订正 2）。
 *    `gate.read` 来自**会话级** readSet（`adapters/registry.js` 的 `readSetFor(session)`），
 *    预览地址也要它。缺了它，M2-A 和 M2-B 都会坏，而且**坏得很安静**。
 *
 * 3. **拿不到真源就留空，不猜**（交接 §8 的最后一句话）。
 *    `nextStep` / `basisDoc` / `slice` 取不到时给空串或 `null`，
 *    **绝不**编一个"看起来合理"的值。UI 显示空，比显示一个猜的数字好。
 *
 * ---- 它不许做什么 ----
 *
 * - 不许 import 任何 `node:` 内置模块（SPEC §5.3-3，`decoupling.test.js` 会查）；
 * - 不许有副作用（不读盘）；
 * - **不许进 `context()`**。它只喂 HTTP。索引块是另一条通道（M0-5 红线）。
 */

import { buildIndex } from '../core/index.js'

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
    required: requiredShaped,
    all,
    forbidden,
    anomalies,
    deliverables: Array.isArray(opts.deliverables) ? opts.deliverables : [],
    graveyardCandidates: Array.isArray(opts.graveyardCandidates) ? opts.graveyardCandidates : [],
    graveyard: Array.isArray(opts.graveyard) ? opts.graveyard : [],
  }
}

/**
 * 字段表 + V1–V10 校验（SPEC §5.2 / §5.3 / §5.4）。
 *
 * **纯函数，零 IO。** 输入是 frontmatter 的 `meta` 与原文字符串，输出是问题列表。
 *
 * 最关键的一条语义（SPEC §5.4，别搞错）：
 *
 * > **error 不阻塞读取，只阻塞"用它当依据"。**
 *
 * 理由：文档写坏了不该让整个插件瘫掉；但也不能让坏文档静默参与决策。
 * 所以读得到（模型能看见），进不了索引（不在必读清单里），并在索引块里报一行异常。
 * 因此本模块**只产出问题、不做裁决**——裁决在 `core/index.js`。
 */

// M1.5 / N3：锚点字段的双名读取。实现在 `core/anchors.js`（两处判据共用一份，
// 避免"一个改了另一个没改"——那正是 N3 的成因）。分层方向允许：docs/ → core/。
import { ANCHOR_FIELDS, declaredAnchorOf } from '../core/anchors.js'

/** role 封闭枚举，8 个（SPEC §5.3）。 */
export const ROLES = Object.freeze([
  'index',
  'spec',
  'decision',
  'evidence',
  'log',
  'handover',
  'instruction',
  'fact',
])

/** status 封闭枚举，6 个、互斥（SPEC §5.3）。 */
export const STATUSES = Object.freeze([
  'authoritative',
  'partial',
  'superseded',
  'sealed',
  'void',
  'draft',
])

/** basis 封闭枚举。 */
export const BASES = Object.freeze(['实测', '推断', '未验证'])

/** 必填字段（V1）。 */
export const REQUIRED_FIELDS = Object.freeze(['id', 'title', 'role', 'order', 'status', 'summary'])

/** `summary` 的长度上限（SPEC §5.2：≤80 字）。 */
export const SUMMARY_MAX_CHARS = 80

/** 校验级别。 */
export const LEVEL_ERROR = 'error'
export const LEVEL_WARN = 'warn'

/** id 的格式：kebab-case。 */
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * `verifiedAt` 认的日期形态（M1.5 / **D4**）。
 *
 * **只认 `YYYY-MM-DD`**，不认完整 ISO 时间戳：
 * H8 要拿它跟"交接的创建时间"比，而文档的"上次验证时间"不需要精确到秒。
 * 只认到日 → 比较时按日粒度 → 没有"同一天算不算过期"的边界扯皮。
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 生成一条问题。
 * @param {string} rule V1–V10
 * @param {'error'|'warn'} level
 * @param {string} message 面向模型的中文说明
 * @returns {{rule: string, level: string, message: string}}
 */
function issue(rule, level, message) {
  return { rule, level, message }
}

/** 值是不是非空数组。 */
function isNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0
}

/** 取数组里的字符串项（非字符串项忽略）。 */
function stringsOf(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '') : []
}

/**
 * 校验单份文档的元数据。
 *
 * @param {object|null} meta 解析出的 frontmatter（坏文档传 null）。
 * @param {object} [context]
 * @param {string} [context.body] 正文，用来做 V7 的锚点检查。
 * @param {Set<string>|string[]} [context.knownIds] 全项目已知 id，用来做 V5。
 * @param {Map<string, number>|object} [context.idCounts] 每个 id 出现次数，用来做 V6。
 * @param {string} [context.selfId] 本文档自己的 id（V5/V6 要排除自己）。
 * @param {object} [context.anchors] 命名空间：{ dsh?, bundle?, commit? } 当前环境锚点，V9 用。
 * @returns {{issues: Array<{rule: string, level: string, message: string}>,
 *            hasError: boolean, fields: object|null}}
 */
export function validateMeta(meta, context = {}) {
  const issues = []
  // 解析阶段就失败（DOC_FM_UNSUPPORTED）——按 V1 的同类处理：不能进索引。
  if (meta === null || typeof meta !== 'object') {
    issues.push(issue('V1', LEVEL_ERROR, '缺少可解析的 frontmatter 块'))
    return { issues, hasError: true, fields: null }
  }

  // ---- V1 必填字段缺失
  for (const field of REQUIRED_FIELDS) {
    const value = meta[field]
    if (value === undefined || value === null || value === '') {
      issues.push(issue('V1', LEVEL_ERROR, `缺少 ${field} 字段`))
    }
  }

  // ---- V2 枚举
  const role = meta.role
  if (role !== undefined && role !== null && !ROLES.includes(role)) {
    issues.push(issue('V2', LEVEL_ERROR, `role 不在枚举内：${String(role)}（允许：${ROLES.join(' / ')}）`))
  }
  const status = meta.status
  if (status !== undefined && status !== null && !STATUSES.includes(status)) {
    issues.push(issue('V2', LEVEL_ERROR, `status 不在枚举内：${String(status)}（允许：${STATUSES.join(' / ')}）`))
  }
  const basis = meta.basis
  if (basis !== undefined && basis !== null && !BASES.includes(basis)) {
    issues.push(issue('V2', LEVEL_ERROR, `basis 不在枚举内：${String(basis)}（允许：${BASES.join(' / ')}）`))
  }

  // ---- id 格式（V1 的延伸：有值但格式坏，同样是 error）
  //
  // ---- 2026-11-15 M2.7：**`id` 必须是字符串，否则文档会静默"半活着"** ----
  //
  // 缺陷（`session-4f229c6b`，用户报「ai 虽然建了文件，但右侧图谱里根本没有它们」）：
  //
  //   1. AI 用 `doc_new` 建了 `docs/1.md`，传的 `id` 是**字符串** `"1"`；
  //   2. 写盘后 frontmatter 是 `id: 1`（YAML 字面量）；
  //   3. 重扫读回来，`parseFrontmatter` 按通用 YAML 语义把它解析成**数字** `1`
  //      （`docs/frontmatter.js` 的 `NUMBER_RE`，那个行为本身是对的）；
  //   4. 于是 `entry.meta.id === "1"` 恒为 false →
  //      `entryById("1")` 找不到、索引块里没有它、图谱里没有它、
  //      `doc_new` 的 `indexed` 判定为 false（报"重扫失败"）。
  //
  // **最坏的地方是它完全静默**：修之前 `typeof id === 'string'` 这个前置条件
  // 让整条校验被**跳过**，于是没有 error、没有 warn、不进 anomalies ——
  // 文件躺在 `docs/` 里，注册表里也有这个条目，但**所有按 id 的查找全部失效**。
  //
  // ⇒ 修法：id 不是字符串就是 **error**。这是硬约束：
  //    id 是「永不变的引用锚点」（`doc_new` 的注释里写了），
  //    锚点一旦是数字，引用它的文档全部指向一个不存在的 id。
  //
  // ⚠️ 为什么不在 `frontmatter.js` 里把数字 id 转成字符串：
  //    那是**通用 YAML 解析器**，`order: 20` 必须解析成数字。
  //    按字段名特判（id 转字符串、order 转数字）会把"通用解析"变成"业务解析"，
  //    以后加一个数字字段就得改一次解析器。**校验层才是对的落点。**
  const id = meta.id
  if (id !== undefined && id !== null && id !== '' && typeof id !== 'string') {
    issues.push(issue(
      'V1',
      LEVEL_ERROR,
      `id 必须是字符串，现在是 ${typeof id}（${JSON.stringify(id)}）。`
        + `把 frontmatter 里那行改成 \`id: "${String(id)}"\`（加引号），`
        + '否则所有按 id 的查找都会失效（索引块、图谱、门禁全都找不到它）。',
    ))
  } else if (typeof id === 'string' && id !== '' && !ID_RE.test(id)) {
    issues.push(issue('V1', LEVEL_ERROR, `id 不是 kebab-case：${id}`))
  }

  // ---- order 必须是有限数
  if (meta.order !== undefined && meta.order !== null) {
    if (typeof meta.order !== 'number' || !Number.isFinite(meta.order)) {
      issues.push(issue('V1', LEVEL_ERROR, `order 必须是有限数：${String(meta.order)}`))
    }
  }

  // ---- V3 superseded 必须有 supersededBy
  if (status === 'superseded' && !isNonEmptyArray(meta.supersededBy)) {
    issues.push(issue('V3', LEVEL_ERROR, 'status: superseded 但 supersededBy 为空'))
  }

  // ---- V4 partial 必须有 scope
  if (status === 'partial' && !isNonEmptyArray(meta.scope)) {
    issues.push(issue('V4', LEVEL_ERROR, 'status: partial 但 scope 为空'))
  }

  // ---- V5 supersedes / supersededBy 指向不存在的 id
  const known = context.knownIds === undefined ? undefined : new Set(context.knownIds)
  if (known !== undefined) {
    for (const field of ['supersedes', 'supersededBy']) {
      for (const target of stringsOf(meta[field])) {
        // `spec-tier1#13` 这种带锚点的引用，只校验 `#` 之前的 id。
        const baseId = target.split('#')[0]
        if (baseId === '' || baseId === context.selfId) continue
        if (!known.has(baseId)) {
          // supersedes is historical: archived predecessors leave the active scan.
          // Missing a forward replacement still makes the declared successor unusable.
          const level = field === 'supersedes' ? LEVEL_WARN : LEVEL_ERROR
          issues.push(issue('V5', level, field === 'supersedes'
            ? `supersedes 引用的历史 id 不在当前目录（可能已归档）：${target}`
            : `${field} 指向不存在的 id：${target}`))
        }
      }
    }
  }

  // ---- V6 id 重复
  const counts = context.idCounts
  if (counts !== undefined && typeof id === 'string' && id !== '') {
    const count = typeof counts.get === 'function' ? counts.get(id) : counts[id]
    if (typeof count === 'number' && count > 1) {
      issues.push(issue('V6', LEVEL_ERROR, `id 重复：${id}（全项目出现 ${count} 次）`))
    }
  }

  // ---- V7 sections[].anchor 在正文里找不到对应标题
  const body = context.body
  if (typeof body === 'string' && Array.isArray(meta.sections)) {
    for (const section of meta.sections) {
      if (section === null || typeof section !== 'object') continue
      const anchor = section.anchor
      if (typeof anchor !== 'string' || anchor === '' || !anchor.startsWith('#')) continue
      if (!bodyHasAnchor(body, anchor)) {
        issues.push(issue('V7', LEVEL_WARN, `sections 里的锚点 ${anchor} 在正文里找不到对应标题`))
      }
    }
  }

  // ---- V8 supersededBy 未反填（对方没有 supersedes 我）
  // M0 只在能查到对方元数据时判；查不到就不报（避免误报）。
  if (Array.isArray(context.metaById) && typeof id === 'string') {
    for (const target of stringsOf(meta.supersededBy)) {
      const baseId = target.split('#')[0]
      const other = context.metaById.find((item) => item?.meta?.id === baseId)
      if (other === undefined) continue
      const backrefs = stringsOf(other.meta.supersedes)
      if (!backrefs.some((ref) => ref.split('#')[0] === id)) {
        issues.push(issue('V8', LEVEL_WARN, `${other.meta.id} 没有在 supersedes 里反填 ${id}`))
      }
    }
  }

  // ---- V12 `verifiedAt`（M1.5 / **D4**）：可选 date 字段
  //
  // 语义：「这份文档上一次被**人工/实测**确认是对的时间」。
  // 它**不是必填**（`REQUIRED_FIELDS` 里没有它）—— 强制要求会让所有现存文档立刻变 error，
  // 那是方案 A 的代价（`P13` 已否决过同类做法）。
  //
  // 格式只认 `YYYY-MM-DD`（**不认**完整 ISO 时间戳）：因为 H8 要拿它跟
  // 「交接的创建时间」比，而文档不会精确到秒。只认到日，比较时按日粒度，
  // 避免"同一天算不算过期"的边界扯皮。
  //
  // 级别：**warn 不是 error**。写错日期不该把文档踢出必读清单（§5.4 的原则：
  // error 只用于"这份文档不能当依据"，而日期写错不影响它作为依据）。
  const verifiedAt = meta.verifiedAt
  if (verifiedAt !== undefined && verifiedAt !== null && verifiedAt !== '') {
    if (typeof verifiedAt !== 'string' || !DATE_RE.test(verifiedAt)) {
      issues.push(issue(
        'V12',
        LEVEL_WARN,
        `verifiedAt 格式不对：${String(verifiedAt)}（应当是 YYYY-MM-DD，例如 2026-11-12）`,
      ))
    } else {
      const stamp = Date.parse(`${verifiedAt}T00:00:00Z`)
      if (!Number.isFinite(stamp)) {
        issues.push(issue('V12', LEVEL_WARN, `verifiedAt 不是一个真实日期：${verifiedAt}`))
      }
    }
  }

  // ---- V9 锚点漂移：只 warn，**绝不自动改 status**（Q5 = D）
  //
  // ⚠️ **M1.5 / N3：这里原来只认扁平字段名，与架构评审（"以此为准"）不一致。**
  //
  // 架构评审的附录 B1 与 §6 Q5 写的是 `verifiedAgainst: { dsh, bundle, commit }`，
  // 而实现拍平成 `verifiedDsh` / `verifiedBundle` / `verifiedCommit` 三个平键，
  // **且 README 的"十处订正"里没有这一条**（评审者的 C4：README 里一次都没出现过
  // `verifiedAgainst` —— 不是"忘了写订正"，是"连偏离都没被承认过"）。
  //
  // 后果：任何**按架构评审写的文档**，H-4 对它**永远静默通过** ——
  // 又一个"看起来严格但永远通过"。M1 已经因为这个毛病被打回两次（H-3、H-4 各一次）。
  //
  // 修法：**两个名字都认**（向后兼容）。
  //
  // ⚠️ 一个必须说清的细节：本插件的解析器**不支持块式嵌套**
  // （`verifiedAgainst:\n  dsh: ...` 会报 `DOC_FM_UNSUPPORTED`）。
  // 所以嵌套写法只能写成**流式 JSON**：
  //   `verifiedAgainst: {"dsh":"0.0.1","bundle":"0.0.1","commit":"deadbee"}`
  // 而 `docs/frontmatter.js` 对 `{...}` **没有专门分支**，它落到 CASE 1（标量），
  // 于是 `meta.verifiedAgainst` 是**字符串**而不是对象（实测见 `_m15/probe-n3.mjs`）。
  //
  // 所以这里必须**同时**接受两种形态：
  //   - 对象（如果将来解析器支持了）；
  //   - 字符串（现在是这个）→ 先 `JSON.parse` 再取键。
  //
  // 这就是"判据要按**真实数据形态**写，而不是按**设计意图**写"——
  // 只看文档会以为它是对象，只有跑一遍才知道它是字符串。
  const anchors = context.anchors
  if (anchors !== null && typeof anchors === 'object') {
    for (const { field, shortName, label } of ANCHOR_FIELDS) {
      const claimed = declaredAnchorOf(meta, field, shortName)
      if (claimed === undefined) continue
      const current = anchors[shortName]
      if (typeof current !== 'string' || current === '') continue
      if (claimed !== current) {
        issues.push(issue('V9', LEVEL_WARN, `verified 锚点与当前环境不符：${label} 记录的是 ${claimed}，当前是 ${current}`))
      }
    }
  }

  // ---- summary 长度（V1 的延伸；超长只 warn，不拦）
  if (typeof meta.summary === 'string' && [...meta.summary].length > SUMMARY_MAX_CHARS) {
    issues.push(issue('V1', LEVEL_WARN, `summary 超过 ${SUMMARY_MAX_CHARS} 字，索引块会很长`))
  }

  const hasError = issues.some((item) => item.level === LEVEL_ERROR)
  return { issues, hasError, fields: meta }
}

/**
 * 正文里是否存在与锚点对应的标题。
 *
 * 只做保守匹配：`#` 后接 `/` 的斜杠式锚点按标题文本匹配，
 * 其余按 Markdown 标题行里是否出现该锚点文本匹配。宁可漏报，不可乱报。
 *
 * @param {string} body
 * @param {string} anchor 形如 `#7` 或 `#施工顺序`
 * @returns {boolean}
 */
export function bodyHasAnchor(body, anchor) {
  const needle = anchor.replace(/^#+/, '').trim()
  if (needle === '') return true
  const headings = body
    .split(/\r?\n/)
    .filter((line) => /^\s{0,3}#{1,6}\s/.test(line))
    .map((line) => line.replace(/^\s{0,3}#{1,6}\s*/, '').trim())

  // `/^\d+$/` 这种数字锚点更可能是「第 N 节」，用宽松匹配：标题里出现该数字即可。
  return headings.some((heading) => heading.includes(needle))
}

/**
 * 统计 id 出现次数（给 V6 用）。
 * @param {Array<{meta: object|null}>} metas
 * @returns {Map<string, number>}
 */
export function countIds(metas) {
  const counts = new Map()
  for (const item of Array.isArray(metas) ? metas : []) {
    const id = item?.meta?.id
    if (typeof id !== 'string' || id === '') continue
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return counts
}

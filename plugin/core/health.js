/**
 * 文档健康度自检（M1-D，SPEC-M1 §6）。
 *
 * **纯函数，零 IO / 零时间 / 零随机 / 不 import 任何内置模块。**
 *
 * ⚠️ 只 import 同目录的模块（分层约束）：`./anchors.js` 是 M1.5 抽出来的共享实现。
 *
 * ---- 五项检查，以及为什么是这五项（M1-Q5）----
 * 挑的标准是**每条都要有真实案例，且能用现有数据结构判定**。
 * 从架构评审 §3.6 的 9 项里砍掉的：
 *   - 「冷启动预算超限」→ 挪到索引块（M1-E），它是**成本**不是**健康度**；
 *   - 「文档内部数字是否一致」「关键数字多处不一致」→ **不可靠**。
 *     文本里的数字一致性判断必然误报，**没有可证伪的判据**。
 *
 * ---- H-3 为什么被我重定义（README 订正清单第 3 条）----
 * SPEC 原文：「孤儿文档 = `authoritative` 但不在必读清单」。
 * 但 `core/index.js` 的 `buildIndex()` 会把**所有无 error 的 authoritative/partial**
 * 都放进必读清单 —— 所以「authoritative 且不在必读」只可能发生在**有 error** 的文档上，
 * 而那时真正的归因是「元数据坏了」，不是「孤儿」。
 * 实测 dogfood 命中 0，且**构造不出合法反例** —— 这是典型的
 * 「看起来严格但永远通过」，正是交接 §9 警告的那类错误。
 *
 * 重定义成「**不可达**」：`authoritative`，既不在必读清单里，**也没有被任何
 * `role: index` 的文档提到**。这可证伪、能造反例（一份谁都没提的 authoritative 文档），
 * 而且它问的是一个真问题：**这份权威文档，读者怎么知道它存在？**
 *
 * ---- H-5 是我认为最该有的一条 ----
 * M0 的 `basis` 字段**只被解析、从未被使用**。一个填了却没人看的字段，等于没填。
 */

import { ANCHOR_FIELDS, declaredAnchorOf } from './anchors.js'

/** 检查级别。 */
export const HEALTH_ERROR = 'error'
export const HEALTH_WARN = 'warn'

/** 五项检查的元信息（工具层用来渲染说明，测试用来断言"五项都在"）。 */
export const HEALTH_RULES = Object.freeze([
  {
    rule: 'H-1',
    level: HEALTH_WARN,
    title: 'supersededBy 未反填',
    detail: 'A.supersededBy 含 B，但 B.supersedes 不含 A',
  },
  {
    rule: 'H-2',
    level: HEALTH_WARN,
    title: 'superseded 链断掉或成环',
    detail: '顺着 supersededBy 走，走不到一个非 superseded 的文档；或回到起点',
  },
  {
    rule: 'H-3',
    level: HEALTH_WARN,
    title: '不可达的权威文档',
    detail: 'authoritative 但不在必读清单，也没被任何 role: index 的文档提到',
  },
  {
    rule: 'H-4',
    level: HEALTH_WARN,
    title: 'verified 锚点与当前环境不符',
    detail: 'V9 已有，这里汇总成一条',
  },
  {
    rule: 'H-5',
    level: HEALTH_WARN,
    title: 'basis 与 status 自相矛盾',
    detail: 'basis: 未验证 但 status: authoritative',
  },
])

/** 把值安全地当字符串数组用。 */
function stringsOf(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '') : []
}

/** 去掉 `id#anchor` 里的锚点部分。 */
function baseIdOf(reference) {
  return String(reference).split('#')[0]
}

/**
 * 判断一条 `role: index` 的文档是否「提到」了某个 id。
 *
 * 三种写法都算提到（真实索引文档的三种常见写法）：
 *   1. 直接写 id：`read-order`
 *   2. 写文件名：`00. 阅读顺序.md`（dogfood 的 `read-order` 就是这么被引用的）
 *   3. 写标题：`# 00 · 阅读顺序（档 2 施工者从这里开始）` 里的标题文本
 *
 * 这是**宽松匹配**，刻意的：H-3 要抓的是"谁都没提"，不是"提得不够显眼"。
 *
 * @param {string} text 索引文档的正文
 * @param {{id: string, title?: string, fileName?: string}} target
 * @returns {boolean}
 */
export function mentionsDoc(text, target) {
  const body = typeof text === 'string' ? text : ''
  if (body === '') return false
  const id = typeof target?.id === 'string' ? target.id : ''
  if (id !== '' && body.includes(id)) return true
  const fileName = typeof target?.fileName === 'string' ? target.fileName : ''
  if (fileName !== '' && body.includes(fileName)) return true
  const title = typeof target?.title === 'string' ? target.title.trim() : ''
  // 标题去掉开头的编号（`00 · ` / `13. `）再匹配，避免"提到编号"被当成"提到文档"。
  const stripped = title.replace(/^[\d.]+\s*[·.]?\s*/, '')
  if (stripped.length >= 4 && body.includes(stripped)) return true
  return false
}

/**
 * 跑五项检查。
 *
 * @param {object} input
 * @param {Array<object>} input.entries 全部注册表条目（含 unmanaged / 坏文档）
 * @param {Array<object>} [input.required] 必读清单（`buildIndex()` 的 required）；
 *        不给就从 entries 自己算（只认 authoritative/partial 且无 error）
 * @param {object} [input.anchors] 当前环境锚点 `{ dsh, bundle, commit }`（H-4 用）
 * @param {(path: string) => string} [input.fileNameOf] 由条目算文件名（H-3 用）
 * @returns {{ok: boolean, issues: Array<object>, stats: object}}
 */
export function checkHealth(input) {
  const opts = input !== null && typeof input === 'object' ? input : {}
  const entries = Array.isArray(opts.entries) ? opts.entries : []
  const anchors = opts.anchors !== null && typeof opts.anchors === 'object' ? opts.anchors : {}

  /** 只认「受管且能解析出 id」的条目；unmanaged（没有 frontmatter）不参与健康度。 */
  const managed = entries.filter((entry) => entry !== null
    && typeof entry === 'object'
    && entry.unmanaged !== true
    && typeof entry.meta?.id === 'string'
    && entry.meta.id !== '')

  const byId = new Map()
  for (const entry of managed) {
    // id 重复时保留第一个（V6 已经会报 error，健康度不重复报）。
    if (!byId.has(entry.meta.id)) byId.set(entry.meta.id, entry)
  }

  const required = Array.isArray(opts.required)
    ? opts.required
    : managed.filter((entry) => (entry.meta.status === 'authoritative' || entry.meta.status === 'partial')
      && entry.hasError !== true)

  const requiredIds = new Set(required.map((entry) => entry?.meta?.id).filter((id) => typeof id === 'string'))

  /** @type {Array<{rule: string, level: string, docId: string, message: string}>} */
  const issues = []
  const push = (rule, level, docId, message) => issues.push({ rule, level, docId, message })

  // ---------------------------------------------------------------- H-1 未反填
  for (const entry of managed) {
    const id = entry.meta.id
    // 去重：`supersededBy: ["b", "b#2"]` 是同一对 (A→B)，只报一条。
    const seenTargets = new Set()
    for (const reference of stringsOf(entry.meta.supersededBy)) {
      const targetId = baseIdOf(reference)
      if (targetId === '' || targetId === id) continue
      if (seenTargets.has(targetId)) continue
      seenTargets.add(targetId)
      const other = byId.get(targetId)
      if (other === undefined) continue // 指向不存在的 id 由 V5 报，不在这里重复
      const backrefs = stringsOf(other.meta.supersedes).map(baseIdOf)
      if (!backrefs.includes(id)) {
        push(
          'H-1',
          HEALTH_WARN,
          id,
          `${id} 声明被 ${targetId} 取代，但 ${targetId} 的 supersedes 里没有 ${id}（反填缺失）`,
        )
      }
    }
  }

  // ---------------------------------------------------------------- H-2 链断/成环
  //
  // 顺着 supersededBy 一直走，只有两种收尾算「正常」：
  //   ① 走到一个 **非 superseded** 的文档（有明确替代品）；
  //   ② 指向一个**不存在的 id**（V5 已经报过 error，这里不重复）。
  // 其余都算坏：没有 supersededBy、成环、自指、链过长。
  for (const entry of managed) {
    if (entry.meta.status !== 'superseded') continue
    const id = entry.meta.id
    const visited = new Set([id])
    let cursor = entry
    /** @type {string | undefined} */
    let reason

    for (let step = 0; step <= managed.length; step += 1) {
      const next = stringsOf(cursor.meta.supersededBy).map(baseIdOf).filter((item) => item !== '')[0]

      if (next === undefined) {
        reason = 'superseded 但没有 supersededBy（无法知道被谁取代）'
        break
      }
      if (visited.has(next)) {
        reason = next === id ? `supersededBy 指向自己（成环）` : `supersededBy 链回到 ${next}（成环）`
        break
      }
      const target = byId.get(next)
      if (target === undefined) {
        reason = undefined // 指向不存在的 id：V5 的职责，不重复报
        break
      }
      if (target.meta.status !== 'superseded') {
        reason = undefined // 走到了一个非 superseded 的文档 —— 正常
        break
      }
      visited.add(next)
      cursor = target
      // 走满整个 managed.size 还没收尾 → 链太长（防御性收尾，理论上被 visited 先挡住）
      if (step === managed.length - 1) {
        reason = `supersededBy 链超过 ${managed.length} 步仍未走到终点`
      }
    }

    if (reason !== undefined) push('H-2', HEALTH_WARN, id, `${id}：${reason}`)
  }

  // ---------------------------------------------------------------- H-3 不可达
  //
  // ⚠️ **这条被 A4 独立评审打回过一次，现在是第二版。**
  //
  // 第一版判据是「authoritative 但不在必读清单，也没被 role:index 提到」。
  // **它恒不触发**：`doc-health.js` 传进来的 `required` 就是 `buildIndex()` 的产物，
  // 而 `buildIndex` 把所有无 error 的 authoritative **都放进 required**（`core/index.js` 规则 3）。
  // 所以「authoritative 且不在 required」在生产路径上**永远为假** ——
  // 我在 SPEC 里批评过「看起来严格但永远通过」，然后自己又写了一条一模一样的。
  //
  // 单测为什么没抓到：`health.test.js` 手工传 `required: [indexDoc]`，
  // **绕开了 buildIndex**，测的是实现而不是接线。
  //
  // 第二版把「不在必读清单」这个**恒假**条件整个去掉，只留可证伪的那一半：
  // **`authoritative` 且没有任何 `role: index` 文档提到它**。
  // 这个条件在真实数据上会触发（谁都没提的权威文档 = 新会话不知道它存在），
  // 而且不依赖 `required` 怎么算。
  const indexDocs = managed.filter((entry) => entry.meta.role === 'index')
  const fileNameOf = typeof opts.fileNameOf === 'function'
    ? opts.fileNameOf
    : (entry) => String(entry?.path ?? '').split(/[\\/]/).pop() ?? ''

  // ---- D7（M1.5）：没有 `role: index` 文档时，**改报 warn**
  //
  // 修之前这条是**静默跳过**：`if (indexDocs.length === 0) continue` ——
  // H-3 整段不执行，而 `doc_health` 的输出看起来"一切正常"。
  //
  // 但"项目里一份 `role: index` 都没有"本身就是一个值得说的事实：
  // 新会话**没有入口索引**，它不知道该先读什么。那是 H-3 想抓的问题的**极端形态**，
  // 而不是"无法判定所以不用管"。
  //
  // 只报 **1 条**（不是每份 authoritative 报一次）—— 否则会把输出刷满，
  // 让人反而看不见真正的问题。
  if (indexDocs.length === 0 && managed.length > 0) {
    push(
      'H-3',
      HEALTH_WARN,
      '(项目)',
      `项目里没有任何 role: index 的文档（${managed.length} 份受管文档）。`
        + '新会话没有入口索引，不知道该先读哪一份 —— 建议建一份 role: index 的「阅读顺序」文档。',
    )
  }

  for (const entry of managed) {
    if (entry.meta.status !== 'authoritative') continue
    if (entry.hasError === true) continue // 有 error 的由 anomalies 报，归因不同
    if (entry.meta.role === 'index') continue // 索引文档本身是"入口"，不要求别人提它
    // ⚠️ 没有索引文档时不逐份报：那种情况由上面那条**项目级** warn 统一说明。
    // 否则 N 份 authoritative 会刷出 N 条一模一样的"没人提到它"，
    // 而真正的原因只有一条（根本没有入口索引）——噪音会把信号埋掉。
    if (indexDocs.length === 0) continue

    const target = {
      id: entry.meta.id,
      title: entry.meta.title,
      fileName: fileNameOf(entry),
    }
    const mentioned = indexDocs.some((doc) => mentionsDoc(doc.text ?? doc.body ?? '', target))
    if (!mentioned) {
      push(
        'H-3',
        HEALTH_WARN,
        entry.meta.id,
        `${entry.meta.id} 是 authoritative，但没有任何 role: index 的文档提到它`
          + `（现有索引：${indexDocs.map((doc) => doc.meta.id).join('、')}）—— 新会话不会知道它存在`,
      )
    }
  }

  // ---------------------------------------------------------------- H-4 锚点漂移
  //
  // ⚠️ **这条也被 A4 独立评审打回过。**
  // 第一版的判据没错，但 `index.js` 传进来的 `anchors` 里
  // `dsh` 与 `commit` **恒为 `undefined`**，于是：
  //
  // ```js
  // if (typeof current !== 'string' || current === '') continue   // ← 永远在这里 continue
  // ```
  //
  // 这两个锚点在生产路径上**从未被检查过** —— 是一段死分支。单测传了完整的
  // `anchors` 才过，同样绕开了接线。
  //
  // 修法分两层：
  //   1. **能判的照常判**（`verifiedBundle` 一直有效，因为 `BUNDLE_VERSION` 是常量）；
  //   2. **判不了的显式记账**：返回 `skipped` 列表，工具层把它渲染进输出，
  //      而不是静默跳过。**「静默跳过」正是这条被判"死分支"的原因。**
  //
  // ⚠️ **M1.5 / N3：字段名也要认两个。**
  // 架构评审（"以此为准"）的附录 B1 写的是 `verifiedAgainst: { dsh, bundle, commit }`，
  // 实现却只认扁平的 `verifiedDsh/...`，于是**按评审写的文档永远静默通过**。
  // 现在两个名字都认，实现在 `core/anchors.js`（与 `docs/schema.js` 的 V9 共用一份）。
  /** 因为"当前环境值未知"而跳过的锚点（去重，供工具层如实展示）。 */
  const skipped = []
  for (const entry of managed) {
    for (const { field, shortName, label } of ANCHOR_FIELDS) {
      const claimed = declaredAnchorOf(entry.meta, field, shortName)
      if (claimed === undefined) continue
      const current = anchors[shortName]
      if (typeof current !== 'string' || current === '') {
        // 文档声明了这个锚点，但我们不知道当前环境值 → **不能假装检查过**。
        if (!skipped.includes(`${field}（${label}）`)) skipped.push(`${field}（${label}）`)
        continue
      }
      if (claimed === current) continue
      push(
        'H-4',
        HEALTH_WARN,
        entry.meta.id,
        `${entry.meta.id} 的 ${field} 记的是 ${claimed}，当前是 ${current}（${label} 锚点漂移）`,
      )
    }
  }

  // ---------------------------------------------------------------- H-5 basis 矛盾
  for (const entry of managed) {
    if (entry.meta.basis !== '未验证') continue
    if (entry.meta.status !== 'authoritative') continue
    push(
      'H-5',
      HEALTH_WARN,
      entry.meta.id,
      `${entry.meta.id} 是 authoritative（会被当成依据），但 basis 是「未验证」。`
        + '要么去验证并改成「实测 / 推断」，要么把 status 降成 draft。',
    )
  }

  // ---------------------------------------------------------------- 排序（输出稳定）
  // error 优先，同级按 docId 字典序，再按 rule —— 保证同样输入永远同样输出，便于 diff。
  const levelRank = (level) => (level === HEALTH_ERROR ? 0 : 1)
  issues.sort((a, b) => (levelRank(a.level) - levelRank(b.level))
    || String(a.docId).localeCompare(String(b.docId))
    || String(a.rule).localeCompare(String(b.rule))
    || String(a.message).localeCompare(String(b.message)))

  return {
    ok: issues.filter((item) => item.level === HEALTH_ERROR).length === 0,
    issues,
    /** 因为"当前环境值未知"而**没能检查**的锚点（工具层必须如实展示，不能静默）。 */
    skipped,
    stats: {
      docs: managed.length,
      required: required.length,
      byRule: countByRule(issues),
      errors: issues.filter((item) => item.level === HEALTH_ERROR).length,
      warnings: issues.filter((item) => item.level === HEALTH_WARN).length,
    },
  }
}

/** 每条规则命中多少（给工具输出用；五项都在，即使为 0）。 */
function countByRule(issues) {
  /** @type {Record<string, number>} */
  const out = {}
  for (const spec of HEALTH_RULES) out[spec.rule] = 0
  for (const item of issues) {
    if (out[item.rule] === undefined) continue
    out[item.rule] += 1
  }
  return out
}

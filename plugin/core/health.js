/** Optional structural diagnostics: reference chains, discoverable entry and explicit environment anchors. Pure, read-only. */
import { ANCHOR_FIELDS, declaredAnchorOf } from './anchors.js'
import { entryPointOf } from './navigation.js'

/** 检查级别。 */
export const HEALTH_ERROR = 'error'
export const HEALTH_WARN = 'warn'

/** 四项检查的元信息（工具层用来渲染说明，测试用来断言"四项都在"）。 */
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
    title: '缺少有效接续入口',
    detail: '存在受管文档，但没有合法的已发布交接或有效 index 入口',
  },
  {
    rule: 'H-4',
    level: HEALTH_WARN,
    title: 'verified 锚点与当前环境不符',
    detail: 'V9 已有，这里汇总成一条',
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
 * 跑四项检查。
 *
 * @param {object} input
 * @param {Array<object>} input.entries 全部注册表条目（含 unmanaged / 坏文档）
 * @param {Array<object>} [input.required] 注册表参考目录（沿用既有字段名，仅统计）。
 *        不给就从 entries 自己算（只认 authoritative/partial 且无 error）
 * @param {object} [input.anchors] 当前环境锚点 `{ dsh, bundle, commit }`（H-4 用）
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

  // H-3 uses the same entry selection as navigation; no body-list synchronization.
  if (managed.length > 0 && entryPointOf(entries) === undefined) {
    push('H-3', HEALTH_WARN, '(项目)', '未找到有效接续入口：没有合法的已发布交接或 authoritative/partial index。此诊断不要求维护正文清单，也不阻塞施工。')
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

/** 每条规则命中多少（给工具输出用；四项都在，即使为 0）。 */
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

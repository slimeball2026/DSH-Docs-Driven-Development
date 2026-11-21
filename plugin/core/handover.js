/**
 * Optional handover diagnostics and legacy navigation parsers.
 * Diagnostics check objective input problems, never wording or task completion.
 * The section parser remains for existing panel pointers; sections are not required.
 * Pure functions: no IO, clock or persistent state.
 */

export const SECTIONS = Object.freeze([
  { index: 1, key: 'intent', label: '我的意图', keywords: ['意图', '为什么'] },
  { index: 2, key: 'status', label: '现在到哪了', keywords: ['现在到哪了', '现状', '到哪了'] },
  { index: 3, key: 'next', label: '下一刀', keywords: ['下一刀', '下一步', '接下来', '接下来做什么', '你接下来做什么'] },
  { index: 4, key: 'pitfalls', label: '坑', keywords: ['坑', '不要重犯'] },
  { index: 5, key: 'acceptance', label: '验收', keywords: ['验收'] },
  { index: 6, key: 'nonGoals', label: '刻意没做', keywords: ['刻意没做', '负向范围', '没做的事'] },
  { index: 7, key: 'open', label: '仍未决', keywords: ['仍未决', '需要拍板', '未决', '已拍板', '决策台账', '拍板完毕', '已裁定'] },
])

/** Read legacy level-two/three sections, including their nested subsections. */
export function splitSections(body) {
  const lines = (typeof body === 'string' ? body : '').split(/\r?\n/)
  const heads = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s{0,3}(#{2,3})\s+(.*)$/.exec(lines[index])
    if (match !== null) heads.push({ level: match[1].length, title: match[2].trim(), line: index })
  }
  return heads.map((head, position) => {
    let end = lines.length
    for (let index = position + 1; index < heads.length; index += 1) {
      if (heads[index].level <= head.level) { end = heads[index].line; break }
    }
    const bodyLines = lines.slice(head.line + 1, end)
    while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === '') bodyLines.pop()
    return { ...head, text: bodyLines.join('\n') }
  })
}

/** Parse legacy headings for navigation only; absent headings are valid. */
export function parseHandoverSections(body) {
  const sections = splitSections(body)
  const used = new Set()
  const result = {}
  for (const spec of SECTIONS) {
    const hit = sections.findIndex((section, index) => !used.has(index)
      && spec.keywords.some((keyword) => section.title.includes(keyword)))
    if (hit < 0) {
      result[spec.key] = { found: false }
    } else {
      used.add(hit)
      result[spec.key] = { found: true, ...sections[hit] }
    }
  }
  return result
}

/** Shared order helper used by document creation. */
export function handoverMinOrder(entries) {
  const orders = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.meta?.role === 'handover')
    .map((entry) => entry.meta.order)
    .filter((order) => typeof order === 'number' && Number.isFinite(order))
  return orders.length > 0 ? Math.min(...orders) : undefined
}

export function handoverListOf(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.meta?.role === 'handover')
    .map((entry) => ({ id: entry.meta.id, status: entry.meta.status, order: entry.meta.order }))
}

export function indexDocsOf(entries) {
  const clean = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.hasError !== true && typeof entry?.meta?.id === 'string' && entry.meta.id !== '')
  const index = clean.filter((entry) => entry.meta.role === 'index')
  return (index.length > 0 ? index : clean.filter((entry) => entry.meta.role === 'spec'))
    .map((entry) => ({ id: entry.meta.id, title: typeof entry.meta.title === 'string' ? entry.meta.title : '' }))
}

/**
 * Objective diagnostics only. A nonempty body is not a quality certificate.
 * Legacy stats remain as zeros for callers that consume the old result shape;
 * no seven-section, action, evidence, order or freshness rule is evaluated.
 */
export function checkHandover(input) {
  const opts = input !== null && typeof input === 'object' ? input : {}
  const errors = []
  if (typeof opts.body !== 'string' || opts.body.trim() === '') {
    errors.push({ rule: 'HD-EMPTY', level: 'error', message: '交接正文为空。' })
  }
  if (opts.meta !== undefined && (opts.meta === null || typeof opts.meta !== 'object'
    || opts.meta.role !== 'handover')) {
    errors.push({ rule: 'HD-ROLE', level: 'error', message: '目标不是 role: handover 的文档。' })
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings: [],
    sections: {},
    stats: { sectionsFound: 0, sectionsTotal: 0, concreteActions: 0, acceptanceItems: 0 },
  }
}

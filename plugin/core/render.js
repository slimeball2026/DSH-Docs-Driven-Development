/** Compact DDD navigation. Text depends only on document state, never steps or timestamps. */
import { entryPointOf, entriesOfIndex } from './navigation.js'

export const DEFAULT_MAX_CHARS = 500
export function shortVersion(fingerprint) {
  return typeof fingerprint === 'string' && fingerprint.length >= 6 ? fingerprint.slice(0, 6) : '??????'
}
export function statusMark(status) {
  return ({ authoritative: '🟢', partial: '🟡', superseded: '🔵', sealed: '🔴', void: '🟠', draft: '⚪' })[status] ?? '❔'
}
const clean = (value) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
const shortened = (value, max) => clean(value).length > max ? `${clean(value).slice(0, max)}…` : clean(value)

/** Project summary remains available to the UI. */
export function projectLineOf(registry, maxChars = 120) {
  const entries = Array.isArray(registry?.entries) ? registry.entries : []
  const pick = (role) => entries.find((entry) => entry?.meta?.role === role && entry.hasError !== true && clean(entry.meta.summary))
  return shortened((pick('index') ?? pick('spec'))?.meta?.summary, maxChars)
}
/** Explicit slice remains available to the UI; no relevance inference. */
export function sliceLineOf(registry, maxChars = 40) {
  const entries = (Array.isArray(registry?.entries) ? registry.entries : [])
    .filter((entry) => entry?.meta?.role === 'index' && entry.hasError !== true)
  const explicit = entries.find((entry) => clean(entry.meta.slice))?.meta.slice
  const scope = entries.find((entry) => Array.isArray(entry.meta.scope) && clean(entry.meta.scope[0]))?.meta.scope[0]
  return shortened(explicit ?? scope, maxChars)
}
function nameOf(entry, projectRoot) {
  if (clean(entry?.meta?.id)) return entry.meta.id
  const path = clean(entry?.path).replaceAll('\\', '/')
  const root = clean(projectRoot).replaceAll('\\', '/').replace(/\/$/, '')
  return root && path.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? path.slice(root.length + 1) : '(未知文档)'
}

/** Same legacy call shape; index.required is a reference directory, not a global construction gate. */
export function renderIndexBlock(state) {
  const opts = state !== null && typeof state === 'object' ? state : {}
  if (opts.activated === false) return ''
  const entries = entriesOfIndex(opts.index)
  if (entries.length === 0) return ''
  const current = entryPointOf(entries)
  const sections = [
    { key: 'gate', pinned: true, text: '【门禁】按目标文件检查先读与版本；外部改动须重读，自己成功修改后不用重读。' },
    { key: 'directory', pinned: true, text: '【目录】按任务选择依据；实时目录见 DDD 面板，或 glob docs/*.md 后按 frontmatter 查找。旧磁盘清单可能过时，以实时目录为准。' },
  ]
  if (current) {
    const id = current.meta.id
    const fingerprint = typeof opts.currentFingerprint === 'function' ? opts.currentFingerprint(id) : current.fingerprint
    sections.push({ key: 'entry', pinned: true,
      text: `【入口】\`${id}\` · ${shortened(current.meta.summary, 80)} · v${shortVersion(fingerprint)}` })
  }
  const forbidden = Array.isArray(opts.index?.forbidden) ? opts.index.forbidden : []
  const anomalies = Array.isArray(opts.index?.anomalies) ? opts.index.anomalies : []
  if (forbidden.length) sections.push({ key: 'forbid', text: '【禁止执行】\n' + forbidden.map((entry) =>
    `- \`${nameOf(entry, opts.projectRoot)}\`：${shortened(entry.meta?.summary, 80)}`).join('\n') })
  if (anomalies.length) sections.push({ key: 'anomaly', text: '【文档异常】\n' + anomalies.map((entry) => {
    const issue = entry.issues?.find((item) => item?.level === 'error')
    return `- \`${nameOf(entry, opts.projectRoot)}\`：${shortened(issue?.message ?? '元数据不合法', 80)}`
  }).join('\n') })
  const limit = Number.isFinite(opts.maxChars) && opts.maxChars > 0 ? Math.floor(opts.maxChars) : DEFAULT_MAX_CHARS
  return fitBudget(sections, limit)
}

/** Preserve actionable base text; large warning lists link to the complete live directory. */
export function fitBudget(sections, budget) {
  const parts = sections.map((section) => ({ ...section }))
  const join = () => parts.map((part) => part.text).filter(Boolean).join('\n')
  for (const key of ['anomaly', 'read', 'unread', 'forbid']) {
    if (join().length <= budget) break
    const section = parts.find((part) => part.key === key && part.pinned !== true)
    if (!section) continue
    const count = section.text.split('\n').slice(1).filter(Boolean).length
    section.text = key === 'read' || key === 'unread' ? ''
      : `${key === 'anomaly' ? '【文档异常】' : '【禁止执行】'}${count} 份，完整清单见 DDD 面板；用 glob docs/*.md 定位后核对 frontmatter。`
  }
  return join()
}

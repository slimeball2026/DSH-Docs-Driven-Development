/** Plugin-owned AGENTS block. User content outside complete markers stays byte-for-byte. */
import { entryPointOf, entriesOfIndex } from './navigation.js'

export const MARKER_START = '<!-- ddd:index'
export const MARKER_END = '<!-- ddd:index end -->'
const BLOCK_RE = /<!--\s*ddd:index[^>]*-->[\s\S]*?<!--\s*ddd:index end\s*-->/i
const DANGLING_START_RE = /<!--\s*ddd:index[^>]*-->/i
const MARKER_RE = /<!--\s*ddd:index/i
export function hasIndexMarker(text) {
  return typeof text === 'string' && MARKER_RE.test(text)
}
const short = (text) => String(text ?? '').trim().replace(/\s+/g, ' ').slice(0, 80)

/** Current entry plus safety warnings; never embed the full reference directory or read counters. */
export function renderAgentsMd(index, extra = {}) {
  const current = entryPointOf(entriesOfIndex(index))
  const forbidden = Array.isArray(index?.forbidden) ? index.forbidden : []
  const anomalies = Array.isArray(index?.anomalies) ? index.anomalies : []
  const out = [
    `${MARKER_START} v1 · 自动生成，请勿手改 -->`,
    '## 本项目是文档驱动开发（DDD）项目',
    '按任务选择依据；门禁检查目标文件的读取与版本，不要求先读完整个目录。',
    '自己成功修改后不用重读；外部改动后须重读目标文件。',
    '实时目录见 DDD 面板；也可用 glob docs/*.md 定位，再 read frontmatter。',
    '旧磁盘阅读清单可能过时，以实时目录为准；不必维护其成员或重写索引。',
  ]
  if (current) out.push(`### 当前入口\n- \`${current.meta.id}\` · ${short(current.meta.summary)}`)
  if (forbidden.length) {
    out.push('### 禁止执行（sealed）')
    for (const entry of forbidden) out.push(`- \`${entry.meta?.id ?? '(未知文档)'}\` · 不要执行：${short(entry.meta?.summary).replace(/^🔴\s*不要执行[：:]?\s*/, '')}`)
  }
  if (anomalies.length) {
    out.push('### 文档异常（不能作为依据）')
    for (const entry of anomalies) {
      const issue = entry.issues?.find((item) => item?.level === 'error')
      out.push(`- \`${entry.meta?.id ?? '(未知文档)'}\`：${short(issue?.message ?? '元数据不合法')}`)
    }
  }
  if (Array.isArray(extra.terms) && extra.terms.some((term) => typeof term === 'string' && term.trim())) {
    out.push('### 术语', ...extra.terms.filter((term) => typeof term === 'string' && term.trim()).map((term) => `- ${term}`))
  }
  out.push(MARKER_END)
  return `${out.join('\n')}\n`
}

export function mergeAgentsMd(existing, block) {
  const text = typeof existing === 'string' ? existing : ''
  const body = typeof block === 'string' ? block : ''
  if (BLOCK_RE.test(text)) return text.replace(BLOCK_RE, () => body.trimEnd())
  const dangling = DANGLING_START_RE.exec(text)
  if (dangling !== null) {
    const head = text.slice(0, dangling.index).replace(/\s+$/, '')
    return head === '' ? `${body.trimEnd()}\n` : `${head}\n\n${body.trimEnd()}\n`
  }
  const trimmed = text.replace(/\s+$/, '')
  return trimmed === '' ? `${body.trimEnd()}\n` : `${trimmed}\n\n${body.trimEnd()}\n`
}
export function sameBlock(a, b) {
  const norm = (text) => String(text ?? '').replace(/\r\n/g, '\n').split('\n')
    .map((line) => line.trim()).filter(Boolean).join('\n')
  return norm(a) === norm(b)
}

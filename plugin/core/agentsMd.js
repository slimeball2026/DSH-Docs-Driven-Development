/**
 * 慢变量索引：`AGENTS.md` 的渲染与"只覆盖标记块"的合并（SPEC §6.5）。
 *
 * **纯函数，零 IO。** 读写文件的活由 `adapters/agentsmd-writer.js` 做。
 *
 * 两条硬要求（SPEC §6.5）：
 * 1. **只写慢变量**。任何随会话变化的内容都不能进来，否则违反 §6.1 ——
 *    `dsh-agent-instructions` 的注入是"持久 user 消息 + digest 变化才追加替换"，
 *    一变就多一条历史消息，旧的在压缩前一直留着。
 * 2. **只覆盖 `<!-- ddd:index ... -->` 标记块**，用户手写的其它内容不能被冲掉。
 */

/** 块的起始标记（SPEC §4.3 的 T2 就靠它识别 DDD 项目）。 */
export const MARKER_START = '<!-- ddd:index'
/** 块的结束标记。 */
export const MARKER_END = '<!-- ddd:index end -->'

/** 完整的块正则：从起始标记到结束标记（非贪婪、跨行）。 */
const BLOCK_RE = /<!-- ddd:index[^>]*-->[\s\S]*?<!--\s*ddd:index end\s*-->/i

/** 只匹配未闭合的起始标记（用于"有头无尾"的坏文件）。 */
const DANGLING_START_RE = /<!--\s*ddd:index[^>]*-->/i

/**
 * 起始标记的识别正则。
 *
 * SPEC §4.3 的 T2 写的是"字符串包含 `<!-- ddd:index`"。这里放宽成
 * `<!--\s*ddd:index`：用户手写 `<!--ddd:index-->`（不带空格）也该认。
 * 标记认不出来 = 插件以为这不是 DDD 项目 = 整个功能 no-op，
 * 所以在这一步**宁可宽松**，不要因为一个空格让人以为自己装坏了。
 */
const MARKER_RE = /<!--\s*ddd:index/i

/**
 * 判断一段文本里是否带激活标记（T2，SPEC §4.3）。
 * @param {string} text
 * @returns {boolean}
 */
export function hasIndexMarker(text) {
  return typeof text === 'string' && MARKER_RE.test(text)
}

/**
 * 渲染慢变量块的内容（不含标记行本身的进出）。
 *
 * @param {object} index `buildIndex()` 的结果
 * @param {object} [extra]
 * @param {string[]} [extra.terms] 术语行（`**切片** = 「档」`）
 * @returns {string}
 */
export function renderAgentsMd(index, extra = {}) {
  const required = Array.isArray(index?.required) ? index.required : []
  const forbidden = Array.isArray(index?.forbidden) ? index.forbidden : []
  const anomalies = Array.isArray(index?.anomalies) ? index.anomalies : []
  const terms = Array.isArray(extra.terms) ? extra.terms.filter((line) => typeof line === 'string' && line !== '') : []

  const out = []
  out.push(`${MARKER_START} v1 · 自动生成，请勿手改 -->`)
  out.push('## 本项目是文档驱动开发（DDD）项目')
  out.push('')
  out.push('改 `docs/` 下的文档前，必须先读过它。')
  out.push('')

  out.push('### 必读（施工前必须读完）')
  if (required.length === 0) {
    out.push('- （当前没有必读文档）')
  } else {
    for (const entry of required) {
      const meta = entry?.meta ?? {}
      const mark = statusMarkOf(meta.status)
      const tokens = typeof meta.tokens === 'number' && Number.isFinite(meta.tokens)
        ? ` · ${(meta.tokens / 1000).toFixed(1)}k tokens`
        : ''
      const scope = Array.isArray(meta.scope) && meta.scope.length > 0
        ? ` · 仅适用 ${meta.scope.join('、')}`
        : ''
      out.push(`- \`${meta.id}\` · ${meta.summary ?? ''} · ${mark}${scope}${tokens}`)
    }
  }
  out.push('')

  out.push('### 禁止执行（sealed：内容有诱惑力但已被推翻）')
  if (forbidden.length === 0) {
    out.push('- （当前没有封存文档）')
  } else {
    for (const entry of forbidden) {
      const meta = entry?.meta ?? {}
      // 作者常在 summary 里自己写「🔴 不要执行：…」。模板已经带了前缀，
      // 直接拼会变成「🔴 不要执行：🔴 不要执行：…」。这里剥掉重复的前缀。
      const summary = String(meta.summary ?? '').replace(/^\s*🔴\s*不要执行[：:]\s*/, '')
      out.push(`- \`${meta.id}\` · 🔴 不要执行：${summary}`)
    }
  }
  out.push('')

  if (terms.length > 0) {
    out.push('### 术语')
    for (const line of terms) out.push(`- ${line}`)
    out.push('')
  }

  // 有 error 的文档不进必读清单，但要让读者知道"它坏了"——否则会以为它不存在。
  if (anomalies.length > 0) {
    out.push('### 文档异常（有 error，不能作为依据）')
    for (const entry of anomalies) {
      const id = entry?.meta?.id ?? entry?.path ?? '(未知文档)'
      const first = (Array.isArray(entry?.issues) ? entry.issues : []).find((item) => item?.level === 'error')
      out.push(`- \`${id}\`：${first?.message ?? '元数据不合法'}`)
    }
    out.push('')
  }

  out.push(MARKER_END)
  return `${out.join('\n')}\n`
}

/** status → emoji（与 render.js 保持一致，避免两处不一致）。 */
function statusMarkOf(status) {
  switch (status) {
    case 'authoritative': return '🟢 ✅'
    case 'partial': return '🟡 ✅'
    case 'superseded': return '⚪ ❌'
    case 'sealed': return '🔴 ❌'
    case 'void': return '⚫ ❌'
    case 'draft': return '🔵 ❌'
    default: return '❔'
  }
}

/**
 * 把新块合并进现有 `AGENTS.md` 文本。
 *
 * 三种情况：
 * 1. 已有完整标记块 → **只替换那一块**，其余原样保留。
 * 2. 只有起始标记没有结束标记（坏文件）→ 从起始标记起替换到文件末尾。
 * 3. 完全没有标记 → **追加**到文件末尾（保留用户已有内容）。
 *
 * @param {string} existing 现有文件内容（不存在就传 ''）
 * @param {string} block renderAgentsMd 的产物
 * @returns {string} 合并后的完整内容
 */
export function mergeAgentsMd(existing, block) {
  const text = typeof existing === 'string' ? existing : ''
  const body = typeof block === 'string' ? block : ''

  if (BLOCK_RE.test(text)) {
    return text.replace(BLOCK_RE, body.trimEnd())
  }

  const dangling = DANGLING_START_RE.exec(text)
  if (dangling !== null) {
    const head = text.slice(0, dangling.index).replace(/\s+$/, '')
    const tail = body.trimEnd()
    return head === '' ? `${tail}\n` : `${head}\n\n${tail}\n`
  }

  const trimmed = text.replace(/\s+$/, '')
  if (trimmed === '') return `${body.trimEnd()}\n`
  return `${trimmed}\n\n${body.trimEnd()}\n`
}

/**
 * 判断新块与旧块是否**内容等价**（用来避免无谓重写，SPEC §6.5 的"越少改越好"）。
 *
 * 只比较块内正文，忽略行尾空白与空行数量差异。
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameBlock(a, b) {
  const norm = (text) => String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n')
  return norm(a) === norm(b)
}

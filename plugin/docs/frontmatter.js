/**
 * frontmatter 最小子集解析器（零依赖）。
 *
 * 为什么自己写：profile 装的 bundle **解析不到任何第三方包**
 * （实测从 bundle 真实路径 `import('js-yaml')` → `ERR_MODULE_NOT_FOUND`，
 * `yaml` / `zod` 同样）。所以只能手写。
 *
 * 为什么砍得这么狠（SPEC §5.1）：把解析器压到 ≤120 行、可单测。
 * 代价是 `verifiedAgainst` 拍平成 `verifiedDsh` / `verifiedBundle` / `verifiedCommit`
 * 三个平键——字段名略啰嗦，换解析器从「需要缩进栈」降到「一行一个 key: value」。
 *
 * **只支持五种形态**：
 *   1. 标量      `title: 档 2 施工图`
 *   2. 数字      `order: 20`
 *   3. 流式 JSON `scope: ["tier2"]` / `sections: [{"anchor":"#7"}]`
 *   4. 裸词列表  `scope: [tier2, tier1]`（JSON 失败时兜底）
 *   5. 空值      `note:`  → null
 *
 * **显式拒绝**（报 `DOC_FM_UNSUPPORTED`，不静默忽略）：
 *   块式列表、块式嵌套、多行字符串、锚点/别名、格式错误的行。
 *
 * **关于注释（与 SPEC 字面表述的偏离，已在 README 记明）**：
 * 本解析器**不剥离 `#` 注释**，`#` 一律当普通字符。
 * 理由：剥离会造成**静默数据丢失**——`summary: 用 # 号标记` 会被截成 `用`。
 * 不剥离时 `anchor: "#7"` 自然正确，而 `id: foo # 注释` 会原样留下（可见的脏，不是隐藏的错）。
 */

/** 唯一的 frontmatter 错误码（SPEC §5.1）。 */
export const FM_UNSUPPORTED = 'DOC_FM_UNSUPPORTED'

const OPEN = '---'
/** DSH 的文档预览同时接受 `---` 与 `...` 作结束标记，这里保持一致，避免插件与 UI 判断不同。 */
const CLOSERS = new Set(['---', '...'])
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/
const NUMBER_RE = /^-?(?:\d+\.?\d*|\.\d+)$/

function fail(message, line) {
  return { code: FM_UNSUPPORTED, message, ...(line === undefined ? {} : { line }) }
}

/**
 * 解析一行 `key: value` 的值部分。
 * @param {string} raw 冒号之后的原文。
 * @param {number} line 行号（1 基，含 frontmatter 起始 `---` 行），用于报错定位。
 * @returns {unknown} 解析出的值。
 * @throws {{code: string, message: string, line: number}} 不支持或格式错误。
 */
function parseValue(raw, line) {
  const text = raw.trim()
  if (text === '') return null

  // 多行字符串 / 锚点别名：显式拒绝，不猜。
  if (text.startsWith('|') || text.startsWith('>')) {
    throw fail('不支持多行字符串（`|` / `>`），请写成单行', line)
  }
  if (text.startsWith('&') || text.startsWith('*')) {
    throw fail('不支持 YAML 锚点/别名（`&` / `*`）', line)
  }

  // 引号标量：只在**最外层**判断引号，所以 `anchor: "#7"` 里的 `#` 不会被当成注释。
  if (text.length >= 2) {
    const head = text[0]
    const tail = text[text.length - 1]
    if (head === '"' && tail === '"') {
      try {
        return JSON.parse(text)
      } catch {
        return text.slice(1, -1)
      }
    }
    if (head === "'" && tail === "'") {
      // YAML 单引号里 `''` 表示一个 `'`。
      return text.slice(1, -1).replaceAll("''", "'")
    }
  }

  // CASE 4：裸词列表 `[a, b]`（先试 JSON，失败再按逗号切）。
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) throw fail('列表没有被 `]` 闭合', line)
    try {
      return JSON.parse(text)
    } catch {
      const inner = text.slice(1, -1).trim()
      if (inner === '') return []
      return inner.split(',').map((item) => {
        const word = item.trim()
        if (word.length >= 2 && (word[0] === '"' || word[0] === "'") && word.at(-1) === word[0]) {
          return word.slice(1, -1)
        }
        return word
      })
    }
  }

  // CASE 2：数字。`verifiedDsh: 0.2.1-rc.1` 不匹配 NUMBER_RE，正确保留为字符串。
  if (NUMBER_RE.test(text)) {
    const number = Number(text)
    if (!Number.isFinite(number)) throw fail(`数值不是有限数：${text}`, line)
    return number
  }

  // CASE 1：标量。
  return text
}

/**
 * 解析正文里的 frontmatter 块。
 * @param {string} source 整份文件文本（可带 BOM）。
 * @returns {{present: boolean, meta: Record<string, unknown> | null,
 *            body: string, error: {code: string, message: string, line?: number} | null}}
 *   `present` 区分三种情况：没有块（false）/ 有块且合法（true + meta）/ 有块但坏了（true + error）。
 */
export function parseFrontmatter(source) {
  const text = typeof source === 'string' ? source : ''
  // BOM 必须先剥掉，否则首行不是 `---`，整份文档会被当成「没有 frontmatter」。
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const lines = src.split(/\r?\n/)
  const absent = { present: false, meta: null, body: src, error: null }

  if ((lines[0] ?? '').trim() !== OPEN) return absent

  let end = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (CLOSERS.has(lines[i].trim())) {
      end = i
      break
    }
  }
  const body = end < 0 ? '' : lines.slice(end + 1).join('\n')
  if (end < 0) {
    return { present: true, meta: null, body, error: fail('frontmatter 块没有结束标记（缺 `---`）') }
  }

  const meta = Object.create(null)
  for (let i = 1; i < end; i += 1) {
    const line = lines[i]
    const lineNo = i + 1
    if (line.trim() === '') continue

    try {
      // 块式列表 / 块式嵌套：靠「行首短横」与「缩进」识别，这是 YAML 的唯一入口特征。
      if (/^\s*-(?:\s|$)/.test(line)) {
        throw fail('不支持块式列表（`- item` 另起一行），请写成单行 `[a, b]`', lineNo)
      }
      if (/^[ \t]/.test(line)) {
        throw fail('不支持块式嵌套（缩进子键），请拍平成平键或用流式 JSON', lineNo)
      }

      const colon = line.indexOf(':')
      if (colon < 0) throw fail('这一行不是 `key: value` 形式', lineNo)

      const key = line.slice(0, colon).trim()
      if (!KEY_RE.test(key)) throw fail(`键名不合法：${key === '' ? '(空)' : key}`, lineNo)

      meta[key] = parseValue(line.slice(colon + 1), lineNo)
    } catch (error) {
      // 本模块**从不向外抛**：所有失败都折成 `{error}`，让调用方统一按「坏文档」处理。
      if (error?.code === FM_UNSUPPORTED) return { present: true, meta: null, body, error }
      throw error
    }
  }

  return { present: true, meta, body, error: null }
}

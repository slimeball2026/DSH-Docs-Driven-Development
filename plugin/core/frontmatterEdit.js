/**
 * 结构化改写 frontmatter —— **正文一个字节都不动**（M1 `doc_mark` 的地基）。
 *
 * 为什么必须结构化改写（交接 §5.3 #16）：
 * 「用字符串替换改 `status:`」看起来只改一行，实际会撞上三个坑：
 *   1. 正文里恰好也有 `status: draft`（文档在讨论 status 本身）→ 改错位置；
 *   2. `status: draft` 是 `status: draft-old` 的前缀 → 改出 `sealed-old`；
 *   3. CRLF 文件被 split/join 成 LF → **整份文件每一行都变了**，指纹全变、
 *      diff 变成全文重写、`edit` 的"仅追加"判定也一起失效。
 *
 * 所以本模块只做一件事：**按行定位 frontmatter 块，只重写块内的目标键**，
 * 块外的字节（含行尾风格、BOM、正文）原样拼回去。
 *
 * **纯函数，零 IO / 零时间 / 零随机 / 不 import 任何内置模块**（`core/` 的硬约束）。
 *
 * ---- 与 `docs/frontmatter.js` 的分工 ----
 * 那个模块负责**读**（解析成对象，供索引与校验用）；
 * 本模块负责**写**（只改指定的键，其余原样）。两者都只认同一个 YAML 子集。
 */

/** frontmatter 起始行。 */
const OPEN = '---'
/** 结束标记（与解析器一致：`---` 或 `...`）。 */
const CLOSERS = Object.freeze(['---', '...'])

/** 与 `docs/frontmatter.js` 完全一致的键名规则。 */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/

/** 需要 JSON 引号包裹的值：含这些字符时裸写会被解析器读错。 */
const NEEDS_QUOTE_RE = /[:#[\]{}",'\n\r\t]|^\s|\s$/

/**
 * 把 JS 值序列化成**本插件解析器认得**的 YAML 子集写法。
 *
 * 只产出四种形态（与 `docs/frontmatter.js` 的 CASE 1/2/3/4 一一对应）：
 *   数字 / 布尔与裸词 / 带引号字符串 / 流式 JSON 数组。
 *
 * ⚠️ 布尔**不写成 `true` / `false`**：解析器把它们当普通字符串（`CASE 1`）。
 * 这一点是刻意的——插件里没有任何布尔字段，写 `true` 只会让人以为它是布尔。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function formatFrontmatterValue(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`不能写入非有限数：${String(value)}`)
    return String(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) {
    // 流式 JSON 数组：解析器会先试 JSON.parse，所以这是最稳的形态。
    // 只保留 JSON 值；遇到函数/undefined 直接抛（写进文件就是脏数据）。
    const clean = value.map((item) => {
      if (item === undefined || typeof item === 'function') {
        throw new Error('数组里不能有 undefined / function')
      }
      return item
    })
    return JSON.stringify(clean)
  }
  if (typeof value === 'object') {
    // 插件里唯一用到的嵌套结构是 `sections: [{anchor, status, reason}]`（M1-Q6 的结构化写入）。
    return JSON.stringify(value)
  }
  const text = String(value)
  if (text === '') return ''
  // 裸写会撞上解析器的注释/分隔符歧义 → 一律用 JSON 引号（解析器对 `"…"` 走 JSON.parse）。
  if (NEEDS_QUOTE_RE.test(text)) return JSON.stringify(text)
  return text
}

/**
 * 判断一行是不是 `key: value` 形式，并取出键名。
 * @param {string} line
 * @returns {string | undefined}
 */
function keyOfLine(line) {
  const colon = line.indexOf(':')
  if (colon < 0) return undefined
  const key = line.slice(0, colon).trim()
  return KEY_RE.test(key) ? key : undefined
}

/**
 * 定位 frontmatter 块。
 *
 * 返回值里的 `lines` 是**去掉行尾符**的行数组，`eol` 是原文用的行尾
 * （`\r\n` 或 `\n`），`bom` 记录原文是否带 BOM —— 三者一起保证「原样拼回」。
 *
 * @param {string} source 整份文件文本
 * @returns {{present: boolean, bom: string, eol: string, lines: string[], bodyLines: string[],
 *            start: number, end: number}}
 */
export function locateFrontmatter(source) {
  const text = typeof source === 'string' ? source : ''
  const bom = text.charCodeAt(0) === 0xfeff ? '\ufeff' : ''
  const src = bom === '' ? text : text.slice(1)

  // 行尾风格：以第一处 `\r\n` 为准（没有就是 `\n`）。混合行尾的文件按 `\n` 处理，
  // 因为拆分用的正则 `\r?\n` 会把 `\r` 留在行尾 —— 这里先统一剥掉，拼回时再加。
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const lines = src.split(/\r?\n/)

  const absent = { present: false, bom, eol, lines, bodyLines: lines, start: -1, end: -1 }
  if ((lines[0] ?? '').trim() !== OPEN) return absent

  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (CLOSERS.includes(lines[index].trim())) {
      end = index
      break
    }
  }
  if (end < 0) return absent // 没有结束标记 = 没有可用的块（与解析器一致）

  return {
    present: true,
    bom,
    eol,
    lines,
    bodyLines: lines.slice(end + 1),
    start: 0,
    end,
  }
}

/**
 * 读出 frontmatter 块内的键值对（**只取值不解析**，解析交给 `docs/frontmatter.js`）。
 *
 * 这里只需要"某个键在第几行"，所以刻意不做类型解析——两处各写一套类型解析，
 * 迟早会不一致。
 *
 * @param {string[]} blockLines frontmatter 块内的行（不含起止标记）
 * @returns {Map<string, number>} 键 → 在 `blockLines` 里的下标
 */
export function indexBlockKeys(blockLines) {
  const found = new Map()
  const lines = Array.isArray(blockLines) ? blockLines : []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    if (/^\s*-(?:\s|$)/.test(line)) continue // 块式列表：解析器会拒，这里也不认
    if (/^[ \t]/.test(line)) continue // 块式嵌套：同上
    const key = keyOfLine(line)
    if (key === undefined) continue
    if (!found.has(key)) found.set(key, index)
  }
  return found
}

/**
 * 把若干字段写进一份文档的 frontmatter。**正文一个字节都不动。**
 *
 * 语义：
 *   - 键已存在 → **原地替换那一行**（保持位置，diff 最小）；
 *   - 键不存在 → **追加到块尾**（`---` 之前）；
 *   - 值为 `undefined` / `null` → **删除该键**（`null` 也删，因为解析器把空值读成 null，
 *     写回 `key:` 与删掉在语义上等价，而删掉更干净）；
 *   - 没有 frontmatter 块 → **返回错误**（不替用户造一个，那是 `doc_new` 的事）。
 *
 * @param {string} source 原文件全文
 * @param {Record<string, unknown>} fields 要写入的字段（值按 `formatFrontmatterValue` 序列化）
 * @returns {{ok: true, text: string, changed: string[], removed: string[], added: string[]}
 *          | {ok: false, code: string, message: string}}
 */
export function setFrontmatterFields(source, fields) {
  const input = fields !== null && typeof fields === 'object' ? fields : {}
  const located = locateFrontmatter(source)

  if (located.present !== true) {
    return {
      ok: false,
      code: 'DOC_FM_MISSING',
      message: '这份文档没有可解析的 frontmatter 块（没有 `---` 起止标记），不能结构化改写。',
    }
  }

  const { bom, eol, lines } = located
  const blockLines = lines.slice(1, located.end) // 不含起止标记
  const positions = indexBlockKeys(blockLines)

  /** @type {Map<string, string>} 要写的新行（键 → 整行文本） */
  const replacements = new Map()
  /** @type {Set<string>} 要删的键 */
  const removals = new Set()
  const changed = []
  const removed = []
  const added = []

  for (const [key, value] of Object.entries(input)) {
    if (!KEY_RE.test(key)) {
      return { ok: false, code: 'DOC_FM_BAD_KEY', message: `字段名不合法：${key}` }
    }
    if (value === undefined || value === null) {
      if (positions.has(key)) {
        removals.add(key)
        removed.push(key)
      }
      continue
    }

    let serialized
    try {
      serialized = formatFrontmatterValue(value)
    } catch (error) {
      return { ok: false, code: 'DOC_FM_BAD_VALUE', message: `${key}: ${error?.message ?? error}` }
    }

    const line = serialized === '' ? `${key}:` : `${key}: ${serialized}`
    if (positions.has(key)) {
      const index = positions.get(key)
      if (blockLines[index] !== line) {
        replacements.set(key, line)
        changed.push(key)
      }
    } else {
      replacements.set(key, line)
      added.push(key)
    }
  }

  if (replacements.size === 0 && removals.size === 0) {
    // 什么都没变：**原样返回**（不要重新拼一遍，否则可能悄悄改动行尾）。
    return { ok: true, text: source, changed: [], removed: [], added: [] }
  }

  const nextBlock = []
  for (let index = 0; index < blockLines.length; index += 1) {
    const key = [...positions.entries()].find(([, at]) => at === index)?.[0]
    if (key !== undefined && removals.has(key)) continue // 删掉这一行
    if (key !== undefined && replacements.has(key)) {
      nextBlock.push(replacements.get(key))
      continue
    }
    nextBlock.push(blockLines[index])
  }

  // 新增的键追加在块尾（`---` 之前）。
  for (const [key, line] of replacements) {
    if (positions.has(key)) continue
    nextBlock.push(line)
  }

  const out = [bom + OPEN, ...nextBlock, lines[located.end], ...located.bodyLines].join(eol)
  return { ok: true, text: out, changed, removed, added }
}

/**
 * 便捷包装：只改一个字段。
 * @param {string} source
 * @param {string} key
 * @param {unknown} value
 * @returns {ReturnType<typeof setFrontmatterFields>}
 */
export function setFrontmatterField(source, key, value) {
  return setFrontmatterFields(source, { [key]: value })
}

/**
 * 取正文（frontmatter 之后的全部内容，**保持原始行尾**）。
 *
 * 用来做「正文一个字节都不变」的反向断言，也供 `doc_mark` 计算标记块插入位置。
 *
 * @param {string} source
 * @returns {string}
 */
export function bodyOf(source) {
  const located = locateFrontmatter(source)
  if (located.present !== true) return typeof source === 'string' ? source : ''
  return located.bodyLines.join(located.eol)
}

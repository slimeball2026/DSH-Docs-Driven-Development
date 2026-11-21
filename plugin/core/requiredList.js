/**
 * M3 · 入口索引的「必读清单」半自动渲染。
 *
 * ---- 为什么要有它（前端实机 fe1/fe2，2026-11-20）----
 *
 * `read-order` 的必读清单同时承担两件事，但只有一件该由人手写：
 *   · **成员与顺序** —— 完全机械：`status` 是 authoritative/partial 的文档就必读，
 *     顺序按 frontmatter 的 `order`。门禁的 `required` 清单本来就从 frontmatter 算
 *     （`core/index.js` 的 `buildIndex()`），**正文这份清单对门禁毫无作用**。
 *   · **「为什么读」** —— 判断（"先读这份""别照 §4 写代码"），frontmatter 的
 *     `summary` 表达不了，必须人手写。
 *
 * 实测代价：前端实机 fe1 在 read-order 上花了 6/38 次调用（3 读 + 3 改 = 16%），
 * fe2 又整份 `write` 重写了 2 次。而它维护的只是一份"frontmatter 的投影"。
 *
 * ---- 设计：标记块 + 内容 hash（用户 2026-11-20 拍板）----
 *
 * · 写入时机：**`doc_new` / `doc_mark` 之后自动**，不让模型多付出一步；
 * · 冲突策略：**warn** —— 只有交接时或明确要求时，人手改这一段才是合理的，
 *   所以检测到人手改过（marker 里的 `hash` 与块内实际内容不符）就**不覆盖**、只警告。
 *
 * 渲染只动 `<!-- ddd:auto:begin ... -->` 与 `<!-- ddd:auto:end -->` 之间，
 * 正文其它部分（尤其块下方的「为什么读」）一个字节都不碰 —— 与
 * `core/agentsMd.js` 的 `<!-- ddd:index -->` 是同一套"只覆盖标记块"的纪律。
 *
 * **纯函数 + 一个注入了 fs 的写盘函数**（与 `core/registerHandover.js` 同构），
 * 所以 `core/` 的 import 纪律（只允许 `./xxx.js`）不被破坏。
 */

import { buildIndex } from './index.js'

/** 小节标题（与 `server/init-workspace.ts` 生成的一致）。 */
export const LIST_HEADING = '## 必读清单'
/** 自动块的起始标记前缀。 */
export const AUTO_BEGIN = '<!-- ddd:auto:begin'
/** 自动块的结束标记。 */
export const AUTO_END = '<!-- ddd:auto:end -->'
/** 块格式版本（改变行格式时 +1，旧块会被视为"格式过期"重新渲染）。 */
export const AUTO_VERSION = 1

/** 终态：这些交接不会再出现在清单里（它们已经不可执行）。 */
const TERMINAL = new Set(['superseded', 'void', 'sealed'])

const BEGIN_RE = /^\s*<!--\s*ddd:auto:begin([^>]*)-->\s*$/
const END_RE = /^\s*<!--\s*ddd:auto:end\s*-->\s*$/
const HEADING_RE = /^##\s/
const PLACEHOLDER_RE = /^\s*[-*]\s*（还没有必读文档/
/** 只有这些才值得写进清单：section 里"没有手写内容"的判定用。 */
const LIST_ITEM_RE = /^\s*(?:\d+\.|[-*])\s+\S/
const COMMENT_RE = /^\s*<!--/

/**
 * FNV-1a 32 位哈希，输出 8 位十六进制。
 *
 * 为什么不 import `docs/fingerprint.js`：`core/` 的 import 只允许 `./xxx.js`
 * （`test/decoupling.test.js`），而这里只需要一个**内容指纹**用于冲突检测，
 * 不需要 sha256 的抗碰撞性。同输入必然同输出（无时间、无随机）。
 *
 * @param {string} text
 * @returns {string}
 */
export function hashOf(text) {
  let hash = 0x811c9dc5
  for (const char of String(text ?? '')) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** 归一化块正文：CRLF 等价、行尾空白忽略、首尾空行不算内容。 */
function normalizeBody(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
}

/**
 * 把注册表条目变成"该出现在必读清单里的文档"。
 *
 * 两条来源：
 *   1. `buildIndex()` 的 `required`（门禁同一口径：authoritative / partial 且无 error）；
 *   2. **非终态的交接** —— 交接刚建出来时是 `draft`，门禁还不要求读，
 *      但 M2.8 起 `doc_new` 会把它登记进索引（"先读这份"），这个语义要保留。
 *
 * 排序与 `buildIndex()` 一致：order 升序，再按 id。**纯函数。**
 *
 * @param {Array<object>} entries
 * @returns {Array<object>}
 */
export function buildRequiredForList(entries) {
  const list = Array.isArray(entries) ? entries.filter((entry) => entry !== null && typeof entry === 'object') : []
  const { required } = buildIndex(list)
  const seen = new Set(required.map((entry) => entry?.meta?.id))
  const handovers = list.filter((entry) => (
    entry?.meta?.role === 'handover'
    && typeof entry?.meta?.id === 'string'
    && entry.meta.id !== ''
    && !TERMINAL.has(entry.meta.status)
    && !seen.has(entry.meta.id)
  ))
  const merged = [...required, ...handovers]
  const orderOf = (entry) => (typeof entry?.meta?.order === 'number' ? entry.meta.order : Number.MAX_SAFE_INTEGER)
  merged.sort((a, b) => {
    const ao = orderOf(a)
    const bo = orderOf(b)
    if (ao !== bo) return ao - bo
    return String(a?.meta?.id ?? '').localeCompare(String(b?.meta?.id ?? ''))
  })
  return merged
}

/** 一条清单行的渲染（形状与交接 §3.1.3 的示例一致）。 */
function lineOf(entry, index) {
  const meta = entry?.meta ?? {}
  const order = typeof meta.order === 'number' ? String(meta.order) : '—'
  const summary = typeof meta.summary === 'string' ? meta.summary.trim() : ''
  return `${index + 1}. \`${meta.id}\` · order ${order} · ${meta.status ?? '?'} · ${summary}`
}

/**
 * 渲染自动块的正文（不含标记行）。**纯函数。**
 *
 * @param {Array<object>} required `buildRequiredForList()` 的产物
 * @returns {{body: string, hash: string, count: number}}
 */
export function renderRequiredBody(required) {
  const list = Array.isArray(required) ? required : []
  const body = list.length === 0
    ? '- （当前没有必读文档）'
    : list.map((entry, index) => lineOf(entry, index)).join('\n')
  return { body, hash: hashOf(normalizeBody(body)), count: list.length }
}

/** 渲染带标记的完整块（多行字符串）。 */
export function renderRequiredBlock(required) {
  const rendered = renderRequiredBody(required)
  return {
    ...rendered,
    text: [
      `${AUTO_BEGIN} v${AUTO_VERSION} hash=${rendered.hash} -->`,
      rendered.body,
      AUTO_END,
    ].join('\n'),
  }
}

/** 数一个 section 里有几条"人写的清单项"（跳过注释与占位符）。 */
function countHandItems(lines) {
  return lines.filter((line) => LIST_ITEM_RE.test(line) && !COMMENT_RE.test(line) && !PLACEHOLDER_RE.test(line)).length
}

/**
 * 把自动块合并进 `read-order` 正文。**纯函数。**
 *
 * 三种情况：
 *   1. **有完整标记块** → 只替换块内内容（其余字节不动）。
 *      · 标记里的 `hash` 与块内实际内容不符 = 被人手改过 → **不覆盖，只 warn**；
 *      · `hash` 缺失且块内为空（init 模板的初始形态）→ 接管；
 *      · `hash` 缺失但块内非空 → 视为手写，warn；
 *   2. **没有标记块、section 里是手写清单** → 不接管（warn 由调用方决定是否展示）；
 *   3. **没有标记块、section 是空的/占位符** → 插入自动块（新项目初始化就会走这里）。
 *
 * @param {string} text `read-order` 整份正文
 * @param {Array<object>} entries 注册表条目
 * @returns {{text: string, changed: boolean, applied: boolean, warning: string,
 *            reason: string, countBefore: number, countAfter: number}}
 */
export function applyRequiredList(text, entries) {
  const source = typeof text === 'string' ? text : ''
  const required = buildRequiredForList(entries)
  const rendered = renderRequiredBlock(required)
  const no = (reason, warning = '') => ({
    text: source, changed: false, applied: false, warning, reason, countBefore: 0, countAfter: 0,
  })

  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.split(/\r?\n/)
  const headIndex = lines.findIndex((line) => line.trim() === LIST_HEADING)
  if (headIndex < 0) return no('no-heading')

  let endIndex = lines.length
  for (let i = headIndex + 1; i < lines.length; i += 1) {
    if (HEADING_RE.test(lines[i])) { endIndex = i; break }
  }

  // ---- ① 已有标记块：只替换块内 ----
  let beginIndex = -1
  for (let i = headIndex + 1; i < endIndex; i += 1) {
    if (BEGIN_RE.test(lines[i])) { beginIndex = i; break }
  }
  if (beginIndex >= 0) {
    let closeIndex = -1
    for (let i = beginIndex + 1; i < endIndex; i += 1) {
      if (END_RE.test(lines[i])) { closeIndex = i; break }
    }
    if (closeIndex < 0) {
      return {
        text: source, changed: false, applied: true,
        warning: '`<!-- ddd:auto:begin -->` 有头无尾（缺 `<!-- ddd:auto:end -->`），本轮不敢覆盖。',
        reason: 'dangling-begin', countBefore: 0, countAfter: 0,
      }
    }

    const attrs = BEGIN_RE.exec(lines[beginIndex])?.[1] ?? ''
    const stored = /hash=([0-9a-fA-F]{8})/.exec(attrs)?.[1]
    const currentBody = normalizeBody(lines.slice(beginIndex + 1, closeIndex).join('\n'))
    const countBefore = countHandItems(lines.slice(beginIndex + 1, closeIndex))

    if (stored === undefined && currentBody !== '') {
      return {
        text: source, changed: false, applied: true,
        warning: '自动块的标记里没有 `hash`，块内却有人写的内容 —— 视为手改，本轮不覆盖。',
        reason: 'unhashed-manual', countBefore, countAfter: countBefore,
      }
    }
    if (stored !== undefined && stored !== hashOf(currentBody)) {
      return {
        text: source, changed: false, applied: true,
        warning: `自动块被手改过（标记 hash=${stored}，实际内容 hash=${hashOf(currentBody)}）——本轮不覆盖。`
          + '如果你是有意改的，请保留；如果想让插件继续维护，把块内内容恢复成生成形态（或删掉整块让它重新接管）。',
        reason: 'hash-mismatch', countBefore, countAfter: countBefore,
      }
    }

    const nextBody = rendered.body
    if (currentBody === normalizeBody(nextBody) && stored !== undefined) {
      return {
        text: source, changed: false, applied: true, warning: '',
        reason: 'up-to-date', countBefore, countAfter: rendered.count,
      }
    }
    const nextLines = [
      ...lines.slice(0, beginIndex),
      ...rendered.text.split('\n'),
      ...lines.slice(closeIndex + 1),
    ]
    return {
      text: nextLines.join(eol), changed: true, applied: true, warning: '',
      reason: 'rendered', countBefore, countAfter: rendered.count,
    }
  }

  // ---- ② 没有标记块：只在 section 没有手写内容时接管 ----
  const section = lines.slice(headIndex + 1, endIndex)
  const handItems = countHandItems(section)
  if (handItems > 0) {
    return {
      text: source, changed: false, applied: false, warning: '',
      reason: 'hand-written-list', countBefore: handItems, countAfter: handItems,
    }
  }

  // 插到标题之后；把占位符行去掉（它是 init 模板里"还没有必读文档"的占位）。
  const rest = section.filter((line) => !PLACEHOLDER_RE.test(line))
  // 去掉标题后的前导空行，保持一个空行分隔（不重复空行）。
  while (rest.length > 0 && rest[0].trim() === '') rest.shift()
  const nextLines = [
    ...lines.slice(0, headIndex + 1),
    '',
    ...rendered.text.split('\n'),
    ...(rest.length > 0 ? ['', ...rest] : []),
    ...lines.slice(endIndex),
  ]
  return {
    text: nextLines.join(eol), changed: true, applied: true, warning: '',
    reason: 'inserted', countBefore: handItems, countAfter: rendered.count,
  }
}

/**
 * 写盘：按 frontmatter 重渲染 `read-order` 的必读清单。
 *
 * **永不抛**：任何失败都折成 `{ applied:false, reason }` ——
 * 自动渲染是**优化**，而 `doc_new` / `doc_mark` 已经写好的文档是**事实**，
 * 两者不能同级（与 `core/registerHandover.js` 的边界同一条）。
 *
 * 写完必须重扫 + 重新记账：
 *   · `markRead`（**仅当本会话读过它**）—— 否则门禁会把这次机械改动当成"外部变更"，
 *     逼模型整份重读，M3 的收益当场归零；
 *   · `noteSelfWrite` —— 让模型之后 `edit` / `doc_mark` 这份索引时不被指纹拦截。
 *
 * @param {object} input
 * @param {object} input.reg 注册表
 * @param {object} input.fs `ctx.fs`
 * @param {object} [input.session]
 * @param {object} [input.exec]
 * @param {string} [input.projectRoot]
 * @param {object} [input.policy] 沙箱 policy（`{mode}`；由调用方从 exec 推）
 * @param {object} [input.logger]
 * @returns {Promise<{changed: boolean, applied: boolean, warning: string,
 *                    reason: string, countBefore: number, countAfter: number}>}
 */
export async function writeRequiredListFile(input) {
  const opts = input !== null && typeof input === 'object' ? input : {}
  const { reg, fs, session, exec, projectRoot, policy, logger } = opts
  const quiet = (reason, applied = false, warning = '') => ({
    changed: false, applied, warning, reason, countBefore: 0, countAfter: 0,
  })

  try {
    if (typeof fs?.readText !== 'function' || typeof fs?.writeText !== 'function' || typeof fs?.resolve !== 'function') {
      return quiet('fs-unavailable')
    }
    const entries = Array.isArray(reg?.entries) ? reg.entries : []
    const indexEntry = entries.find((entry) => entry?.meta?.role === 'index' && typeof entry?.path === 'string')
    if (indexEntry === undefined) return quiet('no-index-doc')

    const original = typeof indexEntry.text === 'string'
      ? indexEntry.text
      : await fs.readText(await fs.resolve(indexEntry.path, { cwd: projectRoot }))
    if (typeof original !== 'string' || original === '') return quiet('empty-index')

    const result = applyRequiredList(original, entries)
    if (result.warning !== '') return quiet(result.reason, result.applied, result.warning)
    if (result.applied !== true) return quiet(result.reason, false)
    if (result.changed !== true) {
      return {
        changed: false, applied: true, warning: '', reason: result.reason,
        countBefore: result.countBefore, countAfter: result.countAfter,
      }
    }

    const target = await fs.resolve(indexEntry.path, { cwd: projectRoot })
    await fs.writeText(target, result.text, undefined, exec?.signal, {
      ...(policy !== null && typeof policy === 'object' ? policy : {}),
      ...(typeof projectRoot === 'string' && projectRoot !== '' ? { workspaceRoot: projectRoot } : {}),
    })

    // ---- 重扫：注册表与 AGENTS.md 都要跟上（与 doc_mark / doc_new 同一纪律）----
    if (typeof reg?.rescan === 'function') {
      await reg.rescan()
    }

    // ---- 重新记账：机械改动不算"外部修改"（M3 的核心收益就在这一句）----
    const indexId = indexEntry.meta?.id
    const fresh = typeof reg?.entryById === 'function' ? reg.entryById(indexId) : undefined
    const absPath = typeof fresh?.path === 'string' && fresh.path !== '' ? fresh.path : indexEntry.path
    const readSet = typeof reg?.readSetFor === 'function' ? reg.readSetFor(session) : undefined
    const hadRead = readSet !== undefined && typeof readSet.has === 'function' && readSet.has(indexId)
    if (hadRead && typeof reg?.markRead === 'function') {
      try { reg.markRead(absPath, session, exec?.seq, typeof fresh?.text === 'string' ? fresh.text : result.text) } catch { /* 记不上只多一次重读 */ }
    }
    if (typeof reg?.noteSelfWrite === 'function') {
      try { reg.noteSelfWrite(absPath, session) } catch { /* 同上 */ }
    }

    return {
      changed: true, applied: true, warning: '', reason: result.reason,
      countBefore: result.countBefore, countAfter: result.countAfter,
    }
  } catch (error) {
    logger?.debug?.(`[ddd] 必读清单自动渲染失败（不影响写入本身）：${error?.message ?? error}`)
    return quiet(`write-failed: ${error?.message ?? error}`, false)
  }
}
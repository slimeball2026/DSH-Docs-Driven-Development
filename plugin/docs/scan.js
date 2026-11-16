/**
 * 扫描 + 读文件 + 建 metas（SPEC §6.3 的数据来源 1）。**有 IO，异步。**
 *
 * 为什么必须有这一层：`systemPrompt.context()` 的 `text` 回调**必须同步**
 * （`dsh-agent-loop` 里 `renderContextSections()` 直接调 `entry.text(context)`），
 * 而 `ctx.fs.stat()` / `readText()` 都是异步。所以**不能在回调里读盘**，
 * 必须提前把所有东西扫进内存，回调只读内存。
 *
 * 本模块只做"把磁盘变成内存结构"，不持有状态、不注册监听。
 */

import { parseFrontmatter } from './frontmatter.js'
import { fingerprintOf } from './fingerprint.js'
import { countIds, validateMeta } from './schema.js'

/** 扫描用的默认排除项（坟场永不进索引）。 */
export const DEFAULT_IGNORED_DIRS = Object.freeze(['_graveyard', 'node_modules', '.git'])

/**
 * 递归列出 `docs/` 下的所有 .md（**排除坟场**）。
 *
 * 三份清单要分开，所以返回值带 `ignored`（被排除的条目）：
 * 让上层能区分"没有文档"和"文档全在坟场里"。
 *
 * @param {object} input
 * @param {(path: string) => Promise<Array<{name: string, type: string}>>} input.listDir
 * @param {string} input.docsAbs docs 目录绝对路径
 * @param {string} input.joinPath
 * @param {number} [input.maxDepth] 递归深度上限（防御异常目录结构）
 * @param {number} [input.maxFiles] 文件数上限
 * @returns {Promise<{files: string[], truncated: boolean}>} 文件绝对路径
 */
export async function listDocFiles(input) {
  const { listDir, docsAbs, joinPath } = input
  const maxDepth = Number.isInteger(input.maxDepth) && input.maxDepth > 0 ? input.maxDepth : 8
  const maxFiles = Number.isInteger(input.maxFiles) && input.maxFiles > 0 ? input.maxFiles : 500

  const files = []
  let truncated = false

  /** 广度优先，避免深目录把栈打爆。 */
  const queue = [{ dir: docsAbs, depth: 0 }]
  while (queue.length > 0) {
    if (files.length >= maxFiles) {
      truncated = true
      break
    }
    const { dir, depth } = queue.shift()
    let entries
    try {
      entries = await listDir(dir)
    } catch {
      continue
    }
    if (!Array.isArray(entries)) continue

    for (const entry of entries) {
      const name = String(entry?.name ?? '')
      if (name === '') continue
      const full = joinPath(dir, name)

      if (entry.type === 'directory') {
        // 坟场永不扫描（SPEC §4.1：坟场不扫描、不可读）。
        if (DEFAULT_IGNORED_DIRS.includes(name)) continue
        if (depth + 1 <= maxDepth) queue.push({ dir: full, depth: depth + 1 })
        continue
      }

      if (entry.type !== 'file') continue
      if (!/\.md$/i.test(name)) continue

      // 上限必须**逐文件**判：同一个目录里可能一次列出上千个 .md，
      // 只在每轮目录循环开头判会让 maxFiles 形同虚设。
      if (files.length >= maxFiles) {
        truncated = true
        break
      }
      files.push(full)
    }
  }

  files.sort()
  return { files, truncated }
}

/**
 * 读 + 解析 + 校验一份文档，产出注册表条目。
 *
 * @param {object} input
 * @param {string} input.path 绝对路径
 * @param {(path: string) => Promise<string | undefined>} input.readText 读全文（不存在返回 undefined）
 * @param {(absPath: string) => string} [input.classify] 路径判定（用来跳过坟场）
 * @param {object} [input.anchors] 环境锚点（V9 用）
 * @returns {Promise<object | null>} 读不到时返回 null
 */
export async function readDoc(input) {
  const { path, readText } = input
  if (typeof path !== 'string' || path === '') return null

  // 坟场里的文件即使被扫到也绝不进注册表。
  if (typeof input.classify === 'function' && input.classify(path) === 'graveyard') return null

  let text
  try {
    text = await readText(path)
  } catch {
    return null
  }
  if (typeof text !== 'string') return null

  const parsed = parseFrontmatter(text)
  const fingerprint = fingerprintOf(text)

  // 解析失败（frontmatter 坏了）也要留一条条目 —— 它要进 anomalies。
  const provisional = {
    path,
    text,
    body: parsed.body,
    fingerprint,
    present: parsed.present,
    parseError: parsed.error,
    meta: null,
    raw: parsed.meta,
    issues: [],
    hasError: false,
  }

  return provisional
}

/**
 * 把一批 provisional 条目补全成最终条目（需要整批信息才能做 V5/V6）。
 *
 * 分两趟是因为 V5（引用存在性）与 V6（id 重复）都是**全项目属性**，
 * 单份文档自己看不出来。
 *
 * @param {Array<object>} provisional readDoc 的产出一批
 * @param {object} [options]
 * @param {object} [options.anchors] 环境锚点
 * @returns {Array<object>} 带 meta / issues / hasError 的条目
 */
export function finalizeDocs(provisional, options = {}) {
  const list = Array.isArray(provisional) ? provisional.filter(Boolean) : []

  // 第一趟：把能解析出 id 的都收进 knownIds（V5 要用"全部存在的 id"）。
  const knownIds = new Set()
  for (const item of list) {
    const id = item.raw?.id
    if (typeof id === 'string' && id !== '') knownIds.add(id)
  }

  // id 出现次数（V6）。
  const idCounts = countIds(list.map((item) => ({ meta: item.raw })))

  // metaById 供 V8 用。
  const metaById = list
    .filter((item) => item.raw !== null && typeof item.raw === 'object')
    .map((item) => ({ meta: item.raw }))

  // 第二趟：逐份校验。
  return list.map((item) => {
    if (item.parseError !== null && item.parseError !== undefined) {
      // frontmatter 块存在但坏了：按 error 处理，进 anomalies。
      return {
        ...item,
        meta: null,
        issues: [{ rule: 'V1', level: 'error', message: item.parseError.message }],
        hasError: true,
      }
    }

    if (item.raw === null || item.raw === undefined) {
      // 完全没有 frontmatter —— 不是错误，只是"不受管"。
      // 它不进索引、不进必读；门禁会在写入时按"没有 frontmatter"拒绝。
      return { ...item, meta: null, issues: [], hasError: false, unmanaged: true }
    }

    const result = validateMeta(item.raw, {
      body: item.body,
      knownIds,
      idCounts,
      selfId: item.raw.id,
      metaById,
      anchors: options.anchors,
    })

    return { ...item, meta: item.raw, issues: result.issues, hasError: result.hasError }
  })
}

/**
 * 一次性扫描整个项目（list → read → finalize）。
 *
 * @param {object} input
 * @returns {Promise<{entries: Array<object>, truncated: boolean}>}
 */
export async function scanProject(input) {
  const { listDir, readText, docsAbs, joinPath } = input
  const { files, truncated } = await listDocFiles({ listDir, docsAbs, joinPath, maxDepth: input.maxDepth, maxFiles: input.maxFiles })

  const provisional = []
  for (const path of files) {
    // 顺序读：文档量在 10~50 份量级，并发收益不大，但顺序更可预测（也更好测）。
    const item = await readDoc({ path, readText, classify: input.classify })
    if (item !== null) provisional.push(item)
  }

  return { entries: finalizeDocs(provisional, { anchors: input.anchors }), truncated }
}

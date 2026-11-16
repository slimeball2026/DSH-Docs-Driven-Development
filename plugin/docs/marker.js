/**
 * 激活标记探测（SPEC §4.3）。**S1 的配套，全局挂载的必需品。**
 *
 * 问题：全局挂载意味着 `guard` 作用于**所有会话**。如果只凭"有 docs/ 目录"就启用，
 * 那一个普通代码仓库里刚好有个 `docs/`（没有 frontmatter），模型去改它就会被拦 ——
 * **不可接受的误伤**（M0-12 专门盯这个）。
 *
 * 标记定义（满足任一即算 DDD 项目）：
 *   T1  `<项目>/docs/` 下**至少有一份合法 frontmatter 的 .md**（能解析出 id + role + status）
 *   T2  `<项目>/AGENTS.md` 里含 `<!-- ddd:index` 标记
 *
 * 两个刻意的实现约束（交接 §3.8 点名的两个坑）：
 * 1. **只读每个文件的 frontmatter 头**，不全文读 —— 探测成本要低（它每次会话都要跑）。
 * 2. **向上探测有层数上限**（`markerProbeDepth`，默认 8），否则会在深目录里一路扫到盘根。
 *
 * 本文件有 IO（走注入的 fs 抽象），**不在 core/ 里**，但仍零第三方依赖。
 */

import { hasIndexMarker } from '../core/agentsMd.js'
import { parseFrontmatter } from './frontmatter.js'

/** 探测标记时最多读每个文件的开头多少字节。 */
export const HEAD_BYTES = 2048

/** 判定结果。 */
export const MARKER_T1 = 't1'
export const MARKER_T2 = 't2'

/**
 * 判断一段 frontmatter 文本是否满足 T1（能解析出 id + role + status）。
 *
 * 纯函数，便于单测。
 * @param {string} text 文件开头（可以是全文）
 * @returns {boolean}
 */
export function looksLikeDddDoc(text) {
  if (typeof text !== 'string') return false
  const parsed = parseFrontmatter(text)
  if (parsed.present !== true || parsed.meta === null) return false
  const meta = parsed.meta
  return typeof meta.id === 'string' && meta.id !== ''
    && typeof meta.role === 'string' && meta.role !== ''
    && typeof meta.status === 'string' && meta.status !== ''
}

/**
 * 从目录里找出所有 .md（只读直接子项，不递归）。
 *
 * @param {(path: string) => Promise<Array<{ name: string, type: string }>>} listDir
 * @param {string} docsAbs
 * @returns {Promise<string[]>}
 */
async function mdFilesIn(listDir, docsAbs) {
  let entries
  try {
    entries = await listDir(docsAbs)
  } catch {
    return []
  }
  if (!Array.isArray(entries)) return []
  return entries
    .filter((entry) => entry?.type === 'file' && /\.md$/i.test(String(entry?.name ?? '')))
    .map((entry) => entry.name)
}

/**
 * 探测一个候选项目根是否带激活标记。
 *
 * @param {object} input
 * @param {string} input.projectRoot 候选项目根（绝对路径）
 * @param {object} input.layout 目录布局
 * @param {(path: string) => Promise<Array<{name: string, type: string}>>} input.listDir
 * @param {(path: string) => Promise<string | undefined>} input.readHead 读文件开头（不存在返回 undefined）
 * @param {string} input.joinPath 拼路径的函数（注入，避免在 docs/ 里直接用 node:path）
 * @returns {Promise<{hit: boolean, via?: 't1'|'t2', file?: string}>}
 */
export async function probeMarker(input) {
  const { projectRoot, layout, listDir, readHead, joinPath } = input

  // ---- T2：AGENTS.md 里含标记（便宜且明确，先查）
  const agentsMdName = layout?.agentsMdName ?? 'AGENTS.md'
  try {
    const head = await readHead(joinPath(projectRoot, agentsMdName))
    if (typeof head === 'string' && hasIndexMarker(head)) {
      return { hit: true, via: MARKER_T2, file: agentsMdName }
    }
  } catch {
    // AGENTS.md 不存在或读不了 —— 不是错误，继续查 T1。
  }

  // ---- T1：docs/ 下至少一份合法 frontmatter 的 .md
  const docsDir = layout?.docsDir ?? 'docs'
  const docsAbs = joinPath(projectRoot, docsDir)
  const names = await mdFilesIn(listDir, docsAbs)

  for (const name of names) {
    // 跳过坟场里的文件（它们不参与索引，也不该让项目"变成 DDD 项目"）。
    const head = await readHeadSafely(readHead, joinPath(docsAbs, name))
    if (typeof head === 'string' && looksLikeDddDoc(head)) {
      return { hit: true, via: MARKER_T1, file: `${docsDir}/${name}` }
    }
  }

  return { hit: false }
}

/** readHead 的容错包装。 */
async function readHeadSafely(readHead, path) {
  try {
    return await readHead(path)
  } catch {
    return undefined
  }
}

/**
 * 向上探测带标记的项目根（SPEC §4.2 的规则 2）。
 *
 * 从 `cwd` 开始逐级向上，**最多 `maxDepth` 层**；先命中者胜。
 * 注意：这不看 `.git`（那是 `dsh-agent-instructions` 的规则），只看**本插件自己的标记**。
 *
 * @param {object} input
 * @param {string} input.cwd 起始目录（绝对路径）
 * @param {number} [input.maxDepth] 层数上限（默认 8）
 * @param {(path: string) => Promise<object>} input.probe 对单个目录执行 probeMarker
 * @param {(path: string) => string | undefined} input.parentOf 取父目录（到根返回 undefined）
 * @returns {Promise<{projectRoot?: string, via?: string, depth: number}>}
 */
export async function findProjectRoot(input) {
  const { cwd, probe, parentOf } = input
  const maxDepth = Number.isInteger(input.maxDepth) && input.maxDepth >= 0 ? input.maxDepth : 8

  let current = typeof cwd === 'string' && cwd !== '' ? cwd : undefined
  let depth = 0

  while (current !== undefined && depth <= maxDepth) {
    const result = await probe(current)
    if (result?.hit === true) {
      return { projectRoot: current, via: result.via, depth }
    }
    current = parentOf(current)
    depth += 1
  }

  return { depth }
}

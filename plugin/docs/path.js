/**
 * 路径判定 —— **全插件唯一的判定入口**（SPEC §4.5）。
 *
 * 所有逻辑都归到 `classifyPath()`，避免各处各写一套。
 *
 * 本文件在 `docs/` 层，允许用 `node:path`（只有 `core/` 禁止 node:*）。
 * 用**真实的** `path.relative` 而不是字符串运算，是因为要如实体贴 Windows 行为：
 * `\` 与 `/` 混用、盘符、大小写不敏感目录。
 *
 * 核心实现要点（都是踩过的坑）：
 * - 用 `path.relative()` 得出相对段、**逐段比较**，绝不用字符串 `startsWith`：
 *   否则 `docs-old/x.md` 会被误判成 `docs/` 下的文档（交接 §4.3 #15）。
 * - 分隔符统一后按段比较，不看整串。
 * - `..` 逃逸：`path.relative` 会给出 `../...`，首段是 `..` 即判定 `outside`。
 *
 * **大小写（对 SPEC §4.5 的一处订正，已记入 README）**：
 * SPEC 写的是「Windows 上 docs 与 DOCS 视为同一目录，`path.resolve` 后比较，
 * 不额外小写化」。这两半自相矛盾——`path.resolve` 只做规范化与绝对化，
 * **不碰大小写**，光靠它 `DOCS` 永远不会等于 `docs`。
 *
 * 而这一点是**门禁的漏洞而不只是整洁问题**：Windows/NTFS 默认大小写不敏感，
 * 模型写 `DOCS/x.md` 改的就是 `docs/x.md`。若按大小写敏感比较，
 * 这个路径会被判成 `outside` 而**放行**——门禁被静默绕过，正是 SPEC §1.2 最反对的。
 *
 * 所以本实现按平台判定：
 * - `win32` / `darwin`（默认大小写不敏感的文件系统）→ 逐段**忽略大小写**比较；
 * - `linux` 等大小写敏感平台 → 逐段**保留大小写**比较。
 *
 * 这样既不制造误伤（Linux 上 `DOCS/` 确实是另一个目录，不该被管），
 * 也不留绕过口（Windows 上换个大小写就能过门禁）。
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * 本进程所在文件系统是否大小写不敏感。
 * 保守取法：只有明确大小写敏感的平台才算敏感。
 */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'

/**
 * 比较两个路径段是否指向同一项（按平台决定是否忽略大小写）。
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameSegment(a, b) {
  if (a === b) return true
  return CASE_INSENSITIVE_FS && a.toLowerCase() === b.toLowerCase()
}

/** 路径种类（SPEC §4.5 的封闭集合）。 */
export const PATH_KINDS = Object.freeze([
  'doc', // <项目>/docs/**.md，不含 _graveyard
  'graveyard', // <项目>/docs/_graveyard/**
  'deliverable', // <项目>/deliverables/**
  'artifact', // <项目>/_artifacts/**
  'agentsmd', // <项目>/AGENTS.md
  'outside', // 其它（含 src/、工作区外）
])

/** 相对路径 → 段数组；丢掉空段与 `.`。 */
function toSegments(relativePath) {
  return String(relativePath)
    .split(/[\\/]+/)
    .filter((segment) => segment !== '' && segment !== '.')
}

/** 配置项（`docs` / `docs/_graveyard`）→ 段数组。非字符串给空数组。 */
function configSegments(dir, fallback) {
  const value = typeof dir === 'string' && dir.trim() !== '' ? dir : fallback
  return toSegments(value)
}

/**
 * `childSegs` 是否以 `parentSegs` 开头（**逐段**比较，不是字符串前缀）。
 * @param {string[]} childSegs
 * @param {string[]} parentSegs
 * @returns {boolean}
 */
function hasPrefix(childSegs, parentSegs) {
  if (parentSegs.length === 0 || childSegs.length < parentSegs.length) return false
  for (let i = 0; i < parentSegs.length; i += 1) {
    if (!sameSegment(childSegs[i], parentSegs[i])) return false
  }
  return true
}

/**
 * 判定一个绝对路径属于哪一类。
 *
 * @param {string} absPath 路径（绝对路径；相对路径会以项目根为基准解析）。
 * @param {object} layout 目录布局（取自 resolveConfig）。
 * @param {string} layout.projectRoot 绝对路径的项目根。
 * @param {string} [layout.docsDir]
 * @param {string} [layout.graveyardDir]
 * @param {string} [layout.deliverablesDir]
 * @param {string} [layout.artifactsDir]
 * @param {string} [layout.agentsMdName]
 * @returns {'doc'|'graveyard'|'deliverable'|'artifact'|'agentsmd'|'outside'}
 */
export function classifyPath(absPath, layout) {
  if (typeof absPath !== 'string' || absPath.trim() === '') return 'outside'
  if (layout === null || typeof layout !== 'object') return 'outside'
  const projectRoot = layout.projectRoot
  if (typeof projectRoot !== 'string' || projectRoot === '') return 'outside'

  /** @type {string} */
  let rel
  try {
    const root = resolve(projectRoot)
    const full = isAbsolute(absPath) ? resolve(absPath) : resolve(root, absPath)
    rel = relative(root, full)
  } catch {
    return 'outside'
  }

  const segs = toSegments(rel)
  // 项目根自身 / 工作区外 / `..` 逃逸 —— 一律 outside。
  if (segs.length === 0 || segs[0] === '..' || isAbsolute(rel)) return 'outside'

  // 坟场优先判定：它嵌在 docs/ 里，必须先于 doc。
  if (hasPrefix(segs, configSegments(layout.graveyardDir, 'docs/_graveyard'))) return 'graveyard'

  if (hasPrefix(segs, configSegments(layout.docsDir, 'docs'))) {
    // docs/ 下只有 .md 算受管文档；其它（图片、附件、临时文件）不参与门禁与索引。
    const name = segs[segs.length - 1]
    return name.toLowerCase().endsWith('.md') ? 'doc' : 'outside'
  }

  if (hasPrefix(segs, configSegments(layout.deliverablesDir, 'deliverables'))) return 'deliverable'
  if (hasPrefix(segs, configSegments(layout.artifactsDir, '_artifacts'))) return 'artifact'

  const agentsMdName = typeof layout.agentsMdName === 'string' && layout.agentsMdName !== ''
    ? layout.agentsMdName
    : 'AGENTS.md'
  // AGENTS.md 只认项目根下那一份；`docs/AGENTS.md` 不算。
  if (segs.length === 1 && sameSegment(segs[0], agentsMdName)) return 'agentsmd'

  return 'outside'
}

/**
 * 文档绝对路径 → 项目内相对路径（统一 `/`），用于索引展示与匹配。
 * @param {string} absPath
 * @param {object} layout 同 classifyPath
 * @returns {string}
 */
export function relativeToProject(absPath, layout) {
  if (typeof absPath !== 'string') return ''
  const projectRoot = layout?.projectRoot
  if (typeof projectRoot !== 'string' || projectRoot === '') {
    return absPath.replaceAll('\\', '/')
  }
  try {
    const root = resolve(projectRoot)
    const full = isAbsolute(absPath) ? resolve(absPath) : resolve(root, absPath)
    return relative(root, full).split(sep).join('/')
  } catch {
    return absPath.replaceAll('\\', '/')
  }
}

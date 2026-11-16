/**
 * 路径判定的单测（SPEC §12.1）。
 *
 * 重点盯这几条：
 * - `docs-old/` **不能**被误判成 `docs/`（交接 §4.3 #15，用 startsWith 就会踩）
 * - `DOCS/` 大小写在 Windows 上视为同一目录
 * - `docs/_graveyard/x.md` → graveyard（坟场判定优先于 doc）
 * - 工作区外 / `..` 逃逸 → outside
 */

import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { PATH_KINDS, classifyPath, relativeToProject, sameSegment } from '../docs/path.js'

const ROOT = resolve('C:/proj/demo')

/** 默认布局。 */
const LAYOUT = Object.freeze({
  projectRoot: ROOT,
  docsDir: 'docs',
  graveyardDir: 'docs/_graveyard',
  deliverablesDir: 'deliverables',
  artifactsDir: '_artifacts',
  agentsMdName: 'AGENTS.md',
})

/** 在项目根下拼一个路径。 */
function at(...parts) {
  return join(ROOT, ...parts)
}

test('封闭集合：PATH_KINDS 恰好是 SPEC §4.5 的六种', () => {
  assert.deepEqual([...PATH_KINDS].sort(), ['agentsmd', 'artifact', 'deliverable', 'doc', 'graveyard', 'outside'])
})

// ---------------------------------------------------------------- doc

test('docs/ 下的 .md → doc', () => {
  assert.equal(classifyPath(at('docs', 'spec.md'), LAYOUT), 'doc')
})

test('docs/ 深层嵌套的 .md → doc', () => {
  assert.equal(classifyPath(at('docs', 'a', 'b', 'c.md'), LAYOUT), 'doc')
})

test('docs/ 下的非 .md（图片等）→ outside（不参与门禁与索引）', () => {
  assert.equal(classifyPath(at('docs', 'diagram.png'), LAYOUT), 'outside')
})

test('**docs-old/ 不得被误判成 docs/**（不能用 startsWith）', () => {
  assert.equal(classifyPath(at('docs-old', 'x.md'), LAYOUT), 'outside')
})

test('docsBak/ 同样不得误判', () => {
  assert.equal(classifyPath(at('docsBak', 'x.md'), LAYOUT), 'outside')
})

test('docs 作为文件名前缀的兄弟目录（docs_x/）不误判', () => {
  assert.equal(classifyPath(at('docs_x', 'y.md'), LAYOUT), 'outside')
})

// ---------------------------------------------------------------- graveyard

test('docs/_graveyard/x.md → graveyard（优先于 doc）', () => {
  assert.equal(classifyPath(at('docs', '_graveyard', 'x.md'), LAYOUT), 'graveyard')
})

test('graveyard 里的非 .md 也是 graveyard（一律不可读）', () => {
  assert.equal(classifyPath(at('docs', '_graveyard', 'x.txt'), LAYOUT), 'graveyard')
})

test('docs/_graveyard-old/x.md 不误判为 graveyard', () => {
  assert.equal(classifyPath(at('docs', '_graveyard-old', 'x.md'), LAYOUT), 'doc')
})

// ---------------------------------------------------------------- 其它受管目录

test('deliverables/x.html → deliverable', () => {
  assert.equal(classifyPath(at('deliverables', 'x.html'), LAYOUT), 'deliverable')
})

test('_artifacts/x.log → artifact', () => {
  assert.equal(classifyPath(at('_artifacts', 'x.log'), LAYOUT), 'artifact')
})

test('项目根下的 AGENTS.md → agentsmd', () => {
  assert.equal(classifyPath(at('AGENTS.md'), LAYOUT), 'agentsmd')
})

test('docs/AGENTS.md 是文档，不是项目根的那个 agentsmd', () => {
  assert.equal(classifyPath(at('docs', 'AGENTS.md'), LAYOUT), 'doc')
})

test('子目录里的 AGENTS.md 不是 agentsmd（只认项目根那一份）', () => {
  assert.equal(classifyPath(at('src', 'AGENTS.md'), LAYOUT), 'outside')
})

// ---------------------------------------------------------------- outside

test('src/ 下 → outside（M0-3 的前提：未读改 src/ 必须放行）', () => {
  assert.equal(classifyPath(at('src', 'index.js'), LAYOUT), 'outside')
})

test('项目根自身 → outside', () => {
  assert.equal(classifyPath(ROOT, LAYOUT), 'outside')
})

test('工作区外（完全另一个盘/目录）→ outside', () => {
  assert.equal(classifyPath(resolve('D:/elsewhere/docs/x.md'), LAYOUT), 'outside')
})

test('`..` 逃逸出项目根 → outside', () => {
  assert.equal(classifyPath(at('..', 'docs', 'x.md'), LAYOUT), 'outside')
})

test('空路径 / 非字符串 → outside（不抛）', () => {
  assert.equal(classifyPath('', LAYOUT), 'outside')
  assert.equal(classifyPath('   ', LAYOUT), 'outside')
  assert.equal(classifyPath(null, LAYOUT), 'outside')
  assert.equal(classifyPath(undefined, LAYOUT), 'outside')
  assert.equal(classifyPath(123, LAYOUT), 'outside')
})

test('布局缺失 / projectRoot 为空 → outside（不抛）', () => {
  assert.equal(classifyPath(at('docs', 'x.md'), null), 'outside')
  assert.equal(classifyPath(at('docs', 'x.md'), {}), 'outside')
  assert.equal(classifyPath(at('docs', 'x.md'), { projectRoot: '' }), 'outside')
})

// ---------------------------------------------------------------- 大小写

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin'

test('DOCS/ 在大小写不敏感平台视为同一目录（判为 doc），否则不误管', () => {
  // 这不是整洁问题：Windows/NTFS 上写 `DOCS/x.md` 改的就是 `docs/x.md`。
  // 若按大小写敏感比较，该路径会被判成 outside 而放行 —— 门禁被静默绕过。
  assert.equal(classifyPath(at('DOCS', 'x.md'), LAYOUT), CASE_INSENSITIVE ? 'doc' : 'outside')
})

test('.MD 扩展名大小写不敏感（所有平台一致）', () => {
  assert.equal(classifyPath(at('docs', 'x.MD'), LAYOUT), 'doc')
})

test('sameSegment 的行为与平台一致（防止断言空跑）', () => {
  assert.equal(sameSegment('docs', 'docs'), true)
  assert.equal(sameSegment('docs', 'Docs'), CASE_INSENSITIVE)
})

test('Agents.md 在大小写不敏感平台仍识为项目根 AGENTS.md', () => {
  assert.equal(classifyPath(at('Agents.md'), LAYOUT), CASE_INSENSITIVE ? 'agentsmd' : 'outside')
})

// ---------------------------------------------------------------- 自定义布局

test('自定义 docsDir 生效，且旧的 docs/ 不再受管', () => {
  const custom = { ...LAYOUT, docsDir: '文档', graveyardDir: '文档/_graveyard' }
  assert.equal(classifyPath(at('文档', 'x.md'), custom), 'doc')
  assert.equal(classifyPath(at('docs', 'x.md'), custom), 'outside')
})

// ---------------------------------------------------------------- relativeToProject

test('relativeToProject 统一成 / 分隔', () => {
  assert.equal(relativeToProject(at('docs', 'a', 'b.md'), LAYOUT), 'docs/a/b.md')
})

test('relativeToProject 对项目根外给出 ../ 形式而不是抛错', () => {
  const out = relativeToProject(resolve('C:/proj/other/x.md'), LAYOUT)
  assert.match(out, /^\.\.\//)
})

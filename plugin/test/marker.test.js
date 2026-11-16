/**
 * 激活标记探测的单测（SPEC §12.1 的 `marker.test.js`）。
 *
 * 必测：T1 命中 / T2 命中 / **只有空 docs/ → 不命中** / `markerProbeDepth` 上限。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HEAD_BYTES,
  MARKER_T1,
  MARKER_T2,
  findProjectRoot,
  looksLikeDddDoc,
  probeMarker,
} from '../docs/marker.js'

const LAYOUT = Object.freeze({
  docsDir: 'docs',
  graveyardDir: 'docs/_graveyard',
  agentsMdName: 'AGENTS.md',
})

/** 简易路径拼接（window 风格也不影响判定）。 */
function joinPath(...parts) {
  return parts.join('\\').replace(/\\+/g, '\\')
}

/** 造一份内存文件系统。 */
function fakeFs(tree) {
  const files = new Map(Object.entries(tree))
  const dirs = new Map()
  for (const key of files.keys()) {
    const parts = key.split('\\')
    for (let i = 1; i < parts.length; i += 1) {
      const dir = parts.slice(0, i).join('\\')
      const name = parts[i - 1]
      if (name === '') continue
      if (!dirs.has(dir)) dirs.set(dir, new Set())
      dirs.get(dir).add(parts[i] ?? '')
    }
  }
  return {
    listDir: async (path) => {
      const names = dirs.get(path) ?? new Set()
      const out = []
      for (const name of names) {
        if (name === '') continue
        const full = `${path}\\${name}`
        out.push({ name, type: files.has(full) ? 'file' : 'directory' })
      }
      return out
    },
    readHead: async (path) => (files.has(path) ? files.get(path).slice(0, HEAD_BYTES) : undefined),
  }
}

/** 合法文档。 */
const DDD_DOC = '---\nid: spec-tier2\nrole: spec\nstatus: authoritative\n---\n# 标题\n'

// ---------------------------------------------------------------- looksLikeDddDoc（T1 的判定内核）

test('T1 内核：id + role + status 齐全 → true', () => {
  assert.equal(looksLikeDddDoc(DDD_DOC), true)
})

test('T1 内核：缺 role → false', () => {
  assert.equal(looksLikeDddDoc('---\nid: a\nstatus: authoritative\n---\n'), false)
})

test('T1 内核：缺 id → false', () => {
  assert.equal(looksLikeDddDoc('---\nrole: spec\nstatus: authoritative\n---\n'), false)
})

test('T1 内核：缺 status → false', () => {
  assert.equal(looksLikeDddDoc('---\nid: a\nrole: spec\n---\n'), false)
})

test('T1 内核：完全没有 frontmatter → false（这正是普通仓库的情况）', () => {
  assert.equal(looksLikeDddDoc('# 普通 README\n\n没有元数据\n'), false)
})

test('T1 内核：frontmatter 坏了（块式列表）→ false', () => {
  assert.equal(looksLikeDddDoc('---\nid: a\nrole: spec\nstatus: authoritative\nscope:\n  - x\n---\n'), false)
})

test('T1 内核：字段在但值为空 → false', () => {
  assert.equal(looksLikeDddDoc('---\nid:\nrole: spec\nstatus: authoritative\n---\n'), false)
})

test('T1 内核：垃圾输入不抛', () => {
  assert.equal(looksLikeDddDoc(null), false)
  assert.equal(looksLikeDddDoc(undefined), false)
  assert.equal(looksLikeDddDoc(''), false)
})

// ---------------------------------------------------------------- probeMarker

test('T2 命中：AGENTS.md 里有标记', async () => {
  const fs = fakeFs({ 'C:\\proj\\AGENTS.md': '# 规则\n\n<!-- ddd:index v1 -->\n' })
  const result = await probeMarker({
    projectRoot: 'C:\\proj', layout: LAYOUT, joinPath, ...fs,
  })
  assert.equal(result.hit, true)
  assert.equal(result.via, MARKER_T2)
})

test('T1 命中：docs/ 下有合法 frontmatter 的 .md', async () => {
  const fs = fakeFs({ 'C:\\proj\\docs\\spec.md': DDD_DOC })
  const result = await probeMarker({
    projectRoot: 'C:\\proj', layout: LAYOUT, joinPath, ...fs,
  })
  assert.equal(result.hit, true)
  assert.equal(result.via, MARKER_T1)
  assert.match(result.file, /spec\.md/)
})

test('**只有空 docs/ → 不命中**（交接 §3.8 的核心用例）', async () => {
  const fs = fakeFs({ 'C:\\proj\\docs\\.keep': '' })
  // 目录存在但没有 .md
  const result = await probeMarker({
    projectRoot: 'C:\\proj', layout: LAYOUT, joinPath, ...fs,
  })
  assert.equal(result.hit, false)
})

test('docs/ 里有 .md 但**没有 frontmatter** → 不命中（M0-12 的场景）', async () => {
  const fs = fakeFs({ 'C:\\proj\\docs\\guide.md': '# 普通文档\n\n没有元数据\n' })
  const result = await probeMarker({
    projectRoot: 'C:\\proj', layout: LAYOUT, joinPath, ...fs,
  })
  assert.equal(result.hit, false)
})

test('docs/ 里有 .md 但 frontmatter 不全 → 不命中', async () => {
  const fs = fakeFs({ 'C:\\proj\\docs\\half.md': '---\nid: a\n---\n正文\n' })
  const result = await probeMarker({
    projectRoot: 'C:\\proj', layout: LAYOUT, joinPath, ...fs,
  })
  assert.equal(result.hit, false)
})

test('完全没有 docs/ 与 AGENTS.md → 不命中且不抛', async () => {
  const fs = fakeFs({})
  const result = await probeMarker({
    projectRoot: 'C:\\proj', layout: LAYOUT, joinPath, ...fs,
  })
  assert.equal(result.hit, false)
})

test('T2 优先于 T1（AGENTS.md 标记先查，省一次目录扫描）', async () => {
  const fs = fakeFs({
    'C:\\proj\\AGENTS.md': '<!-- ddd:index -->',
    'C:\\proj\\docs\\spec.md': DDD_DOC,
  })
  const result = await probeMarker({ projectRoot: 'C:\\proj', layout: LAYOUT, joinPath, ...fs })
  assert.equal(result.via, MARKER_T2)
})

test('readHead 抛错时降级为不命中，不向外抛', async () => {
  const result = await probeMarker({
    projectRoot: 'C:\\proj',
    layout: LAYOUT,
    joinPath,
    listDir: async () => { throw new Error('denied') },
    readHead: async () => { throw new Error('denied') },
  })
  assert.equal(result.hit, false)
})

// ---------------------------------------------------------------- findProjectRoot

test('向上探测：在子目录里能找到带标记的项目根', async () => {
  const fs = fakeFs({ 'C:\\proj\\docs\\spec.md': DDD_DOC })
  const parents = {
    'C:\\proj\\src\\deep': 'C:\\proj\\src',
    'C:\\proj\\src': 'C:\\proj',
    'C:\\proj': 'C:\\',
    'C:\\': undefined,
  }
  const result = await findProjectRoot({
    cwd: 'C:\\proj\\src\\deep',
    parentOf: (path) => parents[path],
    probe: (root) => probeMarker({ projectRoot: root, layout: LAYOUT, joinPath, ...fs }),
  })
  assert.equal(result.projectRoot, 'C:\\proj')
  assert.equal(result.depth, 2)
})

test('向上探测：一个都没标记 → 返回无 projectRoot', async () => {
  const fs = fakeFs({})
  const parents = { 'C:\\a\\b': 'C:\\a', 'C:\\a': 'C:\\', 'C:\\': undefined }
  const result = await findProjectRoot({
    cwd: 'C:\\a\\b',
    parentOf: (path) => parents[path],
    probe: (root) => probeMarker({ projectRoot: root, layout: LAYOUT, joinPath, ...fs }),
  })
  assert.equal(result.projectRoot, undefined)
})

test('**markerProbeDepth 是硬上限**：超出就不再往上扫', async () => {
  const fs = fakeFs({ 'C:\\proj\\docs\\spec.md': DDD_DOC })
  const parents = {
    'C:\\proj\\a': 'C:\\proj',
    'C:\\proj\\a\\b': 'C:\\proj\\a',
    'C:\\proj\\a\\b\\c': 'C:\\proj\\a\\b',
    'C:\\proj': 'C:\\',
    'C:\\': undefined,
  }
  let probed = 0
  const result = await findProjectRoot({
    cwd: 'C:\\proj\\a\\b\\c',
    maxDepth: 2, // 只允许 3 次探测（c, b, a），够不到 C:\proj
    parentOf: (path) => parents[path],
    probe: async (root) => {
      probed += 1
      return probeMarker({ projectRoot: root, layout: LAYOUT, joinPath, ...fs })
    },
  })
  assert.equal(result.projectRoot, undefined, '不该越过深度上限找到根')
  assert.ok(probed <= 3, `探测了 ${probed} 次，超过 maxDepth=2 的上限`)
})

test('深度上限内能命中时正常返回', async () => {
  const fs = fakeFs({ 'C:\\proj\\docs\\spec.md': DDD_DOC })
  const parents = { 'C:\\proj\\src': 'C:\\proj', 'C:\\proj': undefined }
  const result = await findProjectRoot({
    cwd: 'C:\\proj\\src',
    maxDepth: 4,
    parentOf: (path) => parents[path],
    probe: (root) => probeMarker({ projectRoot: root, layout: LAYOUT, joinPath, ...fs }),
  })
  assert.equal(result.projectRoot, 'C:\\proj')
})

test('parentOf 立刻返回 undefined 时不死循环', async () => {
  const result = await findProjectRoot({
    cwd: 'C:\\x',
    parentOf: () => undefined,
    probe: async () => ({ hit: false }),
  })
  assert.equal(result.projectRoot, undefined)
})

test('非法 cwd 不抛', async () => {
  const result = await findProjectRoot({ cwd: null, parentOf: () => undefined, probe: async () => ({ hit: false }) })
  assert.equal(result.projectRoot, undefined)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRegistry } from '../adapters/registry.js'
import { renderAgentsMd } from '../core/agentsMd.js'
import { entryPointOf } from '../core/navigation.js'
import { renderDocText } from '../tools/doc-new.js'

test('M4: role-only change notifies AGENTS and keeps its entry aligned with live navigation', async () => {
  const files = new Map()
  const text = (id, role, order) => renderDocText({ id, title: id, role, order, status: 'authoritative', summary: id }, `# ${id}`)
  files.set('C:/role-test/docs/project.md', text('project', 'index', 0))
  files.set('C:/role-test/docs/candidate.md', text('candidate', 'spec', -10))
  const reg = createRegistry({
    config: { maxWatchedDocs: 100 }, layout: { docsAbs: 'C:/role-test/docs' },
    listDir: async () => [...files.keys()].map((path) => ({ name: path.split('/').at(-1), type: 'file' })),
    readText: async (path) => files.get(path), joinPath: (a, b) => `${a}/${b}`, classify: () => 'doc',
  })
  const blocks = []
  reg.onIndexChanged(() => blocks.push(renderAgentsMd(reg.index)))
  await reg.rescan()
  assert.equal(entryPointOf(reg.entries)?.meta.id, 'project')
  assert.match(blocks.at(-1), /### 当前入口\n- `project`/)

  files.set('C:/role-test/docs/candidate.md', text('candidate', 'handover', -10))
  await reg.rescan()
  assert.equal(blocks.length, 2, 'role affects current entry and must trigger slow navigation refresh')
  assert.equal(entryPointOf(reg.entries)?.meta.id, 'candidate')
  assert.match(blocks.at(-1), /### 当前入口\n- `candidate`/)

  files.set('C:/role-test/docs/candidate.md', text('candidate', 'spec', -10))
  await reg.rescan()
  assert.equal(blocks.length, 3)
  assert.equal(entryPointOf(reg.entries)?.meta.id, 'project')
  assert.match(blocks.at(-1), /### 当前入口\n- `project`/)

  await reg.rescan()
  assert.equal(blocks.length, 3, 'unchanged role and metadata must not create redundant AGENTS notifications')
})

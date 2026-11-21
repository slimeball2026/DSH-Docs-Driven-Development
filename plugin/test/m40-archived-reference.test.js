import assert from 'node:assert/strict'
import test from 'node:test'
import { parseFrontmatter } from '../docs/frontmatter.js'
import { finalizeDocs } from '../docs/scan.js'
import { buildIndex } from '../core/index.js'
import { currentHandoverOf } from '../core/navigation.js'
import { renderDocText } from '../tools/doc-new.js'

function provisional(id, extra = {}) {
  const text = renderDocText({ id, title: id, role: 'handover', order: 0,
    status: 'authoritative', summary: id, ...extra }, `# ${id}`)
  const parsed = parseFrontmatter(text)
  return { path: `C:/archive-test/docs/${id}.md`, text, body: parsed.body,
    raw: parsed.meta, parseError: parsed.error }
}

test('M4: archiving a void predecessor leaves the published handover discoverable', () => {
  const current = provisional('current', { order: -20, supersedes: ['old'] })
  const old = provisional('old', { order: -10, status: 'void' })
  assert.equal(currentHandoverOf(finalizeDocs([current, old]))?.meta.id, 'current')

  // The retained archive path moves old under _graveyard, outside the active scan.
  const after = finalizeDocs([current])
  assert.equal(currentHandoverOf(after)?.meta.id, 'current')
  assert.equal(after[0].hasError, false)
  assert.ok(buildIndex(after).required.includes(after[0]))
  const finding = after[0].issues.find((item) => item.rule === 'V5')
  assert.equal(finding?.level, 'warn', 'historical absence remains visible without hiding the current entry')
  assert.match(finding.message, /old/)
  assert.deepEqual(after[0].meta.supersedes, ['old'], 'no reference rewriting or migration is required')

  const restored = finalizeDocs([current, old])
  assert.equal(currentHandoverOf(restored)?.meta.id, 'current')
  assert.equal(restored[0].issues.some((item) => item.rule === 'V5'), false)
})

test('M4: missing forward replacement is still an error while historical absence is only a warning', () => {
  const [entry] = finalizeDocs([provisional('old', { status: 'superseded',
    supersedes: ['archived-before'], supersededBy: ['missing-successor'] })])
  assert.equal(entry.hasError, true)
  assert.equal(entry.issues.find((item) => item.message.includes('archived-before'))?.level, 'warn')
  assert.equal(entry.issues.find((item) => item.message.includes('missing-successor'))?.level, 'error')
  assert.equal(currentHandoverOf([entry]), undefined)
})

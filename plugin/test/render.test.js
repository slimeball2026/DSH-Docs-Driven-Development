import assert from 'node:assert/strict'
import test from 'node:test'
import { buildIndex } from '../core/index.js'
import { DEFAULT_MAX_CHARS, fitBudget, renderIndexBlock, shortVersion, statusMark } from '../core/render.js'
const entry = (id, role = 'spec', status = 'authoritative', extra = {}) => ({ meta: { id, role, status, order: 0, summary: `${id} summary`, ...extra }, fingerprint: 'abcdef123456', issues: [], hasError: false })
const render = (entries, extra = {}) => renderIndexBlock({ index: buildIndex(entries), activated: true, ...extra })
test('inactive/empty input emits nothing', () => {
  assert.equal(render([entry('index', 'index')], { activated: false }), '')
  for (const input of [null, {}, { index: null }]) assert.equal(renderIndexBlock(input), '')
})
test('only current published handover is injected; complete directory is not a reading prerequisite', () => {
  const text = render([entry('index', 'index'), entry('current', 'handover'), entry('irrelevant-spec'), entry('draft', 'handover', 'draft')])
  assert.match(text, /【入口】`current`/)
  assert.doesNotMatch(text, /irrelevant-spec|`draft`|`index`|未读完必读|可以动 docs/)
  assert.match(text, /glob docs\/\*\.md/)
  assert.match(text, /旧磁盘清单可能过时/)
})
test('gate text describes target file and successful self edit accurately', () => {
  const text = render([entry('index', 'index')])
  assert.match(text, /按目标文件/)
  assert.match(text, /外部改动须重读/)
  assert.match(text, /自己成功修改后不用重读/)
  assert.doesNotMatch(text, /改过的文档立刻变回未读/)
})
test('read state stays in the UI; only changed entry version changes injection', () => {
  const entries = [entry('index', 'index'), entry('other')]
  assert.equal(render(entries), render(entries, { readSet: new Map([['index', { fingerprint: 'abcdef123456' }]]) }))
  const changed = render(entries, { currentFingerprint: () => 'bbbbbb123456' })
  assert.match(changed, /vbbbbbb/)
  assert.doesNotMatch(changed, /`other`|版本已变，请重读/)
})
test('sealed and metadata errors remain visible and never become the entry', () => {
  const bad = entry('broken', 'handover'); bad.hasError = true; bad.issues = [{ level: 'error', message: '坏字段' }]
  const text = render([entry('trap', 'spec', 'sealed'), bad])
  assert.match(text, /【禁止执行】[\s\S]*trap/)
  assert.match(text, /【文档异常】[\s\S]*坏字段/)
  assert.doesNotMatch(text, /【入口】/)
})
test('ordinary navigation remains bounded with many reference docs', () => {
  const text = render([entry('index', 'index'), ...Array.from({ length: 100 }, (_, i) => entry(`doc-${i}`))])
  assert.ok(text.length <= DEFAULT_MAX_CHARS, String(text.length))
})
test('same state is stable; read bookkeeping times do not leak', () => {
  const entries = [entry('index', 'index')]
  const a = render(entries, { readSet: new Map([['index', { fingerprint: 'abcdef123456', at: 12345, seq: 999 }]]) })
  const b = render(entries, { readSet: new Map([['index', { fingerprint: 'abcdef123456', at: 99999, seq: 888 }]]) })
  assert.equal(a, b)
  assert.doesNotMatch(a, /12345|99999|\bseq\b|\d{4}-\d{2}-\d{2}/)
})
test('many warnings collapse to live-directory route, never obsolete AGENTS directory', () => {
  const text = render(Array.from({ length: 100 }, (_, i) => entry(`trap-${i}`, 'spec', 'sealed')))
  assert.match(text, /【禁止执行】100 份/)
  assert.match(text, /完整清单见 DDD 面板/)
  assert.ok(text.length < 500)
})
test('fitBudget retains pinned safety text and does not mutate input', () => {
  const sections = [{ key: 'gate', pinned: true, text: 'gate' }, { key: 'anomaly', text: '【文档异常】\n' + 'x\n'.repeat(30) }]
  const original = JSON.stringify(sections)
  assert.match(fitBudget(sections, 30), /gate/)
  assert.equal(JSON.stringify(sections), original)
})
test('version and status utility compatibility', () => {
  assert.equal(shortVersion('abcdef123456'), 'abcdef')
  assert.equal(shortVersion(null), '??????')
  assert.equal(new Set(['authoritative', 'partial', 'superseded', 'sealed', 'void', 'draft'].map(statusMark)).size, 6)
})

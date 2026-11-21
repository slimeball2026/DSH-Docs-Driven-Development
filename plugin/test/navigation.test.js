import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { currentHandoverOf, entryPointOf } from '../core/navigation.js'
const entry = (id, role = 'handover', status = 'authoritative', order = 0) => ({ meta: { id, role, status, order }, issues: [], hasError: false })
test('published handover sorts by finite order then lexical id; returns original without mutation', () => {
  const a = entry('a', 'handover', 'authoritative', -10), b = entry('b', 'handover', 'authoritative', -10)
  const list = [b, entry('new', 'handover', 'draft', -50), a]
  assert.equal(currentHandoverOf(list), a)
  assert.equal(list[0], b)
  assert.equal(entryPointOf(list), a)
})
test('rejects erroneous, unmanaged, graveyard and non-authoritative handovers', () => {
  for (const extra of [{ hasError: true }, { unmanaged: true }, { inGraveyard: true }, { issues: [{ level: 'error' }] }]) {
    assert.equal(currentHandoverOf([{ ...entry('bad'), ...extra }]), undefined)
  }
  for (const status of ['draft', 'partial', 'superseded', 'void', 'sealed']) assert.equal(currentHandoverOf([entry('bad', 'handover', status)]), undefined)
})
test('falls back only to valid authoritative/partial index', () => {
  const index = entry('index', 'index', 'partial')
  assert.equal(entryPointOf([entry('draft', 'handover', 'draft'), index]), index)
  assert.equal(entryPointOf([entry('spec', 'spec')]), undefined)
  assert.equal(entryPointOf(null), undefined)
})
test('M4 UI describes reference reading, current entry and stale disk lists without global gate promises', () => {
  const main = readFileSync(new URL('../src/client/main-page.tsx', import.meta.url), 'utf8')
  const dashboard = readFileSync(new URL('../src/client/dashboard.tsx', import.meta.url), 'utf8')
  const bar = readFileSync(new URL('../src/client/read-order-bar.tsx', import.meta.url), 'utf8')
  assert.match(main, /snapshot\.entryPoint/)
  assert.match(main, /navigationNotice/)
  assert.match(dashboard, /参考文档阅读记录/)
  assert.doesNotMatch(dashboard, /可以动 docs\//)
  assert.match(bar, /不要求先读完整个目录/)
})

test('invalid order sorts last; publication does not imply immutable or completed', () => {
  const first = entry('first', 'handover', 'authoritative', -10)
  assert.equal(currentHandoverOf([entry('nan', 'handover', 'authoritative', NaN), first]), first)
  first.text = 'Later correction after publication'
  assert.equal(entryPointOf([first]).text, 'Later correction after publication')
})

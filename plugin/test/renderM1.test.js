import assert from 'node:assert/strict'
import test from 'node:test'
import { buildIndex } from '../core/index.js'
import { renderIndexBlock } from '../core/render.js'
const entries = [{ meta: { id: 'index', role: 'index', status: 'authoritative', order: 0, summary: 'Project' }, fingerprint: 'abcdef123456', hasError: false, issues: [] }]
test('M4 retires mandatory whole-directory budget and static workflow tutorials from injection', () => {
  const text = renderIndexBlock({ index: buildIndex(entries), budgetLine: '【预算】必读 90 份', projectLine: 'old project hint', sliceLine: 'M99' })
  assert.match(text, /【入口】`index`/)
  assert.doesNotMatch(text, /【预算】|【怎么做】|M99|old project hint|其它小节手写|索引成员自动/)
})
test('M4 read bookkeeping for unrelated docs does not change compact navigation', () => {
  const index = buildIndex(entries)
  assert.equal(renderIndexBlock({ index }), renderIndexBlock({ index, readSet: new Map([['unrelated', { fingerprint: 'other' }]]) }))
})

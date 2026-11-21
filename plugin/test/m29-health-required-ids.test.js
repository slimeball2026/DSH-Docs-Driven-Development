import assert from 'node:assert/strict'
import test from 'node:test'
import { createHealthTool } from '../tools/doc-health.js'

const entries = [
  { meta: { id: 'read-order', role: 'index', status: 'authoritative' }, text: 'handover-1 spec-1' },
  { meta: { id: 'handover-1', role: 'handover', status: 'authoritative' } },
  { meta: { id: 'spec-1', role: 'spec', status: 'authoritative' } },
]
const makeTool = (required = entries.slice(1), anchors = {}) => createHealthTool({ registry: { entries, index: { required } }, anchors })

test('M4: health retains structured reference ids without making reading a precondition', async () => {
  const tool = makeTool()
  const value = await tool.execute({}, {})
  assert.deepEqual(value.stats.requiredIds, ['handover-1', 'spec-1'])
  assert.equal(value.stats.required, 2)
  const text = tool.output.render({}, value)[0].text
  assert.doesNotMatch(text, /必读|先读|5 项|全过/)
  assert.equal(tool.output.schema.properties.stats.properties.requiredIds.type, 'array')
})

test('M4: health accepts an empty reference directory', async () => {
  const value = await makeTool([]).execute({}, {})
  assert.deepEqual(value.stats.requiredIds, [])
  assert.equal(value.stats.required, 0)
})

test('M4: unknown explicit anchors stay visible as not checked', async () => {
  const tool = createHealthTool({ registry: { entries: [
    { meta: { id: 'i', role: 'index', status: 'authoritative', verifiedDsh: '1.0' } },
  ], index: { required: [] } } })
  const value = await tool.execute({}, {})
  assert.equal(value.skipped.length, 1)
  assert.match(tool.output.render({}, value)[0].text, /未检查的环境锚点/)
})

test('M4: health rule inventory has no snapshot or basis gate', async () => {
  const value = await makeTool().execute({}, {})
  assert.deepEqual(value.rules.map((rule) => rule.rule), ['H-1', 'H-2', 'H-3', 'H-4'])
})

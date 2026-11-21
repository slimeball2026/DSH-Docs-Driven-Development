import assert from 'node:assert/strict'
import test from 'node:test'
import { createHealthTool } from '../tools/doc-health.js'

const entry = (id, extra = {}) => ({ meta: { id, role: 'spec', status: 'authoritative', basis: '未验证', ...extra }, text: `# ${id}` })
const index = entry('read-order', { role: 'index' })
const exec = { agent: { session: {} } }

test('M4: health never calls filesystem or snapshot dependencies', async () => {
  let touches = 0
  const fail = () => { touches += 1; throw new Error('filesystem must not be touched') }
  const entries = [index, entry('spec', { verifiedDsh: 'old' })]
  const original = JSON.stringify(entries)
  const tool = createHealthTool({
    registry: { entries, index: { required: entries } }, anchors: { dsh: 'new' },
    projectRootOf: fail,
    fs: { resolve: fail, readText: fail, writeText: fail },
  })
  const first = await tool.execute({}, exec)
  const second = await tool.execute({}, exec)
  assert.equal(touches, 0)
  assert.equal(JSON.stringify(entries), original)
  assert.deepEqual(first, second)
  assert.equal(first.issues.some((issue) => ['H-5', 'H-6'].includes(issue.rule)), false)
  assert.equal(first.stats.warnings, first.issues.filter((issue) => issue.level === 'warn').length)
  assert.equal(first.stats.errors, first.issues.filter((issue) => issue.level === 'error').length)
})

test('M4: scope errors filters output counts without changing structural rules', async () => {
  const tool = createHealthTool({ registry: { entries: [entry('orphan')], index: { required: [] } } })
  const all = await tool.execute({}, exec)
  assert.ok(all.issues.length > 0)
  const errors = await tool.execute({ scope: 'errors' }, exec)
  assert.deepEqual(errors.issues, [])
  assert.equal(errors.stats.warnings, 0)
  assert.deepEqual(errors.rules, all.rules)
})

test('M4: health findings do not certify deception or completion', async () => {
  const tool = createHealthTool({ registry: { entries: [entry('a')], index: { required: [] } } })
  const value = await tool.execute({}, exec)
  const text = tool.output.render({}, value)[0].text
  assert.doesNotMatch(text, /文档在骗人|全过|可以交接|归零/)
  assert.match(text, /不阻塞施工/)
})

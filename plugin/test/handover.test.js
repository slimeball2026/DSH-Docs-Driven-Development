import assert from 'node:assert/strict'
import test from 'node:test'
import { checkHandover, handoverMinOrder, handoverListOf, indexDocsOf, parseHandoverSections, splitSections } from '../core/handover.js'
import { createHandoverCheckTool, pickHandover } from '../tools/doc-handover-check.js'

const entry = (id, status = 'authoritative', order = 0, body = '无后续任务。') => ({
  meta: { id, role: 'handover', status, order }, body,
})
const toolFor = (entries = []) => createHandoverCheckTool({ registry: { entries } })

test('M4: optional diagnostics accept prose, no next task and untested results', () => {
  for (const body of ['无后续任务。', '本轮未执行测试。', '没有交付，坟场为空。', '验收：2/2 符合。', '1']) {
    const value = checkHandover({ body, meta: entry('h').meta, context: { strict: true, minOrder: -1000 } })
    assert.equal(value.ok, true)
    assert.deepEqual(value.errors, [])
    assert.deepEqual(value.warnings, [])
    assert.equal(value.stats.sectionsTotal, 0)
  }
})

test('M4: empty body is an objective error, independent of strict config', () => {
  for (const body of ['', ' \n\t', undefined, null]) {
    const value = checkHandover({ body, context: { strict: false } })
    assert.equal(value.ok, false)
    assert.deepEqual(value.errors.map((item) => item.rule), ['HD-EMPTY'])
  }
  assert.doesNotThrow(() => checkHandover(null))
})

test('M4: wrong role is diagnosed without judging text quality', () => {
  assert.deepEqual(checkHandover({ body: '内容', meta: { role: 'spec' } }).errors.map((item) => item.rule), ['HD-ROLE'])
})

test('M4: body input takes precedence and does not access registry', async () => {
  const tool = createHandoverCheckTool({ registry: () => { throw new Error('registry accessed') } })
  const value = await tool.execute({ id: 'missing', body: '无后续任务。' }, {})
  assert.equal(value.ok, true)
  assert.equal(value.id, '(文本)')
  assert.deepEqual(value.sections, [])
  assert.match(tool.output.render({}, value)[0].text, /未检查内容真实性/)
})

test('M4: empty body input never falls back to an existing document', async () => {
  const value = await toolFor([entry('h')]).execute({ id: 'h', body: '' }, {})
  assert.equal(value.ok, false)
  assert.equal(value.errors[0].rule, 'HD-EMPTY')
})

test('M4: explicit missing id and wrong-role id return distinct findings', async () => {
  const tool = toolFor([{ meta: { id: 'spec', role: 'spec' }, body: '1' }, entry('h')])
  const missing = await tool.execute({ id: 'not-there' }, {})
  assert.equal(missing.id, 'not-there')
  assert.equal(missing.errors[0].rule, 'HD-MISSING')
  assert.match(missing.errors[0].message, /not-there/)
  const wrong = await tool.execute({ id: 'spec' }, {})
  assert.equal(wrong.errors[0].rule, 'HD-ROLE')
})

test('M4: no current handover does not invent a document creation task', async () => {
  const tool = toolFor([entry('draft', 'draft', -100)])
  const value = await tool.execute({}, {})
  assert.equal(value.ok, false)
  assert.deepEqual(value.errors, [])
  assert.equal(value.warnings[0].rule, 'HD-NO-CURRENT')
  const rendered = tool.output.render({}, value)[0].text
  assert.match(rendered, /未诊断任何文档/)
  assert.doesNotMatch(rendered, /doc_new|先.*建|必须.*建/)
  assert.equal((await tool.execute({ id: 'draft' }, {})).ok, true)
})

test('M4: default selection prefers valid published order then id', () => {
  const entries = [entry('draft', 'draft', -100), entry('z', 'authoritative', -10), entry('a', 'authoritative', -10),
    { ...entry('bad', 'authoritative', -20), hasError: true }]
  assert.equal(pickHandover(entries).entry.meta.id, 'a')
  assert.equal(pickHandover(entries, 'draft').entry.meta.id, 'draft')
})

test('M4: published handover can be corrected later without freshness diagnostics', async () => {
  const current = entry('h', 'authoritative', 50, '当前未执行测试。')
  const tool = toolFor([current])
  assert.equal((await tool.execute({}, {})).ok, true)
  current.body = '后续发现漏项并修复；没有后续任务。'
  const value = await tool.execute({}, {})
  assert.equal(value.ok, true)
  assert.deepEqual(value.warnings, [])
})

test('M4: assertion hook remains active and input keys stay id/body', async () => {
  const tool = createHandoverCheckTool({ assertAllowed: () => { throw new Error('scope denied') } })
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['body', 'id'])
  await assert.rejects(() => tool.execute({ body: 'x' }, {}), /scope denied/)
})

test('legacy navigation parsers remain available without becoming requirements', () => {
  const body = '## 现状\n当前\n### 细节\n子节\n## 下一步\n- 无\n## 验收\n未测'
  assert.equal(splitSections(body)[0].text, '当前\n### 细节\n子节')
  const parsed = parseHandoverSections(body)
  assert.equal(parsed.next.text, '- 无')
  assert.equal(parsed.intent.found, false)
  assert.equal(checkHandover({ body }).ok, true)
})

test('shared handover/index helpers retain production behavior', () => {
  const entries = [entry('h', 'draft', -20), { meta: { id: 'i', title: '入口', role: 'index', order: -100 } }]
  assert.equal(handoverMinOrder(entries), -20)
  assert.equal(handoverMinOrder([{ meta: { role: 'handover', order: NaN } }]), undefined)
  assert.deepEqual(handoverListOf(entries), [{ id: 'h', status: 'draft', order: -20 }])
  assert.deepEqual(indexDocsOf(entries), [{ id: 'i', title: '入口' }])
})

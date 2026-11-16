/**
 * M1.5 的最后两项拍板（用户 2026-11-12）：
 *   - **D5 选 B**：索引块加 `【施工】` 行，**只显示切片名**（不含阶段/下一步）
 *   - **L34 选 c**：`doc_new` 建交接时若 order 不是最小，**返回值里警告，但不改行为**
 *
 * 这两个文件级测试的**重点都是反向断言**：
 *   - D5：不许出现"阶段/下一步"这类快变量；不许写占位
 *   - L34：正常情况**绝不**警告（否则警告会变成噪音，与 N2 的教训相反）
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { fitBudget, renderIndexBlock, sliceLineOf } from '../core/render.js'
import { handoverOrderWarningOf } from '../tools/doc-new.js'

// ================================================================ D5

/** 一个最小的渲染输入。 */
function blockInput(extra = {}) {
  return {
    index: {
      required: [{ meta: { id: 'a', summary: 'a', status: 'authoritative' }, fingerprint: 'abcdef' }],
      forbidden: [],
      anomalies: [],
    },
    readSet: new Map(),
    activated: true,
    budgetLine: '【预算】必读 1 份 ≈ 10 tokens（上限 30k）',
    ...extra,
  }
}

test('D5-B：sliceLineOf 取 role:index 的 slice 字段', () => {
  const line = sliceLineOf({ entries: [
    { meta: { id: 'read-order', role: 'index', slice: 'M1.5' }, hasError: false },
  ] })
  assert.equal(line, 'M1.5')
})

test('D5-B：没有 slice 时**退到 scope[0]**（用已有字段，不逼人加新字段）', () => {
  const line = sliceLineOf({ entries: [
    { meta: { id: 'read-order', role: 'index', scope: ['M2', 'M3'] }, hasError: false },
  ] })
  assert.equal(line, 'M2', '取第一个')
})

test('D5-B：`slice` 优先于 `scope`', () => {
  const line = sliceLineOf({ entries: [
    { meta: { id: 'i', role: 'index', slice: 'M1.5', scope: ['M2'] }, hasError: false },
  ] })
  assert.equal(line, 'M1.5')
})

test('D5-B：**都没有 → 空串（整行不显示）**，不写占位', () => {
  assert.equal(sliceLineOf({ entries: [] }), '')
  assert.equal(sliceLineOf({}), '')
  assert.equal(sliceLineOf(undefined), '')
  assert.equal(sliceLineOf({ entries: [{ meta: { id: 'i', role: 'index' }, hasError: false }] }), '')
  // 空白字符串不算
  assert.equal(sliceLineOf({ entries: [{ meta: { id: 'i', role: 'index', slice: '   ' }, hasError: false }] }), '')
})

test('D5-B：**只认 role: index**（spec 上的 slice 不算）', () => {
  const line = sliceLineOf({ entries: [
    { meta: { id: 's', role: 'spec', slice: '不该被用' }, hasError: false },
    { meta: { id: 'i', role: 'index', slice: 'M1.5' }, hasError: false },
  ] })
  assert.equal(line, 'M1.5')
})

test('D5-B：跳过 hasError 的文档（坏字段不可信）', () => {
  const line = sliceLineOf({ entries: [
    { meta: { id: 'bad', role: 'index', slice: '坏的' }, hasError: true },
    { meta: { id: 'good', role: 'index', slice: 'M1.5' }, hasError: false },
  ] })
  assert.equal(line, 'M1.5')
})

test('D5-B：超长切片名被截断', () => {
  const long = 'x'.repeat(100)
  const line = sliceLineOf({ entries: [{ meta: { id: 'i', role: 'index', slice: long }, hasError: false }] })
  assert.ok(line.length <= 41, `实际 ${line.length}`)
  assert.match(line, /…$/)
})

test('D5-B：索引块里出现【施工】行', () => {
  const block = renderIndexBlock(blockInput({ sliceLine: 'M1.5' }))
  assert.match(block, /【施工】M1\.5/)
})

test('D5-B 反向：拿不到切片名时**整行不出现、不写占位**', () => {
  const block = renderIndexBlock(blockInput({ sliceLine: '' }))
  assert.equal(block.includes('【施工】'), false)
  assert.equal(/未知切片|未设置|（无）/.test(block), false, '不许写占位——那是永久噪声')
})

test('D5-B 反向：**绝不出现「阶段 / 下一步」**（这是选项 A 才有的快变量）', () => {
  // 这条是**守住拍板结果**的断言：如果将来有人"顺手"把阶段加进来，它必须红。
  const block = renderIndexBlock(blockInput({ sliceLine: 'M1.5' }))
  assert.equal(/【阶段】|【下一步】/.test(block), false, '选项 A 的快变量段不该存在')
})

test('D5-B：【施工】是 pinned，**极小预算下也不被裁掉**', () => {
  const sections = [
    { key: 'gate', text: '【门禁】0/30 ｜ 未读完必读清单，改 docs/ 会被拒绝', pinned: true },
    { key: 'project', text: '【项目】一个很长的项目简介'.repeat(3), pinned: true },
    { key: 'work', text: '【施工】M1.5', pinned: true },
    { key: 'unread', text: `【未读】\n${Array.from({ length: 40 }, () => '- `x` · 很长的摘要'.repeat(3)).join('\n')}` },
  ]
  const cropped = fitBudget(sections, 150)
  assert.match(cropped, /【施工】M1\.5/, 'pinned 段被裁了 —— D5 等于没做')
  assert.equal(cropped.includes('很长的摘要'), false, '裁剪逻辑没跑，这条测试在空跑')
})

test('D5-B：【施工】排在【项目】之后、【预算】之前（三个 pinned 连在一起）', () => {
  const block = renderIndexBlock(blockInput({ projectLine: '项目简介', sliceLine: 'M1.5' }))
  const lines = block.split('\n')
  const projectAt = lines.findIndex((line) => line.startsWith('【项目】'))
  const workAt = lines.findIndex((line) => line.startsWith('【施工】'))
  const budgetAt = lines.findIndex((line) => line.startsWith('【预算】'))
  assert.ok(projectAt >= 0 && workAt >= 0 && budgetAt >= 0, '三段都该在')
  assert.ok(projectAt < workAt, '【项目】应当在【施工】之前')
  assert.ok(workAt < budgetAt, '【施工】应当在【预算】之前')
})

test('D5-B：**三份清单全空但有切片名 → 仍然渲染**（新项目刚建的状态）', () => {
  // 这条防的是：`renderIndexBlock` 原来"三份清单都空就返回空串"，
  // 会把【施工】行**静默吞掉**。
  const block = renderIndexBlock({
    index: { required: [], forbidden: [], anomalies: [] },
    readSet: new Map(),
    activated: true,
    sliceLine: 'M1.5',
  })
  assert.match(block, /【施工】M1\.5/)
})

test('D5-B 回归：**三份清单全空且没有切片名 → 仍然返回空串**（M0-9 不许破）', () => {
  const block = renderIndexBlock({
    index: { required: [], forbidden: [], anomalies: [] },
    readSet: new Map(),
    activated: true,
  })
  assert.equal(block, '', 'M0-9：空工作区不该注入任何东西')
})

test('D5-B 回归：**未激活仍然返回空串**（哪怕给了切片名）', () => {
  const block = renderIndexBlock({ activated: false, sliceLine: 'M1.5' })
  assert.equal(block, '')
})

// ================================================================ L34

test('L34-c：交接 order 不是最小 → **给出警告文案**', () => {
  const warning = handoverOrderWarningOf({ order: 999, role: 'handover', handoverMinOrder: -20 })
  assert.notEqual(warning, '')
  assert.match(warning, /999/)
  assert.match(warning, /-20/)
  assert.match(warning, /H7/)
  assert.match(warning, /不是最小的/)
})

test('L34-c 反向：正常路径（order **严格小于** min）**绝不警告**', () => {
  // 这是最重要的一条：`doc_new` 自己算的 order 一定 = min - 10，必然严格小于 min。
  // 如果这里也警告，警告就会变成噪音 —— 与 N2 的教训正好相反。
  assert.equal(handoverOrderWarningOf({ order: -30, role: 'handover', handoverMinOrder: -20 }), '')
  assert.equal(handoverOrderWarningOf({ order: 0, role: 'handover', handoverMinOrder: 10 }), '')
})

test('L34-c 反向：**第一份交接不警告**（没有现存交接，注定最小）', () => {
  assert.equal(handoverOrderWarningOf({ order: -10, role: 'handover', handoverMinOrder: undefined }), '')
  assert.equal(handoverOrderWarningOf({ order: 10, role: 'handover', handoverMinOrder: undefined }), '')
})

test('L34-c 反向：**非交接不警告**（普通文档的 order 是阅读顺序，没有"必须排第一"）', () => {
  for (const role of ['spec', 'decision', 'index', 'log', 'fact', 'evidence', 'instruction']) {
    assert.equal(
      handoverOrderWarningOf({ order: 999, role, handoverMinOrder: 10 }),
      '',
      `${role} 不该被这条判据管`,
    )
  }
})

test('L34-c：边界 —— order 恰好等于 min 也要警告（它确实不是"最小"）', () => {
  const warning = handoverOrderWarningOf({ order: 10, role: 'handover', handoverMinOrder: 10 })
  assert.notEqual(warning, '', '两份 order 相同 → 谁都不是唯一最小 → H7 会报')
})

test('L34-c：垃圾输入不抛', () => {
  for (const input of [null, undefined, {}, { order: 'x' }, { order: Number.NaN, role: 'handover', handoverMinOrder: 1 }]) {
    assert.doesNotThrow(() => handoverOrderWarningOf(input))
  }
  assert.equal(handoverOrderWarningOf({ order: 'x', role: 'handover', handoverMinOrder: 1 }), '')
})

test('L34-c：文案必须**给出正确的做法**（不是只说"你错了"）', () => {
  const warning = handoverOrderWarningOf({ order: 999, role: 'handover', handoverMinOrder: -20 })
  assert.match(warning, /别传 order/, '要告诉它"别传 order，让 doc_new 自己算"')
  assert.match(warning, /最小 - 10|最小值 - 10/)
})

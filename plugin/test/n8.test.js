/**
 * M1.5 / **N8** 的正式单测：索引块【项目】行 + H9（§1 内容判据）。
 *
 * ⚠️ **这个文件是补的。**
 * M1.5 收尾时我发现：N8 的两条判据之前**只在 `_m15/repro-n8.mjs` 脚本里验过**，
 * **没有进 `node --test` 套件**。那意味着：
 *   - CI / 任何只跑单测的人**看不到它**；
 *   - 而 `_m15/` 是"施工者的临时脚本"，不是"项目资产"。
 *
 * 这正是 M1 栽过的形态：**验证停在脚本，没回到测试套件**。
 * 补完之后，N8 的两条判据才真的被"钉住"。
 *
 * 编号说明：M1.5 里这条判据原本叫 H8，**因为与 D4 的 H8 撞车，已改为 H9**。
 * 详见 `core/handover.js` 里那段说明。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { fitBudget, projectLineOf, renderIndexBlock } from '../core/render.js'
import { indexDocsOf } from '../core/handover.js'

/** 一个最小的索引块渲染输入。 */
function blockInput(extra = {}) {
  return {
    index: {
      required: [{ meta: { id: 'a', summary: 'a 的摘要', status: 'authoritative' }, fingerprint: 'abcdef' }],
      forbidden: [],
      anomalies: [],
    },
    readSet: new Map(),
    activated: true,
    budgetLine: '【预算】必读 1 份 ≈ 10 tokens（上限 30k）',
    ...extra,
  }
}

// ---------------------------------------------------------------- 【项目】行

test('N8 主修法：projectLineOf 取 role:index 的 summary', () => {
  const line = projectLineOf({ entries: [
    { meta: { id: 'read-order', role: 'index', summary: '这是项目简介。' }, hasError: false },
  ] })
  assert.equal(line, '这是项目简介。')
})

test('N8 主修法：没有 index 时**退到 spec**', () => {
  const line = projectLineOf({ entries: [
    { meta: { id: 's', role: 'spec', summary: '只有 spec 的项目' }, hasError: false },
  ] })
  assert.equal(line, '只有 spec 的项目')
})

test('N8 主修法：**拿不到就返回空串**（整行不显示，不写占位）', () => {
  assert.equal(projectLineOf({ entries: [] }), '')
  assert.equal(projectLineOf({}), '')
  assert.equal(projectLineOf(undefined), '')
  // 有条目但 summary 为空 → 也是空串（不能显示一个空的【项目】）
  assert.equal(projectLineOf({ entries: [{ meta: { id: 'x', role: 'index', summary: '   ' }, hasError: false }] }), '')
})

test('N8 主修法：**跳过 hasError 的文档**（坏字段不可信）', () => {
  const line = projectLineOf({ entries: [
    { meta: { id: 'bad', role: 'index', summary: '坏掉的索引文档' }, hasError: true },
    { meta: { id: 'good', role: 'index', summary: '好的索引文档' }, hasError: false },
  ] })
  assert.equal(line, '好的索引文档')
})

test('N8 主修法：超长 summary 被截断（不让它吃掉整个预算）', () => {
  const long = 'x'.repeat(500)
  const line = projectLineOf({ entries: [{ meta: { id: 'i', role: 'index', summary: long }, hasError: false }] })
  assert.ok(line.length <= 121, `实际长度 ${line.length}`)
  assert.match(line, /…$/)
})

test('M4: UI project summary is not separately injected into AI context', () => {
  const block = renderIndexBlock(blockInput({ projectLine: '这是项目简介。' }))
  assert.doesNotMatch(block, /【项目】|这是项目简介。/)
  assert.match(block, /【目录】/)
})

test('N8 主修法：**拿不到时整行不显示、不写占位文本**', () => {
  const block = renderIndexBlock(blockInput({ projectLine: '' }))
  assert.equal(block.includes('【项目】'), false)
  // **关键**：不许出现「未知项目」「未设置」「（无）」这类占位
  assert.equal(/未知项目|未设置|（无）/.test(block), false, '不许写占位——那会变成永久噪声')
})

test('fitBudget preserves explicitly pinned sections even at small budgets', () => {
  const sections = [
    { key: 'gate', text: '【门禁】0/30 ｜ 未读完必读清单，改 docs/ 会被拒绝', pinned: true },
    { key: 'budget', text: '【预算】必读 30 份 ≈ 999k tokens（上限 30k）⚠️ 超出上限', pinned: true },
    { key: 'project', text: '【项目】一个被裁剪也绝不能消失的项目简介', pinned: true },
    { key: 'unread', text: `【未读】\n${Array.from({ length: 40 }, () => '- `x` · 很长很长的摘要'.repeat(3)).join('\n')}` },
    { key: 'anomaly', text: `【文档异常】\n${Array.from({ length: 10 }, () => '- `bad`：role 不在枚举内').join('\n')}` },
  ]
  const cropped = fitBudget(sections, 200) // 极小预算，逼它裁到底
  assert.match(cropped, /【项目】/, 'pinned 段被裁掉了 —— N8 就白做了')
  assert.match(cropped, /【门禁】/)
  assert.match(cropped, /【预算】/)
  // 反向：可裁段确实被裁了（否则说明裁剪逻辑没跑，这条断言是空跑）
  assert.equal(cropped.includes('很长很长的摘要'), false, '裁剪逻辑没跑，这条测试在空跑')
})

// M4: H9 diagnostics and phrase-matching helper tests retired.

test('indexDocsOf：优先 index，退 spec，跳过 hasError', () => {
  const docs = indexDocsOf([
    { meta: { id: 'i1', role: 'index', title: '索引一' }, hasError: false },
    { meta: { id: 's1', role: 'spec', title: '规格一' }, hasError: false },
  ])
  assert.deepEqual(docs, [{ id: 'i1', title: '索引一' }], '有 index 时只用 index')

  const onlySpec = indexDocsOf([{ meta: { id: 's1', role: 'spec', title: '规格一' }, hasError: false }])
  assert.deepEqual(onlySpec, [{ id: 's1', title: '规格一' }])

  const withBad = indexDocsOf([
    { meta: { id: 'bad', role: 'index', title: '坏的' }, hasError: true },
    { meta: { id: 'good', role: 'index', title: '好的' }, hasError: false },
  ])
  assert.deepEqual(withBad, [{ id: 'good', title: '好的' }])
})

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
import { checkHandover, indexDocsOf, mentionsProjectIntro } from '../core/handover.js'

/** 一份七段齐全的交接正文（H1–H4 都能过）。 */
function handoverBody(intent) {
  return `## 1. 我的意图

${intent}

## 2. 现在到哪了

| 项 | 值 |
|---|---|
| 单测 | 全绿 |

## 3. 下一刀

- 改 \`core/gate.js\` 的分支

## 4. 坑

| # | 坑 |
|---|---|
| 1 | 顺序反了 |

## 5. 验收

- 会话 session-abc seq=12

## 6. 刻意没做

- 没做 UI

## 7. 仍未决

无
`
}

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

test('N8 主修法：索引块里出现【项目】行', () => {
  const block = renderIndexBlock(blockInput({ projectLine: '这是项目简介。' }))
  assert.match(block, /【项目】这是项目简介。/)
})

test('N8 主修法：**拿不到时整行不显示、不写占位文本**', () => {
  const block = renderIndexBlock(blockInput({ projectLine: '' }))
  assert.equal(block.includes('【项目】'), false)
  // **关键**：不许出现「未知项目」「未设置」「（无）」这类占位
  assert.equal(/未知项目|未设置|（无）/.test(block), false, '不许写占位——那会变成永久噪声')
})

test('N8 主修法：【项目】是 pinned，**极小预算下也不被裁掉**', () => {
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

// ---------------------------------------------------------------- H9 判据（**已删除**）

// ---- 2026-11-15 M2.8（用户拍板「砍掉」）----
//
// 下面 4 条原本断言 H9 的行为。H9 已从 `checkHandover` 里删除，理由见
// `core/handover.js` 里那段长注释。核心两条：
//
//   ① 它认的是**句式**不是内容：§1 写「在一个刚初始化的 DDD 工作区（…）里走一遍」
//      信息完全给了，却判 MISS —— 因为"工作区"不在词表里；
//   ② 它要的信息由系统层【项目】行**每轮免费提供**，H9 自己的文案都承认"只是兜底"。
//
// ⇒ 这 4 条改写成"**H9 不许再报**"，防止它被顺手加回来。

test('**M2.8：H9 已删除 —— §1 完全不提项目也**不许**再报 H9**', () => {
  const verdict = checkHandover({
    meta: { id: 'h', role: 'handover', order: 10, status: 'draft' },
    body: handoverBody('把死锁修掉，让 docs/ 不再只读。'),
    context: { indexDocs: [{ id: 'read-order', title: '阅读顺序' }], handovers: [] },
  })
  assert.equal(
    verdict.warnings.some((item) => item.rule === 'H9'), false,
    'H9 又回来了 —— 它认句式不认内容，且【项目】行已经免费提供同样的信息',
  )
  assert.equal(verdict.errors.some((item) => item.rule === 'H9'), false)
})

test('M2.8：H9 删除后，§1 写什么都不会因为"项目简介"被报', () => {
  // 四种写法：原来两种 HIT 两种 MISS。现在**全都不报**。
  const bodies = [
    '在一个刚初始化的 DDD 工作区（`DDD全流程测试26`）里走一遍最小回路。',   // 原来 MISS
    '项目简介：DDD全流程测试26 是一个空壳工作区。',                       // 原来 HIT
    '本项目是 DDD 全流程测试 26。',                                      // 原来 HIT
    '这是 DDD 全流程测试 26 工作区。',                                   // 原来 MISS
  ]
  for (const text of bodies) {
    const verdict = checkHandover({
      meta: { id: 'h', role: 'handover', order: 10, status: 'draft' },
      body: handoverBody(text),
      context: { indexDocs: [{ id: 'read-order', title: '阅读顺序' }], handovers: [] },
    })
    assert.equal(
      verdict.warnings.some((item) => item.rule === 'H9'), false,
      `还在按句式报 H9：${text}`,
    )
  }
})

// ---- `mentionsProjectIntro` 这个**纯函数**保留着（附原单测）----
//
// 它本身是对的，只是不该被拿去做判据。将来若要做**真正的语义判断**
// （而不是句式匹配）可以从它开始。下面这条钉住它仍然可用。

test('M2.8：`mentionsProjectIntro` 纯函数仍然可用（只是不再被 checkHandover 调用）', () => {
  const indexDocs = [{ id: 'read-order', title: '阅读顺序' }]
  assert.equal(mentionsProjectIntro('本项目是一个 DDD 插件。', { indexDocs }).ok, true)
  assert.equal(mentionsProjectIntro('先按 `read-order` 读。', { indexDocs }).ok, true)
  // 这条就是它误报的证据：内容对了，句式不对，仍判 false
  assert.equal(
    mentionsProjectIntro('在一个刚初始化的 DDD 工作区里走一遍。', { indexDocs }).ok,
    false,
    '它仍然认句式不认内容 —— 这正是它不该当判据的理由',
  )
})

test('H9：**拿不到 indexDocs → 不判**（宁可漏报，不乱报）', () => {
  // 这条很重要：M1 第一版判据（"前 8 字"）在三个真实项目上全部误报。
  // 误报的 warn 会被模型学会无视（正是 D9 批评的形态）。
  const verdict = checkHandover({
    meta: { id: 'h', role: 'handover', order: 10, status: 'draft' },
    body: handoverBody('随便写点什么，不提项目。'),
    context: { handovers: [] },
  })
  assert.equal(verdict.warnings.some((item) => item.rule === 'H9'), false)
})

test('H9：**不改变 ok**（它只是 warn，现存交接一个都不能被打挂）', () => {
  const withoutContext = checkHandover({
    meta: { id: 'h', role: 'handover', order: 10, status: 'draft' },
    body: handoverBody('不提项目。'),
    context: { handovers: [] },
  })
  const withContext = checkHandover({
    meta: { id: 'h', role: 'handover', order: 10, status: 'draft' },
    body: handoverBody('不提项目。'),
    context: { indexDocs: [{ id: 'read-order', title: '阅读顺序' }], handovers: [] },
  })
  assert.equal(withContext.ok, withoutContext.ok, 'H9 改变了 ok —— 它是 warn，不该拦')
  assert.equal(withContext.errors.length, withoutContext.errors.length)
})

test('H9 用的 mentionsProjectIntro：四种形态逐条钉住', () => {
  const indexDocs = [{ id: 'read-order', title: '评审探针项目 · 阅读顺序' }]
  assert.equal(mentionsProjectIntro('本项目是 xxx', { indexDocs }).ok, true, '显式句式')
  assert.equal(mentionsProjectIntro('见 read-order', { indexDocs }).ok, true, 'id')
  assert.equal(mentionsProjectIntro('按「评审探针项目 · 阅读顺序」读', { indexDocs }).ok, true, '完整 title')
  assert.equal(mentionsProjectIntro('随便写点什么', { indexDocs }).ok, false, '什么都不提')
  // 空 §1
  assert.equal(mentionsProjectIntro('', { indexDocs }).ok, false)
  assert.equal(mentionsProjectIntro('   ', { indexDocs }).ok, false)
})

test('H9 用的 mentionsProjectIntro：**不会被 title 的片段骗过**', () => {
  // title 是「评审探针项目 · 阅读顺序」，只提「评审探针」（截断）不应命中 id/title 那条，
  // 但它含「项目」二字 —— 所以这里要确认判据**不是**靠"含项目"蒙混。
  const indexDocs = [{ id: 'read-order', title: '评审探针项目 · 阅读顺序' }]
  const verdict = mentionsProjectIntro('这里有三个项目要做', { indexDocs })
  // 「项目」单独出现不应命中显式句式（句式要求「本项目/这个项目/该项目」）
  assert.equal(verdict.ok, false, '「三个项目」不该被当成项目简介')
})

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

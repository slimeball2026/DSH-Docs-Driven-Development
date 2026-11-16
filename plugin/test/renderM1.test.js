/**
 * M1 对索引块渲染的增量（【预算】行 + R1 去重）。
 *
 * 为什么单独一个文件而不是并进 `render.test.js`：
 * 那个文件钉的是 **M0 的**契约（三份清单、裁剪、不许有快变量）；
 * 这里钉的是 **M1 新增的两件事**。分开之后，将来谁改坏了哪一半，一眼能看出是哪一版的问题。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildIndex } from '../core/index.js'
import { computeBudget, renderBudgetLine } from '../core/budget.js'
import { fitBudget, renderIndexBlock } from '../core/render.js'

const FP = 'abcdef123456'

function entry(meta, overrides = {}) {
  return {
    path: `docs/${meta?.id ?? 'x'}.md`,
    meta,
    issues: [],
    hasError: false,
    fingerprint: FP,
    body: 'x'.repeat(1000),
    text: 'x'.repeat(1000),
    ...overrides,
  }
}

function good(overrides = {}) {
  return {
    id: 'spec-tier2',
    title: '档 2 施工图',
    role: 'spec',
    order: 20,
    status: 'authoritative',
    summary: '档 2 的全部功能切片',
    basis: '实测',
    ...overrides,
  }
}

/** 带预算行渲染。 */
function render(entries, readSet = new Map(), extra = {}) {
  const index = buildIndex(entries)
  return renderIndexBlock({
    index,
    readSet,
    currentFingerprint: () => FP,
    activated: true,
    budgetLine: renderBudgetLine(computeBudget(index.required, { limit: 30000 })),
    ...extra,
  })
}

// ---------------------------------------------------------------- 1. 预算行

test('索引块里出现【预算】行，且格式与 SPEC §7.1 一致', () => {
  const text = render([entry(good())])
  assert.match(text, /【预算】必读 1 份 ≈ 750 tokens（上限 30k）/)
})

test('没有必读文档时**不出现**预算行（不占 token）', () => {
  const text = render([entry(good({ status: 'sealed' }))])
  assert.equal(text.includes('【预算】'), false)
})

test('超预算时带 ⚠️', () => {
  const text = render([entry(good())], new Map(), {
    budgetLine: renderBudgetLine(computeBudget([entry(good())], { limit: 100 })),
  })
  assert.match(text, /⚠️ 超出上限/)
})

test('**预算行永不裁**（pinned）：极紧的预算下它仍完整存在（M1-1 的判据）', () => {
  const entries = Array.from({ length: 12 }, (_, i) => entry(good({
    id: `doc-${String(i).padStart(2, '0')}`,
    order: i * 10,
    summary: '一句尽量长一点的摘要用来占位置',
  })))
  const text = render(entries, new Map(), { maxChars: 200 })
  assert.ok(text.length <= 200, `裁剪后仍超预算：${text.length}`)
  assert.match(text, /【预算】必读 12 份/, '预算行被裁掉了 —— M1-1 会判不了')
})

// ---- 2026-11-14 M2.6：【怎么做】行 + pinned 总预算 ----
//
// 背景：用户全流程演练里，AI 有 3 个回合（共 25 次工具调用）在翻插件源码，
// 因为它不知道「归档 / 交付 / 改阅读顺序」在 DDD 里各等于什么操作。
// 所以索引块加了【怎么做】行（`core/render.js` 的 `TAG.howto`）。
//
// ⚠️ 第一版写成完整句子，**立刻撞红上面那条判据**（`maxChars: 200` 装不下，实测 233）。
// 那说明"pinned 段总长是常量级"这条约束**一直存在，只是从没被显式测过** ——
// 它靠的是"加新行的人刚好没加太长"。这不是判据，是运气。
//
// 下面这条把运气变成判据：**所有 pinned 行的总长必须留有余量**，
// 否则下一个人再加一行就会以"某条无关测试红了"的形式发现，而不是在这里被点名。

test('**pinned 段总长必须留余量**（加新行时不能刚好卡满 200）', () => {
  // 用最坏情况的输入：必读很多 + 每份摘要很长，逼出所有 pinned 行。
  const entries = Array.from({ length: 20 }, (_, i) => entry(good({
    id: `d${i}`,
    order: i,
    summary: '摘要'.repeat(10),
  })))
  const text = render(entries, new Map(), { maxChars: 200 })

  // 只取 pinned 部分：门禁 / 预算 / 怎么做（未读那行是可裁的，不算）。
  const pinnedLines = text.split('\n').filter((line) => /^【(门禁|预算|怎么做)】/.test(line))
  const pinnedLength = pinnedLines.join('\n').length

  assert.equal(pinnedLines.length, 3, `pinned 行数不对：${pinnedLines.length}（门禁/预算/怎么做）`)
  // 阈值取 180（上限 200 的 90%），留 20 字符余量。
  //
  // ⚠️ 我第一版设成 170，实测 171 —— 立刻红。那次红是对的：
  // 它逼我看清「pinned 已经占了 90%」，所以这次只留 20 字符，而不是自我安慰地放宽到 195。
  // 真要再加 pinned 行，必须先精简现有三行（或把内容移出 pinned），不能改这个数。
  assert.ok(
    pinnedLength <= 180,
    `pinned 段总长 ${pinnedLength} 超过 180（上限 200 的 90%）—— `
    + '再加一行就会撑破极紧预算。要么精简，要么把新内容移出 pinned。',
  )
  // 【怎么做】必须真的回答了那三个动作，否则它只是噪声。
  assert.match(text, /doc_mark/, '【怎么做】没说归档怎么做')
  assert.match(text, /deliverables/, '【怎么做】没说交付怎么做')
  assert.match(text, /order/, '【怎么做】没说阅读顺序怎么改')

  // ⚠️ 2026-11-14 用户指出：**改阅读顺序不只是改 order**。
  //
  // 它是两份东西：
  //   - 机器读的 `order` 值（`core/index.js` 的 `byOrderThenId` 升序）；
  //   - **人和 AI 读的入口索引正文**（`## 必读清单` / `## 下一步` / `## 陷阱`）。
  //
  // 只改 order → 索引块排序变了，但那张"先读谁、哪些已作废、有什么坑"的地图
  // 和实际对不上。而那张地图正是新会话照着读的东西。
  //
  // 第一版【怎么做】只写了 `order`（教一半）。这条断言钉住"两处都要说"，
  // 且**不能**只靠 `order` 这个关键词 —— 上面那条已经匹配得到它了。
  assert.match(
    text, /入口索引正文/,
    '【怎么做】只说了改 order —— 阅读顺序还有入口索引正文那一半（只写 order 就是教一半）',
  )
  // ⚠️ 反向断言：**不许**让模型去读插件源码（那正是演练里最贵的错误路径）。
  assert.match(text, /别读插件源码|不要读插件源码/, '没有明确劝阻"去读插件源码"')
})

test('预算行由**必读集合 + tokens** 决定，不含已读状态（读多少都不变）', () => {
  const entries = [entry(good({ id: 'a' })), entry(good({ id: 'b', order: 30 }))]
  const none = render(entries, new Map())
  const all = render(entries, new Map([['a', { fingerprint: FP }], ['b', { fingerprint: FP }]]))
  const budgetOf = (text) => text.split('\n').find((line) => line.startsWith('【预算】'))
  assert.equal(budgetOf(none), budgetOf(all), '读了几份居然改变了预算行（那是快变量）')
})

// ---------------------------------------------------------------- 2. R1 去重

test('**`【已读】` 最多出现一次**（M0 评审的 R1）', () => {
  // R1 的现象是「【已读】1/7」出现**两次**（gate 段与 read 段各带一次前缀）。
  // 所以判据是「不超过 1 次」，不是「恰好 1 次」：
  // 一份都没读的时候本来就不该有【已读】段。
  const cases = [
    { label: '一份都没读', readSet: new Map(), expected: 0 },
    { label: '读了一份', readSet: new Map([['spec-tier2', { fingerprint: FP }]]), expected: 1 },
    {
      label: '全读完',
      readSet: new Map([['spec-tier2', { fingerprint: FP }], ['other', { fingerprint: FP }]]),
      expected: 1,
    },
  ]
  for (const { label, readSet, expected } of cases) {
    const text = render([entry(good()), entry(good({ id: 'other', order: 30 }))], readSet)
    const count = text.split('【已读】').length - 1
    assert.equal(count, expected, `${label}：预期 ${expected} 次，实际 ${count} 次\n${text}`)
    assert.ok(count <= 1, `${label}：【已读】重复了（R1 回归）`)
  }
})

test('门禁状态行改用【门禁】前缀，且仍然携带比率', () => {
  const text = render([entry(good()), entry(good({ id: 'b', order: 30 }))],
    new Map([['spec-tier2', { fingerprint: FP }]]))
  assert.match(text, /【门禁】1\/2/)
})

test('门禁行永不裁（反向断言：极紧预算下仍带「会被拒绝」）', () => {
  const entries = Array.from({ length: 10 }, (_, i) => entry(good({ id: `d${i}`, order: i })))
  const text = render(entries, new Map(), { maxChars: 120 })
  assert.match(text, /会被拒绝/)
})

// ---------------------------------------------------------------- 3. 与 M0 契约的兼容

test('**M0-5 仍然成立**：同样输入两次渲染逐字节相同（预算行不破坏幂等）', () => {
  const entries = [entry(good({ id: 'a' })), entry(good({ id: 'b', order: 30 }))]
  const readSet = new Map([['a', { fingerprint: FP }]])
  assert.equal(render(entries, readSet), render(entries, readSet))
})

test('**索引块里仍然没有时间戳 / 轮次 / seq**（预算行没引入快变量）', () => {
  const text = render([entry(good({ id: 'a' }))])
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}/)
  assert.doesNotMatch(text, /\d{2}:\d{2}:\d{2}/)
  assert.doesNotMatch(text, /\bseq\b/i)
})

test('fitBudget：pinned 段在其它段被裁到极致后仍保留', () => {
  const sections = [
    { key: 'gate', text: '【门禁】0/9 ｜ 未读完必读清单，改 docs/ 会被拒绝', pinned: true },
    { key: 'budget', text: '【预算】必读 9 份 ≈ 51.9k tokens（上限 30k）⚠️ 超出上限', pinned: true },
    { key: 'unread', text: `【未读】\n${'- 很长的一行\n'.repeat(80)}` },
  ]
  const text = fitBudget(sections, 150)
  assert.match(text, /【预算】/)
  assert.match(text, /会被拒绝/)
})

test('budgetLine 是空串时不产生空段（不会多一个空行）', () => {
  const text = renderIndexBlock({
    index: buildIndex([entry(good())]),
    readSet: new Map(),
    currentFingerprint: () => FP,
    activated: true,
    budgetLine: '',
  })
  assert.equal(text.includes('【预算】'), false)
  assert.equal(/\n\n/.test(text), false, '出现了空行')
})

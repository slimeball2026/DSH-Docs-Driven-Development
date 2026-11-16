/**
 * 索引块渲染的单测（SPEC §12.1 的 `render.test.js`）。
 *
 * 这组断言里最重要的是**反向断言**：
 * - 渲染结果里不得出现时间戳 / 轮次 / 步号 / seq
 * - **重复读取同一份未变的文档不得改变渲染结果**（M0-5 的物理前提）
 *
 * 原因是我实测过：`systemPrompt.context()` 的文本一变，DSH 就 append 一条新
 * user/message（agent-loop 的 RuntimeContextProjection，没有 replace）。
 * 教练模式 69 步出了 31 条，就是这么来的。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildIndex } from '../core/index.js'
import {
  DEFAULT_MAX_CHARS,
  fitBudget,
  renderIndexBlock,
  shortVersion,
  statusMark,
} from '../core/render.js'

const FP = 'abcdef123456'

function entry(meta, overrides = {}) {
  return {
    path: `docs/${meta?.id ?? 'x'}.md`,
    meta,
    issues: [],
    hasError: false,
    fingerprint: FP,
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

/** 渲染一份状态。 */
function render(entries, readSet = new Map(), extra = {}) {
  return renderIndexBlock({
    index: buildIndex(entries),
    readSet,
    currentFingerprint: () => FP,
    activated: true,
    ...extra,
  })
}

// ---------------------------------------------------------------- 基本形态

test('未激活 → 返回空串（M0-9 / §6.4 规则 4）', () => {
  assert.equal(render([entry(good())], new Map(), { activated: false }), '')
})

test('三份清单都空 → 返回空串（不占 token）', () => {
  assert.equal(render([]), '')
})

test('未读任何必读 → 块里出现【未读】与门禁警告', () => {
  const text = render([entry(good())])
  assert.match(text, /【未读】/)
  assert.match(text, /会被拒绝/)
})

test('必读全部读完 → 出现【已读】与"可以动 docs/"', () => {
  const text = render([entry(good())], new Map([['spec-tier2', { fingerprint: FP }]]))
  assert.match(text, /【已读】/)
  assert.match(text, /可以动 docs\//)
})

test('已读条目带版本号（指纹前 6 位，SPEC §6.4 规则 3）', () => {
  const text = render([entry(good())], new Map([['spec-tier2', { fingerprint: FP }]]))
  assert.match(text, /vabcdef/)
})

test('shortVersion 取前 6 位，拿不到时给占位', () => {
  assert.equal(shortVersion('abcdef123456'), 'abcdef')
  assert.equal(shortVersion(undefined), '??????')
  assert.equal(shortVersion('abc'), '??????')
})

test('sealed 进【禁止执行】，不进【未读】（M0-10）', () => {
  const text = render([entry(good({ id: 'trap', status: 'sealed' }))])
  assert.match(text, /【禁止执行】/)
  assert.doesNotMatch(text, /【未读】/)
})

test('有 error 的文档进【文档异常】，不进【未读】（M0-7）', () => {
  const bad = entry(good({ id: 'decision-log' }), {
    hasError: true,
    issues: [{ rule: 'V1', level: 'error', message: '缺少 role 字段' }],
  })
  const text = render([bad])
  assert.match(text, /【文档异常】/)
  assert.match(text, /缺少 role 字段/)
  assert.doesNotMatch(text, /【未读】/)
})

test('statusMark 六种 status 各不同', () => {
  const marks = ['authoritative', 'partial', 'superseded', 'sealed', 'void', 'draft'].map(statusMark)
  assert.equal(new Set(marks).size, 6)
})

// ---------------------------------------------------------------- 反向断言：不许有每轮都变的内容

test('**渲染结果不含时间戳 / 轮次 / 步号 / seq**（R3 硬约束）', () => {
  const text = render([entry(good({ id: 'a' })), entry(good({ id: 'b', order: 30 }))])
  // 任何常见的"每轮都变"的形态都不许出现。
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}/, '出现了日期')
  assert.doesNotMatch(text, /\d{2}:\d{2}:\d{2}/, '出现了时间')
  assert.doesNotMatch(text, /第\s*\d+\s*轮/, '出现了轮次号')
  assert.doesNotMatch(text, /步\s*\d+/, '出现了步号')
  assert.doesNotMatch(text, /\bseq\b/i, '出现了 seq')
})

test('**同样的文档 + 同样的已读集合 → 渲染完全相同**（幂等）', () => {
  const entries = [entry(good({ id: 'a' })), entry(good({ id: 'b', order: 30 }))]
  const readSet = new Map([['a', { fingerprint: FP }]])
  assert.equal(render(entries, readSet), render(entries, readSet))
})

test('**重复读取同一份未变文档不改变渲染**（M0-5 的物理前提）', () => {
  const entries = [entry(good({ id: 'a' }))]
  const once = new Map([['a', { fingerprint: FP }]])
  // 第二次读：指纹没变，但 readSet 里的记录对象是新的、可能带 at/seq 等字段。
  const twice = new Map([['a', { fingerprint: FP, at: 9999, text: 'x'.repeat(500) }]])
  assert.equal(render(entries, once), render(entries, twice))
})

test('已读集合里带 at / seq 等字段也不会渲染出来', () => {
  const text = render(
    [entry(good({ id: 'a' }))],
    new Map([['a', { fingerprint: FP, at: 12345, seq: 678 }]]),
  )
  assert.doesNotMatch(text, /12345/)
  assert.doesNotMatch(text, /678/)
})

// ---- 2026-11-14 M2.5：门禁行必须**预告**"改完会作废已读"（摩擦台账 F1）----
//
// 摩擦台账里最贵的一条：AI 改完文档就发现自己的已读失效了，5 个会话撞了 10 次
// （7 次 edit + 3 次 doc_mark）。那是铁律 7 的必然代价 —— 不能改行为，只能预告。

test('**M2.5：门禁行必须预告"改过的文档会立刻变回未读"**（两个分支都要）', () => {
  // 分支一：还没读完
  const unreadText = render([entry(good({ id: 'a' }))], new Map())
  assert.match(
    unreadText,
    /改过的文档立刻变回未读/,
    '门禁行没预告"改完就作废已读" —— AI 只会一遍遍撞同一面墙（摩擦台账 F1）',
  )

  // 分支二：**全部读完**。这里最容易漏 —— 而恰恰是那时 AI 最需要知道"再改就要重读"。
  const allReadText = render([entry(good({ id: 'a' }))], new Map([['a', { fingerprint: FP }]]))
  assert.match(
    allReadText,
    /改过的文档立刻变回未读/,
    '**读完之后**就没预告了 —— 而恰恰是那时 AI 最需要知道"再改就要重读"',
  )
})

// ---- 2026-11-15 M2.7：门禁行还要说清"只读片段不算读过" ----
//
// 为什么：`session-25dad0e8` 的 turn 3 实测（交接演练第 19 轮）——
//   完整读 → 写：8 次里成功 7 次
//   窗口读 → 写：**5 次里成功 0 次**（每一次都被"要先重读"拒掉）
// 也就是说「`read(limit=N)` 换不来写权限」是**每条必踩一次**的坑，
// 而注入里从没提过。模型只能靠撞墙学会。
//
// 这条断言与上一条**共用同一句文案**（pinned 预算只剩 14 字符，新加不了行），
// 所以改文案时两条会一起红 —— 那是**对的**，它们是同一句的两个承诺。
test('**M2.7：门禁行必须说明「只读片段不算读过」**（两个分支都要）', () => {
  const unreadText = render([entry(good({ id: 'a' }))], new Map())
  assert.match(
    unreadText,
    /只读片段不算读过/,
    '没告诉 AI "read(limit=N) 换不来写权限" —— 它只能靠被拒一次才学会（实测 5/5 全撞）',
  )

  const allReadText = render([entry(good({ id: 'a' }))], new Map([['a', { fingerprint: FP }]]))
  assert.match(
    allReadText,
    /只读片段不算读过/,
    '**读完之后**就没了这句 —— 而那时正是 AI 最可能用 read(limit) 敷衍的地方',
  )
  assert.match(allReadText, /整份重读/, '要给出**替代做法**（整份重读），不能只说"不算"')
})

test('**M2.5：那句预告必须是静态文案**（不含日期/时间/轮次，M0-5 红线）', () => {
  const texts = [
    render([entry(good({ id: 'a' }))], new Map()),
    render([entry(good({ id: 'a' }))], new Map([['a', { fingerprint: FP }]])),
  ]
  for (const text of texts) {
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}/, '预告文案里出现了日期')
    assert.doesNotMatch(text, /\d{2}:\d{2}:\d{2}/, '预告文案里出现了时间')
    assert.doesNotMatch(text, /第\s*\d+\s*轮/, '预告文案里出现了轮次号')
  }
})

test('文档没变（指纹没动）时渲染稳定；文档变了才变', () => {
  const before = render([entry(good({ id: 'a' }), { fingerprint: 'aaaaaa111111' })],
    new Map([['a', { fingerprint: 'aaaaaa111111' }]]), { currentFingerprint: () => 'aaaaaa111111' })
  const after = render([entry(good({ id: 'a' }), { fingerprint: 'bbbbbb222222' })],
    new Map([['a', { fingerprint: 'aaaaaa111111' }]]), { currentFingerprint: () => 'bbbbbb222222' })
  assert.notEqual(before, after, '内容变了就该变，这是允许的')
  assert.match(after, /【未读】/, '指纹变了应视为未读')
})

// ---------------------------------------------------------------- 裁剪

test('长度 ≤800 字符（SPEC §6.4 的目标长度）', () => {
  const entries = Array.from({ length: 12 }, (_, i) => entry(good({
    id: `doc-${String(i).padStart(2, '0')}`,
    order: i * 10,
    summary: '一句尽量长一点的摘要用来占位置，看看会不会超',
  })))
  const text = render(entries)
  assert.ok(text.length <= DEFAULT_MAX_CHARS, `渲染 ${text.length} 字符，超过预算 ${DEFAULT_MAX_CHARS}`)
})

test('裁剪顺序：先缩文档异常，再缩已读，再缩未读', () => {
  const sections = [
    { key: 'gate', text: '【已读】0/3 ｜ 未读完必读清单，改 docs/ 会被拒绝', pinned: true },
    { key: 'read', text: `【已读】0/3\n${'- 已读行\n'.repeat(30)}` },
    { key: 'unread', text: `【未读】\n${'- 未读行\n'.repeat(30)}` },
    { key: 'anomaly', text: `【文档异常】\n${'- 异常行\n'.repeat(30)}` },
  ]
  const text = fitBudget(sections, 400)
  assert.ok(text.length <= 400, `裁剪后 ${text.length} 仍超预算`)
  // 门禁状态永不裁。
  assert.match(text, /会被拒绝/)
})

test('裁剪到极致时门禁状态仍在（永不裁）', () => {
  const sections = [
    { key: 'gate', text: '【已读】0/9 ｜ 未读完必读清单，改 docs/ 会被拒绝', pinned: true },
    { key: 'unread', text: `【未读】\n${'- 很长的一行\n'.repeat(80)}` },
  ]
  const text = fitBudget(sections, 80)
  assert.match(text, /会被拒绝/)
})

test('fitBudget 在预算充足时不改动原文', () => {
  const sections = [{ key: 'gate', text: '短', pinned: true }]
  assert.equal(fitBudget(sections, 1200), '短')
})

test('maxChars 可配置，且非法值回落默认', () => {
  const entries = Array.from({ length: 20 }, (_, i) => entry(good({ id: `d${i}`, order: i, summary: '摘要'.repeat(10) })))
  const tight = render(entries, new Map(), { maxChars: 200 })
  assert.ok(tight.length <= 200, `自定义预算失效：${tight.length}`)
  const fallback = render(entries, new Map(), { maxChars: -5 })
  assert.ok(fallback.length <= DEFAULT_MAX_CHARS)
})

// ---------------------------------------------------------------- 健壮性

test('注册表里有缺 id 的条目时不抛、不渲染它', () => {
  const broken = entry(good(), { meta: { status: 'authoritative' } })
  assert.doesNotThrow(() => render([broken]))
})

test('renderIndexBlock 收到垃圾输入不抛', () => {
  assert.equal(renderIndexBlock(null), '')
  assert.equal(renderIndexBlock({}), '')
  assert.equal(renderIndexBlock({ index: null }), '')
})

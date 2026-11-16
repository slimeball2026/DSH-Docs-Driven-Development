/**
 * `server/deliverables.ts` 的单测（M2-D / M2-E 的真源）。
 *
 * ---- 重点：`presented` 必须是真事实 ----
 *
 * R-10 的原话是「`present` 判定链是空的」。我核到的桥是**会话事件**
 * （`dsh-tool-present/lib/index.js:119` 的 `session.append('deliverables/presented', …)`）。
 *
 * 这座桥有三个失败面，**每一个都不报错**：
 * 1. 事件名写错 → 每一格都显示「未声明」（看起来像"AI 从没交付过任何东西"）；
 * 2. 路径没归一化 → Windows 的 `\` 与 `/` 不匹配，同样全成"未声明"；
 * 3. 拿不到事件却当成"确实没声明" → 用户会以为文件是野的。
 *
 * 所以下面每一条都在钉这三件事。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  deliverablesOf,
  graveyardCandidatesOf,
  markReasonOf,
  graveyardOf,
  normalizePath,
  presentedPathsOf,
} from '../server/deliverables.ts'

/** 造一条 `deliverables/presented` 事件（形状照 dsh-tool-present 的实现）。 */
function presentedEvent(files) {
  return { type: 'deliverables/presented', seq: 10, time: 1, data: { turn: 1, callId: 'call-1', files } }
}

// ---------------------------------------------------------------- 1. present 事件折叠

test('**presentedPathsOf：从会话事件里认出 presented 的绝对路径**（R-10 那座桥）', () => {
  const events = [
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    presentedEvent([{ path: 'C:\\proj\\deliverables\\report.xlsx' }]),
    { type: 'turn/end', seq: 11, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const found = presentedPathsOf(events)
  assert.equal(found.size, 1)
  assert.ok(found.has('c:/proj/deliverables/report.xlsx'), [...found].join(','))
})

test('**presentedPathsOf：事件名写错就一个都认不出**（反向的"为什么必须钉事件名"）', () => {
  // 如果 DSH 改了事件名，这里是唯一的回归网。
  const events = [{ type: 'deliverables/presented-v2', seq: 1, time: 1, data: { files: [{ path: 'C:\\a.md' }] } }]
  assert.equal(presentedPathsOf(events).size, 0, '认出了不存在的事件名')
})

test('presentedPathsOf：多次 present 累积；同一路径重复只算一次', () => {
  const found = presentedPathsOf([
    presentedEvent([{ path: 'C:\\p\\a.md' }, { path: 'C:\\p\\b.md' }]),
    presentedEvent([{ path: 'C:\\p\\a.md' }]),
  ])
  assert.deepEqual([...found].sort(), ['c:/p/a.md', 'c:/p/b.md'])
})

test('presentedPathsOf：坏输入不抛（事件流里有别人的事件是常态）', () => {
  for (const events of [undefined, null, [], [{}], [{ type: 'deliverables/presented' }],
    [{ type: 'deliverables/presented', data: { files: 'not-an-array' } }],
    [{ type: 'deliverables/presented', data: { files: [null, {}, { path: 42 }] } }]]) {
    assert.doesNotThrow(() => presentedPathsOf(events))
  }
  assert.equal(presentedPathsOf([{ type: 'deliverables/presented', data: { files: [{}] } }]).size, 0)
})

// ---------------------------------------------------------------- 2. 路径归一化

test('**normalizePath：Windows 的 `\\` 与 `/` 必须等价**（否则永远对不上）', () => {
  assert.equal(normalizePath('C:\\proj\\deliverables\\a.md'), 'c:/proj/deliverables/a.md')
  assert.equal(normalizePath('C:/proj/deliverables/a.md'), 'c:/proj/deliverables/a.md')
  assert.equal(
    normalizePath('C:\\Proj\\Deliverables\\A.MD'),
    normalizePath('c:/proj/deliverables/a.md'),
    '大小写不同但同一文件的两个写法必须归一',
  )
})

test('normalizePath：尾部分隔符不影响比较', () => {
  assert.equal(normalizePath('C:/proj/deliverables/'), normalizePath('C:/proj/deliverables'))
})

// ---------------------------------------------------------------- 3. 交付网格

test('**deliverablesOf：present 过的 → presented:true**', () => {
  const items = [{ name: 'report.xlsx', type: 'file', size: 10240, mtime: 1794490792 }]
  const result = deliverablesOf({
    items,
    dirAbs: 'C:\\proj\\deliverables',
    presented: presentedPathsOf([presentedEvent([{ path: 'C:\\proj\\deliverables\\report.xlsx' }])]),
    presentedKnown: true,
  })
  assert.equal(result.length, 1)
  assert.equal(result[0].presented, true, 'present 过的却显示未声明')
  assert.equal(result[0].presentedKnown, true)
})

test('**deliverablesOf：没 present 的 → presented:false**（"未声明"这条不能省）', () => {
  const result = deliverablesOf({
    items: [{ name: 'draft.csv', type: 'file', size: 100 }],
    dirAbs: 'C:\\proj\\deliverables',
    presented: new Set(),
    presentedKnown: true,
  })
  assert.equal(result[0].presented, false)
})

test('**deliverablesOf：拿不到事件 → presentedKnown:false**（不许谎称"确定没声明"）', () => {
  const result = deliverablesOf({
    items: [{ name: 'x.md', type: 'file', size: 10 }],
    dirAbs: 'C:\\proj\\deliverables',
    presented: new Set(),
    presentedKnown: false,
  })
  assert.equal(result[0].presented, false)
  assert.equal(
    result[0].presentedKnown,
    false,
    '拿不到事件却说"已知" —— UI 会把"不知道"显示成"确定没声明"',
  )
})

test('deliverablesOf：跳过子目录，按路径排序（渲染稳定）', () => {
  const result = deliverablesOf({
    items: [
      { name: 'b.md', type: 'file' },
      { name: 'sub', type: 'dir' },
      { name: 'a.md', type: 'file' },
    ],
    dirAbs: 'C:/proj/deliverables',
    presentedKnown: true,
  })
  assert.deepEqual(result.map((item) => item.path), [
    'C:/proj/deliverables/a.md',
    'C:/proj/deliverables/b.md',
  ])
})

test('deliverablesOf：空目录 / 坏输入不抛', () => {
  for (const input of [undefined, {}, { items: null }, { items: [null] }]) {
    assert.doesNotThrow(() => deliverablesOf(input))
  }
  assert.deepEqual(deliverablesOf({ items: [] }), [])
})

// ---------------------------------------------------------------- 4. 待归档候选

test('**graveyardCandidatesOf：只收 status:void，且不在坟场里的**', () => {
  const entries = [
    { meta: { id: 'old-plan', status: 'void', summary: '已作废：方案 A 不可行' } },
    { meta: { id: 'live', status: 'authoritative' } },
    { meta: { id: 'already-gone', status: 'void' }, inGraveyard: true },
    { meta: { id: 'superseded-one', status: 'superseded' } },
  ]
  const result = graveyardCandidatesOf(entries)
  assert.deepEqual(result.map((item) => item.id), ['old-plan'])
})

// ---- 2026-11-14 M2.5 · W8：reason 曾经**永远取不到** ----
//
// 真缺陷：`doc_mark` 把 reason 写进**正文的 `<!-- ddd:mark -->` 标记块**，
// 而 `graveyardCandidatesOf` 去 `meta.reason` 找 —— 那个字段**永远不存在**
// （frontmatter 里根本没有 `reason`）。
//
// 后果：待归档清单里每条都显示「⚠️ 没有理由」，而 AI 明明给了理由。
// 那正是 SPEC §8.4 M2-5c 要防的状态：「没有理由的提议等于没提议」。
//
// 实测证据：`node _m23/verify-w8-proposal.mjs` 的旧输出里
// `reason: ""`，而磁盘上标记块写着 reason。

test('**M2.5：reason 必须从正文标记块里读出来**（否则 UI 永远显示"没有理由"）', () => {
  const body = '# 旧方案\n\n正文……\n\n'
    + '<!-- ddd:mark 2026-11-14 status=void reason="已被 w8-new 取代，留着会误导读者" -->\n'
  const entries = [{ meta: { id: 'w8-old', status: 'void', summary: 's' }, text: body }]
  const [hit] = graveyardCandidatesOf(entries)
  assert.equal(
    hit.reason,
    '已被 w8-new 取代，留着会误导读者',
    'reason 没从标记块里读出来 —— UI 会显示「⚠️ 没有理由」，而 AI 其实给了理由',
  )
})

test('M2.5：markReasonOf 取**最后一条**带 reason 的块（一份文档可能被 mark 多次）', () => {
  const body = [
    '<!-- ddd:mark 2026-11-10 status=sealed reason="第一次封存" -->',
    '<!-- ddd:mark 2026-11-14 status=void reason="后来改成作废" -->',
  ].join('\n')
  assert.equal(markReasonOf(body), '后来改成作废')
})

test('M2.5：markReasonOf 跳过**没有 reason 的块**（不能因为它更靠后就返回空）', () => {
  const body = [
    '<!-- ddd:mark 2026-11-10 status=void reason="有理由" -->',
    '<!-- ddd:mark 2026-11-14 status=draft -->',
  ].join('\n')
  assert.equal(markReasonOf(body), '有理由', '取了最后一条却把它当空 —— 应跳过无 reason 的块')
})

test('M2.5：markReasonOf 坏输入一律返回空串（不抛、不编）', () => {
  for (const input of [undefined, null, '', 42, 'no mark here', '<!-- ddd:mark -->']) {
    assert.equal(markReasonOf(input), '', `输入 ${JSON.stringify(input)} 时没返回空串`)
  }
})

test('M2.5：frontmatter 里**手写的** reason 优先（兼容有人显式声明）', () => {
  const entries = [{
    meta: { id: 'x', status: 'void', summary: 's', reason: '手写在前面的理由' },
    text: '<!-- ddd:mark 2026-11-14 status=void reason="标记块里的理由" -->',
  }]
  assert.equal(graveyardCandidatesOf(entries)[0].reason, '手写在前面的理由')
})

test('M2.5：**两处都没有 reason 时留空，绝不编**（UI 会显示"没有理由"提醒 AI）', () => {
  const entries = [{ meta: { id: 'x', status: 'void', summary: 's' }, text: '正文' }]
  assert.equal(graveyardCandidatesOf(entries)[0].reason, '')
})

test('**graveyardCandidatesOf：`superseded` 不是归档候选**（两者的语义不同）', () => {
  // SPEC §8.4：`superseded` 是"有更新的版本了"（doc_new 自动），
  // `void` 是"这份别再用了"（AI 主动标 + 写理由）。**不能互相替代。**
  const result = graveyardCandidatesOf([
    { meta: { id: 'a', status: 'superseded' } },
    { meta: { id: 'b', status: 'superseded' } },
  ])
  assert.equal(result.length, 0, 'superseded 被当成待归档了')
})

test('graveyardCandidatesOf：没有理由就给空串，**不编理由**', () => {
  const result = graveyardCandidatesOf([{ meta: { id: 'x', status: 'void', summary: '' } }])
  assert.equal(result[0].reason, '')
})

test('graveyardCandidatesOf：有 reason 字段就带上（M2-5c 要求每条带理由）', () => {
  const result = graveyardCandidatesOf([
    { meta: { id: 'x', status: 'void', summary: 's', reason: '被 SPEC v2 推翻' } },
  ])
  assert.equal(result[0].reason, '被 SPEC v2 推翻')
})

// ---------------------------------------------------------------- 5. 坟场清单

test('graveyardOf：列出坟场文件，路径相对项目根', () => {
  const result = graveyardOf([
    { name: 'old-plan.md', type: 'file', mtime: 1794490792000 },
    { name: 'sub', type: 'dir' },
  ], 'docs/_graveyard')
  assert.equal(result.length, 1)
  assert.equal(result[0].path, 'docs/_graveyard/old-plan.md')
  assert.equal(result[0].archivedAt, 1794490792)
})

test('graveyardOf：不传目录时用默认值', () => {
  assert.equal(graveyardOf([{ name: 'a.md', type: 'file' }])[0].path, 'docs/_graveyard/a.md')
})

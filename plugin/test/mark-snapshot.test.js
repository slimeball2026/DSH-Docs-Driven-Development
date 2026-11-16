/**
 * 标绿快照（M2.6 · 用户拍板方案 B）。
 *
 * ---- 这个模块解决什么问题 ----
 *
 * 用户原话：「**不该预设 AI 能预料到自己真的没东西要改**。」
 *
 * 现有做法是事前提醒（"别过早标绿"），它把责任压在「AI 能否准确预见未来」上。
 * 实测（`session-916967d2`）AI 自己承认：「七段全合规、健康度全过，
 * **但有一句话在说假话**」—— 它在标绿之后才去改 read-order。
 *
 * ⇒ 方案 B：**不要求预判，只做事实对账**。
 *   标绿时记下「其它文档此刻的指纹」，之后比对"它们变了没有"。
 *
 * ---- 写法纪律 ----
 *
 * 每个「会报」的判据都配一条「不该报」的反例 —— 因为一个永远报的提醒会被学会无视
 * （本项目 D9 批评过的形态，H10 就是因此被删的）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MARK_SNAPSHOT_FILE,
  driftMessageOf,
  driftedRefsOf,
  mergeSnapshot,
  snapshotOf,
} from '../core/markSnapshot.js'

// ---------------------------------------------------------------- 1. snapshotOf

test('M2.6：`snapshotOf` 只留合法的 id + 指纹对', () => {
  const record = snapshotOf({
    id: 'handover-1',
    status: 'authoritative',
    refs: [
      { id: 'read-order', fingerprint: 'aaa111' },
      { id: 'spec-1', fingerprint: 'bbb222' },
      { id: '', fingerprint: 'ccc333' },          // 空 id → 丢
      { id: 'no-fp', fingerprint: '' },            // 空指纹 → 丢
      { id: 'bad', fingerprint: 123 },             // 非字符串 → 丢
      null,                                        // 垃圾 → 丢
    ],
  })
  assert.equal(record.id, 'handover-1')
  assert.equal(record.status, 'authoritative')
  assert.deepEqual(record.refs.map((r) => r.id), ['read-order', 'spec-1'])
})

test('M2.6：`snapshotOf` 的 refs **排序稳定**（同样输入 → 同样字节）', () => {
  const a = snapshotOf({ id: 'x', refs: [{ id: 'b', fingerprint: '1' }, { id: 'a', fingerprint: '2' }] })
  const b = snapshotOf({ id: 'x', refs: [{ id: 'a', fingerprint: '2' }, { id: 'b', fingerprint: '1' }] })
  assert.deepEqual(a, b, '顺序不同但内容相同 → 快照必须一致，否则每次标绿都产生假 diff')
  assert.deepEqual(a.refs.map((r) => r.id), ['a', 'b'])
})

test('M2.6：`snapshotOf` 收垃圾输入不抛', () => {
  assert.doesNotThrow(() => snapshotOf(null))
  assert.doesNotThrow(() => snapshotOf(undefined))
  assert.doesNotThrow(() => snapshotOf('不是对象'))
  assert.deepEqual(snapshotOf(null).refs, [])
})

test('M2.6：`at` 只接受有限数（不写 undefined）', () => {
  assert.equal('at' in snapshotOf({ id: 'x', at: 123 }), true)
  assert.equal('at' in snapshotOf({ id: 'x', at: Number.NaN }), false)
  assert.equal('at' in snapshotOf({ id: 'x' }), false)
})

// ---------------------------------------------------------------- 2. mergeSnapshot

test('M2.6：`mergeSnapshot` 同一份文档只保留最新一条', () => {
  const first = snapshotOf({ id: 'h', at: 1, refs: [{ id: 'a', fingerprint: '111' }] })
  const second = snapshotOf({ id: 'h', at: 2, refs: [{ id: 'a', fingerprint: '222' }] })
  const merged = mergeSnapshot(mergeSnapshot({}, first), second)
  assert.equal(merged.h.at, 2, '应当被最新一次覆盖')
  assert.equal(merged.h.refs[0].fingerprint, '222')
})

test('M2.6：`mergeSnapshot` 不同文档各自保留', () => {
  const merged = mergeSnapshot(
    mergeSnapshot({}, snapshotOf({ id: 'h1', refs: [] })),
    snapshotOf({ id: 'h2', refs: [] }),
  )
  assert.deepEqual(Object.keys(merged).sort(), ['h1', 'h2'])
})

test('M2.6：`mergeSnapshot` **不修改入参**（纯函数）', () => {
  const existing = { h1: { id: 'h1', status: 'authoritative', refs: [] } }
  const frozen = JSON.stringify(existing)
  mergeSnapshot(existing, snapshotOf({ id: 'h2', refs: [] }))
  assert.equal(JSON.stringify(existing), frozen, '入参被改了 —— 那不是纯函数')
})

test('M2.6：`mergeSnapshot` 收到坏表 / 坏记录不抛', () => {
  assert.doesNotThrow(() => mergeSnapshot(null, null))
  assert.doesNotThrow(() => mergeSnapshot([], { id: 'x' }))
  assert.deepEqual(mergeSnapshot(null, { id: '', refs: [] }), {}, '空 id 不该进表')
})

// ---------------------------------------------------------------- 3. driftedRefsOf（核心对账）

test('**M2.6：指纹变了 → 报漂移**（这是本机制存在的理由）', () => {
  const table = { h: snapshotOf({ id: 'h', refs: [{ id: 'read-order', fingerprint: 'OLD111' }] }) }
  const drifted = driftedRefsOf(table, 'h', (id) => (id === 'read-order' ? 'NEW222' : undefined))
  assert.equal(drifted.length, 1)
  assert.deepEqual(drifted[0], { id: 'read-order', was: 'OLD111', now: 'NEW222' })
})

test('**M2.6：指纹没变 → 不报**（永远报的提醒会被学会无视）', () => {
  const table = { h: snapshotOf({ id: 'h', refs: [{ id: 'read-order', fingerprint: 'SAME' }] }) }
  const drifted = driftedRefsOf(table, 'h', () => 'SAME')
  assert.deepEqual(drifted, [], '没变却报了 —— 这会让健康度变成噪声')
})

test('**M2.6：文档被删/归档（拿不到指纹）→ 不报**（不重复报悬空引用）', () => {
  const table = { h: snapshotOf({ id: 'h', refs: [{ id: 'gone', fingerprint: 'OLD' }] }) }
  const drifted = driftedRefsOf(table, 'h', () => undefined)
  assert.deepEqual(drifted, [], '引用悬空由 V5 负责，这里不该重复报')
})

test('M2.6：`driftedRefsOf` 三件套坏输入都返回空数组', () => {
  assert.deepEqual(driftedRefsOf(null, 'h', () => 'x'), [])
  assert.deepEqual(driftedRefsOf({}, 'h', () => 'x'), [])
  assert.deepEqual(driftedRefsOf({ h: { refs: [] } }, 'h', '不是函数'), [])
})

test('M2.6：多份引用时只报**真的变了的**那几个', () => {
  const table = {
    h: snapshotOf({
      id: 'h',
      refs: [
        { id: 'a', fingerprint: 'A1' },
        { id: 'b', fingerprint: 'B1' },
        { id: 'c', fingerprint: 'C1' },
      ],
    }),
  }
  const drifted = driftedRefsOf(table, 'h', (id) => ({ a: 'A1', b: 'B2', c: 'C1' })[id])
  assert.deepEqual(drifted.map((d) => d.id), ['b'])
})

// ---------------------------------------------------------------- 4. driftMessageOf

test('M2.6：没有漂移 → 空串（不产生任何噪声）', () => {
  assert.equal(driftMessageOf('h', []), '')
  assert.equal(driftMessageOf('h', undefined), '')
})

test('M2.6：有漂移 → 是**事实陈述**，不是指责', () => {
  const message = driftMessageOf('h', [{ id: 'read-order', was: 'OLD111222', now: 'NEW333444' }])
  assert.match(message, /read-order/, '必须点名是哪份文档')
  assert.match(message, /OLD111/, '必须给出标绿时的值（前 6 位）')
  assert.match(message, /NEW333/, '必须给出现在的值（前 6 位）')
  assert.match(message, /可能已经过时/, '必须说清后果')
  // ⚠️ 反向：不许指责式措辞（那是"软约束"，且会让人反感）。
  assert.doesNotMatch(message, /你错|你忘了|不应该/, '不该用指责措辞')
  // 也不该假装知道"§5 一定错了" —— 改了未必错，得模型自己判断。
  assert.match(message, /核对|判断/, '必须把判断权交回给模型')
})

test('M2.6：快照文件名是常量且稳定（写死它会破坏对账链路）', () => {
  assert.equal(MARK_SNAPSHOT_FILE, 'ddd-mark-snapshots.json')
})

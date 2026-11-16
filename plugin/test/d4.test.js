/**
 * M1.5 / **D4** 的正式单测：`verifiedAt` 字段 + **H8** 判据。
 *
 * ---- D4 是什么（交接 §3.6）----
 * > `verifiedAt`（可选 date 字段）+ **H8**。
 * > **H8 是什么**：一条**新增判据**——「交接时，所有 `authoritative` 文档的
 * > `verifiedAt` 必须 ≥ 本交接的创建时间」。加在 `checkHandover` 的 H7 之后，
 * > **不是**现有 H1–H7 的延续。**先做成 warn**，观察几个真实项目再决定升 error
 *
 * ---- 编号（一个必须记清的事实）----
 * `H8` = **D4**（本条）。`H9` = **N8** 的 §1 项目简介判据。
 * 交接文档里 `H8` 被这两个判据**同时占用**，我按「§3.6 有完整定义的那条保留 H8」
 * 处理，N8 那条改叫 H9。详见 `core/handover.js` 里 H9 那段说明。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { checkHandover } from '../core/handover.js'
import { validateMeta } from '../docs/schema.js'
import { dateOf, verifiedDocsOf } from '../tools/doc-handover-check.js'

/** 七段齐全的交接正文。 */
const GOOD_BODY = `## 1. 我的意图

本项目是探针。做点事。

## 2. 现在到哪了

| 项 | 值 |
|---|---|
| 单测 | 全绿 |

## 3. 下一刀

- 改 \`core/gate.js\`

## 4. 坑

| # | 坑 |
|---|---|
| 1 | x |

## 5. 验收

- 会话 session-abc seq=1

## 6. 刻意没做

- 无

## 7. 仍未决

无
`

/** 跑一次 H8。 */
function h8Of({ docs, createdAt }) {
  const verdict = checkHandover({
    meta: { id: 'h', role: 'handover', order: -10, status: 'draft' },
    body: GOOD_BODY,
    context: {
      handovers: [],
      ...(docs === undefined ? {} : { verifiedDocs: docs }),
      ...(createdAt === undefined ? {} : { handoverCreatedAt: createdAt }),
    },
  })
  return {
    hits: verdict.warnings.filter((item) => item.rule === 'H8'),
    errors: verdict.errors.filter((item) => item.rule === 'H8'),
    ok: verdict.ok,
  }
}

// ---------------------------------------------------------------- 正向：能报

test('H8：authoritative 的 verifiedAt **早于**交接时间 → 1 条 warn', () => {
  const result = h8Of({
    docs: [
      { id: 'spec-old', status: 'authoritative', verifiedAt: '2026-01-01' },
      { id: 'spec-new', status: 'authoritative', verifiedAt: '2026-11-12' },
    ],
    createdAt: '2026-11-12',
  })
  assert.equal(result.hits.length, 1, '应当恰好 1 条（只点名 spec-old）')
  assert.match(result.hits[0].message, /spec-old/)
  assert.equal(/spec-new/.test(result.hits[0].message), false, 'spec-new 是新的，不该被点名')
  assert.equal(result.ok, true, 'H8 是 warn，不能拦落盘')
})

test('H8：全部 fresh → 不报', () => {
  const result = h8Of({
    docs: [{ id: 'a', status: 'authoritative', verifiedAt: '2026-11-12' }],
    createdAt: '2026-11-12',
  })
  assert.equal(result.hits.length, 0)
})

test('H8：**同一天不算过期**（>= 不是 >）', () => {
  const result = h8Of({
    docs: [{ id: 'same-day', status: 'authoritative', verifiedAt: '2026-11-12' }],
    createdAt: '2026-11-12',
  })
  assert.equal(result.hits.length, 0, '同一天应当算 fresh（判据是 >=）')
})

// ---------------------------------------------------------------- 反向：不该乱报

test('H8：只查 **authoritative**（draft / superseded / sealed / void 都不参与）', () => {
  const result = h8Of({
    docs: [
      { id: 'd', status: 'draft', verifiedAt: '2020-01-01' },
      { id: 's', status: 'superseded', verifiedAt: '2020-01-01' },
      { id: 'sealed', status: 'sealed', verifiedAt: '2020-01-01' },
      { id: 'v', status: 'void', verifiedAt: '2020-01-01' },
      { id: 'p', status: 'partial', verifiedAt: '2020-01-01' },
    ],
    createdAt: '2026-11-12',
  })
  assert.equal(result.hits.length, 0, '非 authoritative 一律不查')
})

test('H8：**缺 verifiedAt 不算 stale**（字段是可选的）', () => {
  const result = h8Of({
    docs: [
      { id: 'no-date', status: 'authoritative' },
      { id: 'empty-date', status: 'authoritative', verifiedAt: '' },
    ],
    createdAt: '2026-11-12',
  })
  assert.equal(result.hits.length, 0, '缺字段不该被这条判据报（否则所有老文档立刻变 warn）')
})

test('H8：**格式坏的 verifiedAt 不在 H8 里报**（那是 V12 的活，不重复）', () => {
  const result = h8Of({
    docs: [
      { id: 'bad-format', status: 'authoritative', verifiedAt: '2026/11/12' },
      { id: 'bad-format-2', status: 'authoritative', verifiedAt: '昨天' },
    ],
    createdAt: '2026-11-12',
  })
  assert.equal(result.hits.length, 0, '格式坏由 V12 报；H8 不该重复报同一条')
})

test('H8：**拿不到 handoverCreatedAt → 整段跳过**（不猜）', () => {
  const result = h8Of({
    docs: [{ id: 'old', status: 'authoritative', verifiedAt: '2020-01-01' }],
    createdAt: undefined,
  })
  assert.equal(result.hits.length, 0, '没有比较基准就不判 —— 不能报"查不出原因"的 warn')
})

test('H8：**拿不到 verifiedDocs → 整段跳过**（不猜）', () => {
  const result = h8Of({ docs: undefined, createdAt: '2026-11-12' })
  assert.equal(result.hits.length, 0)
})

test('H8：createdAt 格式坏 → 当作拿不到（跳过）', () => {
  const result = h8Of({
    docs: [{ id: 'old', status: 'authoritative', verifiedAt: '2020-01-01' }],
    createdAt: '2026/11/12',
  })
  assert.equal(result.hits.length, 0)
})

test('H8：**永不产生 error**（它是 warn）', () => {
  const result = h8Of({
    docs: [{ id: 'very-old', status: 'authoritative', verifiedAt: '1999-01-01' }],
    createdAt: '2026-11-12',
  })
  assert.equal(result.errors.length, 0)
  assert.equal(result.hits.length, 1)
})

// ---------------------------------------------------------------- V12：字段本身的校验

test('D4 / V12：verifiedAt 格式合法 → 不报', () => {
  const result = validateMeta({
    id: 'a', title: 't', role: 'spec', order: 10, status: 'draft', summary: 's', basis: '实测',
    verifiedAt: '2026-11-12',
  }, {})
  assert.equal(result.issues.some((item) => item.rule === 'V12'), false)
})

test('D4 / V12：格式坏 → **warn 不是 error**（不能把文档踢出必读清单）', () => {
  for (const bad of ['2026/11/12', '昨天', '2026-13-01', '20261112']) {
    const result = validateMeta({
      id: 'a', title: 't', role: 'spec', order: 10, status: 'draft', summary: 's', basis: '实测',
      verifiedAt: bad,
    }, {})
    const v12 = result.issues.filter((item) => item.rule === 'V12')
    assert.equal(v12.length, 1, `${bad} 应当报 1 条 V12`)
    assert.equal(v12[0].level, 'warn', 'V12 必须是 warn')
    assert.equal(result.hasError, false, `${bad} 不该让 hasError 变 true`)
  }
})

test('D4 / V12：**不填 verifiedAt 完全合法**（可选字段）', () => {
  const result = validateMeta({
    id: 'a', title: 't', role: 'spec', order: 10, status: 'draft', summary: 's', basis: '实测',
  }, {})
  assert.equal(result.issues.some((item) => item.rule === 'V12'), false)
  assert.equal(result.hasError, false)
})

// ---------------------------------------------------------------- helper

test('dateOf：只认 YYYY-MM-DD，其余一律 undefined（不猜）', () => {
  assert.equal(dateOf('2026-11-12'), '2026-11-12')
  assert.equal(dateOf('2026/11/12'), undefined)
  assert.equal(dateOf('2026-11-12T10:00:00Z'), undefined, '完整时间戳不认（粒度是日）')
  assert.equal(dateOf(''), undefined)
  assert.equal(dateOf(null), undefined)
  assert.equal(dateOf(undefined), undefined)
  assert.equal(dateOf(20261112), undefined)
})

test('verifiedDocsOf：给全量、只挑有 id 且无 error 的', () => {
  const docs = verifiedDocsOf([
    { meta: { id: 'a', status: 'authoritative', verifiedAt: '2026-01-01' }, hasError: false },
    { meta: { id: 'b', status: 'draft' }, hasError: false },
    { meta: { id: 'broken', status: 'authoritative' }, hasError: true },
    { meta: null, hasError: false },
  ])
  assert.deepEqual(docs, [
    { id: 'a', status: 'authoritative', verifiedAt: '2026-01-01' },
    { id: 'b', status: 'draft', verifiedAt: undefined },
  ], '坏文档与无 id 的都要被剔掉')
})

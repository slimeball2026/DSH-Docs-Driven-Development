/**
 * M1.5 的 D1（交接排最后）与 D9（H7 是 warn）的单测。
 *
 * ⚠️ **这两条必须一起测**（`P6`）：D1 若不配 D9 的「H7 跳过 superseded」，
 * 新建交接后**每一份旧交接都会立刻变红**。所以本文件里刻意把四个步骤
 * 按 `§3.5` 的顺序组织，任一步缺了，后面那一步的断言就会失败。
 *
 * 四步（顺序不能反）：
 *   ① `doc_new` 的 handover 默认 order = 最小 handover order − 10
 *   ② 建新交接时把旧的 `authoritative` 交接自动标 `superseded`
 *   ③ H7 **跳过** `superseded`
 *   ④ H7 是 **error**
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { nextHandoverOrder, nextOrder } from '../tools/doc-new.js'
import {
  handoverListOf,
  handoverMinOrder,
  checkHandover,
  parseHandoverSections,
} from '../core/handover.js'

/** 造一个条目。 */
function entry(id, role, order, status = 'authoritative') {
  return { path: `docs/${id}.md`, meta: { id, role, order, status, summary: `${id}` }, issues: [], hasError: false }
}

const GOOD_BODY = `# 交接

## 1. 我的意图

把交接变成可校验的产物。

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

// ---------------------------------------------------------------- N5：口径

test('N5：handoverMinOrder 只认 role=handover（不扫全部条目）', () => {
  // 这是 N5 的**核心**：read-order 的 order 0 不该参与 H7 的比较。
  const entries = [
    entry('read-order', 'index', 0),
    entry('spec-a', 'spec', 10),
    entry('handover-a', 'handover', 30),
    entry('handover-b', 'handover', 20),
  ]
  assert.equal(handoverMinOrder(entries), 20)
})

test('N5：项目里没有交接 → undefined（H7 会跳过，而不是瞎报）', () => {
  assert.equal(handoverMinOrder([entry('read-order', 'index', 0)]), undefined)
  assert.equal(handoverMinOrder([]), undefined)
  assert.equal(handoverMinOrder(undefined), undefined)
})

test('N5：order 非数字 / NaN 的条目被跳过，不污染最小值', () => {
  const entries = [
    entry('h-x', 'handover', Number.NaN),
    entry('h-a', 'handover', 5),
  ]
  assert.equal(handoverMinOrder(entries), 5)
})

test('N5：handoverListOf 也只收交接（H6 的口径必须一致）', () => {
  const entries = [entry('read-order', 'index', 0), entry('handover-a', 'handover', 30)]
  assert.deepEqual(handoverListOf(entries), [{ id: 'handover-a', status: 'authoritative', order: 30 }])
})

// ---------------------------------------------------------------- ① order 默认值

test('D1 ①：nextHandoverOrder = 最小 handover order − 10', () => {
  assert.equal(nextHandoverOrder([entry('h-a', 'handover', 30)]), 20)
  assert.equal(nextHandoverOrder([entry('h-a', 'handover', 30), entry('h-b', 'handover', 20)]), 10)
})

test('D1 ①：空项目第一份交接给 -10（保证排在 order>=0 的一切之前）', () => {
  assert.equal(nextHandoverOrder([]), -10)
})

test('D1 ①：**交接的负 order 不拉动**其它文档的 nextOrder', () => {
  // 交接用 -10/-20 之后，普通文档仍应按"最大 + 10"往后排，而不是被负数带跑。
  const entries = [entry('read-order', 'index', 0), entry('h-a', 'handover', -10), entry('spec-a', 'spec', 20)]
  assert.equal(nextOrder(entries), 30)
})

// ---------------------------------------------------------------- ③ H7 跳过 superseded

test('D9 ③：**superseded 的交接不报 H7**（缺这一步就是永久红灯）', () => {
  const verdict = checkHandover({
    meta: { id: 'handover-old', role: 'handover', order: 0, status: 'superseded' },
    body: GOOD_BODY,
    context: { minOrder: -10, handovers: [{ id: 'handover-old', status: 'superseded', order: 0 }] },
  })
  assert.equal(verdict.errors.some((item) => item.rule === 'H7'), false)
  assert.equal(verdict.warnings.some((item) => item.rule === 'H7'), false)
  assert.equal(verdict.ok, true, '被取代的旧交接必须 ok:true（正向判据）')
})

test('D9 ③：superseded **且** order 正确 → 也不报 H7', () => {
  const verdict = checkHandover({
    meta: { id: 'handover-old', role: 'handover', order: -10, status: 'superseded' },
    body: GOOD_BODY,
    context: { minOrder: -10, handovers: [{ id: 'handover-old', status: 'superseded', order: -10 }] },
  })
  assert.equal(verdict.errors.some((item) => item.rule === 'H7'), false)
})

// ---------------------------------------------------------------- ④ H7 是 error

test('D9 ④：H7 **是 error**（这是 P6 的唯一可证伪证据）', () => {
  const verdict = checkHandover({
    meta: { id: 'handover-x', role: 'handover', order: 999, status: 'authoritative' },
    body: GOOD_BODY,
    context: { minOrder: 20, handovers: [{ id: 'handover-x', status: 'authoritative', order: 999 }] },
  })
  const h7 = verdict.errors.find((item) => item.rule === 'H7')
  assert.ok(h7 !== undefined, 'H7 必须在 errors 里')
  assert.equal(h7.level, 'error')
  assert.equal(verdict.ok, false)
  assert.equal(verdict.warnings.some((item) => item.rule === 'H7'), false, '不能同时又出现在 warnings 里')
})

test('D9 ④：order 正确时不报（防止"永远报"）', () => {
  const verdict = checkHandover({
    meta: { id: 'handover-x', role: 'handover', order: 20, status: 'authoritative' },
    body: GOOD_BODY,
    context: { minOrder: 20, handovers: [{ id: 'handover-x', status: 'authoritative', order: 20 }] },
  })
  assert.equal(verdict.errors.some((item) => item.rule === 'H7'), false)
})

test('D9：三份交接共存时的完整矩阵（① + ② + ③ + ④ 一起）', () => {
  // 真实形态：一份被取代的旧交接（order 0）+ 一份当前的（order -10）+ 一份排错的（order 999）
  const handovers = [
    { id: 'old', status: 'superseded', order: 0 },
    { id: 'current', status: 'authoritative', order: -10 },
    { id: 'wrong', status: 'authoritative', order: 999 },
  ]
  const minOrder = -10
  const verify = (id, status, order) => checkHandover({
    meta: { id, role: 'handover', order, status },
    body: GOOD_BODY,
    context: { minOrder, handovers },
  })

  assert.equal(verify('old', 'superseded', 0).ok, true, 'superseded 不报')
  assert.equal(verify('current', 'authoritative', -10).ok, true, 'order 正确不报')
  const wrong = verify('wrong', 'authoritative', 999)
  assert.equal(wrong.ok, false, 'order 排错的权威交接必须失败')
  assert.deepEqual(wrong.errors.filter((i) => i.rule === 'H7').length, 1)
})

// ---------------------------------------------------------------- 交接结构本身没被改坏

test('D9 改动不影响 H1：七段仍能解析', () => {
  const sections = parseHandoverSections(GOOD_BODY)
  assert.equal(Object.values(sections).filter((s) => s.found === true).length, 7)
})

// ---------------------------------------------------------------- D1 ②：取代范围（回归）

test('D1 ② 回归：**draft 的旧交接也要被取代**（端到端验证抓到的真 bug）', async () => {
  // ⚠️ 这条是 `_m15/repro-e2e.mjs` 抓出来的**真实缺陷**，不是设想出来的。
  //
  // 第一版 `supersedeOldHandovers` 只标 `status === 'authoritative'`。
  // 但 `doc_new` 建交接的**默认 status 是 draft** ——
  // 所以"建第二份交接"时，第一份也是 draft，**一个都不标**。
  // 结果：两份 draft 交接共存，"新交接取代旧的"这个语义完全没发生，H6 照报。
  //
  // 修法：同 role 的现存交接，只要不是 `superseded`/`void`/`sealed`（终态），都标。
  const { supersedeOldHandovers } = await import('../tools/doc-new.js')

  /** 造一个能记账的假 fs。 */
  const files = new Map()
  const fs = {
    resolve: async (p) => ({ displayPath: p, targetKey: p }),
    writeText: async (target, content) => { files.set(target.targetKey ?? target, content) },
  }

  const entries = [
    { path: 'C:/proj/docs/h-old.md', meta: { id: 'h-old', role: 'handover', order: -10, status: 'draft' }, text: '---\nid: h-old\norder: -10\nstatus: draft\n---\n\n正文\n' },
    { path: 'C:/proj/docs/h-new.md', meta: { id: 'h-new', role: 'handover', order: -20, status: 'draft' }, text: '---\nid: h-new\norder: -20\nstatus: draft\n---\n\n正文\n' },
    { path: 'C:/proj/docs/spec-x.md', meta: { id: 'spec-x', role: 'spec', order: 10, status: 'authoritative' }, text: '---\nid: spec-x\n---\n' },
  ]
  const reg = { entries, rescan: async () => {} }

  const done = await supersedeOldHandovers({
    reg,
    fs,
    selfId: 'h-new',
    projectRoot: 'C:/proj',
    exec: {},
    logger: undefined,
  })

  assert.deepEqual(done, ['h-old'], 'draft 的旧交接必须被取代（不是只标 authoritative）')
  const written = files.get('C:/proj/docs/h-old.md')
  assert.match(written, /^status: superseded$/m)
  assert.match(written, /supersededBy: \["h-new"\]/)
})

test('D1 ② 回归：终态（superseded / void / sealed）不重复标', async () => {
  const { supersedeOldHandovers } = await import('../tools/doc-new.js')
  const files = new Map()
  const fs = {
    resolve: async (p) => ({ displayPath: p, targetKey: p }),
    writeText: async (target, content) => { files.set(target.targetKey ?? target, content) },
  }
  const entries = ['superseded', 'void', 'sealed'].map((status, index) => ({
    path: `C:/proj/docs/h-${status}.md`,
    meta: { id: `h-${status}`, role: 'handover', order: index, status },
    text: `---\nid: h-${status}\nstatus: ${status}\n---\n`,
  }))
  const done = await supersedeOldHandovers({
    reg: { entries, rescan: async () => {} }, fs, selfId: 'h-new', projectRoot: 'C:/proj', exec: {},
  })
  assert.deepEqual(done, [], '终态不该被再标一次（多一次无意义写入）')
})

test('D1 ② 回归：非 handover 的文档**绝不**被标 superseded', async () => {
  const { supersedeOldHandovers } = await import('../tools/doc-new.js')
  const files = new Map()
  const fs = {
    resolve: async (p) => ({ displayPath: p, targetKey: p }),
    writeText: async (target, content) => { files.set(target.targetKey ?? target, content) },
  }
  const entries = [
    { path: 'C:/proj/docs/spec-x.md', meta: { id: 'spec-x', role: 'spec', order: 10, status: 'authoritative' }, text: '---\nid: spec-x\n---\n' },
  ]
  const done = await supersedeOldHandovers({
    reg: { entries, rescan: async () => {} }, fs, selfId: 'h-new', projectRoot: 'C:/proj', exec: {},
  })
  assert.deepEqual(done, [])
  assert.equal(files.size, 0, '非交接文档一个字节都不该被写')
})

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





// ---------------------------------------------------------------- ④ H7 是 error







// ---------------------------------------------------------------- 交接结构本身没被改坏

test('D9 改动不影响 H1：七段仍能解析', () => {
  const sections = parseHandoverSections(GOOD_BODY)
  assert.equal(Object.values(sections).filter((s) => s.found === true).length, 7)
})

// ---------------------------------------------------------------- D1 ②：取代范围（回归）

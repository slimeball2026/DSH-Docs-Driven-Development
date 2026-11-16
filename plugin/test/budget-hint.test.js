/**
 * M2-G / D-9：预算超限时给出路。
 *
 * ---- 这一组测试的重点（SPEC §6.7 的四条判据）----
 *
 * 1. 超限时 `【预算】` 行给出**具体的 id 列表**（不是"建议读关键文档"这种空话）；
 * 2. 优先级规则**固定且可测**：`role: handover` / `role: index` 优先，其余按 order；
 * 3. **不超限时这两行一个字符都不许变**；
 * 4. 推荐的 id 数量**有上限**。
 *
 * 判据 3 是本文件里最硬的：
 * 它要求**逐字节**对比，所以这里用的是**字面量 golden 字符串**，
 * 而不是"再算一次然后比较" —— 后者两边同时算错也会通过。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MAX_BUDGET_HINTS,
  budgetHintIdsOf,
  computeBudget,
  renderBudgetLine,
} from '../core/budget.js'

/** 造一条必读条目。 */
function entryOf(id, role, order, tokens = 1000) {
  return {
    path: `C:\\proj\\docs\\${id}.md`,
    meta: { id, role, order, status: 'authoritative', summary: `${id} 摘要`, tokens },
    issues: [],
    hasError: false,
  }
}

// ---------------------------------------------------------------- 1. 判据 3：不超限时零变化

test('**判据 3：不超预算时【预算】行与 M1 逐字节相同**（golden 字符串）', () => {
  const budget = computeBudget([entryOf('a', 'spec', 0, 1000)], { limit: 30000 })
  assert.equal(budget.over, false, '这条用例不该超限')

  // M1 的原样输出（**不许改这个字面量**）。给 hintIds 也不该变。
  const M1_LINE = '【预算】必读 1 份 ≈ 1k tokens（上限 30k）'

  assert.equal(renderBudgetLine(budget), M1_LINE, '不超限时的输出变了')
  assert.equal(
    renderBudgetLine(budget, { hintIds: ['a', 'b'] }),
    M1_LINE,
    '不超限时给了 hintIds 就追加了后缀 —— 判据 3 要求一个字符都不变',
  )
})

test('**判据 3：没有必读文档时仍然是空串**（不因为新参数变成别的）', () => {
  const budget = computeBudget([], { limit: 30000 })
  assert.equal(renderBudgetLine(budget), '')
  assert.equal(renderBudgetLine(budget, { hintIds: ['a'] }), '')
})

// ---------------------------------------------------------------- 2. 判据 1：超限时给具体 id

test('**判据 1：超限时【预算】行给出具体的 id 列表**', () => {
  const required = [
    entryOf('read-order', 'index', 0, 20000),
    entryOf('handover-m2', 'handover', -30, 20000),
    entryOf('spec-m2', 'spec', 10, 20000),
  ]
  const budget = computeBudget(required, { limit: 30000 })
  assert.equal(budget.over, true)

  const line = renderBudgetLine(budget, { hintIds: ['handover-m2', 'read-order'] })
  assert.ok(line.includes('`handover-m2`'), `没有给出具体 id：${line}`)
  assert.ok(line.includes('`read-order`'), `没有给出具体 id：${line}`)
  // 判据 1 的反面：不许是空话
  for (const vague of ['建议读关键文档', '注意预算', '请优先阅读']) {
    assert.ok(!line.includes(vague), `出现了空话「${vague}」：${line}`)
  }
})

test('判据 1：超限但**没有 hintIds** 时不追加空话（宁可不写）', () => {
  const budget = computeBudget([entryOf('a', 'spec', 0, 40000)], { limit: 30000 })
  assert.equal(budget.over, true)
  const line = renderBudgetLine(budget, { hintIds: [] })
  assert.equal(line, '【预算】必读 1 份 ≈ 40k tokens（上限 30k）⚠️ 超出上限')
})

// ---------------------------------------------------------------- 3. 判据 2：优先级固定且可测

test('**判据 2：handover 优先于 index，两者都优先于其它角色**', () => {
  const required = [
    entryOf('spec-early', 'spec', -100),   // order 最小，但角色不优先
    entryOf('read-order', 'index', 50),
    entryOf('handover-x', 'handover', 100),
  ]
  const ids = budgetHintIdsOf(required, 3)
  assert.deepEqual(ids, ['handover-x', 'read-order', 'spec-early'])
})

test('判据 2：同档内按 order 升序，order 相同按 id 字典序（渲染稳定）', () => {
  const required = [
    entryOf('b-index', 'index', 20),
    entryOf('a-index', 'index', 10),
    entryOf('zz-spec', 'spec', 5),
    entryOf('aa-spec', 'spec', 5),
  ]
  assert.deepEqual(budgetHintIdsOf(required, 4), ['a-index', 'b-index', 'aa-spec', 'zz-spec'])
})

test('判据 2：**不看已读/未读**（那是状态，会破坏 M0-5 红线）', () => {
  const a = [entryOf('x', 'handover', 0), entryOf('y', 'spec', 1)]
  const b = [
    { ...entryOf('x', 'handover', 0), read: true },
    { ...entryOf('y', 'spec', 1), read: false },
  ]
  assert.deepEqual(budgetHintIdsOf(a, 2), budgetHintIdsOf(b, 2), '优先级受"已读"影响了')
})

test('判据 2：`order` 缺失时排在同档最后，不抛', () => {
  const required = [
    { meta: { id: 'no-order', role: 'handover', status: 'authoritative' } },
    entryOf('has-order', 'handover', 5),
  ]
  assert.deepEqual(budgetHintIdsOf(required, 2), ['has-order', 'no-order'])
})

test('判据 2：没有 id 的条目被跳过，不产生 `` 空壳', () => {
  const required = [
    { meta: { role: 'handover', status: 'authoritative' } },
    entryOf('real', 'handover', 0),
  ]
  assert.deepEqual(budgetHintIdsOf(required, 2), ['real'])
})

// ---------------------------------------------------------------- 4. 判据 4：份数有上限

test('**判据 4：推荐份数有上限，配成 99 也不会列 99 个**', () => {
  const required = Array.from({ length: 20 }, (_, i) => entryOf(`doc-${i}`, 'spec', i))
  assert.equal(budgetHintIdsOf(required, 99).length, MAX_BUDGET_HINTS)
  assert.equal(budgetHintIdsOf(required, 3).length, 3)
})

test('判据 4：非法份数回落默认 3，且至少 1 份', () => {
  const required = Array.from({ length: 5 }, (_, i) => entryOf(`d-${i}`, 'spec', i))
  assert.equal(budgetHintIdsOf(required, undefined).length, 3)
  assert.equal(budgetHintIdsOf(required, 0).length, 1, '0 份应当被夹到 1')
  assert.equal(budgetHintIdsOf(required, -5).length, 1, '负数应当被夹到 1')
  assert.equal(budgetHintIdsOf(required, NaN).length, 3, 'NaN 应当回落默认')
})

test('判据 4：必读份数少于上限时，不补空位', () => {
  const required = [entryOf('only', 'index', 0)]
  assert.deepEqual(budgetHintIdsOf(required, 3), ['only'])
})

// ---------------------------------------------------------------- 5. 端到端：dogfood 的形状

test('**端到端：dogfood 那种 7 份超限的形状，会推荐 handover + index**', () => {
  const required = [
    entryOf('read-order', 'index', 10, 8000),
    entryOf('coach-prompt-spec', 'spec', 20, 9000),
    entryOf('stage-3-machine', 'spec', 30, 7000),
    entryOf('stage-4-verifier', 'spec', 40, 8000),
    entryOf('stage-6-verify', 'spec', 50, 6000),
    entryOf('handover-to-tier26', 'handover', -10, 7000),
    entryOf('spec-tier2', 'spec', 60, 6924),
  ]
  const budget = computeBudget(required, { limit: 30000 })
  assert.equal(budget.over, true, `应当超限，实际 tokens=${budget.tokens}`)

  const hintIds = budgetHintIdsOf(required, 3)
  assert.deepEqual(hintIds, ['handover-to-tier26', 'read-order', 'coach-prompt-spec'])

  const line = renderBudgetLine(budget, { hintIds })
  // 真实形态：`【预算】必读 7 份 ≈ 51.9k tokens（上限 30k）⚠️ 超出上限 —— 建议先读 … 两份`
  assert.ok(line.includes('建议先读'), line)
  assert.ok(line.includes('`handover-to-tier26`'), line)
  assert.ok(line.includes('`read-order`'), line)
})

// ---------------------------------------------------------------- 6. 单份/两份的措辞

test('**量词必须跟着份数走：1 份写「这一份」，N 份写「N 份」**', () => {
  // ⚠️ 这条是实测抓出来的 bug：我第一版写的是
  // `hintIds.length === 1 ? '这一份' : '两份'`，
  // 于是默认配 3 份时输出「…、`coach-prompt-spec` 两份」——
  // **列了三个 id，却写两份**。数据是对的，文案是错的，
  // 而这类错比"没有文案"更难发现（用户会以为只该读两份）。
  const budget = computeBudget([entryOf('x', 'handover', 0, 40000)], { limit: 30000 })

  // ⚠️ **所有断言都必须锚定到 ` —— 建议先读` 之后那一段**。
  // 行首有「必读 1 份」，所以对整行做 `includes('1 份')` 永远为真 ——
  // 我第一版就是这么写的，于是这条测试自己把自己绊倒了（两次）。
  const tailOf = (line) => line.slice(line.indexOf('建议先读'))
  const suffixOf = (line) => line.slice(line.indexOf(' —— '))

  const one = renderBudgetLine(budget, { hintIds: ['x'] })
  assert.ok(tailOf(one).startsWith('建议先读 `x` 这一份'), one)
  assert.ok(!/1\s*份/.test(tailOf(one)), `一份时后缀不该写「1 份」：${suffixOf(one)}`)

  const two = renderBudgetLine(budget, { hintIds: ['x', 'y'] })
  assert.ok(/2\s*份$/.test(two), two)
  assert.ok(!tailOf(two).includes('两份'), '应当用阿拉伯数字，与「必读 2 份」一致')

  const three = renderBudgetLine(budget, { hintIds: ['x', 'y', 'z'] })
  // **反向断言：文案里的数字必须等于实际列出的 id 个数**
  const tail = tailOf(three)
  const listed = (tail.match(/`[^`]+`/g) ?? []).length
  const stated = Number(/(\d+)\s*份/.exec(tail)?.[1])
  assert.equal(listed, 3, `应当列 3 个 id，实际 ${listed}：${three}`)
  assert.equal(stated, listed, `文案说 ${stated} 份，实际列了 ${listed} 个：${three}`)
})

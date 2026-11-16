/**
 * `core/budget.js` 的单测（M1-E）。
 *
 * 三条硬约束各有一组断言，其中最重要的是**不写回 frontmatter** ——
 * 它靠"本模块是纯函数、根本拿不到 fs"来保证，所以这里用**结构断言**钉住：
 * 预算函数的返回值里不含任何文档正文，也不含任何"要写回"的形态。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_BUDGET_TOKENS,
  TOKENS_PER_CHAR,
  computeBudget,
  estimateTokens,
  formatTokens,
  renderBudgetLine,
  tokensOfDoc,
} from '../core/budget.js'

/** 造一个必读条目。 */
function entry(id, body, extra = {}) {
  return { meta: { id, ...extra.meta }, body, text: body }
}

// ---------------------------------------------------------------- 1. 估算

test('estimateTokens：中文按字符数 × 0.75 向上取整', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('四个汉字'), 3) // 4 × 0.75 = 3
  assert.equal(estimateTokens('五个汉字啊'), 4) // 5 × 0.75 = 3.75 → 4
  assert.equal(TOKENS_PER_CHAR, 0.75)
})

test('estimateTokens：按**码位**数而不是 UTF-16 长度（emoji 不虚高一倍）', () => {
  // '🙂' 的 .length 是 2，但只有 1 个码位。
  assert.equal(estimateTokens('🙂'), 1) // ceil(1 × 0.75) = 1
  assert.equal(estimateTokens('🙂🙂🙂🙂'), 3) // ceil(4 × 0.75) = 3
})

test('estimateTokens：非字符串 / null 一律 0（不抛）', () => {
  assert.equal(estimateTokens(null), 0)
  assert.equal(estimateTokens(undefined), 0)
  assert.equal(estimateTokens(42), 0)
})

// ---------------------------------------------------------------- 2. 显式 tokens 优先

test('frontmatter 里显式写了 tokens → 用它，不估算', () => {
  const verdict = tokensOfDoc(entry('a', '很长的正文'.repeat(100), { meta: { tokens: 123 } }))
  assert.deepEqual(verdict, { tokens: 123, source: 'declared' })
})

test('没写 tokens → 估算，且 source 标成 estimated', () => {
  const verdict = tokensOfDoc(entry('a', '四个汉字'))
  assert.deepEqual(verdict, { tokens: 3, source: 'estimated' })
})

test('tokens 写坏了（负数 / NaN / 字符串）→ 回落估算，不抛', () => {
  for (const bad of [-1, Number.NaN, '100', null]) {
    const verdict = tokensOfDoc(entry('a', '四个汉字', { meta: { tokens: bad } }))
    assert.equal(verdict.source, 'estimated', `tokens=${String(bad)} 应该回落估算`)
  }
})

test('tokens: 0 是合法声明（空文档），不当成"没写"', () => {
  const verdict = tokensOfDoc(entry('a', '正文', { meta: { tokens: 0 } }))
  assert.deepEqual(verdict, { tokens: 0, source: 'declared' })
})

test('没有正文 → 0 token，source 标 none', () => {
  assert.deepEqual(tokensOfDoc({ meta: { id: 'a' } }), { tokens: 0, source: 'none' })
})

// ---------------------------------------------------------------- 3. 汇总

test('computeBudget：条数、总量、超限判定都对', () => {
  const budget = computeBudget([
    entry('a', 'x'.repeat(1000)), // ceil(750)
    entry('b', 'x'.repeat(1000)), // 750
  ], { limit: 1000 })
  assert.equal(budget.count, 2)
  assert.equal(budget.tokens, 1500)
  assert.equal(budget.limit, 1000)
  assert.equal(budget.over, true)
  assert.equal(budget.overBy, 500)
})

test('computeBudget：恰好等于上限**不算**超（边界）', () => {
  const budget = computeBudget([entry('a', 'x'.repeat(1000))], { limit: 750 })
  assert.equal(budget.tokens, 750)
  assert.equal(budget.over, false)
  assert.equal(budget.overBy, 0)
})

test('computeBudget：perDoc 按 token 降序，同 token 按 id 稳定排序', () => {
  const budget = computeBudget([
    entry('b', 'x'.repeat(100)),
    entry('a', 'x'.repeat(100)),
    entry('c', 'x'.repeat(1000)),
  ])
  assert.deepEqual(budget.perDoc.map((item) => item.id), ['c', 'a', 'b'])
})

test('computeBudget：默认上限 30000；非法上限回落默认', () => {
  assert.equal(computeBudget([]).limit, DEFAULT_BUDGET_TOKENS)
  for (const bad of [0, -5, Number.NaN, '1000', null]) {
    assert.equal(computeBudget([], { limit: bad }).limit, DEFAULT_BUDGET_TOKENS, `limit=${String(bad)}`)
  }
})

test('computeBudget：空清单 → 0 份 0 token，不超', () => {
  const budget = computeBudget([])
  assert.deepEqual(
    { count: budget.count, tokens: budget.tokens, over: budget.over },
    { count: 0, tokens: 0, over: false },
  )
})

test('computeBudget：分别统计 declared / estimated 的份数（可审计）', () => {
  const budget = computeBudget([
    entry('a', 'x', { meta: { tokens: 10 } }),
    entry('b', 'x'.repeat(100)),
  ])
  assert.equal(budget.declared, 1)
  assert.equal(budget.estimated, 1)
})

// ---------------------------------------------------------------- 4. 渲染

test('renderBudgetLine：形态与 SPEC §7.1 一致', () => {
  // 40000 字符 × 0.75 = 30000，**恰好等于**上限 → 按设计不算超（见边界测试）。
  // 所以这里用 20000 的上限来造真正的超限。
  const line = renderBudgetLine(computeBudget([entry('a', 'x'.repeat(40000))], { limit: 20000 }))
  assert.equal(line, '【预算】必读 1 份 ≈ 30k tokens（上限 20k）⚠️ 超出上限')
})

test('renderBudgetLine：没超预算时**不带**警告后缀', () => {
  const line = renderBudgetLine(computeBudget([entry('a', 'x'.repeat(1000))], { limit: 30000 }))
  // 1000 字符 × 0.75 = 750 → 不足 1k 就写原数（不写 0.8k）。
  assert.equal(line, '【预算】必读 1 份 ≈ 750 tokens（上限 30k）')
  assert.equal(line.includes('⚠️'), false)
})

test('renderBudgetLine：真实规模（dogfood 量级）一行放得下', () => {
  // dogfood 必读 7 份 ≈ 51923 tokens，上限 30000 → 超限。
  const budget = { count: 7, tokens: 51923, limit: 30000, over: true }
  const line = renderBudgetLine(budget)
  assert.equal(line, '【预算】必读 7 份 ≈ 51.9k tokens（上限 30k）⚠️ 超出上限')
  assert.ok(line.length < 80, `这一行太长了（${line.length} 字符），会挤掉索引块预算`)
})

test('renderBudgetLine：没有必读文档 → 空串（不占索引块预算）', () => {
  assert.equal(renderBudgetLine(computeBudget([])), '')
  assert.equal(renderBudgetLine(null), '')
})

test('formatTokens：小于 1000 不缩，大于等于 1000 用 k', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1000), '1k')
  assert.equal(formatTokens(1500), '1.5k')
  assert.equal(formatTokens(28432), '28.4k')
})

// ---------------------------------------------------------------- 5. 红线：不写回 frontmatter

test('**预算函数的输出里没有任何文档正文**（所以不可能被写回 frontmatter）', () => {
  const secret = '这是一段不该出现在预算输出里的正文'
  const budget = computeBudget([entry('a', secret)])
  const serialized = JSON.stringify(budget)
  assert.equal(serialized.includes(secret), false, '预算结果里漏出了正文')
  // 也不该出现任何"要写回的字段"形态
  assert.equal(serialized.includes('"tokens":'), true, 'perDoc 里应该有 tokens 计数')
  assert.equal(Object.hasOwn(budget, 'frontmatter'), false)
})

test('**同输入两次调用结果逐字节相同**（渲染稳定 = 不会每轮 append 新索引消息）', () => {
  const list = [entry('b', 'x'.repeat(100)), entry('a', 'x'.repeat(50))]
  const first = renderBudgetLine(computeBudget(list))
  const second = renderBudgetLine(computeBudget(list))
  assert.equal(first, second)
})

test('**预算行不含快变量**：不含「已读」「本轮」「时间」这类词（M0-5 红线）', () => {
  const line = renderBudgetLine(computeBudget([entry('a', 'x'.repeat(1000))]))
  for (const forbidden of ['已读', '未读', '本轮', '第 ', ':', '20']) {
    assert.equal(line.includes(forbidden), false, `预算行里出现了快变量痕迹「${forbidden}」：${line}`)
  }
})

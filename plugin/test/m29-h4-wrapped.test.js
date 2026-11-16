/**
 * M2.9 · H4 的**折行**（软换行）判据 —— 一条验收 = 一个列表项，不是一个物理行。
 *
 * ---- 缺陷现场（第 32 轮 `session-1fe6505f` seq 166，AI 自己实测出来的）----
 *
 * AI 在 §5 写了：
 *
 * ```
 * 1. 两份文档正文只有一个字符，已整份 `read` 复核，
 *    结果 —— **2/2 通过**。
 * ```
 *
 * `doc_handover_check` 报：
 *
 * ```
 * 通过，但有 1 条提醒：
 * - [H4] §5 验收：有 1/1 条没有证据形式。
 * **不合格的条目**（共 1 条）
 *   - 1. 两份文档正文只有一个字符，
 * ```
 *
 * **注意 `1/1`** —— 它认为 §5 只有**一条**验收，而那条"没有证据"。
 * 但证据明明在下一行（`结果 —— 2/2 通过`）。
 *
 * ---- 根因 ----
 *
 * 旧实现：`linesOf(text).filter(isMeaningfulLine)` → 逐行 `items.push(line)`。
 * 于是折行的第 2 行**既不是列表项也不是表格行**，被直接丢掉；
 * 第 1 行单独去判证据，当然判挂。
 *
 * ⇒ **把"物理行"当成了"逻辑条目"。** 中文写作里长条目折行极其自然。
 *
 * ---- 为什么这不是"放宽判据" ----
 *
 * 合并之后，**证据要求一点没变**：仍然是四类（seq / session / 哈希 / `N/N` + 结果词），
 * 仍然要求比值合理（`0/0` 不算）。变的只是**判据看多大的单位** ——
 * 从"一行"改成"一条"。这两者在 Markdown 里本来就不同。
 *
 * 反例网在下面每个 test 里：**折行但真没证据的条目必须仍然被判挂**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { checkAcceptanceEvidence, hasEvidence } from '../core/handover.js'

// ---------------------------------------------------------------- 1. 折行条目被放过

test('**M2.9 折行的验收条目：证据在第二行也要认**（第 32 轮 seq 166 原样复现）', () => {
  // 这是 AI 在实机里写的**原话**，一字未改。
  const text = [
    '1. 两份文档正文只有一个字符，已整份 `read` 复核，',
    '   结果 —— **2/2 通过**。',
  ].join('\n')

  const verdict = checkAcceptanceEvidence(text)
  assert.equal(verdict.total, 1, `折行被当成了多条（或多条被丢了），实际 total=${verdict.total}`)
  assert.deepEqual(
    verdict.missing, [],
    '折行的条目被判"没有证据" —— 证据就在第二行',
  )
  assert.equal(verdict.ok, true)
})

test('M2.9 折行到三行：整条合并后判，证据在第三行也认', () => {
  const text = [
    '- 单测全量跑过，命令是 `node --test`，',
    '  输出里 tests 1172 / pass 1172，',
    '  结论 **1172/1172 通过**。',
  ].join('\n')
  const verdict = checkAcceptanceEvidence(text)
  assert.equal(verdict.total, 1)
  assert.equal(verdict.ok, true, `三行折行合并失败：${JSON.stringify(verdict.missing)}`)
})

test('M2.9 折行但**真没证据** → 仍然判挂（别把判据整个放宽掉）', () => {
  const text = [
    '- 两份文档我都打开看过了，',
    '  内容确实是对的，没问题。',
  ].join('\n')
  const verdict = checkAcceptanceEvidence(text)
  assert.equal(verdict.total, 1)
  assert.equal(verdict.ok, false, '折行 + 无证据被放过了 —— 这是把判据关掉，不是修 bug')
  assert.equal(verdict.missing.length, 1)
})

// ---------------------------------------------------------------- 2. 三条续接边界

test('M2.9 **空行结束续接**：空行之后是另一段话，不能并进上一条验收', () => {
  // 若把空行后的段落并进上一条，那条会"借"到下面文字里的数字 → 假绿。
  const text = [
    '- 我检查过了，没有发现问题。',
    '',
    '另外备注：上次跑出过 5/5 通过，但那不是这一条验的。',
  ].join('\n')
  const verdict = checkAcceptanceEvidence(text)
  assert.equal(verdict.total, 1)
  assert.equal(
    verdict.ok, false,
    '空行后的段落被并进上一条验收了 —— 那会让"无证据的条目"借用别处的数字变绿',
  )
})

test('M2.9 **标题行结束续接**：`##` 之后不是上一条验收的续行', () => {
  const text = [
    '- 我检查过了，没有发现问题。',
    '### 备注',
    '上次 5/5 通过。',
  ].join('\n')
  const verdict = checkAcceptanceEvidence(text)
  assert.equal(verdict.total, 1)
  assert.equal(verdict.ok, false, '标题之后的正文被并进上一条验收了')
})

test('M2.9 **表格行各自成条**：不吃续行，也不被续行污染', () => {
  const text = [
    '| 项 | 证据 |',
    '|---|---|',
    '| 甲 | seq=42 |',
    '| 乙 | 人工确认 |',
  ].join('\n')
  const verdict = checkAcceptanceEvidence(text)
  assert.equal(verdict.total, 2, '表头/分隔行被数进去了')
  assert.equal(verdict.missing.length, 1, '缺证据的表格行没被点出来')
  assert.ok(verdict.missing[0].includes('乙'))
})

test('M2.9 **围栏行结束续接**：代码块不被并进上一条验收', () => {
  const text = [
    '- 甲：`2/2 通过`。',
    '```bash',
    '- 这是命令示例，不是验收',
    '```',
    '- 乙：`3/3 通过`。',
  ].join('\n')
  const verdict = checkAcceptanceEvidence(text)
  assert.equal(verdict.total, 2, `代码块里的行被数进去了（total=${verdict.total}）`)
  assert.deepEqual(verdict.missing, [])
})

// ---------------------------------------------------------------- 3. 报错文案压成一行

test('M2.9 报错文案里的多条条目**压成一行**（否则提示被截断成半句话）', () => {
  // §5 的提示会 `slice(0, 80)` 展示 missing。若 missing 里带换行，
  // 展示出来就是半句话，AI 很难对上自己写的是哪条 —— 第 32 轮那次正是这样。
  const text = [
    '- 第一行没有证据，',
    '  第二行也没有。',
  ].join('\n')
  const verdict = checkAcceptanceEvidence(text)
  assert.equal(verdict.missing.length, 1)
  assert.equal(
    verdict.missing[0].includes('\n'), false,
    `missing 里还留着换行：${JSON.stringify(verdict.missing[0])}`,
  )
  assert.ok(verdict.missing[0].includes('第二行也没有'), '合并后应当包含两行的内容')
})

// ---------------------------------------------------------------- 4. 不回归：原有形态仍然对

test('M2.9 不回归：多条独立验收各判各的（不会因为合并而串味）', () => {
  const text = [
    '1. 甲：`2/2 通过`。',
    '2. 乙：没有证据的一句话。',
    '3. 丙：`seq=42`。',
  ].join('\n')
  const verdict = checkAcceptanceEvidence(text)
  assert.equal(verdict.total, 3, `三条独立条目被合并了（total=${verdict.total}）`)
  assert.equal(verdict.missing.length, 1)
  assert.ok(verdict.missing[0].includes('乙'))
})

test('M2.9 不回归：比值不成立（`0/0`）即便折行也仍然判挂', () => {
  // 第 29 轮那条「判据在奖励假话」不能因为这次改动复活。
  const text = ['- 我复核了文档，', '  结果 **0/0 通过**。'].join('\n')
  const verdict = checkAcceptanceEvidence(text)
  assert.equal(verdict.total, 1)
  assert.equal(verdict.ok, false, '`0/0 通过` 折行之后被放过了 —— 比值判据失效')
})

test('M2.9 不回归：`hasEvidence` 本身没被改动，单行行为一致', () => {
  assert.equal(hasEvidence('2/2 通过').ok, true)
  assert.equal(hasEvidence('看起来没问题').ok, false)
  assert.equal(hasEvidence('0/0 通过').ok, false)
})

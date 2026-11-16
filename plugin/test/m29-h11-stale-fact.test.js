/**
 * M2.9 · **H11：会过期的"当前事实"断言**（warn）。
 *
 * ---- 现场（第 36 轮 `session-2e2873ec`）----
 *
 * 技能手册 §3.4 明确写着：
 *   > 别在文档里断言"文件仍在 `docs/`"——**那是会过期的**。
 *   > 同理别写"坟场里现在是空的"——那是随时会变的快照。
 *
 * 那一轮的 AI **读到了这条、在自述里引用了它**，然后**还是写了**：
 *
 *   - 没归档任何文档：没有需要作废的对象，**坟场为空是正常状态**。
 *
 * 它自己的复盘原文：
 *   > 我确实犯了一条……正是被点名禁止的那类断言。
 *   > `doc_handover_check` 查不出来，`doc_health` 也查不出来，
 *   > 只有我自己能拦。**这次没拦住。**
 *
 * ⇒ 用户拍板：**只加 warn**（不阻断）。这与 H4 同源 ——
 *   这类句子**不一定错**（刚初始化时"坟场为空"确实是事实），
 *   它错在"写死了一个会变的状态"。
 *
 * ---- 本文件最该看的是"反例"那一组 ----
 *
 * 判据最容易犯的错是**误报**：把"是留在 A 还是 B —— 未定"这种
 * **待决选项**当成事实断言。我第一版就是这样误报的（下面有专门一条钉住它）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { checkHandover } from '../core/handover.js'

/** 造一份七段齐全的交接，`extra` 追加到 §6（刻意没做）。 */
function bodyWith(extra) {
  return [
    '# 交接', '',
    '## §1 我的意图', '', '甲。', '',
    '## §2 现在到哪了', '', '乙。', '',
    '## §3 下一刀', '', '去改 `docs/spec-1.md`。', '',
    '## §4 坑', '', '- 坑一。', '',
    '## §5 验收', '', '- 甲：`2/2 通过`。', '',
    '## §6 刻意没做', '', ...extra, '',
    '## §7 仍未决', '', '无。', '',
  ].join('\n')
}

const check = (body) => checkHandover({
  body,
  meta: { id: 'handover-1', role: 'handover', order: -10, status: 'authoritative' },
  context: { handovers: [{ id: 'handover-1', status: 'authoritative', order: -10 }] },
})

const h11Of = (body) => check(body).warnings.filter((item) => item.rule === 'H11')

// ---------------------------------------------------------------- 正例：该报的要报

test('**H11：第 36 轮那句「坟场为空是正常状态」必须被报出来**', () => {
  const hits = h11Of(bodyWith(['- 没归档任何文档：没有需要作废的对象，坟场为空是正常状态。']))
  assert.equal(hits.length, 1, '没抓到那句会过期的断言 —— 而它正是加这条判据的原因')
  assert.match(hits[0].message, /坟场为空/, '没指出具体是哪句话')
})

test('H11：「文件仍在 docs/」也要报（手册 §3.4 点名的那句）', () => {
  const hits = h11Of(bodyWith(['- `instruction-2` 已 `void`，但文件仍在 `docs/`。']))
  assert.equal(hits.length, 1)
  assert.match(hits[0].message, /仍在/, '没指出具体是哪句话')
})

test('H11：「还在 docs 目录」这种不带斜杠的写法也要认', () => {
  const hits = h11Of(bodyWith(['- 它还在 docs 目录下。']))
  assert.equal(hits.length, 1)
})

test('H11：「还没交付任何文件」要报（交付区内容会变）', () => {
  const hits = h11Of(bodyWith(['- 还没交付任何文件。']))
  assert.equal(hits.length, 1)
})

test('H11：「坟场里没有文档」要报', () => {
  const hits = h11Of(bodyWith(['- 坟场里没有文档。']))
  assert.equal(hits.length, 1)
})

// ---------------------------------------------------------------- 反例：不该报的不能报

test('**H11 反例：待决选项不能误报**（我第一版就是这么错的）', () => {
  // 第 36 轮那份交接 §7 的原话。它是**选项**，说的是"还没定" ——
  // 完全符合"别把会变的东西写成事实"的要求，抓它等于惩罚正确写法。
  const hits = h11Of(bodyWith([
    '- 这两份「1」「2」文档最终是留在 `docs/` 当演练记录，还是会被归档进坟场 —— 未定，等用户拍板。',
  ]))
  assert.deepEqual(hits, [], '把"是留在A还是B——未定"误报成了事实断言')
})

test('**H11 反例：含"还是/未定"的句子即使真的命中正则也要跳过**', () => {
  // ⚠️ **这条是补漏。** 上面那条（第 36 轮原话）其实**根本没命中任何正则**
  //    （`留在 docs/` 不在 `(?:仍|还|尚)在` 里，`坟场` 后面也不是 `空/没有`），
  //    所以它**测不到 `skipIf`** —— 变异 `h11-misfires-on-pending-choice`
  //    把 `skipIf` 短路掉，那条测试照样绿，于是变异 SURVIVED。
  //
  //    ⇒ 必须造一条**真的命中正则、但带"还是/未定"** 的句子，
  //      才能证明 `skipIf` 真的在起作用。
  for (const line of [
    '- 文档是否**仍在 `docs/`**，还是会被搬走 —— 未定。', // 命中 location
    '- 坟场为空，还是要归档新文档 —— 待定。', // 命中 graveyard-empty
  ]) {
    assert.deepEqual(
      h11Of(bodyWith([line])), [],
      `带"还是/未定"的句子被报出来了（skipIf 没生效）：${line}`,
    )
  }
})

test('**H11 对照：把"还是/未定"去掉，同一句话就必须报**（证明上面那条不是空测）', () => {
  // 这是上面那条的**反例的反例**：去掉"还是/未定"之后，正则必须命中。
  // 没有这一条，上面那条可能只是"这句话本来就不命中"，而不是"skipIf 在起作用"。
  assert.equal(
    h11Of(bodyWith(['- 文档**仍在 `docs/`**。'])).length, 1,
    '去掉"还是/未定"后仍不报 —— 说明 location 正则压根没命中，上一条是空测',
  )
  assert.equal(
    h11Of(bodyWith(['- 坟场为空。'])).length, 1,
    '去掉"还是/未定"后仍不报 —— 说明 graveyard 正则压根没命中，上一条是空测',
  )
})

test('H11 反例：**「未定 / 待定」句式整体跳过**', () => {
  for (const line of [
    '- 是否归档 —— 未定。',
    '- 文件放哪 —— 待定。',
    '- 是留在 `docs/` 还是搬走，或者保持现状。',
  ]) {
    assert.deepEqual(h11Of(bodyWith([line])), [], `误报了：${line}`)
  }
})

test('H11 反例：**正常描述文档内容不能报**', () => {
  const hits = h11Of(bodyWith([
    '- 没有把 `spec-1` 标成 `authoritative`（用户没要求）。',
    '- 没有创建 `deliverables/` 目录。',
    '- 没有写额外的 `decision` / `log` 文档。',
  ]))
  // ⚠️ 「没有创建 deliverables/ 目录」这条**会**命中 deliverables 那条正则，
  //    但它是"刻意没做"的合规写法 —— 这正是"只加 warn"的理由：
  //    宁可多报一条让人判断，也不阻断。
  //    这里断言的是**不会因为这几句就整份判不合格**。
  assert.equal(check(bodyWith(['- 没有创建 `deliverables/` 目录。'])).ok, true)
})

test('H11 反例：完全干净的交接**不能报 H11**', () => {
  const hits = h11Of(bodyWith(['- 本轮未归档任何文档。']))
  assert.deepEqual(hits, [], '「本轮未归档任何文档」是正确写法（不变量），被误报了')
})

// ---------------------------------------------------------------- 级别与形状

test('**H11 必须是 warn，不能阻断交接**（用户拍板「只加 warn」）', () => {
  const result = check(bodyWith(['- 坟场为空。']))
  assert.equal(result.ok, true, 'H11 阻断交接了 —— 它必须是 warn')
  assert.equal(result.errors.filter((item) => item.rule === 'H11').length, 0, 'H11 进了 errors')
  assert.equal(result.warnings.filter((item) => item.rule === 'H11').length, 1, 'H11 没进 warnings')
})

test('H11 的文案必须给出**改法**（不能只说"这里不对"）', () => {
  const hits = h11Of(bodyWith(['- 坟场为空。']))
  assert.match(hits[0].message, /改法/, '没给改法')
  assert.match(hits[0].message, /不变量/, '没说清"只写不变量"这个原则')
  assert.match(hits[0].message, /忽略/, '没说"确认不会变就可以忽略" —— 会让人以为必须改')
})

test('H11 同一种模式最多报一次（不要同一句话报两遍）', () => {
  const hits = h11Of(bodyWith([
    '- 坟场为空。',
    '- 坟场里没有文档。',
  ]))
  assert.equal(hits.length, 1, '同一模式报了多次，文案会变噪音')
})

test('H11 坏输入不抛', () => {
  assert.doesNotThrow(() => checkHandover({ body: '' }))
  assert.doesNotThrow(() => checkHandover({}))
})

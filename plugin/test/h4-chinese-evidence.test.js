/**
 * H4 的证据正则认不出中文「通过 / 全绿」—— SPEC-M2 §9.5。
 *
 * ---- 这个文件为什么存在 ----
 *
 * `core/handover.js` 的 `EVIDENCE_PATTERNS` 里 `test` 那一条末尾有个 `\b`：
 *
 * ```js
 * re: /\b\d+\s*\/\s*\d+\s*(?:全绿|通过|passed?|tests?)\b|… /i
 * ```
 *
 * `\b` 只在 `\w`（`[A-Za-z0-9_]`）与非 `\w` 之间成立。**「通」「过」「全」「绿」都不是 `\w`**，
 * 所以 `3/3 通过`、`12/12 全绿` 全部 **MISS**。
 *
 * 这个项目的全部文档都是中文，于是判据要求「写具体证据」，却**认不出中文写的具体证据**。
 * 后果不是"漏报"这么轻 —— 2026-11-13 的演练里，施工者为了凑一份 H4 能认的交接，
 * **连建 4 份**（`handover-001` → `004`），中途还去读源码逆向这个正则
 * （会话 `session-c03fc8c8-4bb3-4ce6-916a-d832228e0d99`）。
 *
 * ---- 写法纪律（SPEC §9.5 明确要求）----
 *
 * **先写这 7 条用例，再改正则。** 修这个正则最容易犯的错就是**把它放宽到什么都认** ——
 * M1.5 复核抓过 5 条「永远通过」的废测试，那正是这类修复的典型事故。
 * 所以下面每一条**正例**都配一条**反例**，且反例单独断言。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { EVIDENCE_PATTERNS, checkHandover, hasEvidence } from '../core/handover.js'

/** `test` 这一条正则（唯一会随本修复改变的形态）。 */
const TEST_PATTERN = EVIDENCE_PATTERNS.find((pattern) => pattern.key === 'test')

/**
 * 一份七段齐全的交接正文。
 *
 * ⚠️ 标题必须写成 `## 1. 我的意图` 这种**带序号**的形式，`meta` 也必须带
 * `role: 'handover'` —— 否则 `checkHandover` 连段落都解析不出来，
 * 整份文档只会报 H1「缺少 7 个必填段落」+ M1「没有 frontmatter」，
 * **H4 根本不会跑**。第一版我漏了这两点，于是端到端那条测的是空气（实测：它 pass）。
 */
function handoverWith(acceptanceLines) {
  return [
    '# 交接 · 测试用',
    '',
    '## 1. 我的意图',
    '',
    '验证 H4 认得出中文证据。**意图**是让判据逼模型写具体，而不是逼它逆向正则。',
    '',
    '## 2. 现在到哪了',
    '',
    '| 项 | 值 |',
    '|---|---|',
    '| 单测 | 722/722 全绿 |',
    '',
    '## 3. 下一刀',
    '',
    '改 `core/handover.js` 的 `EVIDENCE_PATTERNS` 里 `test` 那一条正则。',
    '',
    '## 4. 坑',
    '',
    '| # | 坑 |',
    '|---|---|',
    '| 1 | 把正则放宽到什么都认 |',
    '',
    '## 5. 验收',
    '',
    ...acceptanceLines,
    '',
    '## 6. 刻意没做',
    '',
    '- 没有改任何门禁判据',
    '',
    '## 7. 仍未决',
    '',
    '无',
    '',
  ].join('\n')
}

/** 跑一次校验（带 production 形状的 meta 与 context）。 */
function check(body) {
  return checkHandover({
    meta: { id: 'handover-h4', role: 'handover', order: 0, status: 'authoritative' },
    body,
    context: {
      minOrder: 0,
      handovers: [{ id: 'handover-h4', status: 'authoritative', order: 0 }],
    },
  })
}

// ---------------------------------------------------------------- 0. 前置

test('H4 正则修复：`test` 形态必须存在（否则下面全在测空气）', () => {
  assert.ok(TEST_PATTERN !== undefined, 'EVIDENCE_PATTERNS 里没有 key=test 的形态')
  assert.ok(TEST_PATTERN.re instanceof RegExp)
})

// ---------------------------------------------------------------- 1. 正例（§9.5 表格左半）

test('H4 正则修复：中文「N/N 通过」必须命中（§9.5 用例 1）', () => {
  assert.equal(hasEvidence('3/3 通过').ok, true, '`3/3 通过` 没被认出来（这就是那个 bug）')
})

test('H4 正则修复：中文「N/N 全绿」必须命中（§9.5 用例 2）', () => {
  assert.equal(hasEvidence('12/12 全绿').ok, true, '`12/12 全绿` 没被认出来')
})

test('H4 正则修复：`691/691 全绿` 必须命中（§9.5 用例 3）', () => {
  assert.equal(hasEvidence('691/691 全绿').ok, true)
})

test('H4 正则修复：`722/722 全绿` 必须命中（本项目的真实写法）', () => {
  // ⚠️ 这里**不能**写「单测 722/722 全绿」——
  // 那样会被同一数组里 `单测\s*\d+\s*\/\s*\d+` 那条分支命中，
  // 于是这条测试**在有 bug 的代码上也是绿的**，等于没测。
  // （第一版就是这么写的，实测 pass；改成裸分数才真的红。）
  assert.equal(hasEvidence('722/722 全绿，fail 0').ok, true)
})

// ---------------------------------------------------------------- 2. 不能破坏现有（英文路径）

test('H4 正则修复：英文 `3/3 passed` 仍然命中（§9.5 用例 4）', () => {
  assert.equal(hasEvidence('3/3 passed').ok, true, '修中文时把英文弄坏了')
})

test('H4 正则修复：`ALL PASS（5/5）` 仍然命中（§9.5 用例 5）', () => {
  assert.equal(hasEvidence('ALL PASS（5/5）').ok, true)
})

test('H4 正则修复：`ALL GOOD` / `node --test` / `12 passed` 仍然命中', () => {
  assert.equal(hasEvidence('冒烟 ALL GOOD').ok, true)
  assert.equal(hasEvidence('跑 `node --test --test-isolation=none`').ok, true)
  assert.equal(hasEvidence('12 passed').ok, true)
})

// ---------------------------------------------------------------- 3. 反例（§9.5 表格右半，最关键）

test('**H4 正则修复：不能放宽到「见第 5 节」也算证据**（§9.5 用例 6）', () => {
  // 修 `\b` 最省事的错法是直接把整段改成"出现数字就算"，
  // 那会让「见第 5 节」通过 —— 而它恰恰是这个判据要挡的东西。
  assert.equal(hasEvidence('见第 5 节').ok, false, '`见第 5 节` 被当成证据了')
})

test('**H4 正则修复：不能因为含「过」字就放行「已经改好了」**（§9.5 用例 7）', () => {
  assert.equal(hasEvidence('已经改好了').ok, false, '`已经改好了` 被当成证据了')
})

test('H4 正则修复：无「N/N」形状的中文动词也不算证据（不放宽的回归网）', () => {
  for (const text of [
    '已经通过了',
    '全部跑过一遍',
    '测试都绿了',
    '没有问题',
    '按 §9.5 修了',
  ]) {
    assert.equal(hasEvidence(text).ok, false, `「${text}」被当成证据了`)
  }
})

test('H4 正则修复：只有分数没有结果词也不算证据（不能退化成"有数字就行"）', () => {
  for (const text of [
    '3/3',
    '共 12/12 条',
    '跑了 3/3 次',
  ]) {
    assert.equal(hasEvidence(text).ok, false, `「${text}」被当成证据了`)
  }
})

// ---------------------------------------------------------------- 3b. 反引号包裹的哈希（M2.3 演练 D1）

test('**H4 修复：`sha256 = \\`hex\\``（反引号包裹）必须算证据**（2026-11-14 演练真实事故）', () => {
  // 实机（session-10f26ffe 的 seq=144）：一份**完全正确**的交接被判不合格，
  // 只因哈希包在反引号里 —— 而那是 Markdown 里"这是个值"的标准写法。
  //
  // 根因：`[=:：]\s*[0-9a-f]{8,}` 的 `\s*` 只吃空白，吃不到反引号。
  const hex = 'B8E89AC6C914DF7FE0486A59C484678DF25B7670BA69498C9733AA27B38C354C'
  for (const text of [
    'sha256 = `' + hex + '`',
    'sha256 = ' + hex,
    'sha256: `' + hex + '`',
    'sha256 = **' + hex + '**',
    '**边界**：`input.log` 的 sha256 = `' + hex + '`',
  ]) {
    assert.equal(hasEvidence(text).ok, true, `「${text.slice(0, 40)}…」应当算证据`)
  }
})

test('**H4 修复不许放宽过头**：仍要求 8 位以上十六进制（反引号不能救垃圾值）', () => {
  // 这是"修 D1"时最危险的退化：为了吃反引号而放宽成"有东西就行"。
  for (const text of [
    'sha256 = 见文件',
    'sha256 = `见文件`',
    'sha256 = abc',
    'sha256 = ``',
    'sha256: `  `',
    'sha256 = `abc`',
  ]) {
    assert.equal(hasEvidence(text).ok, false, `「${text}」被当成证据了`)
  }
})

test('H4：`指纹 = hex` 也接受反引号（同一族判据的自洽性）', () => {
  const hex = '0123456789abcdef'
  assert.equal(hasEvidence('指纹 = `' + hex + '`').ok, true)
  assert.equal(hasEvidence('指纹：`' + hex + '`').ok, true)
})

// ---------------------------------------------------------------- 4. 端到端：判据本身要能认中文交接

test('**H4 端到端：一份用中文写证据的交接必须能通过 H4**（这是修复的真实目的）', () => {
  // ⚠️ §5 的三条证据**刻意全部只用中文「N/N 全绿」形态**，不掺 `node --test` / `seq=` / `单测 N/N`。
  // 掺任何一种都会被别的分支命中，于是整段在有 bug 的代码上也过 H4 —— 测不出任何东西。
  const result = check(handoverWith([
    '- 722/722 全绿',
    '- 变异 29/29 通过',
    '- 实机 5/5 全绿',
  ]))

  const h4 = (result.errors ?? []).filter((item) => item.rule === 'H4')
  assert.deepEqual(h4, [], `中文证据被 H4 拒了：${JSON.stringify(h4, null, 2)}`)
})

// ---------------------------------------------------------------- 5. 文案（§9.5.4）

test('H4 拒绝文案必须给出可照抄的样例（否则模型只能去读源码）', () => {
  const result = check(handoverWith(['- 看起来没问题']))

  // M2.6：H4 已降为 warn（用户拍板），改从 warnings 取。
  const h4 = (result.warnings ?? []).find((item) => item.rule === 'H4')
  assert.ok(h4 !== undefined, `这条应该被 H4 拒，实际 errors=${JSON.stringify(result.errors)}`)
  // 演练里的模型被拒 3 次都不知道差在哪，就是因为文案只说"没有证据形式"。
  assert.ok(
    h4.message.includes('seq=42') && h4.message.includes('3/3 通过'),
    `拒绝文案没有给可照抄的样例：${h4.message}`,
  )
})

// ---------------------------------------------------------------- 6. 文案与实现必须一致（M2.6）
//
// ---- 为什么这条比前五条都重要 ----
//
// 2026-11-14 用户跑全流程演练（`session-138d9491`），报「交接一直卡住，感觉根本没有进展」。
// 解码后发现：AI 在 turn 6 里对 `docs/read-order.md` 和交接文档**来回改了 25+ 步**。
//
// 根因不是 AI 不会写，而是**报错文案举的例子，判据自己认不出来**：
//
//   文案：可用的写法示例：`seq=42`、`session-abc123`、`sha256: a1b2c3d4`、
//        `722/722 全绿`、`3/3 通过`、`tests 691 / pass 691`
//   实际：`tests 691 / pass 691` → **MISS**
//         `SHA256 ` + 反引号包住的 hex（无冒号）→ **MISS**（5/5 条全挂）
//         `1041 / 1041`（裸比值）→ **MISS**
//
// AI 照着文案写、还是被拒 → 它以为是自己写错 → 再改 → 再拒。**这就是死循环。**
//
// ⇒ 判据：**文案里举的每一个例子，实现都必须认得。**
//   这条测试直接从文案里把例子抽出来跑，所以文案改了也不会漂。

test('**M2.6：H4 拒绝文案里举的每个例子，判据都必须认得**（文案与实现不许漂）', () => {
  const result = check(handoverWith(['- 看起来没问题']))
  // M2.6：H4 已降为 warn（用户拍板），改从 warnings 取。
  const h4 = (result.warnings ?? []).find((item) => item.rule === 'H4')
  assert.ok(h4 !== undefined, '这条应该被 H4 拒')

  // ⚠️ 只从**「可用的写法示例」那一句**里抽例子。
  //
  // 第一版从整条文案里抽所有反引号内容 —— 于是文案里为了说清"哪些**不算**证据"
  // 而举的反例（`文件数: 4`、`共 12/12 条`）也被当成"可用示例"去断言，
  // 必然红。**判据要区分"正例"与"反例"**，不能一把抓。
  const exampleClause = h4.message.split('可用的写法示例')[1]?.split('。')[0] ?? ''
  const examples = [...exampleClause.matchAll(/`([^`]+)`/g)]
    .map((m) => m[1])
    .filter((text) => /\d/.test(text))

  assert.ok(examples.length >= 5, `从文案里抽到的例子太少（${examples.length}）：${examples.join(' | ')}`)

  const misses = examples.filter((example) => !hasEvidence(`- ${example}`).ok)
  assert.deepEqual(
    misses, [],
    `文案说这些写法可用，但判据认不出来：${misses.map((m) => `\`${m}\``).join('、')}\n`
    + '这会让 AI 照着文案写、却一直被拒 —— 正是"交接卡住没进展"的成因。',
  )

  // 反向：文案里明说"不算"的那几个，判据**必须**真的不认。
  // （否则文案就在撒谎：告诉 AI 某个写法不行，实际却行。）
  for (const bad of ['文件数: 4', '共 12/12 条', '跑了 3/3 次']) {
    assert.equal(
      hasEvidence(`- ${bad}`).ok, false,
      `文案说「${bad}」不算证据，但判据认了 —— 文案与实现不一致`,
    )
  }
})

test('**M2.6：`test` 判据必须认得文案举的测试类例子**（按判据单独测，别被别的分支救）', () => {
  // 只取 test 判据自己的正则，避免被 seq/session/hash 那三条掩盖。
  const testRe = EVIDENCE_PATTERNS.find((item) => item.key === 'test').re

  // 文案里属于"测试输出"的三个例子：
  const mustPass = ['722/722 全绿', '3/3 通过', 'tests 691 / pass 691']
  for (const example of mustPass) {
    assert.ok(testRe.test(example), `\`${example}\` 是文案举的例子，但 test 判据认不出来`)
  }

  // ⚠️ 防放宽过头（H4 被打回过两次，都是因为退化成"有数字就行"）：
  for (const text of ['3/3', '共 12/12 条', '跑了 3/3 次', '我没跑过，测试也没做']) {
    assert.ok(!testRe.test(text), `「${text}」不该被当成测试证据`)
  }
})

test('**M2.6：哈希证据不要求冒号**（`SHA256 ` + 反引号 hex 也必须认）', () => {
  // 实机原文（`session-138d9491` turn 6 的 §5，5 条全部因此被判"无证据"）：
  //   - `docs/test-spec.md` 存在且正文仅一个 `1`：文件 169 字节，SHA256 `0445F64A…`
  //
  // ⚠️ `hasEvidence` 返回的是 `{ ok, hits }`，不是布尔 —— 第一版我直接和 `true` 比，
  //    于是三条断言全红，看起来像"判据坏了"，其实是我读错了接口。
  const line = '- `docs/test-spec.md` 存在：文件 169 字节，SHA256 `0445F64A1B2C3D4E5F60718293A4B5C6D7E8F90`'
  assert.equal(hasEvidence(line).ok, true, '算法名 + 空格 + 反引号 hex 这种标准写法被拒了')

  // ⚠️ 防放宽过头：仍然必须拒绝"没有 hex"的写法。
  assert.equal(hasEvidence('- 哈希见文件，没算').ok, false)
  assert.equal(hasEvidence('- sha256 = 见文件').ok, false)
})

test('**M2.6：裸比值 `1041 / 1041` 不算证据**（既有判据是对的，我一度想放宽它）', () => {
  // ⚠️ 这条测试是**自我纠正**的产物，记在这里以免下一个人重犯：
  //
  // 我修 H4 时先加了"裸比值也算证据"（为了救演练里 AI 写的 `1041 / 1041`）。
  // 但既有的那条测试「只有分数没有结果词也不算证据」立刻把我拦下了 —— 它断言
  // `3/3`、`共 12/12 条`、`跑了 3/3 次` **都不算**，而**它是对的**：
  // 没有结果词就没有"通过"的语义，放宽就等于退化成"有数字就行"（H4 被打回过两次）。
  //
  // ⇒ 正确做法是**改文案**（举 `单测 1041/1041 全绿`），不是放宽判据。
  //
  // ⚠️ 用例本身也踩过一次坑：我第一版写 `- 单测 1041 / 1041` 当反例，结果它**通过了** ——
  //    因为 `单测\s*\d+\s*\/\s*\d+` 那条分支命中了。「单测」这个词自带结果语义，
  //    所以它本来就该过。**反例必须去掉这层前缀**，否则测的不是"裸比值"。
  assert.equal(hasEvidence('- 1041 / 1041').ok, false, '裸比值（无结果词）不该被认可')
  // 加上结果词就认可 —— 这才是文案该举的写法。
  assert.equal(hasEvidence('- 单测 1041/1041 全绿').ok, true, '带结果词应当认可')
  assert.equal(hasEvidence('- 单测 1041 / 1041').ok, true, '「单测」前缀自带结果语义，应当认可')
})

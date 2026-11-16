/**
 * `core/handover.js` 的单测（H1–H7）。
 *
 * **这一组测试的重点不是"合格的能过"，而是"不合格的过不去"。**
 * 只测成功路径等于没测门禁（架构评审 §5 的原话），而 M1 最容易犯的错
 * 就是写出一个「看起来严格但永远通过」的校验。
 *
 * 所以每个硬规则（H1–H4）都配了**反例**，其中 H3/H4 的反例来自真实交接文档的写法。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SECTIONS,
  checkAcceptanceEvidence,
  checkHandover,
  checkNextActions,
  hasEvidence,
  hasSubstance,
  isConcreteAction,
  looksLikeHandover,
  parseHandoverSections,
  splitSections,
} from '../core/handover.js'

/** 一份**合格**的交接正文（七段齐全、§3 具体、§5 带证据）。 */
const GOOD_BODY = `# 交接 · 给 M1 的施工者

## 1. 我的意图

把交接从「写一份文档」变成「一份能通过校验的产物」。现状可以从代码重建，意图不能。

## 2. 现在到哪了

| 切片 | 状态 |
|---|---|
| M0 | 已验收 |
| M1 | 施工中 |

## 3. 下一刀

- 改 \`core/render.js\` 的 fitBudget，加【预算】行
- 跑 \`node --test --test-isolation=none\`

## 4. 坑

| # | 坑 |
|---|---|
| 1 | when 条件里读盘 |

## 5. 验收

- M1-1 索引块有【预算】行：会话 \`session-6d014a01\` 的 \`seq=2468\`
- M1-2 单测 413/413 全绿

## 6. 刻意没做

- 没做第 5 个工具（Q13 上限是 4）

## 7. 仍未决

无
`

/**
 * 造一份正文：在 GOOD_BODY 基础上替换某一段。
 * @param {string} key SECTIONS 的 key
 * @param {string} replacement 新的段内容（不含标题）
 */
function bodyWith(key, replacement) {
  const spec = SECTIONS.find((item) => item.key === key)
  const lines = GOOD_BODY.split('\n')
  const headingRe = new RegExp(`^## ${spec.index}\\. `)
  const start = lines.findIndex((line) => headingRe.test(line))
  assert.ok(start >= 0, `GOOD_BODY 里找不到 §${spec.index}`)
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^## \d+\. /.test(lines[index])) { end = index; break }
  }
  const next = [...lines.slice(0, start + 1), '', ...replacement.split('\n'), '', ...lines.slice(end)]
  return next.join('\n')
}

/** 跑一次校验（默认带上 order/handover 上下文）。 */
function check(body, options = {}) {
  return checkHandover({
    meta: { id: 'handover-m1', role: 'handover', order: 0, status: 'authoritative' },
    body,
    context: { minOrder: 0, handovers: [{ id: 'handover-m1', status: 'authoritative', order: 0 }], ...options },
  })
}

// ---------------------------------------------------------------- 0. 基准

test('合格的交接 → ok:true，无 error', () => {
  const result = check(GOOD_BODY)
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  assert.deepEqual(result.errors, [])
  assert.equal(result.stats.sectionsFound, 7)
  assert.ok(result.stats.concreteActions >= 2)
})

test('**交接只按 §3/§5 的内容判，不按标题措辞判**：换个说法也认', () => {
  const body = GOOD_BODY
    .replace('## 1. 我的意图', '## 为什么这样做')
    .replace('## 2. 现在到哪了', '## 现状')
    .replace('## 3. 下一刀', '## 接下来')
    .replace('## 4. 坑', '## 不要重犯的坑')
    .replace('## 6. 刻意没做', '## 负向范围')
    .replace('## 7. 仍未决', '## 需要拍板')
  assert.equal(check(body).ok, true, JSON.stringify(check(body).errors))
})

// ---------------------------------------------------------------- 1. H1 缺段

test('H1：缺 §3 → error，且**点名缺哪一段**', () => {
  const spec = SECTIONS.find((item) => item.key === 'next')
  const body = GOOD_BODY.replace(/## 3\. 下一刀[\s\S]*?(?=## 4\. )/, '')
  const result = check(body)
  assert.equal(result.ok, false)
  const h1 = result.errors.find((item) => item.rule === 'H1')
  assert.ok(h1 !== undefined, '没有 H1 error')
  assert.ok(h1.message.includes(`§${spec.index}`), `没有点名 §${spec.index}：${h1.message}`)
  assert.ok(h1.message.includes('下一刀'), '没有点名段落名')
})

test('H1：七段全缺 → 一条 H1 报全，不是七条噪音', () => {
  const result = check('# 只有标题\n\n没有段落。\n')
  const h1 = result.errors.filter((item) => item.rule === 'H1')
  assert.equal(h1.length, 1)
  assert.ok(h1[0].message.includes('7 个必填段落'))
})

test('H1：`####` 级标题不算段落（否则随便一个子标题就能冒充）', () => {
  const body = GOOD_BODY.replace('## 3. 下一刀', '#### 下一刀')
  const result = check(body)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((item) => item.rule === 'H1' && item.message.includes('§3')))
})

// ---------------------------------------------------------------- 2. H2 空段

test('H2：§1 只有一句「无」→ error（写了等于没写）', () => {
  const result = check(bodyWith('intent', '无'))
  assert.equal(result.ok, false)
  const h2 = result.errors.find((item) => item.rule === 'H2')
  assert.ok(h2 !== undefined)
  assert.ok(h2.message.includes('§1'))
})

test('H2：§2 只有散文没有表格行 → 仍然通过（§2 不强制表格）', () => {
  // SPEC 对 §2 的要求是「至少 1 个表格行**或**列表项」，散文不算，但这里是散文→应当挂。
  const result = check(bodyWith('status', '现在在做 M1，进展顺利。'))
  const h2 = result.errors.find((item) => item.rule === 'H2' && item.message.includes('§2'))
  // §2 的判据在实现里只要求"有实质内容"，表格由 §4 强制。这条断言钉住这个选择。
  assert.equal(h2, undefined, '§2 不应该因为不是表格而被拒（表格要求只加在 §4）')
})

test('H2：§4 只有散文没有表格行 → error', () => {
  const result = check(bodyWith('pitfalls', '要小心 when 条件里读盘。'))
  assert.equal(result.ok, false)
  const h2 = result.errors.find((item) => item.rule === 'H2' && item.message.includes('§4'))
  assert.ok(h2 !== undefined, '§4 没有表格行却通过了')
  assert.ok(h2.message.includes('表格行'))
})

test('H2：§4 用**编号列表**写坑 → 通过（真实交接的写法，不能误伤）', () => {
  const result = check(bodyWith('pitfalls', [
    '1. **工具定义必须有 description**：漏写会让 request/header 失败。',
    '2. **不要用 node --test test/**：会 ERR_UNSUPPORTED_DIR_IMPORT。',
  ].join('\n')))
  assert.equal(result.ok, true, `编号列表被误判：${JSON.stringify(result.errors)}`)
})

test('H2：§6 只有散文没有列表项 → error', () => {
  const result = check(bodyWith('nonGoals', '这次没有做 UI。'))
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((item) => item.rule === 'H2' && item.message.includes('§6')))
})

test('H2：只有分隔线 / HTML 注释 → 视为空', () => {
  const result = check(bodyWith('intent', '---\n\n<!-- 待补 -->'))
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((item) => item.rule === 'H2' && item.message.includes('§1')))
})

// ---------------------------------------------------------------- 3. H3（核心反例）

test('**H3：§3 只写「继续做下一步」→ 必须被拒**（M1-10）', () => {
  const result = check(bodyWith('next', '- 继续做下一步'))
  assert.equal(result.ok, false, '空话居然通过了')
  const h3 = result.errors.find((item) => item.rule === 'H3')
  assert.ok(h3 !== undefined, '没有 H3 error')
  assert.ok(h3.message.includes('具体路径'), `提示没有说清要求：${h3.message}`)
})

test('H3：`_ref/check-h3.mjs` 的 11 条样例逐条对齐（SPEC 作者预演过的那批）', () => {
  const cases = [
    ['改 ddd-bundle/core/render.js 的 fitBudget', true],
    ['跑 `node --test --test-isolation=none`', true],
    ['用 doc_new 建一份 spec', true],
    ['把 gate.js 的第 189 行条件改掉', true],
    ['继续做下一步', false],
    ['按照计划推进', false],
    ['完成剩余工作', false],
    ['先把交接做好', false],
    ['补充文档', false],
    ['优化代码质量', false],
    ['接着上一轮继续', false],
  ]
  for (const [text, expected] of cases) {
    assert.equal(isConcreteAction(text), expected, `「${text}」期望 ${expected}`)
  }
})

test('H3：多条里只要有一条具体就算过（不要求每条都具体）', () => {
  const result = check(bodyWith('next', '- 继续做下一步\n- 改 `core/gate.js` 的第 189 行'))
  assert.equal(result.ok, true, JSON.stringify(result.errors))
})

test('H3：`writer` 不会被当成工具名 `write`（词边界）', () => {
  assert.equal(isConcreteAction('用 writer 组件重构'), false)
  assert.equal(isConcreteAction('用 write 工具'), true)
})

// ---- A1 审查的反例（2026-11-11）：版本号冒充路径

test('**H3：版本号 `M1.2` / `v0.2` 不算路径**（A1 反例 1）', () => {
  // 修之前 PATH_RE 是 /[\\/]|\.\w{1,5}\b/，`M1.2` 命中 `\.\w{1,5}`，
  // 于是一段「把 M1.2 的收尾工作推进完」的空话通过了 H3。
  // 而这是**极自然**的写法：任何按 M1.2 编号切片的项目都会踩到。
  for (const text of [
    '- 把 M1.2 的收尾工作推进完',
    '- 按照上一轮的节奏继续',
    '- 有疑问就照交接里说的做',
    '- 升级到 v0.2',
  ]) {
    assert.equal(isConcreteAction(text), false, `「${text}」被当成具体动作了`)
  }
})

test('**H3：版本号整段 → 拒绝**（A1 反例 1 的端到端版本）', () => {
  const result = check(bodyWith('next', [
    '- 把 M1.2 的收尾工作推进完',
    '- 按照上一轮的节奏继续',
    '- 有疑问就照交接里说的做',
  ].join('\n')))
  assert.equal(result.ok, false, '三条空话靠一个版本号通过了')
  assert.ok(result.errors.some((item) => item.rule === 'H3'))
})

test('H3：真正的文件名仍算路径（不能为了挡版本号把正常写法也挡了）', () => {
  for (const text of [
    '改 core/render.js 的 fitBudget',
    '改 ddd-bundle\\core\\gate.js',
    '更新 README.md 的安装一节',
    '跑 `node --test --test-isolation=none`',
    '用 doc_new 建一份 spec',
    '推进 `read` 那一步',
  ]) {
    assert.equal(isConcreteAction(text), true, `「${text}」被误判为空话`)
  }
})

// ---- A4 独立评审的反例（2026-11-12）：自然语言里的斜杠 / 裸工具名

test('**H3：自然语言里的斜杠不算路径**（A4 反例）', () => {
  // 第一版只修了"版本号"那一半，PATH_RE 的前半段 `[\\/]` 毫无约束。
  for (const text of [
    '- 和/或这件事先放一放',
    '- 按既定的 A/B 方案继续',
    '- 读/写这两个操作',
    '- 一/二/三都行',
  ]) {
    assert.equal(isConcreteAction(text), false, `「${text}」被当成路径了`)
  }
})

test('**H3：裸工具名不算具体**，必须带反引号或动作动词（A4 反例）', () => {
  // 「推进 read 那件事」原来会命中裸词 `read`。
  assert.equal(isConcreteAction('- 推进 read 那件事'), false, '裸工具名被当成具体动作')
  // 带反引号 / 带动词的仍要算
  assert.equal(isConcreteAction('- 推进 `read` 那一步'), true)
  assert.equal(isConcreteAction('- 用 doc_new 建一份 spec'), true)
})

test('**H3：整段只有自然语言斜杠 + 裸工具名 → 拒绝**（A4 反例端到端）', () => {
  const result = check(bodyWith('next', '- 和/或这件事先放一放\n- 推进 read 那件事'))
  assert.equal(result.ok, false, '整段空话靠「和/或」+「read」通过了')
  assert.ok(result.errors.some((item) => item.rule === 'H3'))
})

test('checkNextActions：具体与空话分得开', () => {
  const verdict = checkNextActions('- 继续做下一步\n- 改 core/render.js')
  assert.equal(verdict.ok, true)
  assert.equal(verdict.concrete.length, 1)
  assert.equal(verdict.vague.length, 1)
})

// ---------------------------------------------------------------- 4. H4（核心反例）
//
// ---- 2026-11-14 M2.6（用户拍板）：**H4 从 error 降为 warn** ----
//
// 为什么：实测一份"人话写得很实在"的交接被判 2/2 全挂（"我用 PowerShell 逐份比对，
// 两行都输出 OK"）—— 它确实验过了，但不是判据认识的"形状"。
// AI 自述：「我手里有证据，但我不知道判据在找什么形状……只能靠读过一遍报错。」
//
// ⇒ 下面五条判据**翻面**：从 `errors` 改成 `warnings`。
//   ⚠️ 但**仍然必须报**（降级不是删除）—— 它是"怎么改"的唯一指引。
//   判据要跟着策略翻面，否则测试会一直替旧行为背书（本项目已记过这一条）。

test('**H4：§5 没有证据形式 → 仍是 warn**（M2.6 起不再阻断，M1-11 翻面）', () => {
  const result = check(bodyWith('acceptance', '- M1-1 索引块有【预算】行\n- M1-2 交接能通过'))
  const h4 = result.warnings.find((item) => item.rule === 'H4')
  assert.ok(h4 !== undefined, '没有 H4 warn —— 降级不等于不报')
  assert.ok(h4.message.includes('证据'), `提示没有说清要求：${h4.message}`)
  // 反向：它**不该**再出现在 errors 里（那会阻断交接）。
  assert.equal(result.errors.filter((item) => item.rule === 'H4').length, 0, 'H4 不该再阻断交接')
})

test('H4：每一条都要有证据（一条缺就报 warn）', () => {
  const result = check(bodyWith('acceptance', [
    '- M1-1 索引块有【预算】行：seq=2468',
    '- M1-2 看起来没问题',
  ].join('\n')))
  const h4 = result.warnings.find((item) => item.rule === 'H4')
  assert.ok(h4 !== undefined, '没有 H4 warn')
  assert.ok(h4.message.includes('1/2'), `没有报出缺的比例：${h4.message}`)
})

test('H4：§5 只有导语没有任何条目 → 也要报 warn', () => {
  const result = check(bodyWith('acceptance', '本切片的验收情况如下。'))
  assert.ok(
    result.warnings.some((item) => item.rule === 'H4' && item.message.includes('没有任何验收条目')),
    '只有导语没有条目时也必须报',
  )
})

test('hasEvidence：五种证据形式都能识别', () => {
  assert.equal(hasEvidence('seq=2468 有索引块').ok, true)
  assert.equal(hasEvidence('会话 session-6d014a01-8a72').ok, true)
  assert.equal(hasEvidence('指纹 8c6246 与磁盘一致').ok, true)
  assert.equal(hasEvidence('单测 413/413 全绿').ok, true)
  assert.equal(hasEvidence('跑 `node --test` 通过').ok, true)
  assert.equal(hasEvidence('看起来没问题').ok, false)
})

// ---- A1 审查的反例 2：文件名冒充证据

test('**H4：文件名**不算证据**（A1 反例 2）**', () => {
  // 修之前 EVIDENCE_PATTERNS 里有一条 `file` 形态，于是
  // 「- M1-3 的改动在 core/handover.js」被当成"有证据"——
  // 而那只是**改动位置**，不是验证结果。
  // 同一个东西不能既证明「我要做什么」（H3）又证明「我做成了」（H4）。
  assert.equal(hasEvidence('- M1-3 的改动在 core/handover.js').ok, false)
  assert.equal(hasEvidence('- M1-4 的反例补在 test/handover.test.js').ok, false)
})

test('**H4：整段只写「改动位置」→ 报 warn**（A1 反例 2 的端到端版本，M2.6 翻面）', () => {
  const result = check(bodyWith('acceptance', [
    'M1-3 我还没真跑过：今天只把代码读了一遍，看着没问题，等下一个会话再验。',
    '',
    '- M1-3 的改动在 core/handover.js',
    '- M1-4 的反例补在 test/handover.test.js',
  ].join('\n')))
  // ⚠️ 降级为 warn 后**仍然必须报** —— 这段确实没验过，提示是有价值的。
  assert.ok(
    result.warnings.some((item) => item.rule === 'H4'),
    '「我没跑过」+ 两个文件名，连 warn 都没有了 —— 降级不等于静默',
  )
  // 反向：不该再阻断。
  assert.equal(result.errors.filter((item) => item.rule === 'H4').length, 0, 'H4 不该再阻断交接')
})

test('H4：四种真证据仍各自有效（不能为了挡文件名把真证据也挡了）', () => {
  for (const text of [
    '- M1-1 索引块有【预算】行：seq=2468',
    '- M1-2 会话 session-6d014a01-8a72 里复现',
    '- M1-3 指纹 v8c6246 与磁盘一致',
    '- M1-4 单测 413/413 全绿',
    '- 跑 `node --test` 通过',
  ]) {
    assert.equal(hasEvidence(text).ok, true, `「${text}」被误判为无证据`)
  }
})

// ---- A4 独立评审的反例（2026-11-12）：四种证据形态全是宽松子串匹配

test('**H4：裸词「测试」/「1/2」/裸 seq / 裸 hex 都不算证据**（A4 反例）', () => {
  // 第一版删掉 `file` 后，剩下四种仍是极度宽松的子串匹配，导致：
  // 「- 我没跑过，测试也没做」靠「测试」二字通过。
  for (const text of [
    '- 我没跑过，测试也没做',
    '- 这一条 1/2 的概率能过',
    '- 见 seq 那一节（没给数字）',
    '- 大概是 deadbeef 之类的吧',
  ]) {
    assert.equal(hasEvidence(text).ok, false, `「${text}」被当成证据了`)
  }
})

test('**H4：整段自认没测 → 报 warn**（A4 反例端到端，M2.6 翻面）', () => {
  const result = check(bodyWith('acceptance', [
    '- 我没跑过，测试也没做',
    '- 这一条 1/2 的概率能过',
  ].join('\n')))
  // 降级 != 静默：这种"自认没测"的交接**必须**被提示出来。
  assert.ok(
    result.warnings.some((item) => item.rule === 'H4'),
    '「我没跑过，测试也没做」连 warn 都没有 —— 那才是真的失效',
  )
  assert.equal(result.errors.filter((item) => item.rule === 'H4').length, 0, 'H4 不该再阻断交接')
})

// ---- A1 审查的反例 3：一个标题兼任两段

test('**H1：一个标题不能同时当 §2 和 §3**（A1 反例 3）', () => {
  // 修之前 `## 3. 现状与下一步` 同时含「现状」与「下一步」，
  // 同一段文本被两个 spec 各匹配一次，H1 报「7/7 段齐全」——
  // 而全文只有 6 个标题，根本没有真正的「下一刀」。
  const parsed = parseHandoverSections([
    '## 1. 我的意图', '甲',
    '## 3. 现状与下一步', '乙',
    '## 4. 坑', '| a | b |',
    '## 5. 验收', '- seq=1',
    '## 6. 刻意没做', '- 无',
    '## 7. 仍未决', '无',
  ].join('\n'))
  // §2 抢先拿到这个标题，§3 就找不到自己的段落 → 必须缺
  assert.equal(parsed.status.found, true)
  assert.equal(parsed.next.found, false, '同一段文字被 §2 与 §3 复用了')
})

test('**H1：六段冒充七段 → 拒绝**（A1 反例 3 端到端）', () => {
  const body = [
    '## 1. 我的意图', '甲',
    '## 3. 现状与下一步', '乙 core/handover.js',
    '## 4. 坑', '| a | b |',
    '## 5. 验收', '- seq=2468',
    '## 6. 刻意没做', '- 无',
    '## 7. 仍未决', '无',
  ].join('\n')
  const result = checkHandover({
    meta: { id: 'h', role: 'handover', order: 0, status: 'authoritative' },
    body,
  })
  assert.equal(result.ok, false, '只有六段却通过了')
  assert.equal(result.stats.sectionsFound, 6)
  assert.ok(result.errors.some((item) => item.rule === 'H1' && item.message.includes('§3')))
})

test('checkAcceptanceEvidence：表格形式的验收也逐行判，**表头不算一条验收**', () => {
  const verdict = checkAcceptanceEvidence([
    '| # | 判据 | 证据 |',
    '|---|---|---|',
    '| M1-1 | 有【预算】行 | seq=2468 |',
    '| M1-2 | 能通过 | 人工确认 |',
  ].join('\n'))
  // 3 行数据里只有 2 条是验收条目；表头（第 1 行）与分隔行都不是。
  assert.equal(verdict.total, 2)
  assert.equal(verdict.missing.length, 1)
  assert.ok(verdict.missing[0].includes('M1-2'))
})

test('checkAcceptanceEvidence：表头本身不会因为"缺证据"而误报', () => {
  const verdict = checkAcceptanceEvidence([
    '| 验收项 | 判据 | 证据 |',
    '|---|---|---|',
    '| M1-1 | 有【预算】行 | seq=2468 |',
  ].join('\n'))
  assert.equal(verdict.ok, true, `表头被当成验收条目了：${JSON.stringify(verdict.missing)}`)
})

// ---------------------------------------------------------------- 5. H5 §7

test('H5：§7 是空的 → warn（不是 error）', () => {
  const result = check(bodyWith('open', ''))
  assert.equal(result.ok, true, 'H5 不该让交接被拒')
  assert.ok(result.warnings.some((item) => item.rule === 'H5'))
})

test('H5：§7 显式写「无」→ 不 warn', () => {
  for (const text of ['无', '无。', '- 无', '没有', '暂无']) {
    const result = check(bodyWith('open', text))
    assert.equal(result.warnings.some((item) => item.rule === 'H5'), false, `「${text}」被误报`)
  }
})

// ---------------------------------------------------------------- 6. H6 / H7

test('**H6：两份 authoritative handover → warn，且点名两份 id**（M1-12）', () => {
  const result = check(GOOD_BODY, {
    handovers: [
      { id: 'handover-m1', status: 'authoritative', order: 0 },
      { id: 'handover-m0', status: 'authoritative', order: 10 },
    ],
  })
  assert.equal(result.ok, true, 'H6 不该让交接被拒')
  const h6 = result.warnings.find((item) => item.rule === 'H6')
  assert.ok(h6 !== undefined, '没有 H6 warn')
  assert.ok(h6.message.includes('handover-m1') && h6.message.includes('handover-m0'), h6.message)
})

test('H6：只有一份 authoritative → 不 warn', () => {
  const result = check(GOOD_BODY)
  assert.equal(result.warnings.some((item) => item.rule === 'H6'), false)
})

test('H7：order 不是最小 → **error**（M1.5 / D9：warn 升为 error）', () => {
  // ⚠️ M1 时这条断言的是 `warn`。M1.5 按 D9 把级别升成 error ——
  // 所以这里**必须**改成断言 errors，否则新的门禁没有被任何测试钉住。
  const result = checkHandover({
    meta: { id: 'handover-m1', role: 'handover', order: 140, status: 'authoritative' },
    body: GOOD_BODY,
    context: { minOrder: 10, handovers: [{ id: 'handover-m1', status: 'authoritative', order: 140 }] },
  })
  const h7 = result.errors.find((item) => item.rule === 'H7')
  assert.ok(h7 !== undefined, '没有 H7 error')
  assert.ok(h7.message.includes('140') && h7.message.includes('10'))
  assert.equal(result.ok, false, 'H7 是 error，所以 ok 必须是 false')
})

test('H7：order 是最小 → 不报（正例，防止"永远报"）', () => {
  const result = checkHandover({
    meta: { id: 'handover-m1', role: 'handover', order: 10, status: 'authoritative' },
    body: GOOD_BODY,
    context: { minOrder: 10, handovers: [{ id: 'handover-m1', status: 'authoritative', order: 10 }] },
  })
  assert.equal(result.errors.some((item) => item.rule === 'H7'), false)
  assert.equal(result.warnings.some((item) => item.rule === 'H7'), false)
})

test('H7：**superseded 的旧交接不报**（D9 第 ③ 步，缺它就是永久红灯）', () => {
  // 这一条是评审者补的，执行者的 D1/D9 建议里**没有**。
  // 实测反例：minOrder=-10 时，`status: superseded, order: 0` 的旧交接会被 M1 的 H7 报警。
  // 升成 error 之后，那会让**每一份历史交接都变红**，而正向判据要求的正是"旧交接 ok:true"。
  const result = checkHandover({
    meta: { id: 'handover-old', role: 'handover', order: 0, status: 'superseded' },
    body: GOOD_BODY,
    context: {
      minOrder: -10,
      handovers: [
        { id: 'handover-old', status: 'superseded', order: 0 },
        { id: 'handover-new', status: 'authoritative', order: -10 },
      ],
    },
  })
  assert.equal(result.errors.some((item) => item.rule === 'H7'), false, 'superseded 不该报 H7')
  assert.equal(result.warnings.some((item) => item.rule === 'H7'), false)
  assert.equal(result.ok, true, '被取代的旧交接必须仍然 ok:true')
})

test('H7：没有 minOrder（项目里没有交接）→ 跳过，不报', () => {
  const result = checkHandover({
    meta: { id: 'handover-m1', role: 'handover', order: 140, status: 'authoritative' },
    body: GOOD_BODY,
    context: { handovers: [{ id: 'handover-m1', status: 'authoritative', order: 140 }] },
  })
  assert.equal(result.errors.some((item) => item.rule === 'H7'), false)
})

// ---------------------------------------------------------------- 7. 严格模式 / 元数据

test('strict:false 时 H1–H4 降为 warn（仅调试用）', () => {
  const result = check(bodyWith('next', '- 继续做下一步'), { strict: false })
  assert.equal(result.ok, true)
  assert.ok(result.warnings.some((item) => item.rule === 'H3' && item.level === 'warn'))
})

test('role 不是 handover → error（交接必须是 role: handover）', () => {
  const result = checkHandover({
    meta: { id: 'spec-x', role: 'spec', order: 0, status: 'authoritative' },
    body: GOOD_BODY,
  })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((item) => item.message.includes('不是 handover')))
})

test('没有 frontmatter → error，且不抛', () => {
  const result = checkHandover({ meta: null, body: GOOD_BODY })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((item) => item.message.includes('frontmatter')))
})

test('空输入不抛', () => {
  assert.doesNotThrow(() => checkHandover({}))
  assert.doesNotThrow(() => checkHandover(null))
})

// ---------------------------------------------------------------- 8. 解析

test('splitSections：只按 ##/### 切，#### 归入上一段', () => {
  const sections = splitSections('## A\n正文\n### A.1\n子正文\n#### 更深\n还是 A.1 的')
  assert.deepEqual(sections.map((section) => section.title), ['A', 'A.1'])
  assert.ok(sections[1].text.includes('#### 更深'))
})

test('**splitSections：最后一个段落也要有 text**（漏 seal 会让文档末段永远判成空）', () => {
  const sections = splitSections('## A\n甲\n## B\n乙\n## C\n丙')
  assert.equal(sections.length, 3)
  assert.equal(sections[0].text, '甲')
  assert.equal(sections[1].text, '乙')
  assert.equal(sections[2].text, '丙', '最后一个段落是空的 —— 少了循环结束后的 seal')
})

test('**交接的 §7 是最后一段时，写「无」必须被判成"确实没有"而不是"空"**（回归）', () => {
  // 这条 bug 是在 dogfood 的真实交接上发现的：§1/§2/§3 全被判成"空"，
  // 因为那几段恰好都以 `###` 子标题开头，而最后一个段落从来没被 seal。
  const body = '## 1. 我的意图\n\n真的想做的事。\n\n## 7. 仍未决\n\n无\n'
  const result = checkHandover({
    meta: { id: 'h', role: 'handover', order: 0, status: 'authoritative' },
    body,
  })
  assert.equal(result.warnings.some((item) => item.rule === 'H5'), false, '§7 写「无」被误报')
  assert.equal(result.errors.some((item) => item.message.includes('§1')), false, '§1 被误判为空')
})

test('parseHandoverSections：同一关键词被多个标题命中时取第一个', () => {
  const parsed = parseHandoverSections('## 5. 验收\n甲\n## 附：验收细节\n乙')
  assert.equal(parsed.acceptance.title, '5. 验收')
  assert.ok(parsed.acceptance.text.includes('甲'))
})

test('looksLikeHandover：4 段以上就算「像」', () => {
  assert.equal(looksLikeHandover(GOOD_BODY), true)
  assert.equal(looksLikeHandover('# 只有标题\n\n没有段落'), false)
})

test('hasSubstance：要求可枚举时确实要求（表格行或列表项都算）', () => {
  assert.equal(hasSubstance('有内容的一段话').ok, true)
  assert.equal(hasSubstance('有内容的一段话', { enumerable: true }).ok, false)
  assert.equal(hasSubstance('| a | b |', { enumerable: true }).ok, true)
  assert.equal(hasSubstance('- 一条', { enumerable: true }).ok, true)
  assert.equal(hasSubstance('1. 一条', { enumerable: true }).ok, true)
  // 只有分隔线 / 表头分隔行不算条目
  assert.equal(hasSubstance('|---|---|', { enumerable: true }).ok, false)
})

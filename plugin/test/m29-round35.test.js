/**
 * M2.9 · 第 35 轮实机反馈的三处修复（用户拍板「1 2 3 一起做」）。
 *
 * 1. **UI**：归档列表里"文件名右边的说明太挤" → 给两侧设上限，把宽度留给 summary。
 * 2. **手册**：中文标题 → `id` 推导失败这条，要在 skill 里提前说（不在这里测，见报告）。
 * 3. **H-6**：顺带列出"正文里含计数的行"，让 AI 知道**哪句**可能过期了。
 *
 * 本文件测 1 的样式与 3 的纯函数。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { countingLinesOf } = await import('../core/markSnapshot.js')

// ---------------------------------------------------------------- 3. countingLinesOf

test('**M2.9 H-6 候选行：能挑出"命中 4/4"这类会过期的计数**（第 35 轮现场）', () => {
  // 第 35 轮 `handover-1` §5 的原话。用户归档 instruction-2 之后它当场变假。
  const text = [
    '---', 'id: handover-1', 'title: 交接', 'role: handover', 'order: -10',
    'status: authoritative', 'summary: s', 'basis: 实测', '---', '',
    '# 交接', '',
    '## §5 验收', '',
    '- `glob docs/**/*.md` 实跑命中 4/4 命中', '',
  ].join('\n')

  const lines = countingLinesOf(text)
  assert.equal(lines.length, 1, `应当只挑出那一条，实际 ${JSON.stringify(lines)}`)
  assert.match(lines[0], /4\/4/, '没挑出含计数的行')
})

test('M2.9 候选行：**不含数字的行不算候选**（否则每条都是候选 = 没提示）', () => {
  const text = [
    '---', 'id: h', 'role: handover', '---', '',
    '## §2 现在到哪了', '',
    '- `read-order` 是入口索引。',
    '- 交接已定稿。',
    '',
  ].join('\n')
  assert.deepEqual(countingLinesOf(text), [], '没有数字的行被当成候选了 —— 会变成噪音')
})

test('M2.9 候选行：**frontmatter 里的数字不算**（`order: 10` 不是引用）', () => {
  const text = [
    '---', 'id: h', 'order: -10', 'status: authoritative', 'basis: 实测', '---', '',
    '## §2', '', '没有数字的正文。', '',
  ].join('\n')
  assert.deepEqual(countingLinesOf(text), [], 'frontmatter 被算进候选了')
})

test('M2.9 候选行：**代码块里的数字不算**（那是示例，不是断言）', () => {
  const text = [
    '---', 'id: h', '---', '',
    '## §5', '',
    '```bash',
    'Copy-Item docs\\a.md deliverables\\a.md  # 2 个文件',
    '```', '',
    '正文没有数字。', '',
  ].join('\n')
  assert.deepEqual(countingLinesOf(text), [], '代码块里的行被当成候选了')
})

test('M2.9 候选行：**最多 5 条**（再多没人看）', () => {
  const text = [
    '---', 'id: h', '---', '',
    ...Array.from({ length: 12 }, (_, i) => `- 第 ${i + 1} 条：${i + 1}/${i + 2} 通过`), '',
  ].join('\n')
  const lines = countingLinesOf(text)
  assert.equal(lines.length, 5, `应当截到 5 条，实际 ${lines.length}`)
})

test('M2.9 候选行：超长行被截断（提示里要能一眼看完）', () => {
  const long = `- ${'很长的描述'.repeat(40)} 命中 3/3`
  const lines = countingLinesOf(`---\nid: h\n---\n\n${long}\n`)
  assert.equal(lines.length, 1)
  assert.ok(lines[0].length <= 91, `没截断：长度 ${lines[0].length}`)
})

test('M2.9 候选行：坏输入一律不抛（它在 doc_health 的 warn 路径上）', () => {
  assert.doesNotThrow(() => countingLinesOf(undefined))
  assert.doesNotThrow(() => countingLinesOf(null))
  assert.deepEqual(countingLinesOf(''), [])
})

test('M2.9 候选行：重复行只列一次', () => {
  const text = ['---', 'id: h', '---', '', '- 4/4 通过', '- 4/4 通过', ''].join('\n')
  assert.equal(countingLinesOf(text).length, 1)
})

// ---------------------------------------------------------------- 1. UI 样式

test('**M2.9 归档列表：说明文字必须拿到宽度**（两侧要有上限）', () => {
  // 现场（用户截图报的）：文件名右边的说明被挤成一窄条。
  // 根因：只有 summary 写了 `flex: 1`，`id` 与 `reason` 无上限 ——
  //       reason 是模型写的整句话，它越长 summary 被挤得越扁。
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'client', 'main-page.tsx'), 'utf8')

  // ① summary 必须能收缩（少了 minWidth: 0，flex 子项不收缩，省略号永不出现）
  assert.match(source, /minWidth: '0'/, 'summary 没设 minWidth: 0 —— 省略号不会出现，会被压扁')
  // ② 两侧必须有 maxWidth 上限
  assert.match(source, /maxWidth: '22ch'/, 'id 没有宽度上限')
  assert.match(source, /maxWidth: '34ch'/, 'reason 没有宽度上限 —— 它会一直挤 summary')
  // ③ 省略号（否则内容被硬裁掉，看不出还有更多）
  assert.match(source, /textOverflow: 'ellipsis'/, '没有省略号')
  // ④ 完整内容要能悬停看到（压窄了必须给补偿）
  assert.match(source, /title: item\.summary/, 'summary 被截断却没给 title 悬停')
  assert.match(source, /title: item\.reason/, 'reason 被截断却没给 title 悬停')
})

// ---------------------------------------------------------------- 1b. flex-basis（第二轮）

/**
 * **第一次没修好：根因是 `flex-basis`，不是 `maxWidth`。**
 *
 * 用户第一次反馈"UI 没修成功"，并给了决定性观察：
 *
 * > 只有当第三列的更详细的说明**只占用一行**时，第二列才能变宽。
 *
 * 这句话直接指向 flex 的 basis：
 *   · `flex: 1 1 auto` → basis = **内容宽度**（内容长就先占一大块）
 *   · `flex: 0 0 auto` → **不收缩**，reason 有多长就占多长
 *   · `flex: 1 1 0%`   → basis = **0**，拿"剩余空间"
 *   · `flex: 0 1 34ch` → basis 封顶且**可收缩**
 *
 * 所以"只在 reason 只有一行时 summary 才变宽"＝ reason 按内容宽度先占位。
 * 光加 `maxWidth` 治不了 —— 它只是上限，在 basis=auto / shrink=0 时照样占满。
 */
test('**M2.9 归档列表：summary 的 flex-basis 必须是 0**（否则 reason 一长就挤扁它）', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'client', 'main-page.tsx'), 'utf8')

  // summary：basis 归零 + 可增长
  assert.match(source, /flex: '1 1 0%'/, 'summary 不是 basis=0 —— 它会先按内容宽度占位')
  assert.doesNotMatch(
    source, /flex: '1 1 auto'/,
    'summary 又变回 basis=auto 了 —— 那正是"reason 占一行时才变宽"的根因',
  )

  // reason：basis 封顶 + **允许收缩**（原来 `0 0 auto` 的不收缩才是真病根）
  assert.match(source, /flex: '0 1 34ch'/, 'reason 没有设成可收缩的 34ch basis')
  assert.doesNotMatch(
    source, /flex: '0 0 auto',\s*\n\s*maxWidth: '34ch'/,
    'reason 又变回"不收缩"（0 0 auto）+ maxWidth —— 只封顶不收缩治不了这个病',
  )
})

test('**M2.9 归档列表的修复必须真的进了构建产物**（只改源码用户看不到）', () => {
  // 第一次修完用户说"没修成功" —— 因为 `lib/client.js` 还是 11-14 的旧版本，
  // 而界面读的是**产物**不是源码。
  //
  // ⚠️ 这条测试不检查产物"是否最新"（那要靠构建），只检查**它是否包含这次修复**。
  //    不包含 = 改了源码没构建 = 用户看到的还是旧界面。
  const bundle = readFileSync(join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8')
  assert.match(
    bundle, /1 1 0%/,
    'lib/client.js 里没有新的 flex-basis —— **忘记构建了**，用户看到的仍是旧界面',
  )
  assert.match(bundle, /0 1 34ch/, 'lib/client.js 里没有 reason 的新 flex 值')
  assert.match(bundle, /22ch/, 'lib/client.js 里没有 id 的宽度上限')
})

test('M2.9 归档列表：**reason 缺失时仍然显式警告**（别被样式改动吃掉）', () => {
  // SPEC §8.4 M2-5c：没有理由的提议等于没提议。这条行为不能因为改样式而丢。
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'client', 'main-page.tsx'), 'utf8')
  assert.match(source, /⚠️ 没有理由/, '「没有理由」的警告没了')
})

// ---------------------------------------------------------------- 1c. 阅读顺序条的图例（窄窗口）

/**
 * **2026-11-16 M2.9 第三处 UI 问题（用户报的）**
 *
 * > 右栏下方的阅读顺序的 UI 上的一段说明
 * > 「接手清单 ｜ 🟢 置信度 ｜ ✓ = AI 已读完」
 * > 这段话在右栏特别窄时会一下排成一列。
 *
 * 根因与归档列表那次**同一个处方**：允许换行。
 *   · `flex: 1` 的 basis 是 0 → 会被压得很小；
 *   · 但没有 `whiteSpace: nowrap` → 中文与 `｜` 之间处处可断行，
 *     于是每压窄一档就多折一行，最终**一字一行**；
 *   · 少了 `minWidth: 0` → flex 子项卡在 min-content（一个汉字宽）。
 */
test('**M2.9 阅读顺序条：图例必须 nowrap + 省略号**（否则窄窗口一字一行）', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'client', 'read-order-bar.tsx'), 'utf8')

  // 取出 `hint` 那段样式定义做局部断言（避免命中文件里别处的 nowrap）
  const hintBlock = /hint: \{([\s\S]*?)\n  \},/.exec(source)?.[1] ?? ''
  assert.ok(hintBlock !== '', '没找到 hint 样式块 —— 结构变了，这条测试要更新')
  assert.match(hintBlock, /whiteSpace: 'nowrap'/, '图例允许换行 —— 窄窗口会一字一行')
  assert.match(hintBlock, /textOverflow: 'ellipsis'/, '没有省略号 —— 文字会被硬裁掉')
  assert.match(hintBlock, /minWidth: '0'/, '没有 minWidth: 0 —— flex 子项卡在 min-content')
  assert.match(hintBlock, /flex: '1 1 0%'/, 'flex basis 不是 0 —— 会被压到很窄')
})

test('**M2.9 阅读顺序条：状态文字不许被压成多行**（title / progress）', () => {
  // 「AI 阅读顺序」与「1/1 ✅ 已读完」是**必须读到的状态**，
  // 宁可挤掉图例（有省略号 + 悬停兜底），也不能把它们变成多行。
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'client', 'read-order-bar.tsx'), 'utf8')

  const titleBlock = /\n  title: \{([\s\S]*?)\n  \},/.exec(source)?.[1] ?? ''
  const progressBlock = /\n  progress: \{([\s\S]*?)\n  \},/.exec(source)?.[1] ?? ''
  assert.match(titleBlock, /whiteSpace: 'nowrap'/, '「AI 阅读顺序」会被折行')
  assert.match(titleBlock, /flexShrink: 0/, '「AI 阅读顺序」会被压没')
  assert.match(progressBlock, /whiteSpace: 'nowrap'/, '进度会被折行')
  assert.match(progressBlock, /flexShrink: 0/, '进度会被压没')
})

test('M2.9 阅读顺序条的修复也要真的进构建产物', () => {
  const bundle = readFileSync(join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8')
  // 图例的完整文案必须在产物里（否则改了常量没构建）
  assert.match(bundle, /接手清单/, 'lib/client.js 里没有图例文案 —— 可能忘记构建')
})

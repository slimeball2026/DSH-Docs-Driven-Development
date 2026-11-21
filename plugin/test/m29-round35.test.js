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

// M4: H-6 counting-candidate diagnostics retired; UI coverage remains.

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

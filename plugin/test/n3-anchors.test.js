/**
 * M1.5 / **N3** 的正式单测：`declaredAnchorOf` 必须**同时认两种字段名**。
 *
 * ---- 这个文件为什么存在（M1.5 复核者补，2026-11-12）----
 *
 * N3 是「高」严重度缺陷：架构评审（"以此为准"）写的是
 * `verifiedAgainst: { dsh, bundle, commit }`，而实现只认拍平的
 * `verifiedDsh` / `verifiedBundle` / `verifiedCommit`。
 * 于是**按评审写的文档，H-4 对它永远静默通过** —— 又一个"看起来严格但永远通过"。
 *
 * 修法落在 `core/anchors.js` 的 `declaredAnchorOf()`，被 `docs/schema.js`（V9）
 * 与 `core/health.js`（H-4）**共用**。
 *
 * **但它在 M1.5 里一条单测都没有。** 证据：
 *
 * ```
 * $ grep -rn 'declaredAnchorOf' ddd-bundle/test/
 * d6.test.js:4: * `core/anchors.js` 的 `declaredAnchorOf` 已经在 ... 之外被
 * ```
 * 唯一命中的是**一行注释**（`d6.test.js` 的头部说明，说它"由 repro-n3.mjs 验过"）。
 *
 * 于是复核实测的两个变异都**存活**：
 * ```
 * 变异 N3-flat-only     （nested = undefined）→ 691 条全绿
 * 变异 N3-no-json-string（不接字符串形态）    → 691 条全绿
 * ```
 *
 * 而 N3 的**核心事实**是施工者实测出来的：「解析器把 `{...}` 读成**字符串**，
 * 不是对象」。**这个事实一条单测都没钉住** —— 哪天有人"优化"掉字符串分支
 * （看着像冗余代码），H-4 会静默退回永远通过，而 691 条测试一条都不会红。
 *
 * 本文件补上单测层，三种形态（对象 / JSON 字符串 / 数字）各钉一条。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { ANCHOR_FIELDS, declaredAnchorOf } from '../core/anchors.js'
import { parseFrontmatter } from '../docs/frontmatter.js'

// ---------------------------------------------------------------- 1. 扁平字段（M1 的既有写法）

test('N3：扁平字段 `verifiedDsh` 优先（向后兼容，不能被 N3 改坏）', () => {
  const meta = { verifiedDsh: '0.2.2' }
  assert.equal(declaredAnchorOf(meta, 'verifiedDsh', 'dsh'), '0.2.2')
})

test('N3：扁平字段是**数字**也认（转成字符串）', () => {
  assert.equal(declaredAnchorOf({ verifiedBundle: 1 }, 'verifiedBundle', 'bundle'), '1')
})

test('N3：扁平字段是空串 / 空白 → 不算给值（不猜）', () => {
  assert.equal(declaredAnchorOf({ verifiedDsh: '' }, 'verifiedDsh', 'dsh'), undefined)
  // 空白串在扁平分支里只判 `!== ''`，所以 '   ' 会被当成值 —— 这是既有行为，
  // 这里如实钉住它，避免"以为它被过滤了"。
  assert.equal(declaredAnchorOf({ verifiedDsh: '   ' }, 'verifiedDsh', 'dsh'), '   ')
})

// ---------------------------------------------------------------- 2. 嵌套字段（N3 的修法本体）

test('N3 核心：嵌套对象形态 `{ dsh: "0.0.1" }` → **能读到**（架构评审的写法）', () => {
  const meta = { verifiedAgainst: { dsh: '0.0.1', bundle: '0.0.1', commit: 'deadbee' } }
  assert.equal(declaredAnchorOf(meta, 'verifiedDsh', 'dsh'), '0.0.1')
  assert.equal(declaredAnchorOf(meta, 'verifiedBundle', 'bundle'), '0.0.1')
  assert.equal(declaredAnchorOf(meta, 'verifiedCommit', 'commit'), 'deadbee')
})

test('N3 核心（**最关键的一条**）：嵌套值是 **JSON 字符串** → 必须能读到', () => {
  // ⚠️ 这是实测事实，不是设计：`docs/frontmatter.js` 对 `{...}` **没有专门分支**，
  // 它落到 CASE 1（标量），于是 `meta.verifiedAgainst` 是**字符串**，不是对象。
  //
  // 实测（`_m15/probe-n3.mjs`）：
  //   nested meta.verifiedAgainst = "{\"dsh\":\"0.0.1\",...}"
  //
  // 如果有人把 `core/anchors.js` 里那个 `JSON.parse` 分支删掉（它看着像冗余代码），
  // H-4 会**静默退回永远通过** —— 这条测试就是那个分支的守卫。
  const meta = { verifiedAgainst: '{"dsh":"0.0.1","bundle":"0.0.1","commit":"deadbee"}' }
  assert.equal(declaredAnchorOf(meta, 'verifiedDsh', 'dsh'), '0.0.1')
  assert.equal(declaredAnchorOf(meta, 'verifiedCommit', 'commit'), 'deadbee')
})

test('N3：真实解析链路上，`verifiedAgainst: {...}` 确实是**字符串**（钉住那个实测事实）', () => {
  // 这条不测 anchors.js，它测的是"为什么必须有字符串分支"这个前提。
  // 如果哪天解析器学会了解析对象（`meta.verifiedAgainst` 变成 object），
  // 这条会红 —— 那时可以**考虑**删掉字符串分支，但要有意识地删，
  // 而不是"看着像冗余代码"顺手删。
  const parsed = parseFrontmatter('---\nid: a\nverifiedAgainst: {"dsh":"0.0.1"}\n---\n正文\n')
  assert.equal(parsed.present, true)
  assert.equal(
    typeof parsed.meta.verifiedAgainst,
    'string',
    '解析器把流式 JSON 读成字符串 —— 这是 `declaredAnchorOf` 必须有 JSON.parse 分支的原因',
  )
})

test('N3：嵌套里的值是数字也认', () => {
  assert.equal(declaredAnchorOf({ verifiedAgainst: { bundle: 1 } }, 'verifiedBundle', 'bundle'), '1')
  assert.equal(declaredAnchorOf({ verifiedAgainst: '{"bundle":1}' }, 'verifiedBundle', 'bundle'), '1')
})

// ---------------------------------------------------------------- 3. 拿不到就不猜

test('N3：坏 JSON 字符串 → **不猜**（返回 undefined，不是抛错）', () => {
  assert.equal(declaredAnchorOf({ verifiedAgainst: '{不是 json' }, 'verifiedDsh', 'dsh'), undefined)
  assert.equal(declaredAnchorOf({ verifiedAgainst: '' }, 'verifiedDsh', 'dsh'), undefined)
})

test('N3：JSON 是数组 / null / 标量 → 都不算（不猜）', () => {
  assert.equal(declaredAnchorOf({ verifiedAgainst: '["dsh"]' }, 'verifiedDsh', 'dsh'), undefined)
  assert.equal(declaredAnchorOf({ verifiedAgainst: 'null' }, 'verifiedDsh', 'dsh'), undefined)
  assert.equal(declaredAnchorOf({ verifiedAgainst: '"dsh"' }, 'verifiedDsh', 'dsh'), undefined)
  assert.equal(declaredAnchorOf({ verifiedAgainst: 42 }, 'verifiedDsh', 'dsh'), undefined)
})

test('N3：嵌套里没有那个键 → undefined（不是空串）', () => {
  assert.equal(declaredAnchorOf({ verifiedAgainst: { bundle: '1' } }, 'verifiedDsh', 'dsh'), undefined)
})

test('N3：meta 不是对象 / 是 null → undefined，不抛', () => {
  assert.equal(declaredAnchorOf(null, 'verifiedDsh', 'dsh'), undefined)
  assert.equal(declaredAnchorOf(undefined, 'verifiedDsh', 'dsh'), undefined)
  assert.equal(declaredAnchorOf('字符串', 'verifiedDsh', 'dsh'), undefined)
})

test('N3：**扁平优先于嵌套**（两个都有时取扁平的）', () => {
  const meta = { verifiedDsh: '1.0.0', verifiedAgainst: { dsh: '2.0.0' } }
  assert.equal(declaredAnchorOf(meta, 'verifiedDsh', 'dsh'), '1.0.0')
})

// ---------------------------------------------------------------- 4. 字段表

test('N3：`ANCHOR_FIELDS` 是三个锚点的唯一定义（V9 与 H-4 共用）', () => {
  assert.deepEqual(
    ANCHOR_FIELDS.map((item) => item.shortName),
    ['dsh', 'bundle', 'commit'],
  )
  assert.deepEqual(
    ANCHOR_FIELDS.map((item) => item.field),
    ['verifiedDsh', 'verifiedBundle', 'verifiedCommit'],
  )
  // 每条都必须有 label（工具输出要用它）
  for (const item of ANCHOR_FIELDS) {
    assert.equal(typeof item.label, 'string')
    assert.notEqual(item.label, '')
  }
})

test('N3：字段表是**冻结**的（防止运行期被改）', () => {
  assert.equal(Object.isFrozen(ANCHOR_FIELDS), true)
  assert.equal(Object.isFrozen(ANCHOR_FIELDS[0]), true)
})

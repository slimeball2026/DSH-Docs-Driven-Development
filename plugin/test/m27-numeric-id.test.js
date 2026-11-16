/**
 * M2.7 · `id` 是数字时文档会**静默半活着**（`session-4f229c6b`）。
 *
 * ---- 用户报的现象 ----
 *
 * > 「ai 虽然建了文件，但右侧图谱里根本没有它们」
 *
 * ---- 根因链 ----
 *
 *   1. AI 用 `doc_new` 建 `docs/1.md`，传的 `id` 是**字符串** `"1"`；
 *   2. `formatValue` 见 `"1"` 没有特殊字符 → 不加引号 → 写出 `id: 1`；
 *   3. 重扫时 `parseFrontmatter` 按通用 YAML 语义解析成**数字** `1`；
 *   4. `entryById("1")` 用严格相等 → `1 === "1"` 为 false → **找不到**；
 *   5. 索引块没有它、图谱没有它、`doc_new` 报"重扫失败"。
 *
 * ---- 为什么这个 bug 特别坏 ----
 *
 * **完全静默**：修之前 `typeof id === 'string'` 那个前置条件让整条格式校验
 * 被**跳过**，于是没有 error、没有 warn、不进 anomalies。
 * 文件在、注册表条目也在，但所有按 id 的查找全部失效。
 *
 * ---- 两道防线（本文件测的就是这两道）----
 *
 *   A. **不要生成坏数据**：`doc_new` 写盘时给"看起来像别的类型"的字符串加引号；
 *   B. **手写的坏数据要能被发现**：`schema.js` 对非字符串 id 报 V1 error。
 *
 * 只做 A 挡不住手写；只做 B 则每次建数字 id 都要先撞一次 error 再改 ——
 * 而那个 error 的修法（加引号）本来就不该由模型来做。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFrontmatter } from '../docs/frontmatter.js'
import { validateMeta } from '../docs/schema.js'
import { renderDocText } from '../tools/doc-new.js'

/** 造一份最小合法 meta。 */
const metaOf = (id) => ({
  id,
  title: '标题',
  role: 'spec',
  order: 10,
  status: 'draft',
  summary: '摘要',
  basis: '未验证',
})

// ---------------------------------------------------------------- A. 写盘往返

test('M2.7：**纯数字 id 写盘后必须往返一致**（否则按 id 的查找全部失效）', () => {
  for (const id of ['1', '2', '42', '007', '1.5', '-3']) {
    const text = renderDocText(metaOf(id), '正文')
    const parsed = parseFrontmatter(text)
    assert.equal(
      typeof parsed.meta?.id,
      'string',
      `id=${id} 写盘后被解析成 ${typeof parsed.meta?.id} —— 往返断了，entryById("${id}") 会永远找不到它`,
    )
    assert.equal(parsed.meta.id, id, `id=${id} 往返后变成了 ${JSON.stringify(parsed.meta.id)}`)
  }
})

test('M2.7：**像布尔/null 的 id 也要加引号**（YAML 会把 true 解析成布尔）', () => {
  for (const id of ['true', 'false', 'null']) {
    const text = renderDocText(metaOf(id), '正文')
    const parsed = parseFrontmatter(text)
    assert.equal(typeof parsed.meta?.id, 'string', `id=${id} 被解析成 ${typeof parsed.meta?.id}`)
    assert.equal(parsed.meta.id, id)
  }
})

test('M2.7：**普通 id 不加多余引号**（否则所有现存文档的形态都会变）', () => {
  const text = renderDocText(metaOf('read-order'), '正文')
  assert.match(text, /^id: read-order$/m, '普通 kebab-case id 不该被加引号 —— 那会让 diff 爆炸')
})

test('M2.7：**order 仍然是数字，不受影响**（别把通用 YAML 语义改坏）', () => {
  const text = renderDocText(metaOf('a'), '正文')
  assert.match(text, /^order: 10$/m, 'order 必须写成裸数字 —— 它就是要被解析成 number 的')
})

// ---------------------------------------------------------------- B. 坏数据要能发现

test('M2.7：**手写的 `id: 1` 必须报 V1 error**（不能静默半活）', () => {
  const text = '---\nid: 1\ntitle: t\nrole: spec\norder: 10\nstatus: draft\nsummary: s\nbasis: 未验证\n---\n\nx\n'
  const parsed = parseFrontmatter(text)
  assert.equal(typeof parsed.meta?.id, 'number', '前置：无引号的 1 会被解析成 number（这是通用 YAML 语义）')

  const verdict = validateMeta(parsed.meta, { body: parsed.body })
  assert.equal(verdict.hasError, true, '数字 id 竟然没被当成 error —— 文档会静默半活着')
  const hit = verdict.issues.find((item) => item.rule === 'V1' && /id 必须是字符串/.test(item.message))
  assert.ok(hit !== undefined, `没报"id 必须是字符串"：${JSON.stringify(verdict.issues.map((i) => i.message))}`)
  // 报错必须给出**可执行的改法**（否则模型只能猜）
  assert.match(hit.message, /加引号/, '报错没说清怎么改 —— 模型会去猜')
})

test('M2.7：**正常文档不受这条新校验影响**（不能把好文档判成坏）', () => {
  const text = '---\nid: read-order\ntitle: 入口\nrole: index\norder: 0\nstatus: authoritative\nsummary: 入口\nbasis: 实测\n---\n\nx\n'
  const parsed = parseFrontmatter(text)
  const verdict = validateMeta(parsed.meta, { body: parsed.body })
  assert.equal(verdict.hasError, false, `好文档被判成 error：${JSON.stringify(verdict.issues)}`)
})

test('M2.7：**kebab-case 校验仍然生效**（新分支不能把旧校验挤掉）', () => {
  const text = '---\nid: Bad_ID\ntitle: t\nrole: spec\norder: 10\nstatus: draft\nsummary: s\nbasis: 未验证\n---\n\nx\n'
  const parsed = parseFrontmatter(text)
  const verdict = validateMeta(parsed.meta, { body: parsed.body })
  assert.equal(verdict.hasError, true)
  assert.ok(
    verdict.issues.some((item) => /不是 kebab-case/.test(item.message)),
    'kebab-case 校验被新分支挤掉了',
  )
})

/**
 * 装配级测试：`index.js` 真的把 4 个工具注册了，且都带 `when`。
 *
 * 为什么要有这一层（而不是只测各模块）：
 * `doc_new` / `doc_mark` 这些工厂函数单测能过，但**忘了在 `index.js` 里调**照样白搭。
 * 而那种错误的症状是「模型看不到工具」，不会在单测里报错。
 * `_ref/smoke-ddd.mjs` 也覆盖这一点，但它是**脚本**（不在 `node --test` 里）；
 * 这里把它变成一条永远不会被忘记跑的测试。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import * as index from '../index.js'
import { fakeToolCtx } from '../testutil/fake.js'

test('index.js 导出 apply / name / inject', () => {
  assert.equal(typeof index.apply, 'function')
  assert.equal(index.name, 'ddd-engine')
  assert.ok(Array.isArray(index.inject))
  for (const dep of ['tools', 'systemPrompt', 'fs']) {
    assert.ok(index.inject.includes(dep), `inject 缺 ${dep}`)
  }
})

test('**apply() 注册了 4 个工具，且都有 `when`**（M1-Q2 / M1-Q8）', () => {
  const ctx = fakeToolCtx()
  // 没有真实 fs：不给 fs，apply 仍然应当装配完（写操作会在执行期报错，这是预期）。
  index.apply(ctx, {})

  const names = ctx.registrations.map((item) => item.definition.name).sort()
  assert.equal(names.length, 4, `注册了 ${names.length} 个工具：${names.join(', ')}`)
  assert.deepEqual(names, ['doc_handover_check', 'doc_health', 'doc_mark', 'doc_new'])

  for (const { definition, options } of ctx.registrations) {
    assert.equal(typeof options?.when, 'function', `${definition.name} 没有 when（全局挂载会污染所有会话）`)
  }
})

/**
 * ⚠️ **这条在 M2 被收窄过一次，理由必须写清楚。**
 *
 * 它的标题是「工具注册不该失败」，但原来的实现是「**一条 warn 都不许有**」。
 * M2 接上 HTTP 路由后，一个没有 `webServer` 的宿主（headless / SDK 组合，
 * 也就是 `fakeToolCtx()` 这个形态）会得到一条 warn —— 那是 SPEC §5.3-1
 * **要求**的行为（"拿不到 webServer 只 warn 不抛"）。
 *
 * 所以这里**不是**把检查放宽到"什么都忽略"，而是把它收窄回标题说的那件事：
 * **工具注册相关的 warn 一条都不许有**。
 *
 * 下面那条 `M2：没有 webServer 的宿主…` 单独钉住路由的 warn 必须**恰好一条**
 * 且文案指明 webServer —— 两条合起来，覆盖范围反而比原来更严
 * （原来只数"有没有 warn"，现在分别钉住"哪条可以有、哪条不许有"）。
 */
test('**装配后没有任何 warn**（工具注册不该失败）', () => {
  const ctx = fakeToolCtx()
  index.apply(ctx, {})
  const warnings = ctx.logs.filter((entry) => entry.level === 'warn')
  // M2：webServer 缺失的那条是**预期内**的，见下面那条测试。
  const toolWarnings = warnings.filter((entry) => !entry.message.includes('webServer'))
  assert.deepEqual(
    toolWarnings,
    [],
    `装配期出现与工具注册相关的 warn：\n${toolWarnings.map((item) => item.message).join('\n')}`,
  )
})

/**
 * M2 起，`fakeToolCtx()` 这类**没有 `webServer`** 的宿主在装配时会得到一条 warn。
 *
 * ---- 这条测试为什么必须存在（而不是把上面那条改成"忽略 webServer 的 warn"）----
 *
 * 上面那条「装配后没有任何 warn」抓到了我接路由的改动 —— **它是对的**，
 * 那正是它该做的事。但如果我为了让它变绿就把 webServer 的 warn 从检查里剔掉，
 * 我就同时失去了「**没有 webServer 时到底发生了什么**」这个问题的答案。
 *
 * 所以这里把那个问题的答案**显式钉住**：
 *   1. 装配**不抛**（插件故障不能变成宿主故障）；
 *   2. 4 个工具**照常注册**（路由失败不能连累门禁与工具）；
 *   3. warn **恰好一条**，且文案指明是 webServer 而不是别的。
 *
 * 第 3 条是关键：如果哪天注册路由的 try/catch 坏了、或者 warn 文案被改成笼统的
 * 「装配失败」，这条会红 —— 而笼统的文案会让人以为是门禁坏了。
 */
test('**M2：没有 webServer 的宿主 → 只 warn 一条，工具与门禁照常装配**（SPEC §5.3-1）', () => {
  const ctx = fakeToolCtx()
  // fakeToolCtx 没有 webServer：这是 headless / SDK 组合的真实形态。
  assert.doesNotThrow(() => index.apply(ctx, {}))

  const warnings = ctx.logs.filter((entry) => entry.level === 'warn')
  assert.equal(warnings.length, 1, `应当恰好 1 条 warn，实际 ${warnings.length} 条：\n${warnings.map((item) => item.message).join('\n')}`)
  assert.ok(
    warnings[0].message.includes('webServer'),
    `warn 没有指明是 webServer：${warnings[0].message}`,
  )
  assert.ok(
    !warnings[0].message.includes('整体失败'),
    `走的不是"缺服务"分支，而是整体失败：${warnings[0].message}`,
  )

  // 关键：路由失败**不许**连累工具与索引。
  assert.equal(ctx.registrations.length, 4, '路由 warn 连累了工具注册')
  assert.equal(ctx.guards.length, 1, '路由 warn 连累了门禁')
  assert.equal(ctx.contexts.length, 1, '路由 warn 连累了索引块')
})

test('**M0 的装配没被破坏**：仍然只注册 1 个 guard + 1 个 context', () => {
  const ctx = fakeToolCtx()
  index.apply(ctx, {})
  assert.equal(ctx.guards.length, 1, 'guard 数变了')
  assert.equal(ctx.contexts.length, 1, 'context 数变了')
  assert.equal(ctx.contexts[0].name, 'ddd:index')
  assert.equal(ctx.contexts[0].interpolate, false)
})

test('**4 个工具的 when 在无项目时一致返回 false**（不会因为在装配期就求值而炸）', async () => {
  const ctx = fakeToolCtx()
  index.apply(ctx, {})
  for (const { definition, options } of ctx.registrations) {
    const verdict = await options.when({ agent: { session: { header: { cwd: 'C:/nowhere' } } } })
    assert.equal(verdict, false, `${definition.name} 在没有 DDD 项目时可见`)
  }
})

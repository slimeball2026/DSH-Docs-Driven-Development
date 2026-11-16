/**
 * 时序仿真测试（**这是冒烟覆盖不到的一层**）。
 *
 * 为什么单独一个文件：`apply()` 的正确性不只在"每个 adapter 单独对不对"，
 * 更在"它们被宿主按什么顺序调用"。
 *
 * 真实时序（读 `dsh-agent-loop` 源码确认）：
 *
 * ```text
 * step()
 *   ├─ assembly = await systemPrompt.assemble(...)        ← 第 1 次求值 text()
 *   │     （此时探测还没跑，缓存空 → 返回 ''）
 *   ├─ decision = await dispatch.waterfall('agent/pre-step', ...)
 *   │     （我们的处理器在这里 await 探测 + 扫描）
 *   └─ sections = renderContextSections(
 *          systemPrompt.refreshContext(assembly, ...))     ← **第 2 次求值 text()**
 * ```
 *
 * 关键事实：`refreshContext()` 会对每个已注册 provider **重新调用** `resolveContext()`，
 * 而不是复用 `assemble()` 时求得的值。**第一轮就有索引靠的是这一点。**
 *
 * 如果将来有人把 `agent/pre-step` 处理器改成 fire-and-forget（不 await），
 * 或者把 `text` 改成读一个只在 assemble 时算一次的缓存，这个测试会红。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

/** 真实文件系统的最小 `ctx.fs` 适配（同步实现、异步签名）。 */
function realFs() {
  const normalize = (path) => path.replaceAll('/', '\\')
  return {
    async resolve(path) {
      const abs = normalize(path)
      return { targetKey: abs, displayPath: abs }
    },
    async stat(target) {
      try {
        const content = readFileSync(target.targetKey)
        return { type: 'file', size: content.length }
      } catch {
        try {
          readdirSync(target.targetKey)
          return { type: 'directory' }
        } catch {
          return undefined
        }
      }
    },
    async readText(target) {
      try {
        return readFileSync(target.targetKey, 'utf8')
      } catch {
        return undefined
      }
    },
    async listDir(target) {
      try {
        return readdirSync(target.targetKey, { withFileTypes: true })
          .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' }))
      } catch {
        return []
      }
    },
    async writeText() {},
    async watch() {
      throw new Error('Filesystem watching is not supported by this provider.')
    },
  }
}

/** 记录 provider 与 pre-step 处理器的假 ctx。 */
function fakeCtx(fs) {
  const providers = new Map()
  const preStep = []
  const guards = []
  return {
    providers,
    preStep,
    guards,
    logger: { debug: () => {}, warn: () => {}, info: () => {} },
    tools: {
      guard: (fn) => { guards.push(fn); return () => {} },
      register: () => { throw new Error('M0 不加工具') },
    },
    systemPrompt: {
      context: (spec) => { providers.set(spec.name, spec); return () => {} },
    },
    on: (event, handler) => {
      if (event === 'agent/pre-step') preStep.push(handler)
      return () => {}
    },
    effect: (fn) => { if (typeof fn === 'function') fn(); return () => {} },
    fs,
  }
}

/** 复刻 `dsh-system-prompt` 的 `resolveContext`：**重新求值** text()。 */
function resolveAll(providers, assembleContext) {
  return [...providers.values()].map((entry) => ({
    name: entry.name,
    text: typeof entry.text === 'function' ? entry.text(assembleContext) : entry.text,
  }))
}

/** 造一个临时 DDD 项目。 */
function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'ddd-seq-'))
  const docs = join(root, 'docs')
  mkdirSync(docs, { recursive: true })
  writeFileSync(join(docs, 'alpha.md'), [
    '---',
    'id: alpha',
    'title: A',
    'role: spec',
    'order: 10',
    'status: authoritative',
    'summary: 摘要A',
    'basis: 实测',
    '---',
    '# A',
    '',
  ].join('\n'))
  return { root, docs }
}

test('**第一轮就有索引**：assemble 为空 → pre-step 后 refreshContext 有值', async () => {
  const { root } = makeProject()
  const ctx = fakeCtx(realFs())
  apply(ctx, {})

  const session = { header: { cwd: root } }
  const assembleContext = { agent: { session } }

  // ① assemble：此刻探测还没跑
  const first = resolveAll(ctx.providers, assembleContext)
  assert.equal(first.map((entry) => entry.text).join(''), '', 'assemble 阶段不该有索引（探测还没跑）')

  // ② pre-step：我们的处理器在这里 await 探测 + 扫描
  assert.equal(ctx.preStep.length, 1, '应当注册且只注册一个 agent/pre-step 处理器')
  for (const handler of ctx.preStep) {
    await handler(
      { agent: { session }, messages: [], turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [] }),
    )
  }

  // ③ refreshContext：重新求值
  const second = resolveAll(ctx.providers, assembleContext).map((entry) => entry.text).join('')
  assert.notEqual(second, '', 'pre-step 之后仍然没有索引 —— 第一轮会缺索引')
  assert.match(second, /alpha/, '索引里没有必读文档')

  rmSync(root, { recursive: true, force: true })
})

test('pre-step 必须**原样返回 next() 的 decision**（否则这一轮进不去）', async () => {
  const { root } = makeProject()
  const ctx = fakeCtx(realFs())
  apply(ctx, {})

  const session = { header: { cwd: root } }
  const sentinel = { kind: 'enter', messages: [{ marker: 'keep-me' }] }

  const results = []
  for (const handler of ctx.preStep) {
    results.push(await handler({ agent: { session } }, async () => sentinel))
  }

  assert.equal(results.length, 1)
  assert.deepEqual(results[0], sentinel, 'pre-step 丢掉了默认 decision，这一轮会进不去')

  rmSync(root, { recursive: true, force: true })
})

test('pre-step 探测失败时**不抛**，仍返回 decision（降级为不激活）', async () => {
  const ctx = fakeCtx({
    resolve: async () => { throw new Error('boom') },
    stat: async () => { throw new Error('boom') },
    readText: async () => { throw new Error('boom') },
    listDir: async () => { throw new Error('boom') },
    writeText: async () => {},
    watch: async () => { throw new Error('boom') },
  })
  apply(ctx, {})

  const session = { header: { cwd: 'C:\\whatever' } }
  const sentinel = { kind: 'enter', messages: [] }
  for (const handler of ctx.preStep) {
    const out = await handler({ agent: { session } }, async () => sentinel)
    assert.deepEqual(out, sentinel, '探测失败时不该吞掉 decision')
  }
})

test('没有 cwd 的会话：pre-step 不抛，索引为空', async () => {
  const ctx = fakeCtx(realFs())
  apply(ctx, {})

  const session = { header: {} }
  for (const handler of ctx.preStep) {
    await handler({ agent: { session } }, async () => ({ kind: 'enter', messages: [] }))
  }
  const text = resolveAll(ctx.providers, { agent: { session } }).map((entry) => entry.text).join('')
  assert.equal(text, '', '没有 cwd 时不该注入索引')
})

test('**子代理会话**：pre-step 跑完也不注入索引（S2）', async () => {
  const { root } = makeProject()
  const ctx = fakeCtx(realFs())
  apply(ctx, {})

  const session = { header: { cwd: root, origin: 'subagent' } }
  for (const handler of ctx.preStep) {
    await handler({ agent: { session } }, async () => ({ kind: 'enter', messages: [] }))
  }
  const text = resolveAll(ctx.providers, { agent: { session } }).map((entry) => entry.text).join('')
  assert.equal(text, '', '子代理会话被注入了索引（S2 失效）')

  rmSync(root, { recursive: true, force: true })
})

test('**M0-8 端到端**：外部改动后，下一次 pre-step 让门禁拒绝并给出 vX/vY', async () => {
  const { root, docs } = makeProject()
  const file = join(docs, 'alpha.md')

  // 收集 tools/result 处理器
  const ctx = fakeCtx(realFs())
  const results = []
  const baseOn = ctx.on
  ctx.on = (event, handler) => {
    if (event === 'tools/result') results.push(handler)
    return baseOn(event, handler)
  }
  apply(ctx, {})

  const session = { header: { cwd: root } }
  const step = async () => {
    for (const handler of ctx.preStep) {
      await handler({ agent: { session } }, async () => ({ kind: 'enter', messages: [] }))
    }
  }
  const editGate = () => ctx.guards[0]({
    name: 'edit',
    arguments: { file_path: file, old_string: 'a', new_string: 'b' },
    agent: { session },
  })

  await step()

  // ① 模拟一次成功的 read（带真实信封，让指纹来自"模型读到的字节"）
  const body = readFileSync(file, 'utf8')
  const lines = body.split('\n').filter((line, index, all) => !(index === all.length - 1 && line === ''))
  const envelope = [
    `<path>${file}</path>`,
    '<type>file</type>',
    '<content>',
    lines.map((line, index) => `${index + 1}: ${line}`).join('\n'),
    `(End of file - total ${lines.length} lines)`,
    '</content>',
  ].join('\n')
  for (const handler of results) {
    handler({ name: 'read', arguments: { file_path: file }, agent: { session } },
      { isError: false, content: [{ type: 'text', text: envelope }] })
  }
  assert.equal(editGate(), undefined, '读过之后应该放行')

  // ② 外部改动文件
  writeFileSync(file, `${body}\n外部追加的一行\n`)

  // ③ 下一次 pre-step 会对账指纹
  await step()

  const reason = editGate()
  assert.equal(typeof reason, 'string', '外部改动后仍然放行 —— M0-8 失效')
  assert.match(reason, /重读/, '理由里应当要求重读')
  assert.match(reason, /v[0-9a-f]{6}/, '理由里应当给出指纹版本号')

  rmSync(root, { recursive: true, force: true })
})

test('**运行时 cwd 优先于 header.cwd**（切目录后索引仍要出现，M0-11）', async () => {
  // 实测场景：用户在会话里用 working_directory 切进 DDD 项目，
  // 但 session.header.cwd 还是建会话时的旧目录。
  // 若只看 header，切进 DDD 项目后索引**永远不会出现**。
  const { root } = makeProject()
  const staleCwd = join(root, '..') // 旧目录（不是 DDD 项目）

  const fs = realFs()
  const ctx = fakeCtx(fs)
  // 模拟 workingDirectory 服务：返回真正的运行时 cwd
  ctx.get = (name) => (name === 'workingDirectory'
    ? { get: () => root }
    : undefined)
  apply(ctx, {})

  const session = { header: { cwd: staleCwd } } // header 是旧的
  for (const handler of ctx.preStep) {
    await handler({ agent: { session } }, async () => ({ kind: 'enter', messages: [] }))
  }
  const text = resolveAll(ctx.providers, { agent: { session } }).map((entry) => entry.text).join('')
  assert.notEqual(text, '', '只读了 header.cwd，切目录后索引没出现')
  assert.match(text, /alpha/, '索引里没有必读文档')

  rmSync(root, { recursive: true, force: true })
})

test('workingDirectory 服务不可用时退回 header.cwd（不抛）', async () => {
  const { root } = makeProject()
  const ctx = fakeCtx(realFs())
  // 没有 get() 方法 → 模拟服务未挂载
  apply(ctx, {})

  const session = { header: { cwd: root } }
  for (const handler of ctx.preStep) {
    await handler({ agent: { session } }, async () => ({ kind: 'enter', messages: [] }))
  }
  const text = resolveAll(ctx.providers, { agent: { session } }).map((entry) => entry.text).join('')
  assert.match(text, /alpha/, '退到 header.cwd 之后应当仍能激活')

  rmSync(root, { recursive: true, force: true })
})

test('workingDirectory.get 抛错时退回 header（不中断）', async () => {
  const { root } = makeProject()
  const ctx = fakeCtx(realFs())
  ctx.get = (name) => (name === 'workingDirectory'
    ? { get: () => { throw new Error('boom') } }
    : undefined)
  apply(ctx, {})

  const session = { header: { cwd: root } }
  for (const handler of ctx.preStep) {
    await handler({ agent: { session } }, async () => ({ kind: 'enter', messages: [] }))
  }
  const text = resolveAll(ctx.providers, { agent: { session } }).map((entry) => entry.text).join('')
  assert.match(text, /alpha/, '服务抛错后应当退回 header')

  rmSync(root, { recursive: true, force: true })
})

test('**注册表未就绪（扫描失败）→ 门禁放行**，不让插件故障阻断施工', async () => {
  // 让 listDir 一直失败 → 扫描得到空注册表；但更极端：让 resolve 抛。
  // 这条测的是"插件自己坏了也不许拦模型"。
  const ctx = fakeCtx({
    resolve: async () => { throw new Error('fs unavailable') },
    stat: async () => { throw new Error('fs unavailable') },
    readText: async () => { throw new Error('fs unavailable') },
    listDir: async () => { throw new Error('fs unavailable') },
    writeText: async () => { throw new Error('fs unavailable') },
    watch: async () => { throw new Error('fs unavailable') },
  })
  apply(ctx, {})

  // 没有任何项目能被探测到（探测全部失败），所以门禁应当直接放行。
  const session = { header: { cwd: 'C:\\nowhere' } }
  for (const handler of ctx.preStep) {
    await handler({ agent: { session } }, async () => ({ kind: 'enter', messages: [] }))
  }

  assert.equal(ctx.guards.length, 1, 'guard 应当仍然注册着（只是内部判定为不激活）')
  const reason = ctx.guards[0]({
    name: 'write',
    arguments: { file_path: 'C:\\nowhere\\docs\\x.md' },
    agent: { session },
  })
  assert.equal(reason, undefined, '插件自身故障时不该拦住模型')
})

test('同一份文档重复读，索引文本不变（M0-5 的物理前提）', async () => {
  const { root, docs } = makeProject()
  const ctx = fakeCtx(realFs())
  apply(ctx, {})

  const session = { header: { cwd: root } }
  const assembleContext = { agent: { session } }

  for (const handler of ctx.preStep) {
    await handler({ agent: { session } }, async () => ({ kind: 'enter', messages: [] }))
  }
  const before = resolveAll(ctx.providers, assembleContext).map((entry) => entry.text).join('')

  // 模拟宿主：读一次文档（tools/result 观测）
  const observe = ctx.on
  void observe
  // 直接走插件注册的 tools/result：fakeCtx.on 只记 pre-step，这里手动补一个入口
  const toolsResult = []
  ctx.on = (event, handler) => {
    if (event === 'tools/result') toolsResult.push(handler)
    return () => {}
  }

  // 重新 apply 一份，拿到 tools/result 处理器
  const ctx2 = fakeCtx(realFs())
  const collected = []
  const originalOn = ctx2.on
  ctx2.on = (event, handler) => {
    if (event === 'tools/result') collected.push(handler)
    return originalOn(event, handler)
  }
  apply(ctx2, {})
  const session2 = { header: { cwd: root } }
  const assembleContext2 = { agent: { session: session2 } }
  for (const handler of ctx2.preStep) {
    await handler({ agent: { session: session2 } }, async () => ({ kind: 'enter', messages: [] }))
  }

  for (const handler of collected) {
    handler({ name: 'read', arguments: { file_path: join(docs, 'alpha.md') }, agent: { session: session2 } }, { isError: false })
  }
  const afterFirstRead = resolveAll(ctx2.providers, assembleContext2).map((entry) => entry.text).join('')

  // 再读一遍（内容没变）
  for (const handler of collected) {
    handler({ name: 'read', arguments: { file_path: join(docs, 'alpha.md') }, agent: { session: session2 } }, { isError: false })
  }
  const afterSecondRead = resolveAll(ctx2.providers, assembleContext2).map((entry) => entry.text).join('')

  assert.equal(afterSecondRead, afterFirstRead, '重复读同一份未变文档改变了索引文本 —— 会产生多余的历史消息')
  assert.notEqual(before, '', '前置条件：索引本来该有内容')

  rmSync(root, { recursive: true, force: true })
})

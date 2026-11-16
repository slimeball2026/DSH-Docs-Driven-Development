/**
 * M0 评审发现的三处缺陷的回归测试（D1 / D2 / D3）。
 *
 * **这三个 bug 的共同点：都不是「某个函数算错了」，而是「两个模块之间没人接线」。**
 * 所以它们既不会被纯函数单测抓到，也不会被 `sequence.test.js` 抓到
 * （那份测的是「第一轮有没有索引」，不测「后续变化有没有跟上」）。
 *
 * | # | 现象 | 根因 |
 * |---|---|---|
 * | D1 | `AGENTS.md` 首次扫描后永不重写 | `rescan()` 不通知 writer |
 * | D2 | 降级模式下新建文档永不被发现 | 只有 `read` 触发重扫；`refreshAllFingerprints` 只更新已在册条目 |
 * | D3 | 新建文档「读完立刻改」被误拒 | `markRead` 对未入册条目返回 false 且**不补记** |
 *
 * 关键设计：**把 watch 可用/不可用分成两个场景**。
 * 不分开的话 D1 会被 D2 掩盖 —— 降级模式下文档根本没进注册表，
 * 于是「AGENTS.md 没更新」既可能是 D1，也可能只是 D2（我在评审时踩过这个坑）。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

/** 等异步 rescan / writer 落定。 */
const settle = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 假 `ctx.fs`：真实文件系统 + 可控的 watch。
 * `watchSupported: false` 时抛错 —— 这是 `dsh-fs` 对「不支持监听」的约定行为。
 */
function makeFs({ watchSupported }) {
  const normalize = (path) => path.replaceAll('/', '\\')
  const watchCallbacks = []

  return {
    watchCallbacks,
    async resolve(path) {
      const abs = normalize(path)
      return { targetKey: abs, displayPath: abs }
    },
    async stat(target) {
      try {
        const info = statSync(target.targetKey)
        return info.isDirectory() ? { type: 'directory' } : { type: 'file', size: info.size }
      } catch {
        return undefined
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
    async writeText(target, content) {
      writeFileSync(target.targetKey, content)
    },
    async watch(target, changed) {
      if (!watchSupported) throw new Error('Filesystem watching is not supported by this provider.')
      watchCallbacks.push(changed)
      return async () => {}
    },
  }
}

/** 假 `ctx`。 */
function makeCtx(fs) {
  const guards = []
  const providers = new Map()
  const preStep = []
  const listeners = new Map()

  return {
    guards,
    providers,
    preStep,
    listeners,
    logger: { debug: () => {}, warn: () => {}, info: () => {} },
    tools: {
      guard: (fn) => { guards.push(fn); return () => {} },
      register: () => { throw new Error('M0 不加工具') },
    },
    systemPrompt: {
      context: (spec) => { providers.set(spec.name, spec); return () => {} },
    },
    on: (event, handler) => {
      if (event === 'agent/pre-step') {
        preStep.push(handler)
        return () => {}
      }
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {}
    },
    effect: (fn) => { if (typeof fn === 'function') fn(); return () => {} },
    fs,
  }
}

/** 造一份合法文档。 */
function doc(id, extra = {}) {
  return [
    '---',
    `id: ${id}`,
    `title: ${id}`,
    `role: ${extra.role ?? 'spec'}`,
    `order: ${extra.order ?? 10}`,
    `status: ${extra.status ?? 'authoritative'}`,
    `summary: ${id} 的摘要`,
    'basis: 实测',
    '---',
    '',
    `# ${id}`,
    '',
  ].join('\n')
}

/** 模拟宿主 `read` 的返回信封。 */
function readEnvelope(file) {
  const body = readFileSync(file, 'utf8')
  const lines = body.split('\n').filter((line, index, all) => !(index === all.length - 1 && line === ''))
  return [
    `<path>${file}</path>`,
    '<type>file</type>',
    '<content>',
    lines.map((line, index) => `${index + 1}: ${line}`).join('\n'),
    `(End of file - total ${lines.length} lines)`,
    '</content>',
  ].join('\n')
}

/**
 * 搭一个跑起来的会话。
 * `agentsMdMinWriteMs: 0` 关掉写 AGENTS.md 的节流，否则测试里看不到结果。
 */
function boot(watchSupported) {
  const root = mkdtempSync(join(tmpdir(), 'ddd-regress-'))
  const docs = join(root, 'docs')
  mkdirSync(docs, { recursive: true })
  writeFileSync(join(docs, 'alpha.md'), doc('alpha', { order: 10 }))
  writeFileSync(join(docs, 'beta.md'), doc('beta', { order: 20 }))

  const fs = makeFs({ watchSupported })
  const ctx = makeCtx(fs)
  apply(ctx, { agentsMdMinWriteMs: 0 })

  const session = { header: { cwd: root } }
  const step = async () => {
    for (const handler of ctx.preStep) {
      await handler({ agent: { session } }, async () => ({ kind: 'enter', messages: [] }))
    }
  }
  const indexText = () => {
    const provider = [...ctx.providers.values()][0]
    return provider === undefined ? '' : provider.text({ agent: { session } })
  }
  const guard = (name, args) => ctx.guards[0]({ name, arguments: args, agent: { session } })
  const observe = (name, args, result) => {
    for (const handler of ctx.listeners.get('tools/result') ?? []) {
      handler({ name, arguments: args, agent: { session } }, result)
    }
  }
  const agentsMd = () => {
    try {
      return readFileSync(join(root, 'AGENTS.md'), 'utf8')
    } catch {
      return ''
    }
  }
  const fireWatch = () => { for (const cb of fs.watchCallbacks) cb(undefined) }
  const cleanup = () => rmSync(root, { recursive: true, force: true })

  return { root, docs, ctx, fs, session, step, indexText, guard, observe, agentsMd, fireWatch, cleanup }
}

// ---------------------------------------------------------------- D1

test('D1：文档状态变化后 AGENTS.md 跟着更新（watch 可用）', async () => {
  const app = boot(true)
  await app.step()
  await settle()

  assert.ok(!app.agentsMd().includes('不要执行'), '前置条件：初始没有 sealed 文档')

  // alpha 从 authoritative 改成 sealed
  writeFileSync(join(app.docs, 'alpha.md'), doc('alpha', { order: 10, status: 'sealed' }))
  app.fireWatch()
  await settle()
  await app.step()
  await settle()

  assert.ok(app.indexText().includes('【禁止执行】'), '前置条件：索引块已把 alpha 移入禁止清单')
  assert.ok(
    app.agentsMd().includes('不要执行'),
    'AGENTS.md 没有跟着更新 —— D1 回归（慢变量永远停在首次扫描的内容）',
  )
  assert.ok(app.agentsMd().includes('alpha'), 'AGENTS.md 里应当出现 alpha')

  app.cleanup()
})

test('D1：新增文档后 AGENTS.md 的必读清单跟着更新（watch 可用）', async () => {
  const app = boot(true)
  await app.step()
  await settle()
  assert.ok(!app.agentsMd().includes('gamma'), '前置条件：gamma 还不存在')

  writeFileSync(join(app.docs, 'gamma.md'), doc('gamma', { order: 30 }))
  app.fireWatch()
  await settle()
  await app.step()
  await settle()

  assert.ok(app.agentsMd().includes('gamma'), 'AGENTS.md 没收录新文档 —— D1 回归')

  app.cleanup()
})

// ---------------------------------------------------------------- D2

test('D2 对照：watch 可用时新建文档能被发现', async () => {
  const app = boot(true)
  await app.step()
  await settle()

  writeFileSync(join(app.docs, 'gamma.md'), doc('gamma', { order: 30 }))
  app.fireWatch()
  await settle()
  await app.step()

  assert.ok(app.indexText().includes('gamma'), 'watch 路径下新文档没被发现')

  app.cleanup()
})

test('D2：**降级模式**下新建文档能被发现（5 轮 pre-step 内）', async () => {
  const app = boot(false)
  await app.step()
  await settle()

  writeFileSync(join(app.docs, 'gamma.md'), doc('gamma', { order: 30 }))
  for (let i = 0; i < 5; i += 1) await app.step()
  await settle()

  assert.ok(
    app.indexText().includes('gamma'),
    '降级模式下新文档永不出现 —— D2 回归（refreshAllFingerprints 只更新已在册条目，发现不了新文件）',
  )

  app.cleanup()
})

test('D2：降级模式下模型用 write 新建，也能被发现', async () => {
  const app = boot(false)
  await app.step()
  await settle()

  const gamma = join(app.docs, 'gamma.md')
  writeFileSync(gamma, doc('gamma', { order: 30 }))
  app.observe('write', { file_path: gamma }, { isError: false, content: [{ type: 'text', text: 'Created file' }] })
  for (let i = 0; i < 5; i += 1) await app.step()
  await settle()

  assert.ok(app.indexText().includes('gamma'), 'write 新建的文档没被发现 —— D2 回归')

  app.cleanup()
})

// ---------------------------------------------------------------- D3

test('D3：刚 read 过的新建文档，重扫完成后 edit 应放行', async () => {
  const app = boot(false)
  await app.step()
  await settle()

  const gamma = join(app.docs, 'gamma.md')
  writeFileSync(gamma, doc('gamma', { order: 30 }))

  // ① 模型 read 它（此时还没入册 → markRead 走待补记队列）
  app.observe('read', { file_path: gamma }, {
    isError: false,
    content: [{ type: 'text', text: readEnvelope(gamma) }],
  })
  // ② 等重扫完成（正常时序里，edit 之前必然有一轮 pre-step）
  await settle()
  await app.step()
  await settle()

  const verdict = app.guard('edit', { file_path: gamma, old_string: 'x', new_string: 'y' })
  assert.equal(
    verdict,
    undefined,
    `刚读过的新文档被拒 —— D3 回归：${verdict}`,
  )

  app.cleanup()
})

test('D3 反向：**没读过**的新文档仍然要拦（不能为了修误伤而把门禁拆了）', async () => {
  const app = boot(false)
  await app.step()
  await settle()

  const gamma = join(app.docs, 'gamma.md')
  writeFileSync(gamma, doc('gamma', { order: 30 }))
  // 不 read，只等它入册
  for (let i = 0; i < 3; i += 1) await app.step()
  await settle()

  const verdict = app.guard('edit', { file_path: gamma, old_string: 'x', new_string: 'y' })
  assert.equal(typeof verdict, 'string', '没读过的必读文档竟然放行了 —— 门禁被拆了')
  assert.match(verdict, /必须先读/, '拒绝理由应当要求先读')

  app.cleanup()
})

test('D3 反向：读的是旧版（外部改过）仍然要拦', async () => {
  const app = boot(false)
  await app.step()
  await settle()

  const alpha = join(app.docs, 'alpha.md')
  app.observe('read', { file_path: alpha }, {
    isError: false,
    content: [{ type: 'text', text: readEnvelope(alpha) }],
  })
  await app.step()
  await settle()
  assert.equal(app.guard('edit', { file_path: alpha, old_string: 'x', new_string: 'y' }), undefined, '前置：读过应放行')

  // 外部改动
  writeFileSync(alpha, `${doc('alpha', { order: 10 })}\n外部追加的一行\n`)
  await app.step()
  await settle()

  const verdict = app.guard('edit', { file_path: alpha, old_string: 'x', new_string: 'y' })
  assert.equal(typeof verdict, 'string', '外部改动后仍放行 —— M0-8 回归')
  assert.match(verdict, /重读/, '理由里应当要求重读')

  app.cleanup()
})

// ---------------------------------------------------------------- M0-8 的 watch 路径

test('M0-8（watch 可用）：外部改动后，pre-step 仍要对账指纹并拒绝', async () => {
  // ⚠️ 2026-11-15 M2.7 补：**这条路径此前零覆盖**。
  //
  // `index.js` 的 `prepareSession()` 分两条路：
  //   - 有 watcher → `refreshAllFingerprints()`
  //   - 无 watcher → `rescanIfStale()`
  // 而 `sequence.test.js` 的 M0-8 端到端用的是**无 watch** 的 fake fs，
  // 于是 `refreshAllFingerprints()` 那一行**从来没被任何测试执行过**。
  // 变异实验：把它改成 `void registry.refreshAllFingerprints()`（不 await）
  // 之后**全部 1073 条单测依然全绿** —— 因为那一行不可达。
  //
  // 这条测试用 `boot(true)`（watch 可用）把它变成可达路径。
  const app = boot(true)
  await app.step()
  await settle()

  const alpha = join(app.docs, 'alpha.md')
  app.observe('read', { file_path: alpha }, {
    isError: false,
    content: [{ type: 'text', text: readEnvelope(alpha) }],
  })
  await app.step()
  await settle()
  assert.equal(
    app.guard('edit', { file_path: alpha, old_string: 'x', new_string: 'y' }),
    undefined,
    '前置：读过之后应当放行',
  )

  // 外部改动（**不触发 watch 回调** —— 模拟"watcher 还没收到事件"的窗口）
  writeFileSync(alpha, `${doc('alpha', { order: 10 })}\n外部追加的一行\n`)
  await app.step()
  await settle()

  const verdict = app.guard('edit', { file_path: alpha, old_string: 'x', new_string: 'y' })
  assert.equal(typeof verdict, 'string', 'watch 模式下外部改动后仍然放行 —— M0-8 在 watch 路径上失效')
  assert.match(verdict, /重读/, '理由里应当要求重读')

  app.cleanup()
})

// ---------------------------------------------------------------- 交叉影响

test('修复没有让索引块变得不稳定（D1/D2 的副作用检查）', async () => {
  const app = boot(false)
  await app.step()
  await settle()

  // 连续 10 轮、文档不变 → 索引文本必须完全一致
  // （这是 M0-5 的物理前提；D2 改成每轮重扫之后尤其要盯）
  const before = app.indexText()
  for (let i = 0; i < 10; i += 1) await app.step()
  await settle()
  const after = app.indexText()

  assert.equal(after, before, '文档没变，索引文本却变了 —— 会让 runtime-context 每轮都 append')

  app.cleanup()
})

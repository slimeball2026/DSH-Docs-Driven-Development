/**
 * M2.7 · 分段读（read with offset/limit）与门禁指纹的交互。
 *
 * 交接 `交接-M2.7.md` §4.7 声称：
 *
 *   > 分段读时 `textFromReadResult()` 返回 undefined，
 *   > `markRead()` 于是写入**注册表缓存的旧指纹**，
 *   > 门禁随后报「你读过的是旧版」——用户看起来像"刚读过却说没读"。
 *
 * **本文件的任务是先用测试把这句话落地，再决定修什么。**
 * 在能复现之前不动产品代码 —— 否则就是"照着自己的描述修一个还没确认的 bug"。
 *
 * 装配照抄 `regressions.test.js` 的 `boot()`（那一套是本仓库唯一经过实战的假 ctx）。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

const settle = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms))

function makeFs() {
  const normalize = (path) => path.replaceAll('/', '\\')
  return {
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
    async watch() {
      throw new Error('Filesystem watching is not supported by this provider.')
    },
  }
}

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
      register: () => { throw new Error('本测试不注册工具') },
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

/** 合法文档：frontmatter 必须是第一行，否则会被判成 unmanaged。 */
function docOf(id, marker, extraLines = 60) {
  const body = [`标记：${marker}`, ...Array.from({ length: extraLines }, (_, i) => `第 ${i + 1} 行补充内容`)]
  return [
    '---',
    `id: ${id}`,
    `title: ${id} 的标题`,
    'role: spec',
    'order: 10',
    'status: authoritative',
    `summary: ${id} 的摘要`,
    'basis: 实测',
    '---',
    '',
    `# ${id}`,
    '',
    ...body,
    '',
  ].join('\n')
}

/** 宿主 `read` 的返回信封。`win` 给了就是分段读（footer 不是 End of file）。 */
function readEnvelope(file, win) {
  const all = readFileSync(file, 'utf8').split('\n').filter((line, i, a) => !(i === a.length - 1 && line === ''))
  if (win === undefined) {
    return [
      '<content>',
      all.map((line, i) => `${i + 1}: ${line}`).join('\n'),
      `(End of file - total ${all.length} lines)`,
      '</content>',
    ].join('\n')
  }
  const slice = all.slice(win.offset - 1, win.offset - 1 + win.limit)
  return [
    '<content>',
    slice.map((line, i) => `${win.offset + i}: ${line}`).join('\n'),
    `(Showing lines ${win.offset}-${win.offset + slice.length - 1} of ${all.length})`,
    '</content>',
  ].join('\n')
}

function boot() {
  const root = mkdtempSync(join(tmpdir(), 'ddd-window-'))
  const docs = join(root, 'docs')
  mkdirSync(docs, { recursive: true })
  const file = join(docs, 'alpha.md')
  writeFileSync(file, docOf('alpha', '原始'))

  const fs = makeFs()
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
  /** 模型真的把文件改了（模拟 edit 成功之后的磁盘状态）。 */
  const modelWrite = (marker) => writeFileSync(file, docOf('alpha', marker))

  return { root, docs, file, ctx, session, step, indexText, guard, observe, modelWrite, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/**
 * ⚠️ **不要**在这里带 `file_path`：调用点写的是
 * `{ file_path: app.file, ...editArgs(...) }`，展开会把真实路径覆盖成 undefined，
 * 门禁拿不到路径就直接放行 —— 整个测试会变成"测空气"。
 * （我第一版就是这么写的，前置断言当场抓到。）
 */
const editArgs = (from, to) => ({ old_string: from, new_string: to })

// ---------------------------------------------------------------- 前置

test('前置：文档确实进了必读清单（否则后面所有断言都在测空气）', async () => {
  const app = boot()
  await app.step()
  await settle()

  const idx = app.indexText()
  assert.ok(idx.includes('【必读】') || idx.includes('alpha'), `索引块里没有 alpha，本测试无效：${idx.slice(0, 400)}`)

  // 没读过 → 必须拒
  const verdict = app.guard('edit', { file_path: app.file, ...editArgs('标记：原始', '标记：改1') })
  assert.equal(typeof verdict, 'string', '没读过的必读文档竟然放行 —— 这个装配没有真正激活')

  app.cleanup()
})

// ---------------------------------------------------------------- §4.7 的核心断言

test('§4.7 前置：改完自己 → **下一轮 pre-step 之后**不重读 → M2.8 起**放行**', async () => {
  // ---- 2026-11-15 M2.8：这条断言**翻了面** ----
  //
  // 原来叫「… → 必须拒绝」，断言 `typeof verdict === 'string'`。
  // 用户 2026-11-15 拍板要认 `selfWritten`：
  //   > 门禁规则是"改过就变回未读，必须整份重读"。但**我自己刚写的改动，
  //   > 为什么还需要重读一遍？** 改的是我自己写的两行。
  //
  // 实机依据：第 26 轮 `session-b5657ffd` 的 `doc_mark` 连续失败 3 次
  //（seq 127 / 161），每次都是"自己刚 edit 完，标状态时被要求整份重读"。
  //
  // ⚠️ 这条测试真正守的边界**没变**：`selfWritten` 只豁免**指纹比对**，
  //    不豁免"必须先读"（见 `m28-selfwritten-real.test.js` 第 4 条）。
  const app = boot()
  await app.step()
  await settle()

  app.observe('read', { file_path: app.file }, { isError: false, content: [{ type: 'text', text: readEnvelope(app.file) }] })
  assert.equal(
    app.guard('edit', { file_path: app.file, ...editArgs('标记：原始', '标记：改1') }),
    undefined,
    '前置：完整读过应当放行',
  )

  // 模型自己改了盘
  app.modelWrite('改1')
  app.observe('edit', { file_path: app.file, ...editArgs('标记：原始', '标记：改1') }, { isError: false, content: [{ type: 'text', text: 'ok' }] })

  // ★ 真实时序：宿主在两次工具调用之间必然跑一轮 pre-step（那里会重算指纹）。
  //   **不跑它就是在测一个真实里不存在的时序**。
  await app.step()
  await settle()

  const verdict = app.guard('edit', { file_path: app.file, ...editArgs('标记：改1', '标记：改2') })
  assert.equal(
    verdict,
    undefined,
    '自己改完（且经过 pre-step 重算指纹）仍被要求重读 —— selfWritten 豁免失效'
      + '（注意：很可能又是 `isSelfWritten` 拿错了指纹来源，见 m28-selfwritten-real.test.js）',
  )

  app.cleanup()
})

test('§4.7：**分段读**不能顶替完整读（**外部改动**后只读窗口 → 仍然拒绝）', async () => {
  // ⚠️ 2026-11-15 M2.7：这条测试的场景从「自己改完」改成「**外部改动**」。
  //
  // 原因：用户拍板把修法 2 **收窄**成"只在外部改动时生效"。
  // 于是"自己改完 + 窗口读"现在**会放行**（那是收窄的目的，见
  // `test/m27-window-read-real.test.js` 的收窄三条用例）。
  // 而这条测试真正要守的语义是"**没看过别人的改动**就拿不到写权限"——
  // 那个场景必须继续拒绝，所以改成外部改动。
  const app = boot()
  await app.step()
  await settle()

  app.observe('read', { file_path: app.file }, { isError: false, content: [{ type: 'text', text: readEnvelope(app.file) }] })
  assert.equal(
    app.guard('edit', { file_path: app.file, ...editArgs('标记：原始', '标记：改1') }),
    undefined,
    '前置：完整读过应放行',
  )

  // ★ **外部**改动：直接写盘，**不**经过 observe（所以不会记成"我写过"）
  writeFileSync(app.file, docOf('alpha', '外部改'))
  await app.step()
  await settle()

  // 确认此刻确实处于"外部改动、还没重读"的状态
  const before = app.guard('edit', { file_path: app.file, ...editArgs('标记：外部改', '标记：改2') })
  assert.equal(typeof before, 'string', '前置：外部改动后应当要求重读')

  // ★ 现在模型做了一个**分段读**（真实会话里这是 `read(limit=12)` 那种）
  app.observe('read', { file_path: app.file, offset: 50, limit: 30 }, {
    isError: false,
    content: [{ type: 'text', text: readEnvelope(app.file, { offset: 50, limit: 30 }) }],
  })

  // ⚠️ 期望"仍然拒绝"。
  //
  // 我第一版把这条断言写反了，期望"分段读之后应当放行"，理由是
  // "模型确实读了一些内容"。但那个期望**是错的**：
  // 窗口读还原不出全文，我们没有资格替模型声称"看过当前这一版"；
  // 更危险的方向是**误放行** —— 外部改动后只读一小段就能拿到写权限，
  // 而模型从没看过改动后的内容（`test/m27-window-read-real.test.js` 复现）。
  const afterWindowRead = app.guard('edit', { file_path: app.file, ...editArgs('标记：外部改', '标记：改2') })
  assert.equal(
    typeof afterWindowRead,
    'string',
    `外部改动后只做分段读竟然放行了 —— 模型没看过别人的改动却拿到写权限：${String(afterWindowRead)}`,
  )
  assert.match(String(afterWindowRead), /重读/)

  // 对照：完整读之后必须放行（否则门禁变成"永远修不好"）
  app.observe('read', { file_path: app.file }, { isError: false, content: [{ type: 'text', text: readEnvelope(app.file) }] })
  assert.equal(
    app.guard('edit', { file_path: app.file, ...editArgs('标记：外部改', '标记：改2') }),
    undefined,
    '完整读之后仍然拒绝 —— 门禁变成"永远修不好"了',
  )

  app.cleanup()
})

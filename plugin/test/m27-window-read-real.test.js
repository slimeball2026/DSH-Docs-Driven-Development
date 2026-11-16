/**
 * M2.7 · §4.7 的**真正**形态（交接里的描述是反的）。
 *
 * 交接 §4.7 说：分段读取不到正文 → 记下**旧指纹** → 看起来像"刚读过却说没读"（偏向严格）。
 *
 * 但代码的实际路径是 `markRead` 写入 `entry.fingerprint`（**注册表当前值**），
 * 而注册表的指纹每次 rescan / pre-step 都从**磁盘**重算。
 * 于是在这个时序里会发生**偏向宽松**的事：
 *
 *   ① 完整读（记 A）
 *   ② 外部改动 → pre-step 重扫 → 注册表 = B，readSet 仍 A → 门禁正确地拒绝
 *   ③ 模型只**分段读**一小段（没看到改动）→ 注册表当前值是 B → readSet 被抬成 B
 *   ④ 门禁**放行** —— 但模型从来没看过改动后的内容
 *
 * 这就是修法 2 想表达的意思：「分段读时**不覆盖**已有指纹」。
 * 现在它没被实现，所以这条能过。
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
    async resolve(path) { const abs = normalize(path); return { targetKey: abs, displayPath: abs } },
    async stat(target) {
      try {
        const info = statSync(target.targetKey)
        return info.isDirectory() ? { type: 'directory' } : { type: 'file', size: info.size }
      } catch { return undefined }
    },
    async readText(target) { try { return readFileSync(target.targetKey, 'utf8') } catch { return undefined } },
    async listDir(target) {
      try {
        return readdirSync(target.targetKey, { withFileTypes: true })
          .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' }))
      } catch { return [] }
    },
    async writeText(target, content) { writeFileSync(target.targetKey, content) },
    async watch() { throw new Error('Filesystem watching is not supported by this provider.') },
  }
}

function makeCtx(fs) {
  const guards = []; const providers = new Map(); const preStep = []; const listeners = new Map()
  return {
    guards, providers, preStep, listeners,
    logger: { debug: () => {}, warn: () => {}, info: () => {} },
    tools: { guard: (fn) => { guards.push(fn); return () => {} }, register: () => { throw new Error('本测试不注册工具') } },
    systemPrompt: { context: (spec) => { providers.set(spec.name, spec); return () => {} } },
    on: (event, handler) => {
      if (event === 'agent/pre-step') { preStep.push(handler); return () => {} }
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {}
    },
    effect: (fn) => { if (typeof fn === 'function') fn(); return () => {} },
    fs,
  }
}

function docOf(id, marker) {
  const body = [`标记：${marker}`, ...Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 行补充内容`)]
  return ['---', `id: ${id}`, `title: ${id} 的标题`, 'role: spec', 'order: 10',
    'status: authoritative', `summary: ${id} 的摘要`, 'basis: 实测', '---', '', `# ${id}`, '', ...body, ''].join('\n')
}

function readEnvelope(file, win) {
  const all = readFileSync(file, 'utf8').split('\n').filter((line, i, a) => !(i === a.length - 1 && line === ''))
  if (win === undefined) {
    return ['<content>', all.map((l, i) => `${i + 1}: ${l}`).join('\n'), `(End of file - total ${all.length} lines)`, '</content>'].join('\n')
  }
  const slice = all.slice(win.offset - 1, win.offset - 1 + win.limit)
  return ['<content>', slice.map((l, i) => `${win.offset + i}: ${l}`).join('\n'),
    `(Showing lines ${win.offset}-${win.offset + slice.length - 1} of ${all.length})`, '</content>'].join('\n')
}

function boot() {
  const root = mkdtempSync(join(tmpdir(), 'ddd-m27b-'))
  const docs = join(root, 'docs')
  mkdirSync(docs, { recursive: true })
  const file = join(docs, 'alpha.md')
  writeFileSync(file, docOf('alpha', '原始'))

  const ctx = makeCtx(makeFs())
  apply(ctx, { agentsMdMinWriteMs: 0 })
  const session = { header: { cwd: root } }
  const step = async () => {
    for (const handler of ctx.preStep) await handler({ agent: { session } }, async () => ({ kind: 'enter', messages: [] }))
  }
  const guard = (from, to) => ctx.guards[0]({ name: 'edit', arguments: { file_path: file, old_string: from, new_string: to }, agent: { session } })
  const observe = (name, args, result) => {
    for (const handler of ctx.listeners.get('tools/result') ?? []) handler({ name, arguments: args, agent: { session } }, result)
  }
  /** 模拟一次**成功**的写（磁盘改了 + 观测到成功结果）。 */
  const modelWriteOk = (marker, from, to) => {
    writeFileSync(file, docOf('alpha', marker))
    observe('edit', { file_path: file, old_string: from, new_string: to }, { isError: false, content: [{ type: 'text', text: 'ok' }] })
  }
  return { root, docs, file, step, guard, observe, modelWriteOk, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('§4.7 真形态：外部改动后「只分段读」不得放行（分段读不能把已读记录抬到新版本）', async () => {
  const app = boot()
  await app.step()
  await settle()

  // ① 完整读
  app.observe('read', { file_path: app.file }, { isError: false, content: [{ type: 'text', text: readEnvelope(app.file) }] })
  assert.equal(app.guard('标记：原始', '标记：改1'), undefined, '前置：完整读过应放行')

  // ② 外部改动（别人/另一个会话改的）
  writeFileSync(app.file, docOf('alpha', '外部改'))
  await app.step()
  await settle()
  assert.equal(
    typeof app.guard('标记：外部改', '标记：再改'), 'string',
    '前置：外部改动后应当要求重读',
  )

  // ③ 模型只分段读一小段（**没看到**「标记：外部改」这一行）
  app.observe('read', { file_path: app.file, offset: 50, limit: 10 }, {
    isError: false,
    content: [{ type: 'text', text: readEnvelope(app.file, { offset: 50, limit: 10 }) }],
  })

  // ④ 此时门禁**必须仍然拒绝**：模型没有读过改动后的内容
  const after = app.guard('标记：外部改', '标记：再改')
  assert.equal(
    typeof after,
    'string',
    '分段读把已读记录抬到了磁盘新版本 —— 模型没看过改动后的内容却拿到了放行',
  )

  app.cleanup()
})

// ---------------------------------------------------------------- M2.7 A 方案（用户拍板）

test('**M2.7 A 方案：片段读完全不记账** —— 既不推开拒绝，也不把记录改坏', async () => {
  // ---- 这条测试的语义被**有意反转**过两次，历史必须留住 ----
  //
  // ① `20cf9da`（修法 2）：断言"自己刚改完 + 窗口读 → **应当放行**"
  //    理由：实测（`session-25dad0e8`）窗口读之后写 5 次全被拒。
  //
  // ② 2026-11-15（A 方案，用户拍板「停用窗口读记账」）：断言改成
  //    **"仍然拒绝"**。因为实测（`_m27/minExp.mjs`）发现修法 2 的
  //    A 分支会把"注册表指纹"和"readSet 指纹"**同时改成片段指纹**，
  //    于是：
  //
  //      完整读 → 自己改 → 窗口读 → **放行**（正确拒绝被推开了）
  //
  //    而开合取决于"中间有没有 pre-step 重算注册表"——**纯时序运气**。
  //
  // 现在的规则：**片段读一次都不调 markRead**。于是已有的完整读记录
  // 保持原样 → 自己改完没重读时，门禁仍然正确地拒绝。
  //
  // ⚠️ 这是"更严格"而不是"更宽松"：代价是自己写的文档也要整份重读一次。
  //    用户接受这个代价，因为"片段读推开写门禁"更危险。
  const app = boot()
  await app.step()
  await settle()

  app.observe('read', { file_path: app.file }, { isError: false, content: [{ type: 'text', text: readEnvelope(app.file) }] })
  assert.equal(app.guard('标记：原始', '标记：改1'), undefined, '前置：完整读过应放行')

  // 模型自己改盘（**成功**的写 → 记入 selfWritten）
  app.modelWriteOk('改1', '标记：原始', '标记：改1')
  await app.step()
  await settle()

  // ---- 2026-11-15 M2.8：这条前置断言**翻了面** ----
  //
  // 原来断言「自己改完不重读，应当先拒绝」。
  // 用户 2026-11-15 拍板要认 `selfWritten`（第 23 轮 seq 192 / 第 26 轮 seq 127/161
  // 都是"自己刚改完，标状态时被迫整份重读"），所以现在是**放行**。
  //
  // ⚠️ 这条测试真正要守的东西**没变**：`片段读`不能把拒绝推开。
  //    所以下面把场景换成"**外部**改动"——那才是窗口读真正危险的地方
  //    （见文件末尾 `M2.7 收窄的边界：别人改过的文档…` 那条）。
  //
  // 这里保留"自己改完 → 放行"作为**新语义的前置断言**，再验窗口读不会破坏它。
  assert.equal(
    app.guard('标记：改1', '标记：改2'), undefined,
    '自己刚改完再写仍被拒 —— selfWritten 豁免没生效（M2.8 前的旧语义）',
  )

  // ★ 模型只窗口读几行确认格式
  app.observe('read', { file_path: app.file, offset: 1, limit: 12 }, {
    isError: false,
    content: [{ type: 'text', text: readEnvelope(app.file, { offset: 1, limit: 12 }) }],
  })

  // 窗口读之后**仍然放行** —— 但注意：放行的理由是 selfWritten，
  // **不是**"窗口读被当成了整份读"。A 方案的反面证据在下面那条
  // `从中间读到文件末尾也不再算全文`（它测的就是"窗口读不许记成全文"）。
  assert.equal(
    app.guard('标记：改1', '标记：改2'),
    undefined,
    '自己写过的情况下窗口读后反而被拒 —— 说明窗口读把已读记录改坏了',
  )

  // ★ 对照：整份重读之后必须放行（否则门禁变成"永远修不好"）
  app.observe('read', { file_path: app.file }, { isError: false, content: [{ type: 'text', text: readEnvelope(app.file) }] })
  assert.equal(
    app.guard('标记：改1', '标记：改2'),
    undefined,
    '整份重读之后仍然拒绝 —— 门禁变成"永远修不好"了',
  )

  app.cleanup()
})

test('**M2.7 A 方案：从中间读到文件末尾也不再算全文**（缺陷的直接回归）', async () => {
  // 这是 `session-535d7bab` seq 182 的原样形状：
  //   read(offset=55, limit=15) 读到第 67 行（文件末尾），footer 是 End of file。
  //
  // 旧实现：footer 是 End of file → 判成全文 → 记片段指纹。
  // 新实现：首行行号 55 ≠ 1 → 片段读 → **不记账**。
  const app = boot()
  await app.step()
  await settle()

  app.observe('read', { file_path: app.file }, { isError: false, content: [{ type: 'text', text: readEnvelope(app.file) }] })
  app.modelWriteOk('改1', '标记：原始', '标记：改1')
  await app.step()
  await settle()

  // ---- 2026-11-15 M2.8：前置断言翻面（同上面那条的理由）----
  //
  // 旧：`assert.equal(typeof app.guard(...), 'string', '前置：应当需要重读')`
  // 新：自己改完 → selfWritten 豁免 → 放行。
  //
  // ⚠️ 但这条测试的**真正目的**是「从中间读到末尾 ≠ 整份读完」，
  //    那个判据在 `partialReadOf` 里，与 selfWritten 无关。
  //    换句话说：这条测试现在验的是"窗口读**不会**把 selfWritten 记录改坏"，
  //    而"窗口读不许记成全文"由 `partialReadOf` 的单元测试覆盖
  //    （`observe.test.js` 的 `envelope-ignores-start-line` 变异守着它）。
  assert.equal(app.guard('标记：改1', '标记：改2'), undefined, '自己改完应当放行（M2.8 起）')

  // ★ 从第 50 行读到末尾（信封首行是 "50: ..."，footer 是 End of file）
  const all = readFileSync(app.file, 'utf8').split('\n').filter((line, i, a) => !(i === a.length - 1 && line === ''))
  const offset = 50
  const slice = all.slice(offset - 1)
  const envelopeToEof = [
    '<content>',
    slice.map((line, i) => `${offset + i}: ${line}`).join('\n'),
    `(End of file - total ${all.length} lines)`,
    '</content>',
  ].join('\n')
  app.observe('read', { file_path: app.file, offset, limit: 30 }, {
    isError: false,
    content: [{ type: 'text', text: envelopeToEof }],
  })

  // 仍然放行 —— 而且这次放行**必须**还是靠 selfWritten（不是靠窗口读记成了全文）。
  // 若窗口读被误记成全文，`readSet` 会被改成片段指纹，这之后**外部改动**的判据
  // 就会失效 —— 那条由 `M2.7 收窄的边界` 守着。
  assert.equal(
    app.guard('标记：改1', '标记：改2'),
    undefined,
    '从第 50 行读到末尾把已读记录改坏了（片段指纹覆盖了完整读记录）',
  )

  app.cleanup()
})

test('M2.7 收窄的**边界**：别人改过的文档，窗口读仍然不许放行', async () => {
  // 收窄不能把安全语义一起放宽：只放宽"我自己写过的那一份"。
  const app = boot()
  await app.step()
  await settle()

  app.observe('read', { file_path: app.file }, { isError: false, content: [{ type: 'text', text: readEnvelope(app.file) }] })
  assert.equal(app.guard('标记：原始', '标记：改1'), undefined, '前置：完整读过应放行')

  // **外部**改动（没有 observe 成功写 → 不记 selfWritten）
  writeFileSync(app.file, docOf('alpha', '外部改'))
  await app.step()
  await settle()

  app.observe('read', { file_path: app.file, offset: 50, limit: 10 }, {
    isError: false,
    content: [{ type: 'text', text: readEnvelope(app.file, { offset: 50, limit: 10 }) }],
  })

  assert.equal(
    typeof app.guard('标记：外部改', '标记：再改'),
    'string',
    '外部改动的文档靠窗口读就拿到了放行 —— 收窄把安全语义一起放宽了',
  )

  app.cleanup()
})

test('M2.7 收窄的**边界**：写**失败**不能记成"我写过"', async () => {
  // 被门禁拒 / edit 没匹配上，都不代表内容变过。
  // 记了会让模型凭空获得一次豁免 —— 而它实际什么都没改成。
  const app = boot()
  await app.step()
  await settle()

  app.observe('read', { file_path: app.file }, { isError: false, content: [{ type: 'text', text: readEnvelope(app.file) }] })

  // 外部改动 + 一次**失败**的 edit（isError: true）
  writeFileSync(app.file, docOf('alpha', '外部改'))
  app.observe('edit', { file_path: app.file, old_string: 'x', new_string: 'y' },
    { isError: true, content: [{ type: 'text', text: 'Error: old_string matched 3 times' }] })
  await app.step()
  await settle()

  app.observe('read', { file_path: app.file, offset: 50, limit: 10 }, {
    isError: false,
    content: [{ type: 'text', text: readEnvelope(app.file, { offset: 50, limit: 10 }) }],
  })

  assert.equal(
    typeof app.guard('标记：外部改', '标记：再改'),
    'string',
    '失败的写被记成了"我写过"，于是窗口读拿到放行 —— 豁免被凭空扩大',
  )

  app.cleanup()
})

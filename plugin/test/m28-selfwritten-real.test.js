/**
 * M2.8 · **用真实插件装配（`apply`）** 测 `selfWritten`。
 *
 * ---- 为什么必须单独有这个文件 ----
 *
 * `test/m28-fixes.test.js` 的 §1/§5 用的是**假注册表**：
 * 它自己实现 `isSelfWritten: (id) => state.selfWritten && id === 'spec-1'`。
 * 于是"真实实现里 `isSelfWritten` 到底算对没算对"**完全没被覆盖** ——
 * 假的写对了、真的写错了，测试照样全绿。
 *
 * ---- 真事故（第 26 轮 `session-b5657ffd`）----
 *
 * `adapters/registry.js` 的 `isSelfWritten` 里：
 * ```js
 * const current = typeof fingerprintOf === 'function'
 *   ? fingerprintOf(id)            // ← 灾难
 *   : entryById(id)?.fingerprint
 * ```
 * `fingerprintOf` 是本文件顶部 `import { fingerprintOf } from '../docs/fingerprint.js'`
 * 的**纯函数 `fingerprintOf(text)`**，永远 `typeof === 'function'`。
 * 于是它拿**字符串 `"handover-1"` 当正文**算哈希 → 恒定且错误的指纹 →
 * 与 `record.fingerprint` 永远不等 → **豁免静默失效**。
 *
 * 症状：`doc_mark` 连续失败 3 次（seq 127 / 161 / 161），
 * 每次失败后模型整份重读、回来再试、再失败；报错只说"你读过的是旧版"，
 * 模型不可能看出真因。
 *
 * ⇒ 本文件的每一行都在**真装配**上跑：`apply(ctx)` + `tools/result` 事件 +
 *   `agent/pre-step`，与宿主真实时序一致。
 *
 * ⚠️ 第一条必须是**前置断言**（条目在册），否则后面全在测空气
 *    —— 交接 §4.1「探针没激活」那个坑，我在写这个文件时当场又踩了一次：
 *    最初我手工拼 `layout` 调 `createRegistry`，`entryById` 一直是 undefined。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

const settle = (ms = 220) => new Promise((resolve) => setTimeout(resolve, ms))

function makeFs() {
  const norm = (p) => String(p).replaceAll('/', '\\')
  return {
    async resolve(path) { const abs = norm(path); return { targetKey: abs, displayPath: abs } },
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
          .map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }))
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
    tools: {
      guard: (fn) => { guards.push(fn); return () => {} },
      register: () => { throw new Error('本测试不注册工具') },
    },
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
  return [
    '---', `id: ${id}`, `title: ${id} 标题`, 'role: spec', 'order: 10',
    'status: authoritative', `summary: ${id} 摘要`, 'basis: 实测', '---',
    '', `# ${id}`, '', `标记：${marker}`, '',
  ].join('\n')
}

function readEnvelope(file) {
  const all = readFileSync(file, 'utf8').split('\n').filter((line, i, a) => !(i === a.length - 1 && line === ''))
  return ['<content>', all.map((l, i) => `${i + 1}: ${l}`).join('\n'),
    `(End of file - total ${all.length} lines)`, '</content>'].join('\n')
}

/**
 * 造一个**区间读**的信封（footer 是 `Showing lines X-Y of N`）。
 *
 * 这是宿主 `read(offset, limit)` 的真实形状 —— 「累计覆盖」要解析的就是它。
 */
function readEnvelopeRange(file, offset, limit) {
  const all = readFileSync(file, 'utf8').split('\n').filter((line, i, a) => !(i === a.length - 1 && line === ''))
  const slice = all.slice(offset - 1, offset - 1 + limit)
  const last = offset + slice.length - 1
  return ['<content>', slice.map((l, i) => `${offset + i}: ${l}`).join('\n'),
    `(Showing lines ${offset}-${last} of ${all.length})`, '</content>'].join('\n')
}

async function boot() {
  const root = mkdtempSync(join(tmpdir(), 'ddd-m28sr-'))
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
  const guard = (from, to) => ctx.guards[0]({
    name: 'edit',
    arguments: { file_path: file, old_string: from, new_string: to },
    agent: { session },
  })
  const observe = (name, args, result) => {
    for (const handler of ctx.listeners.get('tools/result') ?? []) {
      handler({ name, arguments: args, agent: { session } }, result)
    }
  }
  /** 模拟一次**成功**的写：磁盘改 + 上报 tools/result（→ rescan → noteSelfWrite）。 */
  const selfWrite = (marker) => {
    writeFileSync(file, docOf('alpha', marker))
    observe('edit', { file_path: file, old_string: 'x', new_string: 'y' }, { isError: false, content: [{ type: 'text', text: 'ok' }] })
  }
  /** 模拟外部改动：只改盘，**不**上报（模型不知道）。 */
  const externalWrite = (marker) => { writeFileSync(file, docOf('alpha', marker)) }

  await step()
  await settle()
  return { root, docs, file, step, guard, observe, selfWrite, externalWrite, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('M2.8-真装配 前置：装配激活了（没读过必须被拒）」', async () => {
  const app = await boot()
  const verdict = app.guard('标记：原始', '标记：改1')
  assert.equal(typeof verdict, 'string', '装配没激活 —— 后面所有断言都不可信')
  app.cleanup()
})

test('**M2.8-真装配 自己写完 → 再写同一份必须放行**（第 26 轮那个 bug 的回归）', async () => {
  const app = await boot()

  // ① 完整读 → 可写
  app.observe('read', { file_path: app.file }, { isError: false, content: [{ type: 'text', text: readEnvelope(app.file) }] })
  assert.equal(app.guard('标记：原始', '标记：改1'), undefined, '前置：读过应放行')

  // ② 模型自己写成功（observe 会 rescan + noteSelfWrite）
  app.selfWrite('改1')
  await app.step()
  await settle()

  // ③ 紧接着再改一次 —— 指纹变了，但那是**它自己造成的**
  const verdict = app.guard('标记：改1', '标记：改2')
  assert.equal(
    verdict, undefined,
    '自己刚写完再改仍被要求重读 —— `isSelfWritten` 算错了（很可能拿 `fingerprintOf(text)` 当 `fingerprintOf(id)` 用）',
  )
  app.cleanup()
})

test('**M2.8-真装配 自己写完、别人又改 → 必须被拒**（危险方向）', async () => {
  const app = await boot()

  app.observe('read', { file_path: app.file }, { isError: false, content: [{ type: 'text', text: readEnvelope(app.file) }] })
  app.selfWrite('改1')
  await app.step()
  await settle()

  // 别人改了它（模型没看见）
  app.externalWrite('别人改的')
  await app.step()
  await settle()

  const verdict = app.guard('标记：别人改的', '标记：再改')
  assert.equal(
    typeof verdict, 'string',
    '外部改动后仍放行 —— 模型会拿没看过的内容当依据去改（这是"改错"，不是"慢"）',
  )
  app.cleanup()
})

// ---- 2026-11-15 M2.8：这条断言**翻面**（用户拍板 Q2「要放宽」）----
//
// 原来叫「自己写过但从未读过 → 仍必须被拒（写过 ≠ 读过）」。
//
// 那个前提**在真实装配里不可能成立**：
//   · 写成功必须过门禁；
//   · 门禁要求"读过"；
//   ⇒ "写过但从没读过"只可能来自**外部创建**的文件（别人放进 docs/ 的）。
//
// 而外部创建的文件本来就没有 `selfWritten` 记录，所以它走的是
// 「外部改动 → 必须被拒」那条路径（上面第 3 条测试覆盖）。
//
// Q2 的语义：**写成功本身就证明了模型与磁盘一致** ——
// `edit` 的 `old_string` 必须逐字匹配才会成功（`core/roles.js` 的 APPEND_ONLY
// 判据就建立在这个事实上）。所以写完之后更新 readSet 是**诚实的**，不是偷懒。
//
// ⚠️ 真正要守的边界改由下面两条守：
//   1. **外部创建（从未写过、也从未读过）→ 必须被拒**；
//   2. **自己写过之后又被别人改 → 必须被拒**（上一条测试）。
test('**M2.8-真装配 自己写完 = 读过**（写成功证明与磁盘一致，用户拍板 Q2）', async () => {
  const app = await boot()
  // 刻意不 observe('read')：模拟"模型直接 doc_new 建了它，然后马上改"
  //
  // ⚠️ 注意：这个 `selfWrite` 会播放一次 `tools/result` 成功事件，
  // 等价于"一次成功的写"。真实里它必须先过门禁 —— 而门禁要求读过。
  // 所以这条测试模拟的是 `doc_new` 那种"建完即已读"的路径。
  app.selfWrite('改1')
  await app.step()
  await settle()

  const verdict = app.guard('标记：改1', '标记：改2')
  assert.equal(
    verdict, undefined,
    '自己刚写完的文件仍被要求重读 —— Q2 的"写成功即已读"没生效',
  )
  app.cleanup()
})

test('**M2.8-真装配 外部创建、从未读过的文档 → 必须被拒**（Q2 不放宽这条）', async () => {
  const app = await boot()
  // 直接放一份新文件进去（**不**经过 observe，所以既没有 readSet 也没有 selfWritten）
  const fresh = join(app.docs, 'fresh.md')
  writeFileSync(fresh, docOf('fresh', '外部创建'))
  await app.step()
  await settle()

  const verdict = app.guard('标记：外部创建', '标记：再改')
  assert.equal(
    typeof verdict, 'string',
    '外部创建的文件没被拦 —— Q2 把"必须先读"也放宽了（危险方向）',
  )
  app.cleanup()
})

// ---------------------------------------------------------------- §Q2 片段读累计覆盖

/**
 * 用户 2026-11-15 拍板：片段读改为**累计覆盖**。
 *
 * 原来（M2.7 A 方案）片段读**完全不记账** —— 安全，但"分两段读完"永远不算读过。
 * 实测代价（第 26 轮 `session-b5657ffd` seq 133/156）：AI 用 `read(offset=66)` 读了
 * 交接尾部，内容它确实看到了，但 `edit` 仍被拒 → 整份重读一次，白花一步。
 *
 * ⚠️ 安全性来自：**只有真的覆盖全文才算读过**，而且写的是磁盘全文的真实指纹，
 *    不是片段指纹（后者正是旧实现最危险的地方）。
 */
test('**M2.8-真装配 分两段读完 → 算读过**（片段读累计覆盖）', async () => {
  const app = await boot()
  const total = readFileSync(app.file, 'utf8').split('\n').filter((l, i, a) => !(i === a.length - 1 && l === '')).length
  const half = Math.floor(total / 2)

  // 先读前一半
  app.observe('read', { file_path: app.file, offset: 1, limit: half }, {
    isError: false,
    content: [{ type: 'text', text: readEnvelopeRange(app.file, 1, half) }],
  })
  // 此时还没覆盖完 → 仍应被拒
  assert.equal(
    typeof app.guard('标记：原始', '标记：改1'), 'string',
    '只读了半份就放行了 —— 累计覆盖判错了（危险方向）',
  )

  // 再读剩下的
  app.observe('read', { file_path: app.file, offset: half + 1, limit: total }, {
    isError: false,
    content: [{ type: 'text', text: readEnvelopeRange(app.file, half + 1, total - half) }],
  })
  assert.equal(
    app.guard('标记：原始', '标记：改1'), undefined,
    '两段合起来已覆盖全文，却仍被拒 —— 累计覆盖没生效（第 26 轮白读的那个坑）',
  )
  app.cleanup()
})

test('**M2.8-真装配 文件改过之后，之前读的区间不算数**（累计必须按版本）', async () => {
  const app = await boot()
  const total = readFileSync(app.file, 'utf8').split('\n').filter((l, i, a) => !(i === a.length - 1 && l === '')).length
  const half = Math.floor(total / 2)

  // 读前半
  app.observe('read', { file_path: app.file, offset: 1, limit: half }, {
    isError: false,
    content: [{ type: 'text', text: readEnvelopeRange(app.file, 1, half) }],
  })

  // 别人改了文件（版本变了）
  writeFileSync(app.file, docOf('alpha', '外部改'))
  await app.step()
  await settle()

  // 再读后半 —— 前后两段属于**不同版本**，不许拼起来算读过
  app.observe('read', { file_path: app.file, offset: half + 1, limit: total }, {
    isError: false,
    content: [{ type: 'text', text: readEnvelopeRange(app.file, half + 1, total - half) }],
  })
  assert.equal(
    typeof app.guard('标记：外部改', '标记：改2'), 'string',
    '跨版本的两段被拼成"读过" —— 模型没看过外部改动后的内容却拿到写权限',
  )
  app.cleanup()
})

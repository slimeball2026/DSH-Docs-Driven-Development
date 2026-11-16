/**
 * 4 个 M1 工具的单测。
 *
 * 这一组的重点是**拒绝路径**：只测成功路径等于没测门禁
 * （架构评审 §5 的原话，也是 M1-C 的立身之本）。
 *
 * 所以每个写工具都有「该拒的时候真的拒」的断言，
 * 每个工具都有「schema 能被宿主无损序列化」的断言（v0.3.4 回归）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createNewTool, deriveId, handoverIndexHintOf, nextOrder, renderDocText, sandboxPolicyOf } from '../tools/doc-new.js'
import { createMarkTool, markBlock, appendMarkBlock } from '../tools/doc-mark.js'
import { createHandoverCheckTool, pickHandover } from '../tools/doc-handover-check.js'
import { createHealthTool } from '../tools/doc-health.js'
import { createToolGate, safeWhen, assertToolAllowed } from '../tools/when.js'
import { resolveConfig } from '../config.js'
import { assertLosslessJson, assertNoUndefined } from '../testutil/fake.js'

/** 插件根目录（静态断言要读源码）。 */
const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 读源码并**剥掉注释**（注释里故意引用了旧写法，不该让断言误红）。 */
function codeOf(path) {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const FP = 'abcdef123456'

/** 造一份交接正文（合格）。 */
const GOOD_HANDOVER = `# 交接

## 1. 我的意图

把交接变成可校验的产物。

## 2. 现在到哪了

| 切片 | 状态 |
|---|---|
| M0 | 完成 |

## 3. 下一刀

- 改 \`core/render.js\` 的 fitBudget

## 4. 坑

| # | 坑 |
|---|---|
| 1 | when 抛错 |

## 5. 验收

- M1-1 seq=2468 通过

## 6. 刻意没做

- 没做 UI

## 7. 仍未决

无
`

/**
 * 造一个假注册表 + 假 fs，够工具跑。
 * @param {object} [options]
 * @returns {object}
 */
function fakeWorld(options = {}) {
  const files = new Map(options.files ?? [])
  const entries = options.entries ?? []
  const reads = new Map()
  const warnings = []

  const registry = {
    state: options.state ?? 'ready',
    entries,
    index: { required: options.required ?? [], forbidden: [], anomalies: [] },
    readSetFor: () => reads,
    readSet: reads,
    entryById: (id) => entries.find((entry) => entry?.meta?.id === id),
    entryByPath: (path) => entries.find((entry) => entry?.path === path),
    fingerprintOf: (id) => entries.find((entry) => entry?.meta?.id === id)?.fingerprint,
    markRead: (absPath, session, seq, text) => {
      const entry = entries.find((item) => item.path === absPath)
      if (entry === undefined) return false
      reads.set(entry.meta.id, { fingerprint: FP, text })
      return true
    },
    rescan: async () => {
      options.onRescan?.()
    },
  }

  const fs = {
    resolve: async (path) => ({ targetKey: path, displayPath: path }),
    writeText: async (target, content) => {
      files.set(target.targetKey, content)
      return { operation: 'update' }
    },
    readText: async (target) => files.get(target.targetKey),
  }

  return { files, entries, reads, registry, fs, warnings }
}

/** 造一个条目：`text` 是**带合法 frontmatter 的整份文档**，`body` 是正文。 */
function entry(id, meta = {}, extra = {}) {
  const body = extra.body ?? extra.text ?? `# ${id}\n`
  const fullMeta = {
    id,
    title: `${id} 标题`,
    role: 'spec',
    order: 20,
    status: 'authoritative',
    summary: `${id} 摘要`,
    basis: '实测',
    ...meta,
  }
  // 整份文档：frontmatter + 正文。doc_mark 改的就是它。
  const lines = ['---']
  for (const [key, value] of Object.entries(fullMeta)) {
    if (value === undefined || value === null) continue
    lines.push(`${key}: ${Array.isArray(value) ? JSON.stringify(value) : value}`)
  }
  lines.push('---', '', body)
  const text = extra.text ?? lines.join('\n')

  return {
    path: extra.path ?? `C:/proj/docs/${id}.md`,
    body,
    text,
    fingerprint: extra.fingerprint ?? FP,
    meta: fullMeta,
    hasError: false,
    ...extra,
    // 上面展开的 extra 可能带自己的 text/body，最后一律以算好的为准（除显式传入的 text）
    body: extra.body ?? body,
    text,
    meta: { ...fullMeta, ...(extra.meta ?? {}) },
  }
}

/** 工具执行上下文。 */
function execOf(session = {}) {
  return { agent: { session }, seq: 100 }
}

const CONFIG = resolveConfig({})

// ---------------------------------------------------------------- 0. schema 形状（全部工具）

test('**4 个工具的定义都是宿主可无损序列化的 JSON**（v0.3.4 回归）', () => {
  const world = fakeWorld()
  const tools = [
    createNewTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, projectRoot: () => 'C:/proj', cwdOf: () => 'C:/proj' }),
    createMarkTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, readRecordOf: () => undefined }),
    createHandoverCheckTool({ config: CONFIG, registry: () => world.registry }),
    createHealthTool({ config: CONFIG, registry: () => world.registry }),
  ]
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['doc_handover_check', 'doc_health', 'doc_mark', 'doc_new'])

  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string', `${tool.name} 缺 description`)
    assert.ok(tool.description.trim() !== '', `${tool.name} description 是空的`)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    // 这两块会被宿主快照进 request/header，一个 undefined 就整轮失败。
    assertNoUndefined(tool.parameters, `${tool.name}.parameters`)
    assertNoUndefined(tool.output.schema, `${tool.name}.output.schema`)
    assertLosslessJson({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: { schema: tool.output.schema },
    }, tool.name)
  }
})

test('**必填参数被提升到父级 required**（模型漏传就会在执行前被宿主拦住）', () => {
  const world = fakeWorld()
  const tool = createNewTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, projectRoot: () => 'C:/proj' })
  assert.deepEqual([...tool.parameters.required].sort(), ['role', 'summary', 'title'])
})

// ---------------------------------------------------------------- 1. doc_new

test('doc_new：建一份文档，写入 docs/<id>.md，且 frontmatter 合法', async () => {
  const world = fakeWorld({ entries: [] })
  const tool = createNewTool({
    config: CONFIG,
    registry: () => world.registry,
    fs: world.fs,
    projectRoot: () => 'C:/proj',
  })
  const value = await tool.execute({ role: 'spec', title: 'spec-m1', summary: '一份规格' }, execOf())
  assert.equal(value.id, 'spec-m1')
  assert.equal(value.path, 'docs/spec-m1.md')
  assert.equal(value.status, 'draft')
  assert.equal(value.order, 10)

  const written = [...world.files.values()][0]
  assert.match(written, /^---\n/)
  assert.match(written, /\nid: spec-m1\n/)
  assert.match(written, /\nstatus: draft\n/)
  assert.match(written, /\nbasis: 未验证\n/)
})

test('**doc_new：id 冲突 → 拒绝，且不写文件**（M1-3）', async () => {
  const world = fakeWorld({ entries: [entry('taken')] })
  const tool = createNewTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, projectRoot: () => 'C:/proj' })
  await assert.rejects(
    () => tool.execute({ role: 'spec', title: 'x', summary: 'y', id: 'taken' }, execOf()),
    /已被占用/,
  )
  assert.equal(world.files.size, 0, '被拒之后仍然写了文件')
})

test('**doc_new：中文标题派生不出 id → 报错要求显式给 id**（不猜不编号）', async () => {
  const world = fakeWorld()
  const tool = createNewTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, projectRoot: () => 'C:/proj' })
  await assert.rejects(
    () => tool.execute({ role: 'spec', title: '交接给下一位施工者', summary: 'y' }, execOf()),
    /显式传 `id`/,
  )
})

test('doc_new：order 自动取「当前最大 + 10」', async () => {
  const world = fakeWorld({ entries: [entry('a', { order: 50 })] })
  const tool = createNewTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, projectRoot: () => 'C:/proj' })
  const value = await tool.execute({ role: 'spec', title: 'b', summary: 'y', id: 'b' }, execOf())
  assert.equal(value.order, 60)
})

test('**doc_new：必须触发 rescan**（D2 回归：不扫就是新文档永不被发现）', async () => {
  let rescanned = 0
  const world = fakeWorld({ onRescan: () => { rescanned += 1 } })
  const tool = createNewTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, projectRoot: () => 'C:/proj' })
  await tool.execute({ role: 'spec', title: 'x', summary: 'y', id: 'x' }, execOf())
  assert.equal(rescanned, 1, '没有触发 rescan')
})

test('doc_new：把新文档记进本会话 readSet（用**注册表自己的路径**，不是拼出来的）', async () => {
  // 实机 bug 回归：原来传的是 `${root}/${rel.replaceAll('/','\\')}`，
  // 结果是 `...\docs\handover-m1.md` 混用 `/` 与 `\`，而扫描器给的是全 `\`，
  // 于是 entryByPath 永远匹配不上 → doc_new 之后 doc_mark 永远报"没读过"。
  const files = new Map()
  const entries = []
  const reads = new Map()
  const warnings = []

  const registry = {
    state: 'ready',
    get entries() { return entries },
    index: { required: [], forbidden: [], anomalies: [] },
    readSetFor: () => reads,
    readSet: reads,
    entryById: (id) => entries.find((entry) => entry.meta.id === id),
    entryByPath: (path) => entries.find((entry) => entry.path === path),
    fingerprintOf: (id) => entries.find((entry) => entry.meta.id === id)?.fingerprint,
    markRead: (absPath, _session, _seq, text) => {
      const entry = entries.find((item) => item.path === absPath)
      if (entry === undefined) return false
      reads.set(entry.meta.id, { fingerprint: entry.fingerprint, text })
      return true
    },
    // rescan 模拟真实扫描器：路径是**全反斜杠**的绝对路径（与本实现拼出来的不同）
    rescan: async () => {
      for (const [path, content] of files) {
        if (entries.some((entry) => entry.path === path)) continue
        const id = /\nid: (\S+)\n/.exec(content)?.[1]
        if (id === undefined) continue
        entries.push({ path, text: content, body: content, meta: { id, status: 'draft', role: 'spec', order: 30 }, fingerprint: FP })
      }
    },
  }
  const fs = {
    // 后端把路径规范化成全反斜杠
    resolve: async (path) => ({ targetKey: path, displayPath: path.replaceAll('/', '\\') }),
    writeText: async (target, content) => { files.set(target.targetKey.replaceAll('/', '\\'), content) },
    readText: async (target) => files.get(target.targetKey),
  }

  const tool = createNewTool({
    config: CONFIG,
    registry: () => registry,
    fs,
    projectRoot: () => 'C:/proj',
  })
  const value = await tool.execute({ role: 'spec', title: 'x', summary: 'y', id: 'x' }, execOf())

  assert.equal(value.indexed, true, 'rescan 之后没入册')
  assert.equal(value.recorded, true, '**doc_new 之后没能记进 readSet**（doc_mark 会被误拒）')
  assert.equal(reads.has('x'), true)
  assert.deepEqual(warnings, [])
})

test('doc_new：output schema 里有 recorded 字段且是必填', () => {
  const world = fakeWorld()
  const tool = createNewTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, projectRoot: () => 'C:/proj' })
  assert.ok(tool.output.schema.properties.recorded !== undefined)
  assert.ok(tool.output.schema.required.includes('recorded'))
})

// ---- 实机 bug 1：不传 sandboxPolicy 会 file access denied

test('**doc_new：写盘时必须把沙箱 policy 传下去**（实机踩到的 bug）', async () => {
  // `dsh-fs-sandbox.writeText(target, content, expected, signal, sandboxPolicy)` 是**按每次调用**围栏的。
  // 不传 policy 就用默认 workspace root（= 会话建立时的 cwd），
  // 于是「切进另一个 DDD 项目后 doc_new」会得到 file access denied —— 而路径其实在工作区内。
  const calls = []
  const world = fakeWorld()
  const wrappedFs = {
    resolve: async (path, opts) => ({ targetKey: path, displayPath: path }),
    writeText: async (target, content, expected, signal, policy) => {
      calls.push({ target, content, expected, signal, policy })
      return { operation: 'create' }
    },
  }
  const tool = createNewTool({
    config: CONFIG,
    registry: () => world.registry,
    fs: wrappedFs,
    projectRoot: () => 'C:/proj',
  })
  await tool.execute({ role: 'spec', title: 'x', summary: 'y', id: 'x' }, execOf())

  assert.equal(calls.length, 1)
  const { policy } = calls[0]
  assert.ok(policy !== undefined && policy !== null, '**没有传 sandboxPolicy** —— 实机就会 file access denied')
  assert.equal(policy.workspaceRoot, 'C:/proj', 'workspaceRoot 必须是本次的目标项目根')
  assert.ok(['read-only', 'workspace-write', 'danger-full-access'].includes(policy.mode))
})

test('sandboxPolicyOf：拿不到会话模式时回落到 workspace-write（**绝不放宽**成 danger-full-access）', () => {
  for (const exec of [undefined, null, {}, { agent: null }, { agent: { session: { header: {} } } }]) {
    assert.deepEqual(sandboxPolicyOf(exec), { mode: 'workspace-write' })
  }
  // 显式给了就照给
  assert.deepEqual(sandboxPolicyOf({ agent: { session: { header: { sandboxMode: 'read-only' } } } }), { mode: 'read-only' })
  assert.deepEqual(
    sandboxPolicyOf({ agent: { session: { header: { sandboxMode: 'danger-full-access' } } } }),
    { mode: 'danger-full-access' },
  )
  // 非法值也回落
  assert.deepEqual(sandboxPolicyOf({ agent: { session: { header: { sandboxMode: 'nonsense' } } } }), { mode: 'workspace-write' })
})

test('doc_new：记账失败时**如实报告**（不谎称"已记入"）', async () => {
  const world = fakeWorld({ entries: [] })
  // 让 rescan 什么都不做 → entryById 找不到 → recorded=false
  world.registry.rescan = async () => {}
  const tool = createNewTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, projectRoot: () => 'C:/proj' })
  const value = await tool.execute({ role: 'spec', title: 'x', summary: 'y', id: 'x' }, execOf())
  assert.equal(value.recorded, false)
  const rendered = tool.output.render({}, value)[0].text
  assert.match(rendered, /没能记入/)
  assert.doesNotMatch(rendered, /可以直接 doc_mark/)
})

// ---- 2026-11-14 M2.5：记账成功时的文案也**不许承诺"可以直接"**（摩擦台账 F3）----
//
// 真缺陷（session-10f26ffe seq 222/225）：`doc_new` 说「可以直接 doc_mark」，
// 而紧接着 `doc_mark` 就被拒 —— 因为 check 触发的 supersedes 回填改了指纹。
// AI 当时猜了三个原因才猜对。
//
// 修法不是"让 doc_mark 一定通过"（那是门禁，铁律 7），而是**不许撒这个谎**。

test('**M2.5：doc_new 记账成功时不许说"可以直接 doc_mark"**（它可能是错的）', async () => {
  // ⚠️ 要造出 `recorded === true`，`rescan` 必须**真的把新条目放进 entries** ——
  // 否则 `entryById` 找不到它，记账必然失败（第一版夹具就是这样，断言恒假）。
  const world = fakeWorld({ entries: [] })
  world.registry.rescan = async () => {
    // `doc_new` 先写文件、再 rescan；这里模拟"扫描把刚写的那份收进来"。
    for (const [path, text] of world.files) {
      if (world.entries.some((each) => each.path === path)) continue
      const id = /id:\s*([a-z0-9-]+)/i.exec(text)?.[1]
      if (id !== undefined) {
        world.entries.push({ path, meta: { id, role: 'spec', status: 'draft' }, fingerprint: FP, text })
      }
    }
  }

  const tool = createNewTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, projectRoot: () => 'C:/proj' })
  const value = await tool.execute({ role: 'spec', title: 'x', summary: 'y', id: 'x' }, execOf())
  assert.equal(value.recorded, true, '夹具没造出 recorded=true 的情形')

  const rendered = tool.output.render({}, value)[0].text
  assert.doesNotMatch(
    rendered,
    /可以直接 doc_mark/,
    '又承诺"可以直接 doc_mark"了 —— 若有别的工具改过该文件，这句就是假的（摩擦台账 F3）',
  )
  // 但"已记入"这个事实**必须**说（否则 AI 以为完全没记）。
  assert.match(rendered, /已记入本会话的已读集合/)
  // 并且必须**明确可能失效的原因**，不能只说"可能失败"让 AI 去猜。
  assert.match(rendered, /失效|重读/, '没有提示"可能失效"')
})

test('doc_new：role / status / basis 枚举校验', async () => {
  const world = fakeWorld()
  const tool = createNewTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, projectRoot: () => 'C:/proj' })
  await assert.rejects(() => tool.execute({ role: 'nope', title: 'x', summary: 'y' }, execOf()), /role 不合法/)
  await assert.rejects(() => tool.execute({ role: 'spec', title: 'x', summary: 'y', status: 'nope' }, execOf()), /status 不合法/)
  await assert.rejects(() => tool.execute({ role: 'spec', title: 'x', summary: 'y', basis: 'nope' }, execOf()), /basis 不合法/)
})

test('doc_new：status=partial 必须给 scope', async () => {
  const world = fakeWorld()
  const tool = createNewTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, projectRoot: () => 'C:/proj' })
  await assert.rejects(
    () => tool.execute({ role: 'spec', title: 'x', summary: 'y', status: 'partial' }, execOf()),
    /必须给 scope/,
  )
})

test('deriveId / nextOrder / renderDocText 是纯函数且可用于单测', () => {
  assert.equal(deriveId('My Spec v2'), 'my-spec-v2')
  assert.equal(deriveId('交接给下一位'), '')
  assert.equal(nextOrder([]), 10)
  assert.equal(nextOrder([entry('a', { order: 30 })]), 40)
  const text = renderDocText({ id: 'a', title: 'A', role: 'spec', order: 10, status: 'draft', summary: 's', basis: '未验证' })
  assert.match(text, /^---\n/)
  assert.match(text, /\n# A\n/)
})

// ---------------------------------------------------------------- 2. doc_mark（重点：拒绝路径）

test('**doc_mark：改 sealed 但没给 reason → 拒绝**（M1-4）', async () => {
  const world = fakeWorld({ entries: [entry('a')] })
  const tool = createMarkTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, readRecordOf: () => ({ fingerprint: FP }) })
  await assert.rejects(() => tool.execute({ id: 'a', status: 'sealed' }, execOf()), /必须给 reason/)
})

test('**doc_mark：改 void 但没给 reason → 拒绝**', async () => {
  const world = fakeWorld({ entries: [entry('a')] })
  const tool = createMarkTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, readRecordOf: () => ({ fingerprint: FP }) })
  await assert.rejects(() => tool.execute({ id: 'a', status: 'void' }, execOf()), /必须给 reason/)
})

test('**doc_mark：改 superseded 但没给 supersededBy → 拒绝**', async () => {
  const world = fakeWorld({ entries: [entry('a')] })
  const tool = createMarkTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, readRecordOf: () => ({ fingerprint: FP }) })
  await assert.rejects(() => tool.execute({ id: 'a', status: 'superseded' }, execOf()), /必须给 supersededBy/)
})

test('**doc_mark：没读过 → 拒绝**（改状态也是改语义，不能走后门）', async () => {
  const world = fakeWorld({ entries: [entry('a')] })
  const tool = createMarkTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, readRecordOf: () => undefined })
  await assert.rejects(() => tool.execute({ id: 'a', status: 'draft' }, execOf()), /必须先读它/)
})

test('**doc_mark：读的是旧版 → 拒绝，并指出两个指纹**', async () => {
  const world = fakeWorld({ entries: [entry('a', {}, { fingerprint: 'newnewnewnew' })] })
  const tool = createMarkTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, readRecordOf: () => ({ fingerprint: 'oldoldoldold' }) })
  await assert.rejects(() => tool.execute({ id: 'a', status: 'draft' }, execOf()), /磁盘已是 vnewnew/)
})

// ---- 2026-11-15 M2.7：交接标绿**不再校验**（用户拍板，硬门禁降级成提示词层）----
//
// 用户原话：
// > 交接文档本身的结构必须要保证或近似，但我认为它**可以只是提示词层面的东西**，
// > 不必完全一致。
//
// 改动前这里是 `assert.rejects(/交接不合格/)` —— 断言的是「不合格就拒绝落盘」。
// 现在**行为被有意反转**：结构引导保留在 `doc_new` 的提示里，
// 但没有任何 `if` 会因为"交接写得不够好"而拒绝落盘。
//
// ⚠️ 这不是"测试没跟上"，是**用户明确改变了设计**。两条测试一起改，
//    并写清为什么 —— 免得下一个看到 diff 的人以为是有人手滑删掉了门禁。

test('**M2.7：交接不合格也允许标 authoritative**（硬门禁已降级为提示词层）', async () => {
  const bad = entry('handover-x', { role: 'handover', status: 'draft' }, { body: '## 1. 我的意图\n甲\n\n## 3. 下一刀\n\n- 继续做下一步\n' })
  const world = fakeWorld({ entries: [bad] })
  const tool = createMarkTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, readRecordOf: () => ({ fingerprint: FP }) })

  const value = await tool.execute({ id: 'handover-x', status: 'authoritative' }, execOf())
  assert.equal(value.id, 'handover-x', '缺段交接被拒了 —— 硬门禁没被真正降级')
  assert.ok(value.changed.includes('status'))
})

test('**M2.8 §7 建交接时自动把它登记进 `read-order` 的必读清单**（拆循环依赖）', async () => {
  // 用户 2026-11-15 拍板「1 要修」。
  //
  // 要解决的循环依赖：交接必须出现在索引必读清单里，但索引正文又要在交接落笔前定稿。
  // 第 24 轮 AI 为此在 turn 3 第一步烧掉 10 879 字符纯推演（自我否决 6 个方案）。
  //
  // ⇒ `doc_new` 是**唯一知道新 id 的那一刻**，由它顺手登记。
  const indexText = [
    '---', 'id: read-order', 'title: 入口索引', 'role: index', 'order: 0',
    'status: authoritative', 'summary: 入口', 'basis: 实测', '---', '',
    '# 入口索引', '',
    '## 必读清单', '',
    '按 `order` 升序：', '',
    '1. `spec-1`（order 10，spec）—— 唯一的 spec。',
    '',
    '## 下一步', '',
    '- 建交接。',
    '',
  ].join('\n')

  const world = fakeWorld({
    entries: [
      entry('read-order', { role: 'index', order: 0 }, { text: indexText, body: indexText }),
    ],
  })
  // 让 rescan 不覆盖我们塞进去的条目
  world.registry.rescan = async () => {}

  const tool = createNewTool({
    config: CONFIG,
    registry: () => world.registry,
    fs: world.fs,
    projectRoot: () => 'C:/proj',
    cwdOf: () => 'C:/proj',
  })

  const value = await tool.execute(
    { role: 'handover', title: '本轮交接', summary: '交接摘要', id: 'handover-1', body: '# 交接\n' },
    execOf(),
  )

  assert.equal(typeof value.indexRegistered, 'boolean', '返回值缺 indexRegistered（render 要读它）')
  assert.equal(value.indexRegistered, true, `没能自动登记：${value.indexRegistrationReason}`)

  // 索引文件真的被改了
  const written = world.files.get('C:/proj/docs/read-order.md')
  assert.ok(typeof written === 'string', '索引文件没被写回')
  assert.match(written, /`handover-1`/, '交接没进必读清单')
  assert.match(written, /1\. `handover-1`/, '交接没排到第一条（它 order 最小）')
  assert.match(written, /2\. `spec-1`/, '原第一条没被 +1')
  // 其它小节不许动
  assert.match(written, /## 下一步\n\n- 建交接。/, '其它小节被改坏了')
})

/**
 * 第 27 轮 `session-6bd267f1` 反馈 P0 第一条（**端到端**，看的是渲染出来的回执）。
 *
 * 缺陷：AI 严格照顺序先定稿 read-order（清单写 3 条）→ `doc_health` 全过
 * → 才 `doc_new` 建交接 → 工具自动插成 4 条 → 交接正文里的「3 条」**当场过期**。
 *
 * AI 原话：
 * > 这不是「把没做的事写成做了」，那种错还能自查；
 * > 这是**你核对过的状态在核对之后被工具改掉了**，
 * > 而手册的顺序规则里没有这一步的位置。
 *
 * ⇒ 工具既然改了别人的文件，就有义务**在回执里说清改成了什么**。
 *
 * ⚠️ 这条必须测**渲染输出**，不能只测 `registerHandoverInIndex` 的返回值 ——
 *    我第一版只测了纯函数，于是变异 `docnew-hides-index-count-change`
 *    （把 `indexCountBefore` 写死成 0）**存活**了：纯函数回传对了，
 *    但 `doc_new` 根本没把它渲染给模型看。
 */
test('**M2.8 §9 建交接的回执必须说出「必读清单从 N 条变成 M 条」**', async () => {
  const indexText = [
    '---', 'id: read-order', 'title: 入口索引', 'role: index', 'order: 0',
    'status: authoritative', 'summary: 入口', 'basis: 实测', '---', '',
    '# 入口索引', '',
    '## 必读清单', '',
    '按 `order` 升序：', '',
    '1. `spec-1`（order 10，spec）—— 甲。',
    '',
    '## 下一步', '', '- 建交接。', '',
  ].join('\n')

  const world = fakeWorld({
    entries: [entry('read-order', { role: 'index', order: 0 }, { text: indexText, body: indexText })],
  })
  world.registry.rescan = async () => {}

  const tool = createNewTool({
    config: CONFIG, registry: () => world.registry, fs: world.fs,
    projectRoot: () => 'C:/proj', cwdOf: () => 'C:/proj',
  })
  const value = await tool.execute(
    { role: 'handover', title: '本轮交接', summary: '交接摘要', id: 'handover-1', body: '# 交接\n' },
    execOf(),
  )

  // ① 返回值带上了条数（1 → 2）
  assert.equal(value.indexCountBefore, 1, '没回传"改之前有几条"')
  assert.equal(value.indexCountAfter, 2, '没回传"改之后有几条"')

  // ② 渲染出来的回执里**明确说了这件事**（这才是模型真正看到的）
  const rendered = tool.output.render(
    { role: 'handover' }, value,
  )[0].text
  assert.match(
    rendered, /1 条变成了 2 条|必读清单从/,
    '回执里没说清单条数变了 —— 模型不会知道它手写的「N 条」已经过期',
  )
  assert.match(rendered, /计数/, '没提醒"这类计数现在过期了"')
})

test('**M2.8 §7 建非交接文档时**不许碰索引**', async () => {
  const indexText = '---\nid: read-order\nrole: index\norder: 0\nstatus: authoritative\nsummary: s\nbasis: 实测\n---\n\n## 必读清单\n\n1. `a` —— 甲。\n'
  const world = fakeWorld({
    entries: [entry('read-order', { role: 'index', order: 0 }, { text: indexText, body: indexText })],
  })
  world.registry.rescan = async () => {}
  const tool = createNewTool({
    config: CONFIG, registry: () => world.registry, fs: world.fs,
    projectRoot: () => 'C:/proj', cwdOf: () => 'C:/proj',
  })

  const value = await tool.execute(
    { role: 'spec', title: '新规格', summary: '甲', id: 'spec-9', body: '# 规格\n' },
    execOf(),
  )
  assert.equal(value.indexRegistered, false, '规格文档不该触发索引登记')
  assert.equal(world.files.get('C:/proj/docs/read-order.md'), undefined, '索引被不该动的人动了')
})

// ---------------------------------------------------------------- M2.9：登记回执要分流

/**
 * 2026-11-16 用户拍板「顺手做」。
 *
 * ---- 缺陷现场（第 32 轮 `session-1fe6505f` seq 74）----
 *
 * AI 先在 `read-order` 里手写了一条 `handover-1`，再建交接。工具看到那个 id
 * 已经在清单里，按设计**不覆盖模型写的措辞**，于是返回：
 *
 * ```
 * ⚠️ 没能把本份交接自动登记进入口索引（必读清单里已经有 `handover-1`，不覆盖模型写的措辞）。
 * **你需要在交接里如实说明**，或者自己 `edit` 索引补一行 —— 别写"已登记"。
 * ```
 *
 * **第二句是错的**：清单里那条已经在，不需要再补。
 * 但 AI 看到的字面意思是"没登记上"，它会去 `edit` 补 —— 要么写重复，要么怀疑自己。
 *
 * ⚠️ 这正是 M2.8 第 30 轮修过的「回执与事实不符」的**同一个病**
 * （那次是 `doc_mark` 说"已标绿"但 H-6 说又改了）。**修一处不等于修一类。**
 */
test('**M2.9 「清单里已经有」必须报成「不是失败」**（不能让人去补一行）', () => {
  const hint = handoverIndexHintOf('必读清单里已经有 `handover-1`，不覆盖模型写的措辞', -10)

  assert.match(hint, /不是失败/, '把成功报成了失败 —— AI 会去补一行，变成两条讲同一份交接的条目')
  assert.match(hint, /不需要再 `edit` 补一行/, '没明确说"别补"，AI 会按字面去补')
  // 必须带上实际 order 供对账（第 32 轮就是这里猜错成 0）
  assert.match(hint, /`-10`/, '没给出本份交接的实际 order，AI 无法对账')
})

test('M2.9 「清单里已经有」的对账提示要点明**顺序死锁**与出路', () => {
  const hint = handoverIndexHintOf('必读清单里已经有 `handover-1`', -10)
  // 根因（清单要写交接的 order，而 order 建完才知道）要说出来，
  // 否则 AI 只会觉得"我又算错了"。
  assert.match(hint, /顺序死锁|建完才知道/, '没说清为什么会猜错 —— AI 会以为是自己粗心')
  // 两条出路：别写数字 / 建之前显式传 order（用户拍板方案 A）
  assert.match(hint, /别写数字|显式传 `order`/, '没给出路，AI 下次还会猜')
})

test('M2.9 **真失败**（没有 index 文档）时不能误报成"不是失败"', () => {
  // 两种 reason 性质完全不同，分流不能反过来。
  const hint = handoverIndexHintOf('项目里没有 role: index 的文档', -10)
  assert.equal(hint, '', '真失败被说成"不是失败" —— AI 会以为不用管')
})

test('M2.9 坏输入一律不抛（这个函数在回执路径上，抛错会毁掉整个 doc_new 的返回）', () => {
  assert.doesNotThrow(() => handoverIndexHintOf(undefined))
  assert.doesNotThrow(() => handoverIndexHintOf(null))
  assert.doesNotThrow(() => handoverIndexHintOf('必修清单里已经有 x'))
  assert.equal(handoverIndexHintOf(''), '')
})

/**
 * 端到端：**撞上"清单里已经有"这个分支时，`doc_new` 的渲染里必须出现那句"不是失败"**。
 *
 * 为什么必须端到端再测一遍：上面三条只测了纯函数 `handoverIndexHintOf`。
 * 而 M2.8 第 26 轮的真事故就是"纯函数写对了、接线却把参数传反了"
 * （`fingerprintOf(text)` 当 `fingerprintOf(id)` 用）——
 * 纯函数全绿，上线后照样炸。所以接线必须单独断言。
 */
test('**M2.9 接线：手写了交接条目 → 渲染里出现「不是失败」**', async () => {
  // 索引正文里**已经**有一条 `handover-1`（模拟第 32 轮 AI 先手写的情形）。
  const indexText = [
    '---', 'id: read-order', 'title: 入口索引', 'role: index', 'order: 0',
    'status: authoritative', 'summary: 入口', 'basis: 实测', '---', '',
    '# 入口索引', '',
    '## 必读清单', '',
    '1. `handover-1`（order -10）—— 先读这份。',
    '2. `spec-1`（order 10）—— 施工图。',
    '',
  ].join('\n')

  const world = fakeWorld({
    entries: [
      entry('read-order', { role: 'index', order: 0 }, { text: indexText, body: indexText }),
    ],
  })
  world.registry.rescan = async () => {}

  const tool = createNewTool({
    config: CONFIG, registry: () => world.registry, fs: world.fs,
    projectRoot: () => 'C:/proj', cwdOf: () => 'C:/proj',
  })
  const value = await tool.execute(
    { role: 'handover', title: '本轮交接', summary: '甲', id: 'handover-1', body: '# 交接\n' },
    execOf(),
  )

  // 前置：确实走到了"已经有"这条分支（没登记，但原因是"已经有"）
  assert.equal(value.indexRegistered, false, '前置：手写已存在时不该再登记')
  assert.match(value.indexRegistrationReason, /已经有/, '前置：原因应当是"已经有"')

  const rendered = tool.output.render({}, value).map((item) => item.text ?? '').join('\n')
  assert.match(
    rendered, /不是失败/,
    '渲染里没出现"不是失败" —— 纯函数改对了但接线没接上（或参数传反了）',
  )
  assert.doesNotMatch(
    rendered, /你需要在交接里如实说明/,
    '还在劝人"如实说明/自己补一行" —— 而清单里那条已经在',
  )
})

test('**M2.8 §7 项目里没有 `role: index` 文档 → 不报错，只如实说没登记**', async () => {
  const world = fakeWorld({ entries: [] })
  world.registry.rescan = async () => {}
  const tool = createNewTool({
    config: CONFIG, registry: () => world.registry, fs: world.fs,
    projectRoot: () => 'C:/proj', cwdOf: () => 'C:/proj',
  })
  const value = await tool.execute(
    { role: 'handover', title: '交接', summary: '甲', id: 'handover-1', body: '# 交接\n' },
    execOf(),
  )
  assert.equal(value.indexRegistered, false)
  assert.ok(value.indexRegistrationReason.length > 0, '没登记却不说原因 —— AI 又要去猜')
})

test('**M2.8 §14 建交接不传 id、标题只有中文+数字 → 必须报错并提示传 id**', async () => {
  // 第 30 轮 `session-84b1e3ea` 翻车现场：
  //   doc_new 没传 id，title="交接：全流程测试30"
  //   → deriveId 把中文全丢掉只剩 "30" → ID_RE 接受纯数字 → 建出 docs/30.md
  //   → AI 发现不对，又建 handover-1、把 30 标 void、再修索引（多花 4 步）
  const world = fakeWorld({ entries: [] })
  world.registry.rescan = async () => {}
  const tool = createNewTool({
    config: CONFIG, registry: () => world.registry, fs: world.fs,
    projectRoot: () => 'C:/proj', cwdOf: () => 'C:/proj',
  })
  await assert.rejects(
    () => tool.execute(
      { role: 'handover', title: '交接：全流程测试30', summary: '甲', body: '# 交接\n' },
      execOf(),
    ),
    /请显式传 `id`/,
    '没拦住纯数字派生 —— 会建出 id 为 "30" 的交接',
  )
})

test('**M2.9 压缩后的报错文案仍然给出可照抄的出路**（§7 第 1 项）', async () => {
  // 用户拍板「顺手做」：第 31 轮那次报错 200+ 字，但它确实让 AI **一步就改对了**。
  // ⇒ 压缩的是**论证**（"纯数字 id 不接受"那段是设计依据，对模型没用），
  //   不是那条能照抄的出路。这条测试钉住"出路还在"。
  const world = fakeWorld({ entries: [] })
  world.registry.rescan = async () => {}
  const tool = createNewTool({
    config: CONFIG, registry: () => world.registry, fs: world.fs,
    projectRoot: () => 'C:/proj', cwdOf: () => 'C:/proj',
  })
  let message = ''
  await assert.rejects(
    () => tool.execute({ role: 'handover', title: '交接：全流程测试30', summary: '甲', body: '# 交接\n' }, execOf()),
    (error) => { message = error.message; return true },
  )
  // ① 必须给出能照抄的 id 样例（第 31 轮就是靠它一步改对的）
  assert.match(message, /handover-m1/, '样例没了 —— AI 会去猜 id 该长什么样')
  // ② 必须点名这次捡到了什么（否则它以为是"标题太短"）
  assert.match(message, /30/, '没说捡到了什么，AI 无法判断自己哪里写错')
  // ③ 压缩的验收：**不能再带那套设计论证**
  assert.doesNotMatch(message, /YAML 会把/, '设计论证没压掉（这段对模型没用）')
  assert.ok(message.length < 130, `文案还不够短：${message.length} 字符`)
})

test('M2.8 §14 显式传纯数字 id **仍然允许**（那是明确要求，不是猜的）', async () => {
  // 收紧只在"派生"这条路上：派生是工具的猜测，猜错该拒绝；
  // 显式传 id 是明确要求，不该拦。
  const world = fakeWorld({ entries: [] })
  world.registry.rescan = async () => {}
  const tool = createNewTool({
    config: CONFIG, registry: () => world.registry, fs: world.fs,
    projectRoot: () => 'C:/proj', cwdOf: () => 'C:/proj',
  })
  const value = await tool.execute(
    { role: 'spec', title: '随便', summary: '甲', id: '30', body: '# 甲\n' },
    execOf(),
  )
  assert.equal(value.id, '30', '显式给的纯数字 id 被拒了 —— 收得过头')
})

test('**M2.8 §15 supersede 反填后必须重新记账**（否则下次 doc_mark 莫名要求重读）', async () => {
  // 第 30 轮 `session-84b1e3ea` 现场：
  //   seq 135 doc_new 建 handover-1 ✅（回执说"已记入本会话的已读集合"）
  //   seq 152 doc_mark 把误生成的 30 标 void ✅
  //   seq 168 doc_mark handover-1 ❌ 「你读过的是旧版（v24b7de），磁盘已是 va60b3e」
  // 而 seq 135→168 之间**没有任何工具碰过 handover-1**。
  //
  // 根因：`doc_new` 的记账顺序是 ①markRead → ②rescan → ③markRead(fresh) → ④supersede。
  // ④ 的反填**又写了一次 handover-1**（写进 `supersedes: ["30"]`），指纹从 B 变 C，
  // 而 ③ 记的是 B → 门禁认为"你读过的是旧版"。
  //
  // ⇒ 所以 `doc_new` 那句"已记入本会话的已读集合"在当时就是**假话**。
  const indexText = '---\nid: read-order\nrole: index\norder: 0\nstatus: authoritative\nsummary: s\nbasis: 实测\n---\n\n## 必读清单\n\n1. `a` —— 甲。\n'
  // 一份**旧的 authoritative 交接**（会被自动 supersede → 触发反填）
  const oldHandover = '---\nid: old-h\nrole: handover\norder: -10\nstatus: authoritative\nsummary: 旧\nbasis: 实测\n---\n\n# 旧交接\n'
  const world = fakeWorld({
    entries: [
      entry('read-order', { role: 'index', order: 0 }, { text: indexText, body: indexText }),
      entry('old-h', { role: 'handover', order: -10 }, { text: oldHandover, body: oldHandover }),
    ],
  })
  world.registry.rescan = async () => {}

  const markReadCalls = []
  const realMarkRead = world.registry.markRead
  world.registry.markRead = (...args) => {
    markReadCalls.push(args[0])
    return typeof realMarkRead === 'function' ? realMarkRead(...args) : true
  }
  // ⚠️ 桩必须让 `rescan` 把**新建的文档**收进 entries —— 否则 `entryById('handover-1')`
  //    永远返回 undefined，我加的那段"supersede 后重新记账"就被静默跳过了。
  //    真实注册表在 rescan 后会收录新文件，这里要模拟同一件事。
  world.registry.rescan = async () => {
    if (!world.registry.entries.some((e) => e?.meta?.id === 'handover-1')) {
      const text = world.files.get('C:/proj/docs/handover-1.md') ?? '# 交接\n'
      world.registry.entries.push(entry('handover-1', { role: 'handover', order: -20 }, { text, body: text }))
    }
  }

  const tool = createNewTool({
    config: CONFIG, registry: () => world.registry, fs: world.fs,
    projectRoot: () => 'C:/proj', cwdOf: () => 'C:/proj',
  })
  const value = await tool.execute(
    { role: 'handover', title: '交接', summary: '甲', id: 'handover-1', body: '# 交接\n' },
    execOf(),
  )

  assert.ok(
    Array.isArray(value.supersededOld) && value.supersededOld.includes('old-h'),
    '前置：应当真的取代了旧交接（否则反填不会发生，这条测试在测空气）',
  )
  // 记账次数必须 ≥ 3：①写后、③rescan 后、④反填后
  const selfRecords = markReadCalls.filter((p) => String(p).includes('handover-1'))
  assert.ok(
    selfRecords.length >= 3,
    `supersede 反填后没有重新记账（只记了 ${selfRecords.length} 次）——`
      + '下次 doc_mark 会莫名要求整份重读',
  )
})

test('**M2.8 §15 建交接的提示必须说「工具插的那行要留着」**（否则 H-3 会报）', async () => {
  // 第 30 轮：AI 把上一轮的「别给交接留位置」读成"清单里不要出现交接"，
  // 于是它 edit 时把工具自动登记的那一行 handover-1 **一起删掉了**。
  // 结果 doc_health 的 H-3 报「没有任何 index 文档提到它」。
  //
  // AI 的原话：
  // > 工具承诺和健康检查不一致。这花了我 2 次调用。
  //
  // 它判断错了原因（不是工具不一致），但现象是真的 —— 根因是我那句话有歧义。
  const indexText = '---\nid: read-order\nrole: index\norder: 0\nstatus: authoritative\nsummary: s\nbasis: 实测\n---\n\n## 必读清单\n\n1. `a` —— 甲。\n'
  const world = fakeWorld({
    entries: [entry('read-order', { role: 'index', order: 0 }, { text: indexText, body: indexText })],
  })
  world.registry.rescan = async () => {}
  const tool = createNewTool({
    config: CONFIG, registry: () => world.registry, fs: world.fs,
    projectRoot: () => 'C:/proj', cwdOf: () => 'C:/proj',
  })
  const value = await tool.execute(
    { role: 'handover', title: '交接', summary: '甲', id: 'handover-1', body: '# 交接\n' },
    execOf(),
  )
  const rendered = tool.output.render({ role: 'handover' }, value)[0].text

  assert.match(
    rendered, /必须留着/,
    '没告诉模型"工具插的那行要留着" —— 它会把那行删掉，H-3 立刻报',
  )
  assert.match(rendered, /H-3/, '没说清后果（H-3 会报"没有任何 index 文档提到它"）')
})

test('**M2.8 §13 建交接的提示必须说「别手写交接条目」**（否则会重复）', async () => {
  // 第 29 轮 `session-dd0e36b5` 现场：
  //   seq 65  AI 手写 read-order 清单，第 3 条写「最新交接（role: handover，order 最小）」
  //   seq 71  doc_new 自动插入 `handover-1` 作为第 1 条
  //   → 清单里**两条都在讲交接**（一条泛指、一条具体），AI 只好重读 + 再改一遍
  //
  // AI 的原话：
  // > 这条铁律在这个点上自相矛盾：建交接本身就是对索引的写入，
  // > 所以「落笔前索引已定稿」永远不可能成立。
  //
  // ⇒ 光说"会自动登记"不够，必须明确告诉它**别自己写这一条**。
  // ⚠️ 必须有 `role: index` 文档，否则走的是"没能自动登记"那条分支，
  //    回执里那一段根本不会出现 —— 我第一版就是漏了这个，测试红得对。
  const indexText = '---\nid: read-order\nrole: index\norder: 0\nstatus: authoritative\nsummary: s\nbasis: 实测\n---\n\n## 必读清单\n\n1. `a` —— 甲。\n'
  const world = fakeWorld({
    entries: [entry('read-order', { role: 'index', order: 0 }, { text: indexText, body: indexText })],
  })
  world.registry.rescan = async () => {}
  const tool = createNewTool({
    config: CONFIG, registry: () => world.registry, fs: world.fs,
    projectRoot: () => 'C:/proj', cwdOf: () => 'C:/proj',
  })
  const value = await tool.execute(
    { role: 'handover', title: '交接', summary: '甲', id: 'handover-1', body: '# 交接\n' },
    execOf(),
  )
  const rendered = tool.output.render({ role: 'handover' }, value)[0].text

  assert.match(
    rendered, /别给交接留位置/,
    '没告诉模型"别手写交接条目" —— 它会手写一条泛指、工具再插一条具体，变成两条',
  )
  assert.match(
    rendered, /两条/,
    '没说清后果（会出现两条讲交接的条目）—— 模型不会理解为什么要这样',
  )

  // ⚠️ 这条测试**红过一次，红得对**：我第一版只断言 `/别给交接留位置|泛指条目/`，
  //    而 ⓪ 前置那段里也有「别写『最新交接（role: handover）』这种泛指条目」——
  //    于是变异（删掉回执那一段）仍然能通过。
  //
  //    ⇒ 必须断言**两段各自都在**：
  //      ① ⓪ 前置（建交接**之前**写的索引才看得到它）；
  //      ② 回执（建完之后解释"刚才发生了什么"）。
  //    两处的读者时机不同，缺一个都会漏掉一半场景。
  assert.match(rendered, /"⓪ 前置"有一条例外/, '⓪ 前置那段没提这条例外')
})

test('**M2.8 §11 `doc_handover_check({body})` 能在 `doc_new` 之前预检正文**', async () => {
  // 第 28 轮 `session-2bc68acd` 反馈。AI 把它叫「自指悖论」并如实承认：
  // > §5 里那条「`doc_handover_check` 复检 `7/7 通过`」，我是**先写进正文、后跑校验**的。
  // > 它最后确实通过了，但写下那一刻它还不是事实。
  //
  // **但这其实不是悖论，是缺一个入口。** `checkHandover` 是纯函数，
  // 对一段还没落盘的文本就能直接算 —— 实测（`_m28/selfref.mjs`）确认。
  //
  // ⇒ 给 `body` 参数：先验草稿，再 `doc_new` 定稿。§5 的话从"写下那一刻是假的"
  //   变成"写下之前已经验过"。
  const world = fakeWorld({ entries: [] })
  const tool = createHandoverCheckTool({ config: CONFIG, registry: () => world.registry })

  const goodBody = [
    '## 1. 我的意图', '- 甲。',
    '## 2. 现在到哪了', '- 乙。',
    '## 3. 下一刀', '- 改 `ddd-bundle/core/gate.js`。',
    '## 4. 坑', '- 丙。',
    '## 5. 验收', '- `3/3 通过`。',
    '## 6. 刻意没做', '- 丁。',
    '## 7. 仍未决', '- 戊。',
  ].join('\n')

  const value = await tool.execute({ body: goodBody }, execOf())

  // ① 形状与正式路径一致（schema 是 required 的，少键就整个调用被拒）
  assert.equal(typeof value.ok, 'boolean')
  assert.ok(Array.isArray(value.errors))
  assert.ok(Array.isArray(value.warnings))
  assert.equal(value.sections.length, 7, 'sections 必须仍然是 7 条')
  assert.equal(value.stats.sectionsFound, 7, '七段应当都找到')
  assert.equal(value.kind, undefined) // 不引入 schema 外的键

  // ② 它真的在验内容（H4 会抓形状不对的证据）
  const badBody = goodBody.replace('- `3/3 通过`。', '- 都验过了，没有问题。')
  const bad = await tool.execute({ body: badBody }, execOf())
  assert.ok(
    bad.warnings.some((item) => item.rule === 'H4'),
    '预检没有发现 §5 的证据形状问题 —— 那它就白加了',
  )
})

test('M2.8 §11 预检**不看磁盘**（项目里没有交接也能用）', async () => {
  const world = fakeWorld({ entries: [] }) // 一份文档都没有
  const tool = createHandoverCheckTool({ config: CONFIG, registry: () => world.registry })
  const body = ['## 1. 我的意图', 'x', '## 2. 现在到哪了', 'x', '## 3. 下一刀', 'x',
    '## 4. 坑', 'x', '## 5. 验收', 'x', '## 6. 刻意没做', 'x', '## 7. 仍未决', 'x'].join('\n')
  // 不抛 = 预检不依赖磁盘
  const value = await tool.execute({ body }, execOf())
  assert.equal(typeof value.ok, 'boolean')
})

test('**M2.7：结构引导仍然在 `doc_new` 的提示里**（降级 ≠ 删掉）', async () => {
  // 这条守的是"降级"而不是"删除"：判定不再拦，但**该怎么做**必须还在说。
  // 否则就是"为了省步数把要求也一起丢了"。
  const world = fakeWorld({ entries: [] })
  world.registry.rescan = async () => {}
  const tool = createNewTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, projectRoot: () => 'C:/proj' })
  const value = await tool.execute(
    { role: 'handover', title: 'h', summary: 's', id: 'h1', body: '# 交接\n' },
    execOf(),
  )
  const rendered = tool.output.render({}, value)[0].text
  // 七段结构、下一刀、验收 —— 三件事至少都要被提到
  assert.match(rendered, /§3|下一刀|下一步/, '没提 §3（下一刀）—— 下个会话不知道要干什么')
  assert.match(rendered, /§5|验收/, '没提 §5（验收）—— 交接失去可核对性')
  assert.match(rendered, /七段|七|段/, '没提结构要求')
})

test('**M2.8 §4 建交接的提示里不许再叫人打草稿**（edit 已放开，绕法失去理由）', async () => {
  // 用户 2026-11-15：
  // > ai 现在大概不用自己在临时文件区给交接文档打草稿，因为那是 edit 交接文档
  // > 还有限制的时候，施工者往 skill 里写的对策提示词。
  //
  // 那条对策的**前提已经消失**：`core/roles.js` 现在是
  // `handover: { write: DENY, edit: ALLOW }` —— 写错了直接原地改就行。
  //
  // 实测它只剩成本（第 24 轮 `session-5b5f5c68`）：
  // AI 在 seq 61 计划「Let me draft in `_artifacts/handover-draft.md` first」，
  // **全会话 `_artifacts` 写入 0 次** —— 提示没产生草稿，只产生了一次犹豫。
  const world = fakeWorld({ entries: [] })
  world.registry.rescan = async () => {}
  const tool = createNewTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, projectRoot: () => 'C:/proj' })
  const value = await tool.execute(
    { role: 'handover', title: 'h', summary: 's', id: 'h1', body: '# 交接\n' },
    execOf(),
  )
  const rendered = tool.output.render({}, value)[0].text

  assert.doesNotMatch(
    rendered,
    /handover-draft|打草稿|先在 `_artifacts\/`/,
    '还在叫人去 _artifacts 打草稿 —— 那是 edit 交接被锁死时代的对策，现在只剩成本',
  )
  // ---- 但结构自查必须留下 ----
  //
  // ⚠️ 我第一版把整段删了，被**本文件上面那条**
  // 「M2.7：结构引导仍然在 doc_new 的提示里」抓住 —— 因为"七段齐全"
  // 是那段里唯一提到"七段"的地方。整段删 = 把要求也一起丢了。
  assert.match(rendered, /七段/, '连结构清单也删了 —— 这是过头（"为了省步数把要求一起丢了"）')
  assert.match(rendered, /原地 `edit`/, '没说清"写错了怎么办"—— 模型会去重写整份新的')
})

test('**M2.7：交接提示必须以「三步」开头**（用户 2026-11-15 定义的总纲）', async () => {
  // 用户原话：
  // > 交接流程应该是这样的，只有 3 步：1. 写交接文档 2. 给文档标置信度 3. 重排阅读顺序
  //
  // 之前 7 段交接提示散落在返回值各处、**没有总纲**，
  // 实测（第 20/21 轮）AI 要靠自己拼顺序，拼错就多花 6~10 步。
  const world = fakeWorld({ entries: [] })
  world.registry.rescan = async () => {}
  const tool = createNewTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, projectRoot: () => 'C:/proj' })
  const value = await tool.execute(
    { role: 'handover', title: 'h', summary: 's', id: 'h1', body: '# 交接\n' },
    execOf(),
  )
  const rendered = tool.output.render({}, value)[0].text

  assert.match(rendered, /交接只有三步/, '没有三步总纲 —— AI 又得自己拼顺序')
  assert.match(rendered, /1\.\s*\*\*写交接文档\*\*/, '第 1 步缺失或措辞不符')
  assert.match(rendered, /2\.\s*\*\*给文档标置信度\*\*/, '第 2 步缺失或措辞不符')
  assert.match(rendered, /3\.\s*\*\*重排阅读顺序\*\*/, '第 3 步缺失或措辞不符')

  // ---- 2026-11-16 M2.9：**这条断言原来是反的，已实测证伪** ----
  //
  // 原文断言：
  //   assert.match(rendered, /第 3 步在第 2 步\*\*之后\*\*/,
  //     '没说清 2→3 的顺序 —— 又会先改 read-order 再标绿')
  //
  // 它守的是提示里那句话：
  //   > ⚠️ 第 3 步在第 2 步**之后**：标完置信度再动 `read-order`，
  //   > 否则标绿那一刻引用的内容已经过时（H-6 会报）。
  //
  // **实测证明这句和这条断言都错了**（`_m28/probe-order-conflict.mjs`，
  // 真 `apply()` 装配，两个顺序各跑一遍）：
  //
  //   顺序 A（先改 read-order → 写交接 → 标绿）：H-6 = **0 条**
  //   顺序 B（写交接 → 标绿 → 再改 read-order）：H-6 = **1 条**
  //     · `handover-1` 标成 authoritative 之后，这些文档改过：
  //       `read-order`：标绿时 9537a6，现在 ce3576
  //
  // 原因：**H-6 的定义就是"标绿之后改过的文档"**。
  // 所以"标绿后再改 read-order"必然触发它 —— 原句把因果说反了，
  // 而这条测试**在钉住那个反因果**，等于保证它不被修正。
  //
  // 这正是"测试可以钉住错误行为"的实例：测试红了不代表代码错，
  // 也可能是**测试本身在守一个已被证伪的假设**。
  assert.match(
    rendered, /第 3 步在第 2 步\*\*之前\*\*/,
    '没说清 2→3 的顺序 —— 标绿后再改索引必然触发 H-6（实测 1 条）',
  )
  assert.doesNotMatch(
    rendered, /第 3 步在第 2 步\*\*之后\*\*/,
    '又回到了"标绿之后再改索引"的旧说法 —— 那是 H-6 的成因，不是它的解药',
  )

  // ---- 2026-11-15 M2.7（#3）：**⓪ 前置** ----
  //
  // 依据（`session-535d7bab` AI 自述，它自己列为"最难"）：
  // > 我先 `doc_new` 建了 `handover-1`，正文里写「read-order 的必读清单已登记…」
  // > ——**但那时我还没改 read-order**。`doc_handover_check` 照样给 7/7 通过，
  // > 因为它只查七段结构，不查内容真假。
  //
  // 核实属实（seq 130 建交接 → seq 135 才改 read-order）。
  // 上一版的三步总纲只说了"第 3 步在第 2 步之后"，
  // **没说第 1 步（写交接）也必须在所有引用定稿之后** —— 这就是缺口。
  assert.match(rendered, /⓪\s*前置/, '没有"前置"这一步 —— AI 会先建交接再补引用，然后被迫重读')
  assert.match(rendered, /所有要引用的东西/, '没说清前置要定稿什么')
  assert.match(rendered, /变成假话/, '没说清顺序反了的具体后果（交接说假话）')

  // 必须说明"不校验"，否则 AI 会以为还有门禁在等它
  assert.match(rendered, /不校验/, '没说"这三步不校验" —— AI 会反复自查')
})

test('M2.7：**非交接文档不该有**三步总纲', async () => {
  const world = fakeWorld({ entries: [] })
  world.registry.rescan = async () => {}
  const tool = createNewTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, projectRoot: () => 'C:/proj' })
  const value = await tool.execute({ role: 'spec', title: 's', summary: 's', id: 's1' }, execOf())
  const rendered = tool.output.render({}, value)[0].text
  assert.doesNotMatch(rendered, /交接只有三步/, 'spec 文档不该收到交接专属提示')
})

test('doc_mark：合格的交接 → 允许标 authoritative（行为不变）', async () => {
  const good = entry('handover-ok', { role: 'handover', status: 'draft', order: 0 }, { body: GOOD_HANDOVER })
  const world = fakeWorld({ entries: [good] })
  const tool = createMarkTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, readRecordOf: () => ({ fingerprint: FP }) })
  const value = await tool.execute({ id: 'handover-ok', status: 'authoritative' }, execOf())
  assert.equal(value.id, 'handover-ok')
  assert.ok(value.changed.includes('status'))
})

test('doc_mark：sealed 带 reason → 成功，正文出现可追溯标记块（M1-5）', async () => {
  const world = fakeWorld({ entries: [entry('a')] })
  const tool = createMarkTool({
    config: CONFIG,
    registry: () => world.registry,
    fs: world.fs,
    readRecordOf: () => ({ fingerprint: FP }),
    now: () => '2026-11-11',
  })
  const value = await tool.execute({ id: 'a', status: 'sealed', reason: '已被第 3 版推翻' }, execOf())
  assert.equal(value.marked, true)
  const written = [...world.files.values()][0]
  assert.match(written, /<!-- ddd:mark 2026-11-11 status=sealed reason="已被第 3 版推翻" -->/)
  // 标记块在最后，正文其余部分没被动
  assert.ok(written.trimEnd().endsWith('-->'))
})

test('**doc_mark：正文一个字节都不变**（除了追加的标记块）', async () => {
  const body = '# 标题\n\n正文里有 status: draft 这样的字样。\n'
  const original = `---\nid: a\nstatus: draft\n---\n\n${body}`
  const world = fakeWorld({ entries: [entry('a', { status: 'draft' }, { body, text: original })] })
  const tool = createMarkTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, readRecordOf: () => ({ fingerprint: FP }) })
  await tool.execute({ id: 'a', status: 'authoritative' }, execOf())
  const written = [...world.files.values()][0]
  assert.ok(written.includes(body.trimEnd()), '正文被改动了')
  assert.match(written, /\nstatus: authoritative\n/)
})

test('doc_mark：段落级状态被序列化成结构化 sections（M1-6）', async () => {
  const world = fakeWorld({ entries: [entry('a')] })
  const tool = createMarkTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, readRecordOf: () => ({ fingerprint: FP }) })
  const value = await tool.execute({ id: 'a', anchor: '#7', sectionStatus: 'authoritative', reason: '这一节已复核' }, execOf())
  assert.deepEqual(value.added, ['sections'])
  const written = [...world.files.values()][0]
  assert.match(written, /sections: \[\{"anchor":"#7","status":"authoritative","reason":"这一节已复核"\}\]/)
})

test('doc_mark：anchor 与 sectionStatus 必须成对出现', async () => {
  const world = fakeWorld({ entries: [entry('a')] })
  const tool = createMarkTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, readRecordOf: () => ({ fingerprint: FP }) })
  await assert.rejects(() => tool.execute({ id: 'a', anchor: '#7' }, execOf()), /必须同时给 sectionStatus/)
  await assert.rejects(() => tool.execute({ id: 'a', sectionStatus: 'draft' }, execOf()), /必须同时给 anchor/)
})

test('doc_mark：什么都不给 → 拒绝', async () => {
  const world = fakeWorld({ entries: [entry('a')] })
  const tool = createMarkTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, readRecordOf: () => ({ fingerprint: FP }) })
  await assert.rejects(() => tool.execute({ id: 'a' }, execOf()), /至少要给/)
})

test('markBlock / appendMarkBlock 保持行尾风格', () => {
  assert.equal(markBlock({ status: 'sealed', reason: 'x', at: '2026-11-11' }), '<!-- ddd:mark 2026-11-11 status=sealed reason="x" -->')
  assert.equal(markBlock({}), '')
  const lf = appendMarkBlock('a\n', '<!-- x -->')
  assert.equal(lf, 'a\n\n<!-- x -->\n')
  const crlf = appendMarkBlock('a\r\n', '<!-- x -->')
  assert.equal(crlf, 'a\r\n\r\n<!-- x -->\r\n')
})

// ---- A3 自查（2026-11-11）：三条绕过门禁的路径

// ---- 2026-11-15 M2.7：这条测试的**前提已经不存在** ----
//
// 它原本守的是「`handoverCheckStrict: false` 也不能关掉落盘硬门禁」。
// 而现在硬门禁本身被用户要求删掉了（见上一条测试的长注释），
// 所以"能不能被配置关掉"这个问题不再有意义 —— **没有门禁可关**。
//
// ⚠️ 我**没有**把它改成 `assert.doesNotReject` 然后留着：
//    那会变成一条"测什么都没意义"的恒真测试。
//    改成断言"配置项仍然存在且被正确解析"—— 那件事仍然是真的，
//    而且将来谁想恢复硬门禁，会先看到这条。
test('M2.7：`handoverCheckStrict` 配置项仍然存在（硬门禁已移除，但配置契约没破）', () => {
  assert.equal(resolveConfig({}).handoverCheckStrict, true, '默认值变了 —— 会静默影响所有项目')
  assert.equal(resolveConfig({ handoverCheckStrict: false }).handoverCheckStrict, false)
})

test('**reason 里的 `-->` 不能逃出 HTML 注释**（注入）', async () => {
  const world = fakeWorld({ entries: [entry('a')] })
  const tool = createMarkTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, readRecordOf: () => ({ fingerprint: FP }) })
  await tool.execute({ id: 'a', status: 'sealed', reason: 'x --> 这句跑到注释外面去了' }, execOf())
  const written = [...world.files.values()][0]
  // 关键：整份文件里 `-->` 只出现在标记块自己那一处
  const block = written.split('\n').find((line) => line.includes('ddd:mark'))
  assert.ok(block !== undefined, '没有标记块')
  assert.equal(block.trimEnd().endsWith('-->'), true)
  assert.equal(block.split('-->').length - 1, 1, `标记块里出现了多个 -->：${block}`)
  assert.ok(block.includes('-- >'), '没有把 --> 消毒')
})

test('**evidence 类文档不能用 doc_mark 改状态**（不能从这里绕过 roles.js）', async () => {
  const world = fakeWorld({ entries: [entry('ev', { role: 'evidence' })] })
  const tool = createMarkTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, readRecordOf: () => ({ fingerprint: FP }) })
  await assert.rejects(
    () => tool.execute({ id: 'ev', status: 'draft' }, execOf()),
    /evidence/,
  )
  assert.equal(world.files.size, 0, '被拒之后仍然写了文件')
})

// ---------------------------------------------------------------- 3. doc_handover_check

test('doc_handover_check：合格的交接 → ok:true（M1-7）', async () => {
  const world = fakeWorld({ entries: [entry('h', { role: 'handover', status: 'authoritative', order: 0 }, { body: GOOD_HANDOVER })] })
  const tool = createHandoverCheckTool({ config: CONFIG, registry: () => world.registry })
  const value = await tool.execute({}, execOf())
  assert.equal(value.ok, true, JSON.stringify(value.errors))
  assert.equal(value.id, 'h')
  assert.equal(value.stats.sectionsFound, 7)
})

// ---- 2026-11-14 M2.6：交接了但**阅读顺序没跟着改**（H10，warn）----
//
// 实测（`session-524e5041` turn 9 → 10）：AI 建完交接、归档旧交接、跑完 doc_health，
// **始终没碰 read-order**，用户不得不提醒「你还得把阅读顺序修改了」。
//
// 用户 2026-11-14：这类事要**在犯错之前就告诉它**（已加在 doc_new 的文案里），
// **再加个 warn 保底**（就是这条）。
//
// ⚠️ 两个分支都要测：会报**和**不报。
// 一个永远报的 warn 会被模型学会无视（本项目 D9 批评过的形态）。

// ---- 2026-11-14 M2.6：H10 **已被删除**（它自己制造了死锁）----
//
// 历史（三行看完）：
//   1. 用户报「交接时漏改阅读顺序」→ 我加了 H10：入口索引 order 不比交接小就 warn。
//   2. 用户报「交接死锁」（`session-e951840c`）→ 查明 H10 **永远满足不了**：
//      `doc_new` 建交接的 order 永远取「最小 handover order − 10」，所以交接 order
//      每轮都在变小，而 H10 要求 read-order 比它更小 —— 双方无限后退。
//      实测：read-order 从 0 → -30 → -40 → -60，H10 **每次都报**。
//   3. 用户拍板：删掉它，换更稳的判据。
//
// ⇒ 下面这条测试**翻面了**：从"必须报警"改成"**不许**报警"。
//   判据要跟着修复一起翻面，否则测试会一直替旧行为背书（本项目 M2.5 已记过这条）。

test('**M2.6：H10 已删除 —— 入口索引 order 比交接大也**不许**再报警**', async () => {
  const world = fakeWorld({
    entries: [
      entry('h', { role: 'handover', status: 'authoritative', order: -90 }, { body: GOOD_HANDOVER }),
      entry('read-order', { role: 'index', status: 'authoritative', order: 0 }),
    ],
  })
  const tool = createHandoverCheckTool({ config: CONFIG, registry: () => world.registry })
  const value = await tool.execute({}, execOf())
  const h10 = value.warnings.filter((item) => item.rule === 'H10')
  assert.equal(
    h10.length, 0,
    'H10 又回来了 —— 它要求 read-order 的 order 严格小于交接，'
    + '而交接 order 每轮都在变小，所以它永远满足不了（无限后退）。'
    + '详见 `tools/doc-handover-check.js` 里那段删除说明。',
  )
})

// （H10 的另两条测试已随判据一起删除 —— 见上面那条翻面的测试。）

test('**doc_handover_check：缺 §3 → errors 点名（M1-9）**', async () => {
  const body = GOOD_HANDOVER.replace(/## 3\. 下一刀[\s\S]*?(?=## 4\. )/, '')
  const world = fakeWorld({ entries: [entry('h', { role: 'handover', order: 0 }, { body })] })
  const tool = createHandoverCheckTool({ config: CONFIG, registry: () => world.registry })
  const value = await tool.execute({}, execOf())
  assert.equal(value.ok, false)
  assert.ok(value.errors.some((item) => item.rule === 'H1' && item.message.includes('§3')))
})

test('**doc_handover_check：§3 只有空话 → errors（M1-10）**', async () => {
  const body = GOOD_HANDOVER.replace('- 改 `core/render.js` 的 fitBudget', '- 继续做下一步')
  const world = fakeWorld({ entries: [entry('h', { role: 'handover', order: 0 }, { body })] })
  const tool = createHandoverCheckTool({ config: CONFIG, registry: () => world.registry })
  const value = await tool.execute({}, execOf())
  assert.equal(value.ok, false)
  assert.ok(value.errors.some((item) => item.rule === 'H3'))
})

test('**doc_handover_check：§5 没有证据 → warn（M2.6 起不再阻断，M1-11 翻面）**', async () => {
  const body = GOOD_HANDOVER.replace('- M1-1 seq=2468 通过', '- M1-1 看起来没问题')
  const world = fakeWorld({ entries: [entry('h', { role: 'handover', order: 0 }, { body })] })
  const tool = createHandoverCheckTool({ config: CONFIG, registry: () => world.registry })
  const value = await tool.execute({}, execOf())
  // 降级后：交接仍然合格（ok=true），但**必须**给出 H4 提示。
  assert.equal(value.ok, true, 'H4 不该再阻断交接')
  assert.ok(
    value.warnings.some((item) => item.rule === 'H4'),
    'H4 提示消失了 —— 降级不等于静默',
  )
  assert.equal(value.errors.filter((item) => item.rule === 'H4').length, 0)
})

test('**doc_handover_check：两份 authoritative → warn 且点名（M1-12）**', async () => {
  const world = fakeWorld({
    entries: [
      entry('h1', { role: 'handover', status: 'authoritative', order: 0 }, { body: GOOD_HANDOVER }),
      entry('h2', { role: 'handover', status: 'authoritative', order: 10 }, { body: GOOD_HANDOVER }),
    ],
  })
  const tool = createHandoverCheckTool({ config: CONFIG, registry: () => world.registry })
  const value = await tool.execute({ id: 'h1' }, execOf())
  assert.equal(value.ok, true)
  const h6 = value.warnings.find((item) => item.rule === 'H6')
  assert.ok(h6 !== undefined)
  assert.ok(h6.message.includes('h1') && h6.message.includes('h2'))
})

test('doc_handover_check：不填 id → 优先 authoritative（不是取 order 最小的旧交接）', () => {
  const entries = [
    entry('old', { role: 'handover', status: 'superseded', order: 20, supersededBy: ['new'] }),
    entry('new', { role: 'handover', status: 'authoritative', order: 140 }),
    entry('idx', { role: 'index', order: 10 }),
  ]
  const picked = pickHandover(entries)
  assert.equal(picked.entry.meta.id, 'new', '选中了旧的 superseded 交接')
})

test('doc_handover_check：id 不存在 → 报错并列出有哪些交接', async () => {
  const world = fakeWorld({ entries: [entry('h', { role: 'handover', order: 0 }, { body: GOOD_HANDOVER })] })
  const tool = createHandoverCheckTool({ config: CONFIG, registry: () => world.registry })
  await assert.rejects(() => tool.execute({ id: 'nope' }, execOf()), /找不到.*h/)
})

test('doc_handover_check：一份交接都没有 → 提示先用 doc_new 建', async () => {
  const world = fakeWorld({ entries: [entry('a')] })
  const tool = createHandoverCheckTool({ config: CONFIG, registry: () => world.registry })
  await assert.rejects(() => tool.execute({}, execOf()), /没有任何 role: handover/)
})

// ---------------------------------------------------------------- 4. doc_health

test('doc_health：健康项目 → ok:true，issues 空（M1-D 正向）', async () => {
  // ⚠️ M1.5 / D7：必须配一份 role: index 文档，否则会多一条
  // 「项目里没有任何入口索引」的项目级 warn（那是另一条判据，见 health.test.js）。
  const idx = entry('read-order', { role: 'index' }, { text: '# 阅读顺序\n\n先读 `a`。\n' })
  const a = entry('a')
  const world = fakeWorld({ entries: [idx, a], required: [idx, a] })
  const tool = createHealthTool({ config: CONFIG, registry: () => world.registry })
  const value = await tool.execute({}, execOf())
  assert.equal(value.ok, true)
  assert.deepEqual(value.issues, [])
  assert.equal(value.rules.length, 5)
})

test('**doc_health：H-5 命中时返回 warn**（故意造出来的失败案例）', async () => {
  const idx = entry('read-order', { role: 'index' }, { text: '# 阅读顺序\n\n先读 `guess`。\n' })
  const bad = entry('guess', { basis: '未验证', status: 'authoritative' })
  const world = fakeWorld({ entries: [idx, bad], required: [idx, bad] })
  const tool = createHealthTool({ config: CONFIG, registry: () => world.registry })
  const value = await tool.execute({}, execOf())
  assert.equal(value.issues.length, 1)
  assert.equal(value.issues[0].rule, 'H-5')
  assert.equal(value.issues[0].level, 'warn')
  assert.equal(value.rules.find((item) => item.rule === 'H-5').hits, 1)
})

test('doc_health：scope=errors 时过滤掉 warn（当前 5 项都是 warn，所以是空）', async () => {
  const bad = entry('guess', { basis: '未验证' })
  const world = fakeWorld({ entries: [bad], required: [bad] })
  const tool = createHealthTool({ config: CONFIG, registry: () => world.registry })
  const value = await tool.execute({ scope: 'errors' }, execOf())
  assert.deepEqual(value.issues, [])
})

// ---------------------------------------------------------------- 5. when（M1-L8）

test('**when：未激活 / 子代理 / 注册表未就绪 → false**', () => {
  const gate = createToolGate({
    config: CONFIG,
    probe: () => ({ hasMarker: false }),
    registry: () => undefined,
  })
  assert.equal(gate({ agent: { session: { header: { cwd: 'C:/x' } } } }), false)

  const gate2 = createToolGate({
    config: CONFIG,
    probe: () => ({ hasMarker: true, projectRoot: 'C:/p' }),
    registry: () => ({ state: 'ready' }),
  })
  assert.equal(gate2({ agent: { session: { header: { cwd: 'C:/p', origin: 'subagent' } } } }), false)
  assert.equal(gate2({ agent: { session: { header: { cwd: 'C:/p' } } } }), true)
  assert.equal(gate2({ agent: { session: { header: { cwd: 'C:/p' } } } }), true)
  // 注册表没就绪
  const gate3 = createToolGate({
    config: CONFIG,
    probe: () => ({ hasMarker: true, projectRoot: 'C:/p' }),
    registry: () => ({ state: 'failed' }),
  })
  assert.equal(gate3({ agent: { session: { header: { cwd: 'C:/p' } } } }), false)
})

test('**when：内部抛异常 → 返回 false，绝不冒泡**（M1-L8 的核心断言）', () => {
  const gate = createToolGate({
    config: CONFIG,
    probe: () => { throw new Error('probe 炸了') },
    registry: () => ({ state: 'ready' }),
  })
  assert.doesNotThrow(() => gate({ agent: { session: {} } }))
  assert.equal(gate({ agent: { session: {} } }), false)
})

test('safeWhen：任何异常都折成 false', () => {
  assert.equal(safeWhen(() => { throw new Error('x') })({}), false)
  assert.equal(safeWhen(() => true)({}), true)
  assert.equal(safeWhen(() => 'truthy')({}), false, '非 true 一律当 false')
  assert.equal(safeWhen(undefined)({}), false)
})

test('**when：context 是垃圾也不抛**', () => {
  const gate = createToolGate({ config: CONFIG, probe: () => ({ hasMarker: true, projectRoot: 'C:/p' }), registry: () => ({ state: 'ready' }) })
  for (const context of [null, undefined, {}, { agent: null }, { agent: {} }, 'x', 42]) {
    assert.doesNotThrow(() => gate(context))
  }
})

test('**when：拿不到 session → false（fail-closed，不能暴露工具）**', () => {
  // `shouldActivate` 的默认是 `hasProjectRoot !== false` 时放行 —— 对门禁那是保守，
  // 但对工具可见性方向相反：拿不到会话就暴露 4 份 schema。这里必须挡死。
  const gate = createToolGate({
    config: CONFIG,
    probe: () => ({ hasMarker: true, projectRoot: 'C:/p' }),
    registry: () => ({ state: 'ready' }),
  })
  for (const context of [null, undefined, {}, { agent: null }, { agent: {} }, { agent: { session: null } }]) {
    assert.equal(gate(context), false, `context=${JSON.stringify(context)} 时工具可见了`)
  }
})

test('**when：真实子代理 header → false**（S2，M1-14 的代码级判据）', () => {
  // 照抄 dsh-subagent 构造子会话 header 的形态（`origin: "subagent"` + `delegationDepth`）。
  const gate = createToolGate({
    config: CONFIG,
    probe: () => ({ hasMarker: true, projectRoot: 'C:/p' }),
    registry: () => ({ state: 'ready' }),
  })
  const sub = {
    header: {
      id: 'session-child',
      cwd: 'C:/p',
      parentSession: 'session-parent',
      isSeeded: false,
      origin: 'subagent',
      delegationDepth: 1,
    },
  }
  assert.equal(gate({ agent: { session: sub } }), false, '子代理会话看到了工具（S2 失效）')
})

// ---------------------------------------------------------------- 6. S2 执行期兜底（M1-14）

/**
 * 造一个执行期兜底。
 * @param {object} [overrides]
 */
function gateOf(overrides = {}) {
  return assertToolAllowed({
    config: CONFIG,
    probe: () => ({ hasMarker: true, projectRoot: 'C:/p' }),
    registry: () => ({ state: 'ready' }),
    ...overrides,
  })
}

const SUB_EXEC = {
  agent: {
    session: {
      header: { id: 'child', cwd: 'C:/p', parentSession: 'p', isSeeded: false, origin: 'subagent', delegationDepth: 1 },
    },
  },
}
const PARENT_EXEC = { agent: { session: { header: { id: 'parent', cwd: 'C:/p' } } } }

test('**S2 执行期兜底：子代理执行工具 → 抛错拒绝**（M1-14 的硬落点）', () => {
  // 实机验收发现：`when` 这条防线在子代理路径上不可靠（子代理仍能看到并执行 4 个工具）。
  // 所以补一道执行期的 `if`——与 M0 的 guard 同一思路：不能靠"不注册"时就在回调里判。
  assert.throws(() => gateOf()(SUB_EXEC), /子代理会话里不可用/)
})

test('S2 兜底：普通会话 → 放行', () => {
  assert.doesNotThrow(() => gateOf()(PARENT_EXEC))
})

test('S2 兜底：不是 DDD 项目 → 拒绝', () => {
  const gate = gateOf({ probe: () => ({ hasMarker: false }) })
  assert.throws(() => gate(PARENT_EXEC), /不可用/)
})

// ---- 2026-11-14 M2.5：未激活的报错必须**给出具体出路**，不能只报"不可用" ----
//
// 实测代价（会话 `25c3ac49`）：旧文案是一句打包的话
// 「这里不是 DDD 项目，或激活标记没探测到」，AI 拿到后**没去找用户**，
// 而是花了 20+ 次工具调用去逆向插件（搜 app.asar → 读 profiles → 读 init-workspace.ts），
// 最后**手写** docs/read-order.md 绕过 doc_new。
//
// 一句含糊的报错，把 AI 推向了"读插件源码"这条最贵的路。

/**
 * 去掉**劝阻行**之后剩下的文本。
 *
 * ⚠️ 这是本项目第二次踩同一个坑：反向断言（"不许出现 X"）会被
 * 「**不要**做 X」这句**劝阻**本身匹配上。
 * M2.5 那次是 `确认工作目录`（`tools.test.js` 里有当时的注释），
 * M2.6 这次是 `自己写 AGENTS.md`。
 *
 * 与其把正则写成难读的负向断言，不如先把劝阻行整行剔除，再断言"剩下的内容里没有 X"——
 * 语义正好就是我们要的：**文案里只能出现"不要做 X"，不能出现"去做 X"**。
 *
 * @param {string} message
 * @returns {string}
 */
function instructionsOf(message) {
  return String(message)
    .split('\n')
    .filter((line) => !/(不要|别|不许|禁止)/.test(line))
    .join('\n')
}

test('**M2.5：no-marker 的报错必须说清"怎么加标记"**（否则 AI 会去读插件源码）', () => {
  const gate = gateOf({ probe: () => ({ hasMarker: false, projectRoot: 'C:/p' }) })
  let message = ''
  try { gate(PARENT_EXEC) } catch (error) { message = String(error.message) }
  assert.match(message, /no-marker/, '没给出原因码')
  // ---- M2.6：出路改成「请用户点按钮」----
  // 旧断言要求文案里出现 `AGENTS.md` / `ddd:index` —— 那是在**要求 AI 自己动手**，
  // 而用户 2026-11-14 明确否掉了这条路（越权）。现在断言的是「给出用户可执行的动作」。
  assert.match(message, /初始化为 DDD 工作区/, '没说清用户该点哪个按钮')
  // 必须**明确劝阻**去读插件源码（那是最贵的错误路径）。
  assert.match(message, /不要|别/, '没有劝阻"去读插件源码"这条错路')
  // ⚠️ 反向：不许**指示** AI 自己去凑标记（劝阻句已剔除，见 `instructionsOf`）。
  assert.doesNotMatch(
    instructionsOf(message),
    /(建|写|创建|新建).{0,12}(AGENTS\.md|ddd:index)/,
    '又在让 AI 自己写标记文件了 —— 那是用户的选择',
  )
})

// ---- 2026-11-14 M2.5 收尾：这条测试原来断言的是**错的结论** ----
//
// 第一版写的是「no-project-root 的报错必须说清"找用户确认目录"」——
// 那是基于一个错误归因（以为这个原因码 = 拿不到 cwd）。
//
// 实测（会话 `47533924`，目录 `DDD新建测试2`）推翻了它：
// 会话 cwd 明明有值，AI 也真的去问了用户、用户也确认了「就是这个目录」，
// 再试**还是同一个错**。所以"让 AI 去问工作目录"是**把人往错误方向引**。
//
// 真实含义：`detect()` 探不到标记时**按设计**返回 `{hasMarker:false}`（无 projectRoot），
// 于是 `scope.js` 的 `hasProjectRoot === false` 永远先命中。
// ⇒ `no-project-root` 实际意思是「这个目录不是 DDD 工作区」。
//
// 用户 2026-11-14 拍板：**只改文字，不改机制**（改机制会破坏"探不到就 no-op"）。

test('**M2.5：no-project-root 必须被解释成"不是 DDD 工作区"，而不是"找不到目录"**', () => {
  const gate = gateOf({ probe: () => ({ hasMarker: true, projectRoot: undefined }) })
  let message = ''
  try { gate(PARENT_EXEC) } catch (error) { message = String(error.message) }
  assert.match(message, /no-project-root/, '没给出原因码')

  // 必须说清真实原因。
  assert.match(message, /不是 DDD 工作区|还不是 DDD 工作区/, '没说清"这个目录不是 DDD 工作区"')

  // ---- M2.6：出路必须**可执行**，且指向**用户**那一下点击 ----
  //
  // 历史（三次改错，别再犯）：
  //   1. M2.5 之前：「拿不到工作目录，去找用户确认」→ 死循环（用户答了也没用）。
  //   2. M2.5 收尾：「按 README 做」→ 全新目录里**没有 README**，等于换了个方向的死循环。
  //   3. M2.6 第一版：「AI 自己写 AGENTS.md」→ **用户否掉**：
  //      「这个目录要不要变成 DDD 工作区」是用户的选择，AI 不该被报错推着替他决定。
  //   ⇒ 正确出路：请用户点面板上那个按钮。
  assert.match(message, /初始化为 DDD 工作区/, '没说清用户该点哪个按钮（这是唯一可执行的出路）')

  // ⚠️ 反向断言 ①：**不许指示 AI 自己去建标记文件**（越权，且只"激活"不是正常工作区）。
  // 劝阻句已剔除（见 `instructionsOf`），否则「不要自己写 AGENTS.md」会把自己匹配进去。
  assert.doesNotMatch(
    instructionsOf(message),
    /(建|写|创建|新建).{0,12}(AGENTS\.md|ddd:index)/,
    '又在让 AI 自己写 AGENTS.md 去凑标记了 —— 那是用户的选择（用户 2026-11-14 否掉过）',
  )

  // ⚠️ 反向断言 ②：**不许再把人往"确认工作目录"这条错路上引**。
  // 这一条就是旧文案的病根（AI 为此问了用户一轮，然后回到原地）。
  //
  // 注意正则要排除"不要确认工作目录"这种**劝阻**写法 —— 第一版写得太宽，
  // 把劝阻句本身也匹配进去了（那是测试的错，不是文案的错）。
  assert.doesNotMatch(
    message,
    /(先|请|需要|建议).{0,6}(确认|检查).{0,6}工作目录/,
    '又在让 AI 去确认工作目录了 —— 实测证明那不是问题所在（会话 47533924）',
  )
  assert.match(message, /不要.{0,6}(确认|更改).{0,4}工作目录/, '没有明确劝阻"去确认工作目录"')
})

test('**M2.5：三种原因给三种出路**（不能一句打包话糊过去）', () => {
  const messages = new Set()
  for (const probe of [
    { hasMarker: false, projectRoot: 'C:/p' },   // no-marker
    { hasMarker: true, projectRoot: undefined }, // no-project-root
  ]) {
    try { gateOf({ probe: () => probe })(PARENT_EXEC) } catch (error) { messages.add(String(error.message)) }
  }
  assert.equal(messages.size, 2, '两种原因给了同一句话 —— 那等于没诊断')
})

// ---- 2026-11-14 M2.5：全新目录的第一次调用被误报 no-project-root ----
//
// 实测（session-3ce8bc82）：用户在**全新的空目录**里说「用 ddd 建一份 spec」，
// doc_new 报 no-project-root。AI 按提示问用户「这个目录对吗」，用户答「对」，
// 再试 —— **还是同一个错**。死循环。
//
// 根因：`probeOf()` 走 `prober.peek()`（只读缓存、绝不读盘）。全新目录缓存为空
// → projectRoot undefined → 误判成 no-project-root。
// 而真实原因应该是 no-marker（"还不是 DDD 工作区"），那条提示恰好告诉用户怎么初始化。
//
// ⚠️ `index.js` 的 `locate()`（HTTP 路由）早就修过同一个坑，工具这条路漏了。

test('**M2.5：缓存为空时会现探一次**（否则全新目录永远报 no-project-root）', async () => {
  const { assertToolAllowedAsync } = await import('../tools/when.js')
  let ensured = 0
  const cache = { hasMarker: false, projectRoot: undefined }
  const gate = assertToolAllowedAsync({
    config: CONFIG,
    probe: () => ({ ...cache }),          // 首次：缓存为空
    registry: () => ({ state: 'ready' }),
    ensureProbe: async () => {             // 现探：发现标记
      ensured += 1
      cache.hasMarker = true
      cache.projectRoot = 'C:/p'
    },
  })

  await assert.doesNotReject(() => gate(PARENT_EXEC), '现探之后应当放行')
  assert.equal(ensured, 1, '没有去现探 —— 全新目录会一直被误报 no-project-root')
})

test('**M2.5：现探也探不到时，报的是 no-marker 而不是 no-project-root**', async () => {
  const { assertToolAllowedAsync } = await import('../tools/when.js')
  const cache = { hasMarker: false, projectRoot: undefined }
  const gate = assertToolAllowedAsync({
    config: CONFIG,
    probe: () => ({ ...cache }),
    registry: () => ({ state: 'ready' }),
    ensureProbe: async () => { cache.projectRoot = 'C:/p' }, // 探到了根，但没有标记
  })

  let message = ''
  try { await gate(PARENT_EXEC) } catch (error) { message = String(error.message) }
  assert.match(message, /no-marker/, '还是报 no-project-root —— 那会让人一直去查工作目录')
  assert.match(message, /初始化为 DDD 工作区/, '没告诉用户怎么初始化')
})

test('M2.5：子代理 / 已禁用这类失败**不触发**现探（探了也改变不了结论）', async () => {
  const { assertToolAllowedAsync } = await import('../tools/when.js')
  let ensured = 0
  const gate = assertToolAllowedAsync({
    config: CONFIG,
    probe: () => ({ hasMarker: true, projectRoot: 'C:/p' }),
    registry: () => ({ state: 'ready' }),
    ensureProbe: async () => { ensured += 1 },
  })
  await assert.rejects(() => gate(SUB_EXEC), /子代理会话里不可用/)
  assert.equal(ensured, 0, '子代理也去现探了 —— 白读一次盘')
})

// ---- 2026-11-16 M2.9：**删掉「§5 不要放代码块」这条过时提示** ----
//
// ---- 这条测试原来断言什么 ----
//
// 2026-11-14 M2.5 加了两条测试，断言"建交接时必须提示 §5 不要放代码块"。
// 当时的前提是：H4 会把代码块**内部**的表格行也算作验收条目。
//
// ---- 前提已经不成立 ----
//
// M2.8 用户拍板决策 #8 修了 `checkAcceptanceEvidence`：它现在跟踪围栏状态，
// **代码块内部的行一律不算验收条目**（`core/handover.js`：`if (inFence) continue`）。
//
// 于是那条提示变成**教人迁就一个已经不存在的缺陷**，而且与技能手册直接矛盾
// （手册 §4.3：「✅ **§5 可以放代码块了**（2026-11-16 起）」）。
//
// ---- 现场（第 33 轮 `session-4473f62b` seq 133 之后）----
//
// 用户问"哪些步骤难"，AI 原文：
// > skill 手册说 §5 CAN have code blocks now (2026-11-16 change),
// > but the doc_new response said 「§5「验收」里不要放代码块」.
// > **That's a direct contradiction between skill manual and tool feedback.**
//
// 它把这条列为**拖累最大的一项** —— 不是 token，是"两个权威同时说话该信谁"。
//
// ⚠️ **修一处不等于修一类**：M2.8 修了解析器，但漏删了这条提示和它的两条测试。
//    这正是本仓库反复吃的亏（第 26 轮假注册表、第 30 轮回执矛盾都是同一形状）。
test('**M2.9 建交接时不许再说「§5 不要放代码块」**（判据已修，提示必须同源）', async () => {
  const world = fakeWorld({ entries: [] })
  world.registry.rescan = async () => {}
  const tool = createNewTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, projectRoot: () => 'C:/proj' })
  const value = await tool.execute(
    { role: 'handover', title: 'h', summary: 's', id: 'h1', body: '# 交接\n' },
    execOf(),
  )
  const rendered = tool.output.render({}, value)[0].text
  assert.doesNotMatch(
    rendered, /不要放代码块/,
    '又出现了"§5 不要放代码块" —— 而解析器早就跳过围栏内的行了，'
      + '这句话会让 AI 在技能手册与工具之间二选一（第 33 轮实机现场）',
  )
  assert.doesNotMatch(
    rendered, /代码块内的表格行也算/,
    '还在解释一个已经不存在的机制',
  )
})

test('M2.9 正向确认：**§5 放代码块真的不会被判不合格**（端到端，判据侧）', async () => {
  // 光删提示不够 —— 必须同时钉住"判据真的放过它"。
  // 否则哪天解析器回退，提示删了、判据却又不认，AI 撞了也没人提前说。
  const { checkAcceptanceEvidence } = await import('../core/handover.js')
  const text = [
    '- 建文档：`2/2 通过`。',
    '',
    '```bash',
    'Copy-Item docs\\spec-1.md deliverables\\spec-1.md -Force',
    '```',
    '',
    '- 索引：`4/4 通过`。',
  ].join('\n')
  const verdict = checkAcceptanceEvidence(text)
  assert.equal(verdict.total, 2, `代码块里的行被数进去了（total=${verdict.total}）`)
  assert.deepEqual(verdict.missing, [], '代码块里的命令被当成"缺证据的验收"')
})

// ---- 2026-11-15 M2.7（#3）：**顺序纪律 —— 建交接应该是最后一步** ----
//
// 依据：**三轮不同的模型独立得出同一个结论**（本项目最强的信号之一）。
//   · `session-c2555c7b` 第 20 轮：「交接文档和它引用的东西是循环依赖」
//   · `session-b1c9883d` 第 21 轮：「顺序应当是先定稿引用 → 最后建交接 → 再标绿」
//   · `交接-M2.7.md` §4（M2.6）：「把取证据当成了收尾动作，但它其实是最后一个」
//
// 为什么放 `doc_new` 而不是索引块：pinned 预算只剩 14 字符（见 `core/render.js`），
// 而**建交接那一刻正是顺序已经走错的时刻** —— 此时说才有用。

test('**M2.7（#3）：建交接时必须说清「建交接是最后一步」**（顺序纪律）', async () => {
  const world = fakeWorld({ entries: [] })
  world.registry.rescan = async () => {}
  const tool = createNewTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, projectRoot: () => 'C:/proj' })
  const value = await tool.execute(
    { role: 'handover', title: 'h', summary: 's', id: 'h1', body: '# 交接\n' },
    execOf(),
  )
  const rendered = tool.output.render({}, value)[0].text
  assert.match(rendered, /建交接应该是最后一步/, '没点明顺序 —— AI 会先建交接再改引用它的文档，然后被迫重读')
  assert.match(rendered, /read-order/, '没说清具体是哪一步会反过来作废交接的指纹')
  assert.match(rendered, /doc_health/, '没给出"先跑 doc_health 归零"这个可执行的检查点')
  assert.match(rendered, /标绿|doc_mark/, '没说清标绿必须是最后一个动作')
})

test('M2.7（#3）：**非交接文档不该有**顺序纪律提示', async () => {
  const world = fakeWorld({ entries: [] })
  world.registry.rescan = async () => {}
  const tool = createNewTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, projectRoot: () => 'C:/proj' })
  const value = await tool.execute({ role: 'spec', title: 's', summary: 's', id: 's1' }, execOf())
  const rendered = tool.output.render({}, value)[0].text
  assert.doesNotMatch(rendered, /建交接应该是最后一步/, 'spec 文档不该收到交接专属提示')
})

// ---- 2026-11-15 M2.7（#2）：**别把会变的计数写进 §5 证据** ----
//
// 依据（`session-b1c9883d` 第 21 轮，AI 自己指出的机制）：
//   > 我写进 §5 的计数证据（「4 份受管文档，1 份必读」），
//   > 在写完的同一刻就已经不是最新的了 —— 因为把本份登记进 read-order
//   > 这一步，直接把「1 份必读」变成了「2 份必读」。
//
// 这是「哈希脆弱」的推广：**计数型证据也会自我失效，而且更隐蔽**。

test('**M2.7（#2）：建交接时必须提醒「§5 别写会变的计数」**', async () => {
  const world = fakeWorld({ entries: [] })
  world.registry.rescan = async () => {}
  const tool = createNewTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, projectRoot: () => 'C:/proj' })
  const value = await tool.execute(
    { role: 'handover', title: 'h', summary: 's', id: 'h1', body: '# 交接\n' },
    execOf(),
  )
  const rendered = tool.output.render({}, value)[0].text
  assert.match(rendered, /别写会变的计数/, '没提醒计数会自我失效 —— AI 会写「N 份文档」然后被迫改两处')
  assert.match(rendered, /状态陈述/, '只说了"别写"，没给出**替代做法**（改写成状态陈述）')
  // 必须说清它与 H4 不冲突，否则 AI 会以为"那 H4 怎么办"
  assert.match(rendered, /不冲突/, '没说清"这条与 H4 不冲突"，AI 会两边为难')
})

test('M2.7（#2）：**非交接文档不该有**计数提醒', async () => {
  const world = fakeWorld({ entries: [] })
  world.registry.rescan = async () => {}
  const tool = createNewTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, projectRoot: () => 'C:/proj' })
  const value = await tool.execute({ role: 'spec', title: 's', summary: 's', id: 's1' }, execOf())
  const rendered = tool.output.render({}, value)[0].text
  assert.doesNotMatch(rendered, /别写会变的计数/, 'spec 文档不该收到交接专属提示')
})

// ---- 2026-11-14 M2.5：接线层的两条静态断言 ----
//
// ⚠️ 这两条是变异 `gate-never-ensures-probe` / `tool-drops-await-assert` **存活**逼出来的。
//
// 原因：上面那三条测试只测 `when.js` 的**单元层**（我自己传 ensureProbe），
// 而变异改的是 `index.js` 的接线与工具里的 `await` —— **纯逻辑对 ≠ 接线对**。
// 这与本轮修跨会话泄漏时撞的是同一件事（`.tsx` 进不了单测 → 补静态断言）。

test('**M2.5：index.js 必须真的把 ensureProbe 传进判定**（否则全新目录仍死循环）', () => {
  const index = codeOf(join(BUNDLE, 'index.js'))
  // 必须用 async 版（同步版没有现探能力）。
  assert.match(index, /assertToolAllowedAsync\(/, '还在用同步版判定 —— 全新目录会一直被误报 no-project-root')
  // 必须真的传 ensureProbe，且真的调 prober.ensure（不是 peek）。
  assert.match(index, /ensureProbe:\s*async/, '没传 ensureProbe —— 现探永远不会发生')
  assert.match(index, /prober\.ensure\(/, 'ensureProbe 里没用 prober.ensure —— 那还是只读缓存')
})

test('**M2.5：四个工具都必须 await 判定**（不 await = async 判定被静默吞掉）', () => {
  // 判定改成 async 之后，任何一处漏 await 都会让"现探"永远不发生，
  // 而且**不会报错**（Promise 被丢掉）—— 这正是变异存活的原因。
  for (const file of ['doc-new.js', 'doc-mark.js', 'doc-health.js', 'doc-handover-check.js']) {
    const source = codeOf(join(BUNDLE, 'tools', file))
    assert.match(
      source,
      /await deps\.assertAllowed\?\.\(exec\)/,
      `${file} 没 await 判定 —— async 判定被吞掉，现探不会发生`,
    )
  }
})

test('S2 兜底：注册表未就绪 → 拒绝', () => {
  const gate = gateOf({ registry: () => ({ state: 'failed' }) })
  assert.throws(() => gate(PARENT_EXEC), /注册表还没就绪/)
})

test('S2 兜底：拿不到 session → 拒绝（fail-closed）', () => {
  for (const exec of [null, undefined, {}, { agent: null }, { agent: {} }]) {
    assert.throws(() => gateOf()(exec), /拿不到会话上下文/)
  }
})

test('S2 兜底：**4 个工具的执行入口都接了它**（否则某一个是后门）', async () => {
  // 用「子代理 exec」直接调每个工具，四个都必须拒绝。
  const world = fakeWorld({ entries: [entry('a')] })
  const subExec = SUB_EXEC
  const tools = [
    createNewTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, projectRoot: () => 'C:/p', assertAllowed: gateOf() }),
    createMarkTool({ config: CONFIG, registry: () => world.registry, fs: world.fs, readRecordOf: () => ({ fingerprint: FP }), assertAllowed: gateOf() }),
    createHandoverCheckTool({ config: CONFIG, registry: () => world.registry, assertAllowed: gateOf() }),
    createHealthTool({ config: CONFIG, registry: () => world.registry, assertAllowed: gateOf() }),
  ]
  for (const tool of tools) {
    await assert.rejects(
      () => tool.execute({ id: 'a', role: 'spec', title: 'x', summary: 'y' }, subExec),
      /子代理会话里不可用/,
      `${tool.name} 没有接执行期兜底 —— 子代理可以用它`,
    )
  }
})

/**
 * M2.9 · `doc_health` 的「N 份必读」必须**列出 id**（用户拍板 §7 第 2 项「顺手做」）。
 *
 * ---- 缺陷 ----
 *
 * 原来 `doc_health` 的健康回执只说：
 *
 * ```
 * 文档健康度：5 项检查全过（4 份受管文档，2 份必读）。
 * ```
 *
 * 这是一个**只有数、没有名字**的回执。模型读到「2 份必读」，
 * 既不知道是哪两份，也不知道自己已读的那份算不算 —— 它只能再去 `read` 一遍索引。
 *
 * ---- 为什么这不是"加新信息" ----
 *
 * `checkHealth` 的入参里本来就有 `reg.index.required`（完整条目），
 * 代码只是把它 `.length` 之后就丢了。**白丢的上下文**。
 *
 * ---- 为什么必须连 schema 一起改 ----
 *
 * M2.6 的教训（`session-f36fd404`）：返回值里多一个 schema 没声明的键，
 * 宿主判 `additionalProperties: false` 会**拒绝整个工具调用**，那一轮从 8 657 字符
 * 打回 25 038 字符。所以这里有一条测试专门钉 schema。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

const { createHealthTool } = await import('../tools/doc-health.js')
const { resolveConfig } = await import('../config.js')
const { fingerprintOf } = await import('../docs/fingerprint.js')

const config = resolveConfig({})

const ROOT = mkdtempSync(join(tmpdir(), 'ddd-m29h-'))
mkdirSync(join(ROOT, 'docs'), { recursive: true })
mkdirSync(join(ROOT, '_artifacts'), { recursive: true })

const ORDER = {
  'read-order': 0,
  'handover-1': -90,
  'spec-1': 10,
}

/** 写一份合法受管文档，返回路径。 */
function writeDoc(id, role, body = '# 标题\n') {
  const order = ORDER[id] ?? 50
  const status = id === 'read-order' ? 'authoritative' : 'authoritative'
  const text = `---\nid: ${id}\ntitle: ${id}\nrole: ${role}\norder: ${order}\n`
    + `status: ${status}\nsummary: 摘要\nbasis: 实测\n---\n\n${body}`
  const path = join(ROOT, 'docs', `${id}.md`)
  writeFileSync(path, text, 'utf8')
  return path
}

// 必读清单里放 3 份（read-order 自己 + 交接 + spec）。
// 索引正文里「必读清单」那节的 id 决定 `buildIndex` 的 required 是谁 —— 这里
// 直接让假注册表给出 required，不依赖正文解析（那件事另有测试覆盖）。
writeDoc('read-order', 'index', [
  '# 入口',
  '',
  '## 必读清单',
  '',
  '1. `handover-1` —— 先读这份。',
  '2. `spec-1` —— 施工图。',
  '',
].join('\n'))
writeDoc('handover-1', 'handover', '# 交接\n\n## §1 我的意图\n\n甲。\n')
writeDoc('spec-1', 'spec', '# 规格\n')

const fsApi = {
  async resolve(path) { return { displayPath: path, targetKey: path } },
  async readText(target) {
    try { return readFileSync(target.targetKey, 'utf8') } catch { return undefined }
  },
  async writeText(target, text) { writeFileSync(target.targetKey, text, 'utf8') },
}

/** 造一个注册表；`required` 是必读条目数组（默认：交接 + spec 两份）。 */
function makeRegistry(requiredIds = ['handover-1', 'spec-1']) {
  const entries = []
  for (const id of ['read-order', 'handover-1', 'spec-1']) {
    const path = join(ROOT, 'docs', `${id}.md`)
    let text
    try { text = readFileSync(path, 'utf8') } catch { continue }
    entries.push({
      path,
      text,
      body: text,
      meta: {
        id,
        role: id === 'read-order' ? 'index' : (id === 'handover-1' ? 'handover' : 'spec'),
        order: ORDER[id],
        status: 'authoritative',
        basis: '实测',
      },
      fingerprint: fingerprintOf(text),
      unmanaged: false,
      hasError: false,
    })
  }
  const required = requiredIds
    .map((id) => entries.find((e) => e.meta.id === id))
    .filter(Boolean)
  return {
    state: 'ready',
    entries,
    index: { required, forbidden: [], anomalies: [] },
    readSetFor: () => new Map(),
    readSet: new Map(),
    entryById: (id) => entries.find((e) => e.meta.id === id),
    entryByPath: (p) => entries.find((e) => e.path === p),
    fingerprintOf: (id) => entries.find((e) => e.meta.id === id)?.fingerprint,
    hasError: () => false,
    textOf: (id) => entries.find((e) => e.meta.id === id)?.text,
    rescan: async () => {},
  }
}

const session = { header: { id: 'm29', cwd: ROOT } }
const makeHealth = (requiredIds) => createHealthTool({
  config,
  registry: () => makeRegistry(requiredIds),
  fs: fsApi,
  projectRootOf: () => ROOT,
  assertAllowed: async () => {},
})

test('**M2.9 doc_health 的必读清单要列 id**（不能只说"2 份必读"）', async () => {
  const tool = makeHealth()
  const value = await tool.execute({}, { agent: { session }, seq: 1 })

  assert.deepEqual(
    value.stats.requiredIds, ['handover-1', 'spec-1'],
    '返回值里没有必读 id 列表 —— 模型只知道"2 份"，不知道是哪两份',
  )

  const rendered = tool.output.render({}, value)[0].text
  assert.match(rendered, /handover-1/, `渲染里没有必读 id：${rendered.slice(0, 120)}`)
  assert.match(rendered, /spec-1/, `渲染里没有必读 id：${rendered.slice(0, 120)}`)
  assert.match(rendered, /2 份必读/, '连数量都丢了')
})

test('M2.9 有 warn 时的渲染**也要**列必读 id（两条路径一致）', async () => {
  // 有 issues 走的是另一条 render 分支。只改「全过」那条会让两条路径不一致，
  // 而模型看到的往往正是**有 warn 的那一次**。
  writeFileSync(
    join(ROOT, '_artifacts', 'ddd-mark-snapshots.json'),
    `${JSON.stringify({
      'handover-1': {
        id: 'handover-1', status: 'authoritative',
        refs: [{ id: 'read-order', fingerprint: 'STALE0000000' }],
      },
    }, null, 2)}\n`,
    'utf8',
  )
  const tool = makeHealth()
  const value = await tool.execute({}, { agent: { session }, seq: 2 })
  assert.ok(value.issues.length > 0, '前置：应当有 warn')
  const rendered = tool.output.render({}, value)[0].text
  assert.match(rendered, /handover-1|必读/, `有 warn 时必读 id 丢了：${rendered.slice(0, 200)}`)
})

test('M2.9 必读为空时**不多说**（不能渲染出"份必读："后面什么都没有）', async () => {
  const tool = makeHealth([])
  const value = await tool.execute({}, { agent: { session }, seq: 3 })
  assert.deepEqual(value.stats.requiredIds, [])
  const rendered = tool.output.render({}, value)[0].text
  assert.doesNotMatch(rendered, /必读：/, `必读为空却渲染出冒号：${rendered.slice(0, 160)}`)
})

// ---------------------------------------------------------------- H-6 的候选行（M2.9）

/**
 * **端到端：H-6 必须把"含计数的行"列出来。**
 *
 * ⚠️ 这条测试是**补漏**。我先写了 `countingLinesOf` 的 8 条纯函数测试，
 * 变异 `h6-loses-counting-candidates`（把 `countingLinesOf(...)` 改成 `[]`）
 * **照样存活** —— 因为纯函数测试不经过 `doc_health` 的接线。
 *
 * 这正是本项目第四次踩"纯函数全绿、接线断了"这个坑
 * （前三次：假注册表、`m28-selfwritten-real`、`m27-window-read-real`）。
 * **凡是被测逻辑在工具里，就必须走工具的 `execute()`。**
 */
test('**M2.9 H-6 端到端：正文里的计数行必须被列出来**（第 35 轮那句 4/4）', async () => {
  // 造一份正文里含计数的交接（`handover-1` 就是被标绿那份）
  writeDoc('handover-1', 'handover', [
    '# 交接',
    '',
    '## §5 验收',
    '',
    '- `glob docs/**` 实跑命中 4/4 命中。',
    '',
  ].join('\n'))

  // 快照：`read-order` 在标绿时是 STALE0000000，现在是别的 → 必然漂移
  writeFileSync(
    join(ROOT, '_artifacts', 'ddd-mark-snapshots.json'),
    `${JSON.stringify({
      'handover-1': {
        id: 'handover-1', status: 'authoritative',
        refs: [{ id: 'read-order', fingerprint: 'STALE0000000' }],
      },
    }, null, 2)}\n`,
    'utf8',
  )

  const tool = makeHealth()
  const value = await tool.execute({}, { agent: { session }, seq: 4 })
  const h6 = value.issues.filter((item) => item.rule === 'H-6')
  assert.equal(h6.length, 1, '前置：应当报 1 条 H-6')

  // ① 主体：谁漂移了
  assert.match(h6[0].message, /read-order/, 'H-6 没说哪份文档漂移了')
  // ② **新增的候选行**：哪句可能过期了
  assert.match(
    h6[0].message, /4\/4/,
    'H-6 没列出含计数的行 —— 模型只看到两个指纹，无法把"它改过"和"我那句 4/4"联系起来',
  )
  assert.match(h6[0].message, /候选/, '没说明"这些是候选不是判决"')
})

test('M2.9 H-6 端到端：正文**没有**计数行时，不能凭空造出候选段', async () => {
  writeDoc('handover-1', 'handover', '# 交接\n\n## §2 现在到哪了\n\n全部是文字描述，没有数字。\n')
  writeFileSync(
    join(ROOT, '_artifacts', 'ddd-mark-snapshots.json'),
    `${JSON.stringify({
      'handover-1': {
        id: 'handover-1', status: 'authoritative',
        refs: [{ id: 'read-order', fingerprint: 'STALE0000000' }],
      },
    }, null, 2)}\n`,
    'utf8',
  )
  const tool = makeHealth()
  const value = await tool.execute({}, { agent: { session }, seq: 5 })
  const h6 = value.issues.filter((item) => item.rule === 'H-6')
  assert.equal(h6.length, 1)
  assert.doesNotMatch(
    h6[0].message, /含数字\/计数/,
    '正文没有计数行，却仍然渲染了候选段（会变成"每条 H-6 都带一堆空话"）',
  )
})

test('**M2.9 `requiredIds` 必须在 output schema 里声明**（否则宿主拒绝整个调用）', () => {
  // M2.6 的现场（`session-f36fd404`）：返回值多一个 schema 没声明的键，
  // 宿主判 `additionalProperties: false` → **整个工具调用被拒**，
  // 那一轮从 8 657 字符打回 25 038 字符。所以这条必须钉住。
  const tool = makeHealth()
  const stats = tool.output.schema.properties.stats
  assert.ok(
    stats.properties.requiredIds !== undefined,
    'stats.requiredIds 没在 schema 里声明 —— 宿主会拒绝整个 doc_health 调用',
  )
  // 它得是 id 的数组，不是数量
  assert.equal(stats.properties.requiredIds.type, 'array')
  // ⚠️ `define-tool` 的 DSL 会把作者写的 `required: true` **提升**成父级的
  //    `required` 数组（见 `tools/define-tool.js` 第 190 行的 `compileProperties`），
  //    所以这里要断言**提升后的形状**，不是断言属性值上还留着 `required: true`。
  //    我第一版就是断言错方向红的 —— 那正好说明这条测试确实在读真实 schema。
  assert.ok(
    Array.isArray(stats.required) && stats.required.includes('requiredIds'),
    `stats.required 里没有 requiredIds（实际：${JSON.stringify(stats.required)}）`,
  )
})

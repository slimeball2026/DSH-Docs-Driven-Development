/**
 * M1.5 / **N2** 的正式单测：`doc_mark` 必须拒绝不认识的参数。
 *
 * ---- 这个文件为什么存在（M1.5 复核者补，2026-11-12）----
 *
 * N2 的修法（`tools/doc-mark.js` 的 `KNOWN_PARAMS` 白名单）在 M1.5 里
 * **一条单测都没有**。证据：
 *
 * ```
 * $ grep -rn 'unknownParamsOf|KNOWN_PARAMS|不认这些参数' ddd-bundle/test/
 * (0 命中)
 * ```
 *
 * 于是复核实测的变异测试里，这条**存活**了：
 *
 * ```
 * 变异：unknownParamsOf 恒返回 []
 * 结果：691 条单测全绿  ← 白名单失效了，没有任何测试发现
 * ```
 *
 * 它当时只靠 `_m15/repro-e2e.mjs` 第 7 段兜（脚本能抓住，单测不能）。
 * 这不是"完全没人守"，而是**只有一层守**——而 N2 是「高」严重度缺陷
 * （静默丢参会让模型以为改成了，然后在错误的 order 上继续施工）。
 *
 * 本文件补上单测层。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createMarkTool, unknownParamsOf } from '../tools/doc-mark.js'
import { resolveConfig } from '../config.js'

const ROOT = 'C:/proj/n2'

/** 一个最小注册表。 */
function makeRegistry(overrides = {}) {
  const entries = [{
    path: `${ROOT}/docs/a.md`,
    text: '---\nid: a\nrole: spec\norder: 20\nstatus: draft\n---\n\n# a\n',
    meta: { id: 'a', role: 'spec', order: 20, status: 'draft' },
    hasError: false,
    fingerprint: 'abcdef',
  }]
  return {
    state: 'ready',
    entries,
    index: { required: [], forbidden: [], anomalies: [] },
    entryById: (id) => entries.find((e) => e.meta?.id === id),
    entryByPath: (p) => entries.find((e) => e.path === p),
    fingerprintOf: () => 'abcdef',
    textOf: () => entries[0].text,
    hasError: () => false,
    readSet: new Map(),
    readSetFor: () => new Map(),
    rescan: async () => {},
    markRead: () => true,
    ...overrides,
  }
}

const fs = {
  resolve: async (path) => ({ displayPath: path, targetKey: path }),
  writeText: async () => {},
}

function makeTool(registryOverrides = {}, writeLog = [], readRecord = { fingerprint: 'abcdef', text: 'stub' }) {
  return createMarkTool({
    config: resolveConfig({}),
    registry: () => makeRegistry(registryOverrides),
    fs: {
      ...fs,
      writeText: async (target, content) => { writeLog.push({ target, content }) },
    },
    // ⚠️ 这里必须给一个**已读记录**（指纹与注册表一致），否则会先撞
    // 「改状态之前必须先读它」那条门禁 —— 而那与 N2 无关。
    // 第一版我传的是 `() => undefined`，于是"合法参数应当写入"那条测试
    // 被这条无关的门禁挡住，红得不明不白。
    readRecordOf: () => readRecord,
    projectRootOf: () => ROOT,
  })
}

const execOf = () => ({
  name: 'doc_mark',
  seq: 1,
  agent: { session: { header: { cwd: ROOT, sandboxMode: 'workspace-write' } } },
})

// ---------------------------------------------------------------- 1. 纯函数

test('N2：`unknownParamsOf` 对空对象 / null / 非对象都返回空数组（不抛）', () => {
  assert.deepEqual(unknownParamsOf({}), [])
  assert.deepEqual(unknownParamsOf(null), [])
  assert.deepEqual(unknownParamsOf(undefined), [])
  assert.deepEqual(unknownParamsOf('不是对象'), [])
  assert.deepEqual(unknownParamsOf(42), [])
})

test('N2：`unknownParamsOf` 认得全部已知参数（一个都不报）', () => {
  const known = {
    id: 'a',
    status: 'draft',
    anchor: '#1',
    sectionStatus: 'partial',
    reason: '为什么',
    supersededBy: ['b'],
  }
  assert.deepEqual(unknownParamsOf(known), [], '这六个都是 KNOWN_PARAMS 里的')
})

test('N2：`unknownParamsOf` 报出**每一个**不认识的参数（不是只报第一个）', () => {
  const args = { id: 'a', order: 5, role: 'spec', title: '标题', bogus: 1 }
  assert.deepEqual(unknownParamsOf(args).sort(), ['bogus', 'order', 'role', 'title'])
})

test('N2：`order` 是**不被认识**的（这是 N6 的镜像事实，必须钉住）', () => {
  // doc_mark 的职责是"改状态"不是"改顺序"。如果哪天有人给它加了 order，
  // 这条会红 —— 那时必须同时更新 N6 的裁定（见 M1.5-验收报告 §二末）。
  assert.deepEqual(unknownParamsOf({ id: 'a', order: 0 }), ['order'])
})

// ---------------------------------------------------------------- 2. 接线：execute 真的抛

test('N2（接线）：`doc_mark{order}` → **抛错**，且文案点名 order', async () => {
  const tool = makeTool()
  await assert.rejects(
    () => tool.execute({ id: 'a', order: 5, status: 'draft' }, execOf()),
    (error) => {
      assert.match(error.message, /不认这些参数/)
      assert.match(error.message, /order/)
      // 必须给出替代做法，否则模型只能猜
      assert.match(error.message, /edit/)
      return true
    },
  )
})

test('N2（接线）：抛错**发生在任何写盘之前**（失败必须是原子的）', async () => {
  const writes = []
  const tool = makeTool({}, writes)
  await assert.rejects(() => tool.execute({ id: 'a', order: 5, status: 'draft' }, execOf()))
  assert.deepEqual(writes, [], '参数不合法时一个字节都不该写出去')
})

test('N2（接线）：多个未知参数**一次全报**，不逼模型逐个试', async () => {
  const tool = makeTool()
  await assert.rejects(
    () => tool.execute({ id: 'a', order: 5, role: 'spec' }, execOf()),
    (error) => {
      assert.match(error.message, /order/)
      assert.match(error.message, /role/)
      return true
    },
  )
})

test('N2（接线）：合法参数**不**被误报（回归：白名单不能过紧）', async () => {
  // ⚠️ 这里刻意**不**断言"写了盘"。
  // 第一版我断言 `writes.length === 1`，结果红了 —— 原因是 `a` 的 status
  // 本来就是 `draft`，改成 `draft` 是**无变化**，`doc_mark` 正确地
  // 不写盘、只返回 `changed: []`。那与 N2 无关，是我的断言写错了。
  //
  // 真正要验的是：**合法参数不会走到"不认这些参数"那条抛错**。
  const tool = makeTool()
  const value = await tool.execute({ id: 'a', status: 'draft' }, execOf())
  assert.equal(value.id, 'a')
  assert.deepEqual(value.changed, [], '同值时无变化（这是正确行为，不是失败）')
})

test('N2（接线）：合法参数 + **真变化** → 正常写盘（证明白名单没把路堵死）', async () => {
  // ⚠️ `scope` / `role` 等结构字段**不在**白名单里（那是刻意的，见 N6 的裁定），
  // 所以这里只用 `status`：`draft → authoritative` 是一个真的状态变化。
  const writes = []
  const tool = makeTool({}, writes)
  const value = await tool.execute({ id: 'a', status: 'authoritative' }, execOf())
  assert.ok(value.changed.includes('status'), `changed 应含 status：${JSON.stringify(value.changed)}`)

  // ---- 2026-11-14 M2.6：标绿会**额外写一份快照**（`_artifacts/ddd-mark-snapshots.json`）----
  //
  // 所以不能再用 `writes.length === 1` —— 那是"只有文档写盘"时代的断言。
  // 改成：**按目标文件分组**，分别断言"文档写了"和"快照写了"。
  //
  // ⚠️ 这条测试红过一次，红得对：它说明我的快照接真的发生了写入。
  //    但断言本身要跟着新行为改，不能靠"把写入数放宽到 >= 1"糊过去
  //    （那样文档不写也能通过）。
  //
  // ⚠️ 第二次红也有价值：`fs.resolve` 在这个测试桩里返回的是
  //    `{ displayPath, targetKey }`，直接 `String(target)` 会得到 `[object Object]`，
  //    分组必然全错。**取路径要用 `displayPath`** —— 这也是宿主 fs 的真实形状。
  const pathOf = (item) => String(item.target?.displayPath ?? item.target?.targetKey ?? '')
  const docWrites = writes.filter((item) => !pathOf(item).includes('ddd-mark-snapshots'))
  const snapshotWrites = writes.filter((item) => pathOf(item).includes('ddd-mark-snapshots'))
  assert.equal(docWrites.length, 1, `文档本身应当写盘一次，实际：${writes.map(pathOf).join(', ')}`)
  assert.equal(snapshotWrites.length, 1, `标绿时应当额外写一份快照，实际：${writes.map(pathOf).join(', ')}`)

  // ⚠️ **返回值里不许出现 schema 之外的字段** —— 2026-11-14 血泪（`session-f36fd404`）。
  //
  // 我第一版在这里加了 `snapshotRefs`，宿主立刻拒绝：
  //   Error: tool "doc_mark" returned invalid output:
  //   "value.snapshotRefs" is not a declared property (additionalProperties: false)
  // 后果：**每次标绿都失败**，AI 只能重来 —— 那一轮 turn 3 输出 25 038 字符
  // （上一轮 8 657），用户直接说「反而表现更糟糕了」。
  //
  // ⇒ 现在断言：返回值**只有** schema 声明过的那些键。
  //   这条比"记得同步改 schema"更硬 —— 它直接看实际返回了什么。
  //
  // ---- 2026-11-15 M2.8：加 `basisPending` 时**被它挡了一次**（红得对）----
  //
  // 我给 `doc_mark` 加了"标绿时 basis 还是未验证就提醒一句"，返回值和 schema 都改了，
  // 但忘了同步这个白名单 → 这条立刻红。**这正是它存在的意义**：
  // 它不看我的意图，只看"实际返回了什么、schema 认不认"。
  //
  // ⇒ 加字段时的正确顺序是：① 返回值 + ② output.schema + ③ **这个数组**，三处都要改。
  const declared = [
    'id', 'changed', 'added', 'removed', 'marked', 'indexed', 'basisPending',
    // M3：必读清单半自动渲染（2026-11-20 拍板）—— 加字段时 ①②③ 三处都要改。
    'requiredListApplied', 'requiredListChanged', 'requiredListWarning',
  ]
  const extra = Object.keys(value).filter((key) => !declared.includes(key))
  assert.deepEqual(
    extra, [],
    `返回了 schema 之外的字段 ${extra.join('、')} —— 宿主会拒绝整个工具调用，`
    + '不是"多一个字段"而是"这个工具坏了"。要加字段必须同时改 output schema。',
  )
})

test('N2：`reason` 与 `supersededBy` 是**认识**的（否则改 void/sealed 无法留理由）', async () => {
  const writes = []
  const tool = makeTool({}, writes)
  // superseded 必须给 supersededBy（schema 要求），这里同时验它不报"不认"
  await tool.execute({ id: 'a', status: 'superseded', supersededBy: ['b'], reason: '已作废' }, execOf())
  assert.equal(writes.length, 1)
})

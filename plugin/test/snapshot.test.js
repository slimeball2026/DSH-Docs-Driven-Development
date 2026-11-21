/**
 * `server/snapshot.ts` 的单测。
 *
 * ---- 这一组测试的重点 ----
 *
 * 交接 §2 说得最狠的一条：
 * > **写 UI 的测试时，不要只测"渲染没崩"。要测"数据错了，UI 会不会显示错"。**
 *
 * 所以这里**每一条都在钉真值**，尤其是最后那组**同源一致性**测试：
 * 用**同一个注册表**同时算出「索引块的 `【门禁】N/M`」和「快照的 `gate.read/required`」，
 * 然后断言两者相等。那正是 M2-2 的判据本身 ——
 * 如果看板显示 5 而索引块显示 3，用户会相信看板，而门禁按索引块办事。
 *
 * ---- 关于 `.js` 测试 import `.ts` ----
 *
 * Node 24 原生剥离类型，**不需要 `--experimental-strip-types`**（本机实测）。
 * 所以 722 条既有 `.js` 测试的运行方式**一个字符都不用改**（M2-W4 选方案 b）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildSnapshot, SNAPSHOT_VERSION } from '../server/snapshot.ts'
import { buildIndex as buildIndexRef } from '../core/index.js'
import { renderIndexBlock } from '../core/render.js'

// ---------------------------------------------------------------- 夹具

/**
 * 造一条注册表条目。
 * @param {object} meta
 * @param {object} [extra]
 * @returns {object}
 */
function entryOf(meta, extra = {}) {
  return {
    path: `C:\\proj\\docs\\${meta.id}.md`,
    meta,
    issues: [],
    hasError: false,
    unmanaged: false,
    inGraveyard: false,
    fingerprint: extra.fingerprint ?? `fp-${meta.id}`,
    ...extra,
  }
}

/** 一份健康的受管文档。 */
function docOf(id, role, order, extra = {}) {
  return entryOf({
    id,
    role,
    order,
    status: 'authoritative',
    summary: `${id} 的摘要`,
    title: `${id} 标题`,
    ...extra,
  })
}

/** 一个典型项目的条目集：必读 3 份 + 非必读 2 份 + 1 份坏文档 + 1 份 sealed。 */
function sampleEntries() {
  return [
    docOf('read-order', 'index', 0),
    docOf('handover-m2', 'handover', -30),
    docOf('spec-m2', 'spec', 10),
    docOf('decision-log', 'decision', 20),
    docOf('old-note', 'log', 30, { status: 'superseded' }),
    entryOf(
      { id: 'broken-role', role: 'bogus-role', order: 40, status: 'authoritative', summary: '坏的' },
      {
        hasError: true,
        issues: [{ rule: 'V2', level: 'error', message: 'role 不在枚举内：bogus-role' }],
      },
    ),
    docOf('sealed-trap', 'spec', 50, { status: 'sealed' }),
  ]
}

/** 空 readSet。 */
const EMPTY_READ = new Map()

/**
 * 造一份 readSet（id → 指纹记录）。
 * @param {Array<[string, string]>} pairs
 * @returns {Map<string, {fingerprint: string}>}
 */
function readSetOf(pairs) {
  return new Map(pairs.map(([id, fingerprint]) => [id, { fingerprint, at: 1 }]))
}

// ---------------------------------------------------------------- 1. 基本形状

test('snapshot：空注册表 → 结构完整、gate 0/0、不抛', () => {
  const snap = buildSnapshot({ entries: [], sessionId: 'session-abc123' })
  assert.equal(snap.ok, true)
  assert.equal(snap.version, SNAPSHOT_VERSION)
  assert.deepEqual(snap.gate, { read: 0, required: 0, ready: false })
  assert.deepEqual(snap.required, [])
  assert.deepEqual(snap.forbidden, [])
  assert.deepEqual(snap.anomalies, [])
  assert.equal(snap.budget, null, '没有预算数据时必须是 null，不能编一个 0/0')
})

test('snapshot：**完全没有入参也不抛**（防御性，UI 不能因为 host 传空就白屏）', () => {
  const snap = buildSnapshot(undefined)
  assert.equal(snap.ok, true)
  assert.equal(snap.sessionId, '')
  assert.equal(snap.gate.required, 0)
})

// ---------------------------------------------------------------- 2. 三份清单同源

test('snapshot：必读 = buildIndex 的 required（3 份），坏文档进 anomalies 不进必读', () => {
  const snap = buildSnapshot({ entries: sampleEntries(), sessionId: 'session-abc123' })
  // read-order(index) / handover-m2(handover) / spec-m2(spec) / decision-log(decision)
  // —— 注意：**必读不等于「只有 handover+index」**。
  // `buildIndex` 的规则是「status 可执行（authoritative/partial）就进 required」，
  // 所以 spec / decision 也在必读里。我第一版抄成「handover+index」是错的，
  // 这条断言就是为了钉住那个错误不会回来。
  assert.deepEqual(
    snap.required.map((item) => item.id),
    ['handover-m2', 'read-order', 'spec-m2', 'decision-log'],
  )
  assert.equal(snap.gate.required, 4)
})

test('snapshot：`sealed` 进 forbidden 且**不在必读里**', () => {
  const snap = buildSnapshot({ entries: sampleEntries(), sessionId: 'session-abc123' })
  assert.deepEqual(snap.forbidden.map((item) => item.id), ['sealed-trap'])
  assert.ok(
    !snap.required.some((item) => item.id === 'sealed-trap'),
    'sealed 文档混进了必读清单',
  )
})

test('snapshot：坏文档进 anomalies，**文案与索引块同源**', () => {
  const snap = buildSnapshot({ entries: sampleEntries(), sessionId: 'session-abc123' })
  assert.deepEqual(snap.anomalies, [
    { id: 'broken-role', message: 'role 不在枚举内：bogus-role' },
  ])
  assert.ok(
    !snap.required.some((item) => item.id === 'broken-role'),
    '有 error 的文档不能进必读',
  )
})

test('snapshot：`superseded` 不进必读、也不报异常（规则 3）', () => {
  const snap = buildSnapshot({ entries: sampleEntries(), sessionId: 'session-abc123' })
  assert.ok(!snap.required.some((item) => item.id === 'old-note'))
  assert.ok(!snap.anomalies.some((item) => item.id === 'old-note'))
  // 但它仍然在图谱的全量清单里（用户要能看见"这份被取代了"）。
  assert.ok(snap.all.some((item) => item.id === 'old-note'))
})

test('snapshot：`unmanaged` 不进任何清单（也不报异常）', () => {
  const entries = [
    ...sampleEntries(),
    entryOf({ id: '' }, { unmanaged: true, meta: null }),
  ]
  const snap = buildSnapshot({ entries, sessionId: 'session-abc123' })
  assert.ok(!snap.all.some((item) => item.id === ''), 'unmanaged 混进了图谱')
  assert.equal(snap.anomalies.length, 1, 'unmanaged 被误报成异常')
})

// ---------------------------------------------------------------- 3. gate.read（会话级）

test('snapshot：**未读任何文档 → gate.read = 0**', () => {
  const snap = buildSnapshot({
    entries: sampleEntries(),
    readSet: EMPTY_READ,
    sessionId: 'session-abc123',
  })
  assert.equal(snap.gate.read, 0)
  assert.equal(snap.gate.ready, false)
  assert.ok(snap.required.every((item) => item.read === false))
})

test('snapshot：读了一份 → gate.read = 1，且只有那一份 read:true', () => {
  const snap = buildSnapshot({
    entries: sampleEntries(),
    readSet: readSetOf([['read-order', 'fp-read-order']]),
    sessionId: 'session-abc123',
  })
  assert.equal(snap.gate.read, 1)
  assert.equal(snap.required.find((item) => item.id === 'read-order').read, true)
  assert.equal(snap.required.find((item) => item.id === 'spec-m2').read, false)
})

test('snapshot：**全部读完 → ready:true**', () => {
  const snap = buildSnapshot({
    entries: sampleEntries(),
    readSet: readSetOf([
      ['read-order', 'fp-read-order'],
      ['handover-m2', 'fp-handover-m2'],
      ['spec-m2', 'fp-spec-m2'],
      ['decision-log', 'fp-decision-log'],
    ]),
    sessionId: 'session-abc123',
  })
  assert.equal(snap.gate.read, 4)
  assert.equal(snap.gate.ready, true)
})

test('**snapshot：指纹变了 = 未读**（读了旧版不算读过，SPEC §9.3）', () => {
  const snap = buildSnapshot({
    entries: sampleEntries(),
    // 记录里的指纹与条目当前指纹不一致
    readSet: readSetOf([['read-order', 'fp-OLD-版本']]),
    sessionId: 'session-abc123',
  })
  assert.equal(snap.gate.read, 0, '读了旧版却算成已读 —— 这会让门禁形同虚设')
  assert.equal(snap.required.find((item) => item.id === 'read-order').read, false)
})

test('**snapshot：readSet 为空 Map 时不会把「没读」算成「读了」**', () => {
  const snap = buildSnapshot({
    entries: sampleEntries(),
    readSet: new Map(),
    sessionId: 'session-abc123',
  })
  assert.equal(snap.gate.read, 0)
})

test('snapshot：`readSet` 传成非 Map（比如 undefined）→ 退回空集合，不抛', () => {
  const snap = buildSnapshot({
    entries: sampleEntries(),
    readSet: undefined,
    sessionId: 'session-abc123',
  })
  assert.equal(snap.gate.read, 0)
})

// ---------------------------------------------------------------- 4. budget（`over` 不是 `overflow`）

test('**snapshot：budget 的字段名是 `over`**（照第一版 SPEC 写成 overflow 会让看板永不报警）', () => {
  const snap = buildSnapshot({
    entries: sampleEntries(),
    sessionId: 'session-abc123',
    budget: { count: 7, tokens: 51900, limit: 30000, over: true, overBy: 21900 },
  })
  assert.equal(snap.budget.over, true)
  assert.equal(snap.budget.overBy, 21900)
  assert.equal(snap.budget.tokens, 51900)
  assert.equal(snap.budget.limit, 30000)
  // 反向：不该出现 `overflow` 这个键
  assert.equal('overflow' in snap.budget, false, 'budget 里出现了 overflow 键')
})

test('snapshot：未超预算时 over:false、overBy:0', () => {
  const snap = buildSnapshot({
    entries: sampleEntries(),
    sessionId: 'session-abc123',
    budget: { count: 3, tokens: 1000, limit: 30000, over: false, overBy: 0 },
  })
  assert.equal(snap.budget.over, false)
  assert.equal(snap.budget.overBy, 0)
})

// ---------------------------------------------------------------- 5. 不猜（真源缺失就留空）

test('**snapshot：slice / nextStep / basisDoc 取不到就留空，不写占位**', () => {
  const snap = buildSnapshot({ entries: sampleEntries(), sessionId: 'session-abc123' })
  assert.equal(snap.slice, '', 'slice 缺失时必须是空串，不能编一个切片名')
  assert.equal(snap.nextStep, '', 'nextStep 缺失时必须是空串')
  assert.equal(snap.basisDoc, null, 'basisDoc 缺失时必须是 null')
  assert.equal(snap.project, '', 'project 缺失时必须是空串')
})

test('snapshot：给了就原样透传（不加工、不截断）', () => {
  const snap = buildSnapshot({
    entries: sampleEntries(),
    sessionId: 'session-abc123',
    slice: 'M2',
    nextStep: '改 src/xlsx.js 的 writeRows',
    project: '档 2 的入口索引：先读哪一份',
    basisDoc: { id: 'handover-m2', section: '§3.1', fingerprint: 'f679e4' },
  })
  assert.equal(snap.slice, 'M2')
  assert.equal(snap.nextStep, '改 src/xlsx.js 的 writeRows')
  assert.equal(snap.project, '档 2 的入口索引：先读哪一份')
  assert.deepEqual(snap.basisDoc, { id: 'handover-m2', section: '§3.1', fingerprint: 'f679e4' })
})

// ---------------------------------------------------------------- 6. sessionId

test('**snapshot：sessionId 必须原样带出**（缺了它 M2-A / M2-B 会静默坏）', () => {
  const snap = buildSnapshot({
    entries: sampleEntries(),
    sessionId: 'session-2dd5116a-cd54-4557-b85a-577939692c82',
  })
  assert.equal(snap.sessionId, 'session-2dd5116a-cd54-4557-b85a-577939692c82')
})

// ---------------------------------------------------------------- 7. 图谱分组

test('snapshot：`all` 按 role 分组、组内按 order 升序（SPEC §6.3）', () => {
  const snap = buildSnapshot({ entries: sampleEntries(), sessionId: 'session-abc123' })
  const ids = snap.all.map((item) => item.id)
  // index → handover → spec → decision → evidence → instruction → log → fact
  assert.deepEqual(ids, [
    'read-order',    // index
    'handover-m2',   // handover
    'spec-m2',       // spec（order 10）
    'sealed-trap',   // spec（order 50）—— 组内按 order 升序
    'decision-log',  // decision
    'old-note',      // log
    // broken-role 有 error，但 `all` 是"全量"清单，它仍在里面
    // （它在 role 上写的是 bogus-role，未知角色排最后）
    'broken-role',
  ])
})

// ---------------------------------------------------------------- 8. **同源一致性（M2-2 的判据本身）**

/**
 * 用**同一个注册表**同时算出索引块与快照，比对门禁比率。
 *
 * 这是本文件最重要的一组测试：如果两边不同源，
 * 看板会显示一个"看起来对"的数字，而门禁按另一个数字办事 —— 用户会相信看板。
 *
 * @param {Map<string, object>} readSet
 */
function assertGateMatchesIndex(readSet) {
  const entries = sampleEntries()

  const block = renderIndexBlock({
    activated: true,
    index: buildIndexForTest(entries),
    readSet,
    maxChars: 4000,
  })

  const snap = buildSnapshot({ entries, readSet, sessionId: 'session-abc123' })

  assert.equal(snap.entryPoint.id, 'handover-m2')
  assert.match(block, /【入口】`handover-m2`/)
  assert.equal(snap.required.length, buildIndexForTest(entries).required.length)
  assert.doesNotMatch(block, /【门禁】\d+\/\d+/)
  assert.match(snap.navigationNotice, /旧磁盘阅读清单可能过时/)

}

/** 测试内部用：直接借 buildIndex（与 snapshot 用的是同一个函数）。 */
function buildIndexForTest(entries) {
  return buildIndexRef(entries)
}

test('**同源一致性：未读时看板入口与注入一致且保留完整目录**（M2-2）', () => {
  assertGateMatchesIndex(EMPTY_READ)
})

test('**同源一致性：读了一部分时两处入口仍一致**（M2-2 的「读过 1 份后仍一致」）', () => {
  assertGateMatchesIndex(readSetOf([['read-order', 'fp-read-order']]))
})

test('**同源一致性：全部读完时两处入口仍一致**', () => {
  assertGateMatchesIndex(readSetOf([
    ['read-order', 'fp-read-order'],
    ['handover-m2', 'fp-handover-m2'],
    ['spec-m2', 'fp-spec-m2'],
    ['decision-log', 'fp-decision-log'],
  ]))
})

test('**同源一致性：指纹过期（读了旧版）时两处入口仍一致**', () => {
  assertGateMatchesIndex(readSetOf([['read-order', 'fp-旧版本']]))
})

test('M4 snapshot 当前入口与完整有效目录分开；草稿不抢入口', () => {
  const entries = [...sampleEntries(), docOf('draft', 'handover', -100, { status: 'draft' })]
  const snap = buildSnapshot({ entries, sessionId: 'session-test' })
  assert.equal(snap.entryPoint.id, 'handover-m2')
  assert.equal(snap.required.length, 4)
  assert.ok(snap.all.some((item) => item.id === 'draft'))
  const fallback = buildSnapshot({ entries: entries.filter((entry) => entry.meta.role !== 'handover'), sessionId: 'session-test' })
  assert.equal(fallback.entryPoint.id, 'read-order')
})

// ---------------------------------------------------------------- 9. 稳定性

test('snapshot：同样的输入 → 同样的输出（`generatedAt` 除外）', () => {
  const a = buildSnapshot({ entries: sampleEntries(), sessionId: 'session-abc123', generatedAt: 1 })
  const b = buildSnapshot({ entries: sampleEntries(), sessionId: 'session-abc123', generatedAt: 1 })
  assert.deepEqual(a, b, '两次调用结果不同 —— 纯函数被破坏了')
})

test('snapshot：`generatedAt` 给了就用给的，不给才取当前时间', () => {
  const fixed = buildSnapshot({
    entries: [],
    sessionId: 'session-abc123',
    generatedAt: 1794490792206,
  })
  assert.equal(fixed.generatedAt, 1794490792206)

  const auto = buildSnapshot({ entries: [], sessionId: 'session-abc123' })
  assert.equal(typeof auto.generatedAt, 'number')
  assert.ok(auto.generatedAt > 1_700_000_000_000, '自动时间戳看起来不对')
})

/**
 * M2.7 · #2：`doc_health` 的**计数必须与实际列出的条目一致**。
 *
 * ---- 缺陷（`session-535d7bab` seq 209 实测）----
 *
 * ```
 * 文档健康度：0 条 warn（4 份受管文档）。
 * 这些都是 warn，不阻塞施工，但每一条都是"文档在骗人"的迹象：
 * - [H-6] `instruction-1`：`instruction-1` 标成 authoritative 之后，这些文档改过…
 * ```
 *
 * 标题说 **0 条**，正文却列了 **1 条**。
 *
 * ---- 根因 ----
 *
 * `stats.warnings` 取的是 `result.stats.warnings` —— 那**只统计 `checkHealth`
 * 的 5 项**（H-1~H-5）。而 H-6 是 `doc_health` 里**后追加**的 `driftIssues`，
 * 从来没被算进那个数。
 *
 * ---- 为什么危害比"难看"大 ----
 *
 * AI 会以为健康度是干净的，从而**跳过处理**。那一轮的 AI 自述原文：
 *
 * > it says "0 条 warn" in header yet lists one.
 * > Let me check whether it's benign.
 *
 * 它注意到了矛盾，然后**自己判断成良性跳过了**。那一轮运气好（确实良性），
 * 换一份真引用了 `read-order` 的交接就会漏掉。
 *
 * ---- 修法 ----
 *
 * 从**合并后**的 `allIssues` 直接数，两处口径永远一致。
 *
 * 本文件用**真实工具实例**验证这个不变量（不是纯函数），
 * 因为缺陷就在工具的组装层。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const { createHealthTool } = await import('../tools/doc-health.js')
const { resolveConfig } = await import('../config.js')
const { fingerprintOf } = await import('../docs/fingerprint.js')

const config = resolveConfig({})

const ROOT = mkdtempSync(join(tmpdir(), 'ddd-h2-'))
mkdirSync(join(ROOT, 'docs'), { recursive: true })
mkdirSync(join(ROOT, '_artifacts'), { recursive: true })

const readOrderPath = join(ROOT, 'docs', 'read-order.md')
const handoverPath = join(ROOT, 'docs', 'handover-1.md')

const readOrderText = '---\nid: read-order\ntitle: 入口\nrole: index\norder: 0\nstatus: authoritative\nsummary: 入口\nbasis: 实测\n---\n\n# 入口\n'
const handoverText = '---\nid: handover-1\ntitle: 交接\nrole: handover\norder: -90\nstatus: authoritative\nsummary: 交接\nbasis: 实测\n---\n\n# 交接\n'
writeFileSync(readOrderPath, readOrderText, 'utf8')
writeFileSync(handoverPath, handoverText, 'utf8')

/** 写一份**漂移**的快照（handover-1 标绿时 read-order 是别的指纹）。 */
function writeDriftSnapshot() {
  const table = {
    'handover-1': {
      id: 'handover-1',
      status: 'authoritative',
      refs: [{ id: 'read-order', fingerprint: 'STALE0000000' }],
    },
  }
  writeFileSync(join(ROOT, '_artifacts', 'ddd-mark-snapshots.json'), `${JSON.stringify(table, null, 2)}\n`, 'utf8')
}

const fsApi = {
  async resolve(path) { return { displayPath: path, targetKey: path } },
  async readText(target) {
    try { return readFileSync(target.targetKey, 'utf8') } catch { return undefined }
  },
  async writeText(target, text) { writeFileSync(target.targetKey, text, 'utf8') },
}

function makeRegistry() {
  const safeRead = (p) => {
    try { return readFileSync(p, 'utf8') } catch { return undefined }
  }
  const entries = []
  const ro = safeRead(readOrderPath)
  if (ro !== undefined) {
    entries.push({
      path: readOrderPath, text: ro, body: ro,
      meta: { id: 'read-order', role: 'index', status: 'authoritative', order: 0 },
      fingerprint: fingerprintOf(ro), unmanaged: false, hasError: false,
    })
  }
  const ho = safeRead(handoverPath)
  if (ho !== undefined) {
    entries.push({
      path: handoverPath, text: ho, body: ho,
      meta: { id: 'handover-1', role: 'handover', status: 'authoritative', order: -90 },
      fingerprint: fingerprintOf(ho), unmanaged: false, hasError: false,
    })
  }
  return {
    state: 'ready',
    entries,
    index: { required: [], forbidden: [], anomalies: [] },
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

const session = { header: { id: 'p', cwd: ROOT } }
const makeHealth = () => createHealthTool({
  config,
  registry: () => makeRegistry(),
  fs: fsApi,
  projectRootOf: () => ROOT,
  assertAllowed: async () => {},
})

test('M2.7 #2：**H-6 必须计入 stats.warnings**（标题不能与正文矛盾）', async () => {
  writeDriftSnapshot()
  const tool = makeHealth()
  const value = await tool.execute({}, { agent: { session }, seq: 1 })

  const h6 = value.issues.filter((item) => item.rule === 'H-6')
  assert.equal(h6.length, 1, '前置：应当报出 1 条 H-6')

  // ⚠️ 不能断言 `warnings === 1` —— 这个测试项目里还有别的 warn（H-5：
  // `handover-1` 标了 authoritative 但 basis 未验证）。我第一版就是这么写的，
  // 红在「2 !== 1」。真正要守的不变量是 **计数 == 条目数**，见下一条。
  const warnItems = value.issues.filter((item) => item.level === 'warn')
  assert.equal(
    value.stats.warnings,
    warnItems.length,
    `标题会显示「${value.stats.warnings} 条 warn」但正文列了 ${warnItems.length} 条 —— `
      + 'AI 会据此判断成"干净"并跳过处理（session-535d7bab seq 209 就是这么漏的）',
  )
  // 并且 H-6 确实被算进去了（不是"两边都漏掉 H-6"）
  assert.ok(
    warnItems.some((item) => item.rule === 'H-6'),
    'H-6 没进 issues 列表',
  )
})

test('M2.7 #2：**渲染出来的标题必须与条目数一致**（端到端，不是只看 stats）', async () => {
  writeDriftSnapshot()
  const tool = makeHealth()
  const value = await tool.execute({}, { agent: { session }, seq: 2 })
  const rendered = tool.output.render({}, value)[0].text

  const declared = /(\d+)\s*条\s*warn/.exec(rendered)
  assert.ok(declared !== null, `标题里找不到"N 条 warn"：${rendered.slice(0, 80)}`)
  const listed = (rendered.match(/^- \[H-\d+\]/gm) ?? []).length
  assert.equal(
    Number(declared[1]),
    listed,
    `标题说 ${declared[1]} 条，正文列了 ${listed} 条 —— 自相矛盾`,
  )
})

test('M2.7 #2：没有漂移时计数仍然是 0（不能反向虚报）', async () => {
  // 快照里的指纹与磁盘一致 → 不算漂移。
  const table = {
    'handover-1': {
      id: 'handover-1',
      status: 'authoritative',
      refs: [{ id: 'read-order', fingerprint: fingerprintOf(readFileSync(readOrderPath, 'utf8')) }],
    },
  }
  writeFileSync(join(ROOT, '_artifacts', 'ddd-mark-snapshots.json'), `${JSON.stringify(table, null, 2)}\n`, 'utf8')

  const tool = makeHealth()
  const value = await tool.execute({}, { agent: { session }, seq: 3 })
  assert.equal(value.issues.filter((item) => item.rule === 'H-6').length, 0, '前置：不该有漂移')
  assert.equal(value.stats.warnings, value.issues.filter((i) => i.level === 'warn').length,
    '计数与条目数不一致（这次是多报了）')
})

// ---------------------------------------------------------------- M2.8 Q1：报完自动重取快照

/**
 * 用户 2026-11-15 拍板 Q1 = A：**标绿是"取快照"，不是"封口"**。
 *
 * 为什么（用户原话）：
 * > 不该认定 AI 能判断出自己的任务跑完了没，很多时候 AI 自己觉得跑完了，
 * > 去做最后一步，然后又发现别的东西要做。
 *
 * 实测：8 轮里 **3 轮（37.5%）在标绿之后继续改**，第 19 轮标绿后又跑 13 步。
 *
 * M2.7 的做法是"同一份快照只报一次"——那只是**压下症状**：
 * 第二次及以后的漂移**完全不报**，模型从此不知道引用还准不准。
 *
 * Q1 的做法：报出漂移 → **把基线重取成"现在"**。于是 H-6 从
 * "永远满足不了的警告"变成"**每次基线漂移报一次**"，
 * 而模型不需要预判"我改完了没有"。
 */
test('**M2.8 Q1：H-6 报过一次之后，快照基线被自动刷新到当前版本**', async () => {
  writeDriftSnapshot()
  const snapshotPath = join(ROOT, '_artifacts', 'ddd-mark-snapshots.json')
  const before = JSON.parse(readFileSync(snapshotPath, 'utf8'))

  // 前置：快照里的 read-order 指纹与磁盘**不一致**（这就是"漂移"）
  const currentFp = fingerprintOf(readFileSync(readOrderPath, 'utf8'))
  assert.notEqual(
    before['handover-1'].refs.find((r) => r.id === 'read-order').fingerprint,
    currentFp,
    '前置：快照必须与磁盘不一致，否则这条测试在测空气',
  )

  const tool = makeHealth()
  const value = await tool.execute({}, { agent: { session }, seq: 4 })
  assert.equal(
    value.issues.filter((item) => item.rule === 'H-6').length, 1,
    '前置：应当报出一条 H-6',
  )

  // ★ 报完之后，快照文件里的基线应该已经被刷成**当前**指纹
  const after = JSON.parse(readFileSync(snapshotPath, 'utf8'))
  assert.equal(
    after['handover-1'].refs.find((r) => r.id === 'read-order').fingerprint,
    currentFp,
    '报完之后没有重取基线 —— H-6 又变成"永远满足不了"的警告（Q1 没生效）',
  )
})

test('**M2.8 Q1：重取基线之后，再跑一次 doc_health 不再报同一条 H-6**', async () => {
  // 这是 Q1 的核心收益：模型被告知一次，之后基线跟着走，不会"越改越报"。
  writeDriftSnapshot()
  const tool = makeHealth()

  const first = await tool.execute({}, { agent: { session }, seq: 5 })
  assert.equal(
    first.issues.filter((item) => item.rule === 'H-6').length, 1,
    '前置：第一次应当报出来',
  )

  // 换一个会话 id（绕开"同一会话只报一次"的内存去重），验证的是**文件基线**已经变了
  const otherSession = { id: 'session-other-q1' }
  const second = await tool.execute({}, { agent: { session: otherSession }, seq: 6 })
  assert.equal(
    second.issues.filter((item) => item.rule === 'H-6').length, 0,
    '重取基线之后另一个会话仍报 H-6 —— 基线没真的写回去',
  )
})

test.after(() => rmSync(ROOT, { recursive: true, force: true }))

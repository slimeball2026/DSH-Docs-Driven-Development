/**
 * 门禁裁决的单测（SPEC §12.1 的 `gate.test.js`）。
 *
 * 必测：无路径参数放行、非 docs 放行、未读拒绝且文案含缺项 id、
 * 读过放行、**指纹变了视为未读**。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildIndex } from '../core/index.js'
import { GATE_ALLOW, GATE_DENY, decideGate, pathArgOf } from '../core/gate.js'

const FP = 'abcdef123456'

/** 造一条文档条目。 */
function entry(meta, overrides = {}) {
  return {
    path: `docs/${meta?.id ?? 'x'}.md`,
    meta,
    issues: [],
    hasError: false,
    fingerprint: FP,
    ...overrides,
  }
}

function good(overrides = {}) {
  return {
    id: 'spec-tier2',
    title: '档 2 施工图',
    role: 'spec',
    order: 20,
    status: 'authoritative',
    summary: '摘要',
    basis: '实测',
    ...overrides,
  }
}

/** 一个把 docs/xxx 判成 doc、_graveyard 判成 graveyard 的假 classifier。 */
function fakeClassify(path) {
  const text = String(path).replaceAll('\\', '/')
  if (text.includes('_graveyard')) return 'graveyard'
  if (/\/docs\/.+\.md$/.test(text)) return 'doc'
  return 'outside'
}

/** 组一份完整的 decideGate 入参。 */
function call(input) {
  const entries = input.entries ?? [entry(good())]
  const index = buildIndex(entries)
  return decideGate({
    classify: fakeClassify,
    required: index.required,
    readSet: input.readSet ?? new Map(),
    currentFingerprint: input.currentFingerprint ?? (() => FP),
    metaOf: (path) => entries.find((item) => path.endsWith(`${item.meta?.id}.md`))?.meta,
    errorOf: (id) => entries.find((item) => item.meta?.id === id)?.hasError === true,
    textOf: input.textOf,
    gateEnabled: input.gateEnabled,
    toolName: input.toolName,
    args: input.args,
  })
}

// ---------------------------------------------------------------- pathArgOf

test('pathArgOf：write / edit / read 取 file_path', () => {
  assert.equal(pathArgOf({ name: 'write', arguments: { file_path: 'docs/a.md' } }), 'docs/a.md')
  assert.equal(pathArgOf({ name: 'edit', arguments: { file_path: 'docs/a.md' } }), 'docs/a.md')
  assert.equal(pathArgOf({ name: 'read', arguments: { file_path: 'docs/a.md' } }), 'docs/a.md')
})

test('pathArgOf：str_replace_editor 非 view 取 path，view 不取', () => {
  assert.equal(
    pathArgOf({ name: 'str_replace_editor', arguments: { command: 'create', path: 'docs/a.md' } }),
    'docs/a.md',
  )
  assert.equal(
    pathArgOf({ name: 'str_replace_editor', arguments: { command: 'view', path: 'docs/a.md' } }),
    undefined,
  )
})

test('pathArgOf：pwsh / present / glob 没有单一路径参数 → undefined', () => {
  assert.equal(pathArgOf({ name: 'pwsh', arguments: { command: 'cat docs/a.md' } }), undefined)
  assert.equal(pathArgOf({ name: 'glob', arguments: { pattern: 'docs/**' } }), undefined)
})

// ---------------------------------------------------------------- 放行

test('没有路径参数 → 放行（pwsh 拦不住，SPEC L1）', () => {
  assert.equal(call({ toolName: 'pwsh', args: { command: 'echo hi' } }).decision, GATE_ALLOW)
})

test('非 docs/ 路径 → 放行（M0-3：未读改 src/ 必须放行）', () => {
  const result = call({ toolName: 'write', args: { file_path: 'C:/proj/demo/src/x.js' } })
  assert.equal(result.decision, GATE_ALLOW)
})

test('deliverables/ → 放行（成品直接产出，不拦）', () => {
  const result = call({ toolName: 'write', args: { file_path: 'C:/proj/demo/deliverables/report.html' } })
  assert.equal(result.decision, GATE_ALLOW)
})

test('read 永不拦（即使未读）', () => {
  const result = call({ toolName: 'read', args: { file_path: 'C:/proj/demo/docs/spec-tier2.md' } })
  assert.equal(result.decision, GATE_ALLOW)
})

test('gateEnabled=false 时全放行（调试开关）', () => {
  const result = call({
    gateEnabled: false,
    toolName: 'write',
    args: { file_path: 'C:/proj/demo/docs/spec-tier2.md' },
  })
  assert.equal(result.decision, GATE_ALLOW)
})

test('读过且指纹一致 → 放行（M0-6）', () => {
  const result = call({
    toolName: 'edit',
    args: { file_path: 'C:/proj/demo/docs/spec-tier2.md' },
    readSet: new Map([['spec-tier2', { fingerprint: FP }]]),
  })
  assert.equal(result.decision, GATE_ALLOW)
})

// ---------------------------------------------------------------- 拒绝

test('未读就改 docs/ → 拒绝，理由包含缺项 id（M0-2）', () => {
  const result = call({
    toolName: 'write',
    args: { file_path: 'C:/proj/demo/docs/spec-tier2.md' },
  })
  assert.equal(result.decision, GATE_DENY)
  assert.match(result.reason, /spec-tier2/)
  assert.match(result.reason, /read/)
})

test('拒绝文案列出**所有**缺的必读 id（SPEC §7.4 第 1 条）', () => {
  const entries = [
    entry(good({ id: 'aaa', order: 10 })),
    entry(good({ id: 'bbb', order: 20 })),
    entry(good({ id: 'ccc', order: 30 })),
  ]
  const result = call({
    entries,
    toolName: 'write',
    args: { file_path: 'C:/proj/demo/docs/bbb.md' },
  })
  assert.equal(result.decision, GATE_DENY)
  assert.match(result.reason, /aaa/)
  assert.match(result.reason, /ccc/)
})

test('**指纹变了 → 视为未读**，理由指出 v3 / v5（M0-8）', () => {
  const result = call({
    toolName: 'edit',
    args: { file_path: 'C:/proj/demo/docs/spec-tier2.md' },
    readSet: new Map([['spec-tier2', { fingerprint: 'aaa111222333' }]]),
    currentFingerprint: () => FP,
  })
  assert.equal(result.decision, GATE_DENY)
  assert.match(result.reason, /重读/)
  assert.match(result.reason, /v aaa111|vaaa111/i)
})

test('改 docs/ 下没有 frontmatter 的文档 → 拒绝并说明先补 frontmatter', () => {
  const result = decideGate({
    classify: fakeClassify,
    required: [],
    readSet: new Map(),
    metaOf: () => undefined,
    toolName: 'write',
    args: { file_path: 'C:/proj/demo/docs/plain.md' },
  })
  assert.equal(result.decision, GATE_DENY)
  assert.match(result.reason, /frontmatter/)
})

test('**注册表里根本没有这份文档 → 放行**（避免误伤新建文件）', () => {
  // 与上一条的区别：`knownOf` 明确说"注册表不认识它"。
  // 典型场景：模型刚 new 出来的 docs/new.md，扫描还没覆盖到。
  // 若在这里拒绝，等于让插件自身的刷新延迟变成对模型的误伤。
  const result = decideGate({
    classify: fakeClassify,
    required: [],
    readSet: new Map(),
    metaOf: () => undefined,
    knownOf: () => false,
    toolName: 'write',
    args: { file_path: 'C:/proj/demo/docs/brand-new.md' },
  })
  assert.equal(result.decision, GATE_ALLOW)
})

test('注册表认识这份文档但没有 id → 仍然拒绝（真的没 frontmatter）', () => {
  const result = decideGate({
    classify: fakeClassify,
    required: [],
    readSet: new Map(),
    metaOf: () => undefined,
    knownOf: () => true,
    toolName: 'write',
    args: { file_path: 'C:/proj/demo/docs/plain.md' },
  })
  assert.equal(result.decision, GATE_DENY)
})

test('拿不到 knownOf 时按"已知但没 id"处理（保持 M0-2 原行为）', () => {
  const result = decideGate({
    classify: fakeClassify,
    required: [],
    readSet: new Map(),
    metaOf: () => undefined,
    toolName: 'write',
    args: { file_path: 'C:/proj/demo/docs/plain.md' },
  })
  assert.equal(result.decision, GATE_DENY)
})

test('有 error 的文档读得到但写不得（§5.4）', () => {
  const bad = entry(good({ id: 'decision-log' }), { hasError: true })
  const result = call({
    entries: [bad],
    toolName: 'write',
    args: { file_path: 'C:/proj/demo/docs/decision-log.md' },
  })
  assert.equal(result.decision, GATE_DENY)
  assert.match(result.reason, /error/)
})

// ---------------------------------------------------------------- 坟场

test('坟场：**连 read 也拒**（SPEC §8.1）', () => {
  const readResult = call({
    toolName: 'read',
    args: { file_path: 'C:/proj/demo/docs/_graveyard/old.md' },
  })
  assert.equal(readResult.decision, GATE_DENY)
  assert.match(readResult.reason, /_graveyard/)
})

test('坟场：write 也拒', () => {
  const result = call({
    toolName: 'write',
    args: { file_path: 'C:/proj/demo/docs/_graveyard/old.md' },
  })
  assert.equal(result.decision, GATE_DENY)
})

// ---------------------------------------------------------------- role 策略

test('role=evidence → write 与 edit 都拒', () => {
  const ev = entry(good({ id: 'evidence-a15', role: 'evidence' }))
  for (const toolName of ['write', 'edit']) {
    const result = call({
      entries: [ev],
      toolName,
      args: { file_path: 'C:/proj/demo/docs/evidence-a15.md', old_string: 'a', new_string: 'b' },
      readSet: new Map([['evidence-a15', { fingerprint: FP }]]),
    })
    assert.equal(result.decision, GATE_DENY, `${toolName} 应被拒`)
  }
})

test('role=handover → write 与 edit 都拒', () => {
  const ho = entry(good({ id: 'handover', role: 'handover' }))
  const result = call({
    entries: [ho],
    toolName: 'write',
    args: { file_path: 'C:/proj/demo/docs/handover.md' },
    readSet: new Map([['handover', { fingerprint: FP }]]),
  })
  assert.equal(result.decision, GATE_DENY)
})

// ---- 2026-11-14 M2.6：**draft 交接允许 edit**（用户拍板）----
//
// 背景（会话 `session-e951840c`，用户报「交接死锁」）：
// AI 建了 handover-1/2/3/4 四份，每份都被 `doc_handover_check` 挑出**1 条** H4 缺证据。
// 它想改那一条 —— 但 `edit` 被门禁拒绝，唯一出路是"再建一份新的"，
// 于是每修一行就要重写 3000 字。**44 步、4 份废交接、最后被用户中止。**
//
// 而 **SPEC-M1 §4.4 的原设计是允许的**，原文：
//   「模型写 handover 文档（用 write 新建，**或 edit 已有 draft**）」
//
// ⇒ draft = 还没定稿，改它不算改历史；一旦标成 authoritative 才是"上一轮的记录"。

test('**M2.6：role=handover 且 status=draft → edit 放行**（SPEC-M1 §4.4 的原设计）', () => {
  const ho = entry(good({ id: 'handover', role: 'handover', status: 'draft' }))
  const result = call({
    entries: [ho],
    toolName: 'edit',
    args: {
      file_path: 'C:/proj/demo/docs/handover.md',
      old_string: '§5 验收：健康检查无链断',
      new_string: '§5 验收：健康检查无链断（sha256: a1b2c3d4）',
    },
    readSet: new Map([['handover', { fingerprint: FP }]]),
    textOf: () => '# 交接\n\n§5 验收：健康检查无链断\n',
  })
  assert.equal(result.decision, GATE_ALLOW, `draft 交接应当允许 edit，实得：${result.decision}`)
})

test('**M2.6：role=handover → edit 在**任意状态**都放行**（用户第二次拍板：彻底放开）', () => {
  // 演进（三行）：
  //   1. 原实现：任何状态都拒绝 edit（注释「改交接 = 改历史」），但与 SPEC-M1 §4.4 不符。
  //   2. 第一次修：只放开 draft。实测（`session-47f59223`）**不够** ——
  //      AI 在"还有东西要改"时就标了 authoritative，随后哈希过时 → 锁死 →
  //      产生 33 000 字的往返思考（「改不了……要不要建新的？太重了」）。
  //   3. 用户第二次拍板：**任意状态都允许 edit**。
  //
  // 安全性依据：用户要求核实"你自己有没有改过给你的交接文档" ——
  // 结果是**一次都没改过**（`git log -- 交接-M2.6.md` 只有 M2.5 的两次提交）。
  // 真实使用中交接是"照做"的对象，不是"改"的对象。
  for (const status of ['draft', 'authoritative', 'partial', 'sealed', 'superseded', 'void']) {
    const ho = entry(good({ id: 'handover', role: 'handover', status }))
    const result = call({
      entries: [ho],
      toolName: 'edit',
      args: {
        file_path: 'C:/proj/demo/docs/handover.md',
        old_string: '§5 验收：健康检查无链断',
        new_string: '§5 验收：健康检查无链断（sha256: a1b2c3d4）',
      },
      readSet: new Map([['handover', { fingerprint: FP }]]),
      textOf: () => '# 交接\n\n§5 验收：健康检查无链断\n',
    })
    assert.equal(result.decision, GATE_ALLOW, `status=${status} 的交接应当允许 edit，实得：${result.decision}`)
  }
})

test('**M2.6：role=handover 且 status=draft → write 仍然拒**（新建请用 doc_new）', () => {
  const ho = entry(good({ id: 'handover', role: 'handover', status: 'draft' }))
  const result = call({
    entries: [ho],
    toolName: 'write',
    args: { file_path: 'C:/proj/demo/docs/handover.md' },
    readSet: new Map([['handover', { fingerprint: FP }]]),
  })
  assert.equal(result.decision, GATE_DENY, 'write 会绕过 doc_new 的 supersedes 链，必须继续拒绝')
})

test('role=decision → write 拒，**纯追加的 edit 放行**', () => {
  const dec = entry(good({ id: 'decision-log', role: 'decision' }))
  const readSet = new Map([['decision-log', { fingerprint: FP }]])

  const writeResult = call({
    entries: [dec],
    toolName: 'write',
    args: { file_path: 'C:/proj/demo/docs/decision-log.md' },
    readSet,
  })
  assert.equal(writeResult.decision, GATE_DENY)

  const text = '## 决策\n\n已有内容\n'
  const editResult = call({
    entries: [dec],
    toolName: 'edit',
    args: {
      file_path: 'C:/proj/demo/docs/decision-log.md',
      old_string: '已有内容',
      new_string: '已有内容\n\n## 新决策\n追加的行',
    },
    readSet,
    textOf: () => text,
  })
  assert.equal(editResult.decision, GATE_ALLOW)
})

test('role=decision → 改中间内容的 edit 被拒', () => {
  const dec = entry(good({ id: 'decision-log', role: 'decision' }))
  const text = `## 决策\n\n早期内容\n${'填充行\n'.repeat(40)}末尾\n`
  const result = call({
    entries: [dec],
    toolName: 'edit',
    args: {
      file_path: 'C:/proj/demo/docs/decision-log.md',
      old_string: '早期内容',
      new_string: '被改写的内容',
    },
    readSet: new Map([['decision-log', { fingerprint: FP }]]),
    textOf: () => text,
  })
  assert.equal(result.decision, GATE_DENY)
  assert.match(result.reason, /追加/)
})

test('role=instruction 且 status=draft → write 放行', () => {
  const ins = entry(good({ id: 'rules', role: 'instruction', status: 'draft' }))
  const result = call({
    entries: [ins],
    toolName: 'write',
    args: { file_path: 'C:/proj/demo/docs/rules.md' },
    readSet: new Map([['rules', { fingerprint: FP }]]),
  })
  assert.equal(result.decision, GATE_ALLOW)
})

test('role=instruction 且非 draft → write 拒', () => {
  const ins = entry(good({ id: 'rules', role: 'instruction' }))
  const result = call({
    entries: [ins],
    toolName: 'write',
    args: { file_path: 'C:/proj/demo/docs/rules.md' },
    readSet: new Map([['rules', { fingerprint: FP }]]),
  })
  assert.equal(result.decision, GATE_DENY)
})

test('role=log / index / fact / spec → 读写都放行', () => {
  for (const role of ['log', 'index', 'fact', 'spec']) {
    const doc = entry(good({ id: `d-${role}`, role }))
    const result = call({
      entries: [doc],
      toolName: 'write',
      args: { file_path: `C:/proj/demo/docs/d-${role}.md` },
      readSet: new Map([[`d-${role}`, { fingerprint: FP }]]),
    })
    assert.equal(result.decision, GATE_ALLOW, `${role} 应放行`)
  }
})

// ---------------------------------------------------------------- 非必读清单

test('不在必读清单的 draft 文档：读过就能改，不强制必读', () => {
  const draft = entry(good({ id: 'draft-doc', status: 'draft' }))
  const result = call({
    entries: [draft],
    toolName: 'edit',
    args: { file_path: 'C:/proj/demo/docs/draft-doc.md' },
    readSet: new Map([['draft-doc', { fingerprint: FP }]]),
  })
  assert.equal(result.decision, GATE_ALLOW)
})

test('不在必读清单但读过又变了 → 仍然拒绝（防拿旧版当依据）', () => {
  const draft = entry(good({ id: 'draft-doc', status: 'draft' }))
  const result = call({
    entries: [draft],
    toolName: 'edit',
    args: { file_path: 'C:/proj/demo/docs/draft-doc.md' },
    readSet: new Map([['draft-doc', { fingerprint: 'oldoldold' }]]),
    currentFingerprint: () => FP,
  })
  assert.equal(result.decision, GATE_DENY)
})

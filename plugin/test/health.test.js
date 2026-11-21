/**
 * `core/health.js` 的单测（H-1 – H-4）。
 *
 * **每条检查都配反例**：只测「没问题时返回 ok」等于没测。
 * 其中 H-3 是重定义过的（README 订正清单第 3 条），所以额外钉住
 * 「为什么原定义不可证伪」这件事本身。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HEALTH_RULES,
  checkHealth,
} from '../core/health.js'

/**
 * 造一个受管条目。
 * @param {string} id
 * @param {object} [meta] frontmatter 覆盖项
 * @param {object} [extra] 其它字段（body / text / path / hasError / unmanaged）
 */
function doc(id, meta = {}, extra = {}) {
  return {
    path: extra.path ?? `C:/proj/docs/${id}.md`,
    body: extra.body ?? `# ${id}`,
    text: extra.text ?? `# ${id}`,
    meta: { id, title: `${id} 标题`, role: 'spec', status: 'authoritative', order: 20, basis: '实测', ...meta },
    hasError: extra.hasError === true,
    unmanaged: extra.unmanaged === true,
  }
}

/** 跑一次健康度检查。 */
function health(entries, options = {}) {
  return checkHealth({ entries, ...options })
}

/** 取某条规则命中的文档 id。 */
function idsOf(result, rule) {
  return result.issues.filter((item) => item.rule === rule).map((item) => item.docId)
}

// ---------------------------------------------------------------- 0. 基准

test('四项检查都在（不多不少）', () => {
  assert.deepEqual(HEALTH_RULES.map((item) => item.rule), ['H-1', 'H-2', 'H-3', 'H-4'])
  assert.ok(HEALTH_RULES.every((item) => item.level === 'warn'), '四项都该是 warn，不是 error')
})

test('干净的文档集 → ok:true、issues 为空、byRule 四项都是 0', () => {
  // ⚠️ M1.5 / D7 改了这条的前提：**项目里必须有一份 role: index 的文档**才算"干净"。
  //
  // 修之前这条用的是 `health([doc('a')])`（只有一份 spec，没有索引文档），
  // 而当时的实现把"没有索引文档"**静默跳过**了，所以它显示干净。
  // D7 之后那种项目会得到 1 条 warn —— 因为"没有任何入口索引"本身就是
  // 一个值得说的事实（新会话不知道该先读哪一份），而不是"无法判定所以不用管"。
  const result = health([
    doc('read-order', { role: 'index', body: '# 阅读顺序\n\n先读 `a`。\n' }),
    doc('a'),
  ])
  assert.equal(result.ok, true)
  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.stats.byRule, { 'H-1': 0, 'H-2': 0, 'H-3': 0, 'H-4': 0 })
})

test('D7：项目里**没有任何 role: index 文档** → 报 1 条项目级 warn（不再静默跳过）', () => {
  const result = health([doc('a')])
  const h3 = result.issues.filter((item) => item.rule === 'H-3')
  assert.equal(h3.length, 1, '只报 1 条，不逐份刷')
  assert.equal(h3[0].docId, '(项目)')
  assert.match(h3[0].message, /index/)
  assert.equal(result.ok, true, '仍然是 warn，不阻塞')
})

test('D7：**完全空的项目**不报（没有文档就没有"缺入口索引"这回事）', () => {
  const result = health([])
  assert.deepEqual(result.issues, [])
})

test('**健康度里没有任何 error**：ok 永远为 true（它不阻塞施工）', () => {
  const result = health([
    doc('a', { basis: '未验证' }),
    doc('b', { supersededBy: ['c'] }),
    doc('c', { status: 'superseded', supersededBy: ['d'] }),
    doc('d', { verifiedDsh: '0.0.1' }),
  ], { anchors: { dsh: '0.2.2-rc.1' } })
  assert.equal(result.ok, true)
  assert.equal(result.stats.errors, 0)
  assert.ok(result.issues.length >= 3)
})

test('没有 frontmatter 的条目（unmanaged）不参与健康度', () => {
  const result = health([doc('plain', {}, { unmanaged: true, meta: undefined })])
  assert.equal(result.stats.docs, 0)
  assert.deepEqual(result.issues, [])
})

// ---------------------------------------------------------------- 1. H-1 未反填

test('**H-1：A.supersededBy 含 B 但 B 没有反填 → 报 A**（dogfood 里的真实案例）', () => {
  const result = health([
    doc('handover-to-tier2', { status: 'superseded', supersededBy: ['handover-to-tier26'] }),
    doc('handover-to-tier26'),
  ])
  assert.deepEqual(idsOf(result, 'H-1'), ['handover-to-tier2'])
  const issue = result.issues.find((item) => item.rule === 'H-1')
  assert.ok(issue.message.includes('handover-to-tier2') && issue.message.includes('handover-to-tier26'))
})

test('H-1：反填了 → 不报', () => {
  const result = health([
    doc('a', { status: 'superseded', supersededBy: ['b'] }),
    doc('b', { supersedes: ['a'] }),
  ])
  assert.deepEqual(idsOf(result, 'H-1'), [])
})

test('H-1：指向不存在的 id → 不在这里报（V5 已经报过，不重复）', () => {
  const result = health([doc('a', { status: 'superseded', supersededBy: ['ghost'] })])
  assert.deepEqual(idsOf(result, 'H-1'), [])
})

test('H-1：带锚点的引用 `b#3` 按 id `b` 处理', () => {
  const result = health([
    doc('a', { status: 'superseded', supersededBy: ['b#3'] }),
    doc('b'),
  ])
  assert.deepEqual(idsOf(result, 'H-1'), ['a'])
})

test('**H-1 与 V8 去重**：同一对 (A→B) 只报一条（不因一条链报两次）', () => {
  const result = health([
    doc('a', { status: 'superseded', supersededBy: ['b', 'b#2'] }),
    doc('b'),
  ])
  assert.equal(idsOf(result, 'H-1').length, 1, '同一个目标被重复报了两条')
})

// ---------------------------------------------------------------- 2. H-2 链断/成环

test('H-2：superseded 但没有 supersededBy → 报', () => {
  const result = health([doc('a', { status: 'superseded' })])
  assert.deepEqual(idsOf(result, 'H-2'), ['a'])
})

test('**H-2：链成环 → 报，且不无限循环**', () => {
  const result = health([
    doc('a', { status: 'superseded', supersededBy: ['b'] }),
    doc('b', { status: 'superseded', supersededBy: ['a'] }),
  ])
  assert.ok(idsOf(result, 'H-2').length >= 1, '环没有被发现')
  assert.ok(result.issues.some((item) => item.rule === 'H-2' && item.message.includes('成环')))
})

test('H-2：链走到一个非 superseded 的文档 → 正常，不报', () => {
  const result = health([
    doc('a', { status: 'superseded', supersededBy: ['b'] }),
    doc('b', { status: 'superseded', supersededBy: ['c'] }),
    doc('c'),
  ])
  assert.deepEqual(idsOf(result, 'H-2'), [])
})

test('H-2：链指向不存在的 id → 不在这里报（V5 的职责）', () => {
  const result = health([doc('a', { status: 'superseded', supersededBy: ['ghost'] })])
  assert.deepEqual(idsOf(result, 'H-2'), [])
})

test('H-2：自指（自己取代自己）→ 当成成环', () => {
  const result = health([doc('a', { status: 'superseded', supersededBy: ['a'] })])
  assert.ok(idsOf(result, 'H-2').includes('a'))
})

test('**H-2 的循环真的会跑**：长链也能走到终点（回归 managed.size 那个 bug）', () => {
  // 曾经的 bug：循环上界写成 `managed.size`（数组没有 size，是 undefined），
  // `0 <= undefined` 为 false → 循环一次都不跑 → **H-2 永远不报**。
  // 这正是「看起来严格但永远通过」。这条断言让循环必须真的走起来。
  const chain = []
  for (let index = 0; index < 6; index += 1) {
    chain.push(doc(`d${index}`, { status: 'superseded', supersededBy: [`d${index + 1}`] }))
  }
  chain.push(doc('d6')) // 终点：非 superseded
  const result = health(chain)
  assert.deepEqual(idsOf(result, 'H-2'), [], '正常长链被误报')

  // 把链中间的 supersededBy 抹掉，让链真的断掉 → 必须报出来（证明循环确实在走）
  const brokenChain = chain.map((item, index) => (index === 3
    ? doc('d3', { status: 'superseded' }) // 没有 supersededBy
    : item))
  const broken = health(brokenChain)
  assert.ok(idsOf(broken, 'H-2').includes('d3'), '断掉的链没有被发现 —— 循环可能没跑')
})

// ---------------------------------------------------------------- H-3 shared entry discoverability

test('M4 H-3: valid index needs no body listing for other documents', () => {
  const result = health([doc('index', { role: 'index' }), doc('orphan')])
  assert.deepEqual(idsOf(result, 'H-3'), [])
})

test('M4 H-3: published handover is an entry without an index', () => {
  const result = health([doc('h', { role: 'handover' }), doc('spec')])
  assert.deepEqual(idsOf(result, 'H-3'), [])
})

test('M4 H-3: drafts, invalid documents and graveyard entries are not entry points', () => {
  for (const bad of [doc('h', { role: 'handover', status: 'draft' }),
    doc('i', { role: 'index' }, { hasError: true }),
    { ...doc('h', { role: 'handover' }), inGraveyard: true }]) {
    const result = health([bad, doc('s')])
    assert.deepEqual(idsOf(result, 'H-3'), ['(项目)'])
  }
})

test('M4 H-3: reference list parameter cannot change entry discovery', () => {
  const entries = [doc('i', { role: 'index' }), doc('s')]
  assert.deepEqual(health(entries).issues, health(entries, { required: [] }).issues)
})

// ---------------------------------------------------------------- 4. H-4 锚点漂移

test('**H-4：verifiedDsh 与当前环境不符 → 报**', () => {
  const result = health([doc('spec-tier1', { verifiedDsh: '0.1.0' })], { anchors: { dsh: '0.2.2-rc.1' } })
  assert.deepEqual(idsOf(result, 'H-4'), ['spec-tier1'])
  assert.ok(result.issues.find((item) => item.rule === 'H-4').message.includes('0.1.0'))
})

test('H-4：三个锚点分别判', () => {
  const result = health([
    doc('a', { verifiedBundle: '0.0.9' }),
    doc('b', { verifiedCommit: 'abc123' }),
  ], { anchors: { bundle: '0.1.0', commit: 'def456' } })
  assert.deepEqual(idsOf(result, 'H-4').sort(), ['a', 'b'])
})

test('H-4：一致 → 不报；当前环境未知 → 不报（不猜）', () => {
  assert.deepEqual(idsOf(health([doc('a', { verifiedDsh: '0.2.2-rc.1' })], { anchors: { dsh: '0.2.2-rc.1' } }), 'H-4'), [])
  assert.deepEqual(idsOf(health([doc('a', { verifiedDsh: '0.1.0' })], { anchors: {} }), 'H-4'), [])
})

// ---- A4 独立评审：H-4 的 dsh / commit 是死分支

test('**H-4：环境值未知时必须记进 skipped，不能静默跳过**（A4 反例）', () => {
  // `index.js` 实际传的 anchors 是 `{ dsh: undefined, bundle: '0.1.0', commit: undefined }`，
  // 于是 verifiedDsh / verifiedCommit **从未被检查过** —— 死分支，而且没有任何痕迹。
  // 修法：跳过的锚点记进 `skipped`，工具层如实展示。
  const result = health([doc('a', { verifiedDsh: '0.0.1', verifiedCommit: 'deadbeef' })],
    { anchors: { dsh: undefined, bundle: '0.1.0', commit: undefined } })
  assert.deepEqual(idsOf(result, 'H-4'), [], '当前值未知时不该报（不猜）')
  assert.equal(result.skipped.length, 2, `跳过的锚点没有被记录：${JSON.stringify(result.skipped)}`)
  assert.ok(result.skipped.some((item) => item.includes('verifiedDsh')))
  assert.ok(result.skipped.some((item) => item.includes('verifiedCommit')))
})

test('H-4：环境值给齐时 skipped 为空，且能真的报出漂移', () => {
  const result = health([doc('a', { verifiedDsh: '0.0.1', verifiedCommit: 'deadbeef' })],
    { anchors: { dsh: '0.2.2-rc.1', bundle: '0.1.0', commit: 'abc123' } })
  assert.deepEqual(result.skipped, [])
  assert.equal(idsOf(result, 'H-4').length, 2)
})

test('H-4：文档没声明某个锚点 → 不算 skipped（不该虚报）', () => {
  const result = health([doc('a')], { anchors: { dsh: undefined, bundle: '0.1.0', commit: undefined } })
  assert.deepEqual(result.skipped, [])
})

test('M4: authoritative with unverified basis does not produce H-5', () => {
  const result = health([doc('read-order', { role: 'index' }), doc('guess', { basis: '未验证' })])
  assert.deepEqual(idsOf(result, 'H-5'), [])
  assert.equal(Object.hasOwn(result.stats.byRule, 'H-5'), false)
})

// ---------------------------------------------------------------- 6. 输出稳定性

test('**同一输入两次调用，issues 逐字节相同**（便于 diff）', () => {
  const entries = [
    doc('z', { basis: '未验证' }),
    doc('a', { verifiedDsh: '0.0.1' }),
    doc('m', { status: 'superseded', supersededBy: ['a'] }),
  ]
  const first = health(entries, { anchors: { dsh: '9.9.9' } })
  const second = health(entries, { anchors: { dsh: '9.9.9' } })
  assert.deepEqual(first.issues, second.issues)
})

test('排序：error 优先，同级按 docId 字典序', () => {
  const result = health([
    doc('zeta', { basis: '未验证' }),
    doc('alpha', { basis: '未验证' }),
    doc('beta', { verifiedDsh: '0.0.1' }),
  ], { anchors: { dsh: '1.0.0' } })
  const ids = result.issues.map((item) => item.docId)
  assert.deepEqual(ids, [...ids].sort(), `没有按 docId 排序：${ids}`)
})

test('空输入 / 坏输入不抛', () => {
  assert.doesNotThrow(() => checkHealth({}))
  assert.doesNotThrow(() => checkHealth(null))
  assert.doesNotThrow(() => checkHealth({ entries: [null, undefined, 42, 'x'] }))
})

test('stats：docs / required / errors / warnings 都对', () => {
  // ⚠️ M1.5 / D7：配一份 index 文档，否则会多一条项目级 warn（warnings 会从 1 变 2）。
  // 注意 `stats.required` 是**从 entries 自己算**的（只认 authoritative/partial 且无 error），
  // 所以 index 文档也计入 —— 3 份文档 = 3 条 required。
  const result = health([
    doc('read-order', { role: 'index' }),
    doc('a'),
    doc('b', { basis: '未验证' }),
  ])
  assert.equal(result.stats.docs, 3)
  assert.equal(result.stats.required, 3)
  assert.equal(result.stats.warnings, 0, '有效入口不要求列出各文档；basis 不再告警')
  assert.equal(result.stats.errors, 0)
})

/**
 * 「AI 阅读顺序」条的测试（M2.3 · 需求 2）。
 *
 * ---- 这个文件要钉住的四件事 ----
 *
 * 1. **顺序不许 client 重排**：`required` 的给定顺序**就是**显示顺序。
 *    这条是本切片最容易悄悄写错的地方 —— 顺手 `sort` 一下看起来"更整齐"，
 *    实际会造出与索引块不一致的第二套顺序。
 * 2. **已读是 AI 的已读**：`read` 只认 `=== true`，缺字段/字符串 `'true'` 都不算。
 * 3. **坏输入不抛、不吞位置**：空数组返回空、非数组返回空、`id` 为空仍然占位
 *    （跳过会让序号与索引块错位）。
 * 4. **收起状态存不进也不炸**：隐私模式下 `localStorage` 是**抛**而不是返回 null。
 *
 * ⚠️ 所有断言都先证明**夹具真的非空**（M1.5 反复栽的"空数组上断言恒真"）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  READ_ORDER_MEMORY_PREFIX,
  READ_ORDER_ROOT_SCOPE,
  READ_ORDER_STORAGE_KEY,
  canPersistMemory,
  defaultStorage,
  memoryIdsOf,
  memoryKeyOf,
  readCollapsedOf,
  readMemoryOf,
  readOrderOf,
  readOrderProgressOf,
  rememberReadOf,
  statusMarkOf,
  writeCollapsedTo,
  writeMemoryTo,
} from '../src/client/read-order.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_SRC = join(HERE, '..', 'src', 'client')

/** 造一条 `required` 文档（形状照 `SnapshotDoc`，只填用得到的字段）。 */
function doc(overrides = {}) {
  return {
    id: 'a',
    role: 'spec',
    order: 10,
    status: 'authoritative',
    summary: '',
    title: '',
    fingerprint: '',
    read: false,
    verifiedAt: null,
    hasError: false,
    ...overrides,
  }
}

/** 一个内存 storage（`localStorage` 的结构性子集）。 */
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, value) },
    /** 测试用：直接看底层。 */
    raw: map,
  }
}

test('readOrderOf：**给定顺序就是显示顺序**（client 绝不重排）', () => {
  // 故意给一个**乱序**的 order：若实现里偷偷 sort，断言会红。
  const required = [
    doc({ id: 'read-order', order: 0 }),
    doc({ id: 'spec-main', order: 10 }),
    doc({ id: 'handover', order: -70 }),
  ]
  const items = readOrderOf(required)

  // 先证明夹具非空（否则下面的 deepEqual 恒真）。
  assert.equal(items.length, 3, '夹具没读到数据 —— 后面的断言会变成恒真')
  assert.deepEqual(
    items.map((item) => item.id),
    ['read-order', 'spec-main', 'handover'],
    'client 重排了顺序 —— 会造出与索引块不一致的第二套顺序',
  )
  // 序号是**位置**，不是 order 字段。
  assert.deepEqual(items.map((item) => item.seq), [1, 2, 3])
})

test('readOrderOf：**read 只认 === true**（字符串 / 缺字段都不算已读）', () => {
  const items = readOrderOf([
    doc({ id: 'a', read: true }),
    doc({ id: 'b', read: false }),
    doc({ id: 'c', read: 'true' }),
    doc({ id: 'd' }),
  ])
  assert.equal(items.length, 4, '夹具没读到数据')
  assert.deepEqual(items.map((item) => item.read), [true, false, false, false])
})

test('readOrderOf：**坏输入一律返回空数组，不抛**', () => {
  assert.deepEqual(readOrderOf(undefined), [])
  assert.deepEqual(readOrderOf(null), [])
  assert.deepEqual(readOrderOf([]), [])
  assert.deepEqual(readOrderOf('not-an-array'), [])
  assert.deepEqual(readOrderOf([null, 42]), [])
})

test('readOrderOf：**id 为空仍然占位**（跳过会让序号与索引块错位）', () => {
  const items = readOrderOf([doc({ id: '' }), doc({ id: 'b' })])
  assert.equal(items.length, 2, '空 id 的那条被吞了 —— 序号会与索引块错位')
  assert.equal(items[0].id, '')
  assert.equal(items[0].seq, 1)
  assert.equal(items[1].seq, 2)
})

test('readOrderProgressOf：**0 篇必读不算 ready**（"没有必读"不等于"读完了"）', () => {
  const empty = readOrderProgressOf([])
  assert.deepEqual(empty, { total: 0, read: 0, ready: false })

  const partial = readOrderProgressOf(readOrderOf([doc({ id: 'a', read: true }), doc({ id: 'b' })]))
  assert.deepEqual(partial, { total: 2, read: 1, ready: false })

  const done = readOrderProgressOf(readOrderOf([doc({ id: 'a', read: true }), doc({ id: 'b', read: true })]))
  assert.deepEqual(done, { total: 2, read: 2, ready: true })
})

test('readOrderProgressOf：**与 host 的 gate 同一判据**（总数 = 必读条数）', () => {
  // 这条防的是"条上的 7/7 与索引块的 0/7 打架"。
  const required = Array.from({ length: 7 }, (_, index) => doc({ id: `d${index}`, read: index < 3 }))
  const progress = readOrderProgressOf(readOrderOf(required))
  assert.equal(progress.total, 7, '总数必须等于 required.length')
  assert.equal(progress.read, 3)
  assert.equal(progress.ready, false)
})

test('readCollapsedOf：**默认展开**（默认藏起来的控件等于没有）', () => {
  assert.equal(readCollapsedOf(undefined), false, '拿不到 storage 时必须默认展开')
  assert.equal(readCollapsedOf(memoryStorage()), false, '没存过时必须默认展开')
  assert.equal(readCollapsedOf(memoryStorage({ [READ_ORDER_STORAGE_KEY]: '1' })), true)
  // 损坏值 / 空串：一律当展开，不猜。
  assert.equal(readCollapsedOf(memoryStorage({ [READ_ORDER_STORAGE_KEY]: '' })), false)
  assert.equal(readCollapsedOf(memoryStorage({ [READ_ORDER_STORAGE_KEY]: 'yes' })), false)
})

test('writeCollapsedTo：存得进去，且**读得回来**（往返一致）', () => {
  const storage = memoryStorage()
  writeCollapsedTo(storage, true)
  assert.equal(storage.raw.get(READ_ORDER_STORAGE_KEY), '1')
  assert.equal(readCollapsedOf(storage), true)

  writeCollapsedTo(storage, false)
  assert.equal(storage.raw.get(READ_ORDER_STORAGE_KEY), '0')
  assert.equal(readCollapsedOf(storage), false)
})

test('回归：**storage 抛错时既不炸也不改判**（隐私模式下 localStorage 是抛）', () => {
  // 隐私模式 / 策略禁用时，`localStorage.getItem` **抛**而不是返回 null。
  const throwing = {
    getItem: () => { throw new Error('SecurityError') },
    setItem: () => { throw new Error('SecurityError') },
  }
  assert.equal(readCollapsedOf(throwing), false, '读失败必须降级为展开，不能抛给 React')
  // 写失败同样不许抛（否则一次点击就让整个面板白屏）。
  assert.doesNotThrow(() => { writeCollapsedTo(throwing, true) })
})

test('defaultStorage：拿不到 localStorage 时返回 undefined（不抛）', () => {
  // Node 里本来就没有 localStorage —— 这本身就是"拿不到"的真实样本。
  const original = globalThis.localStorage
  try {
    delete globalThis.localStorage
    assert.equal(defaultStorage(), undefined)
  } finally {
    if (original !== undefined) globalThis.localStorage = original
  }
})

test('回归：**阅读顺序条只读 required**（不许改成 all —— 那会把 AI 不需要读的也列上）', () => {
  const bar = readFileSync(join(CLIENT_SRC, 'read-order-bar.tsx'), 'utf8')
  // 2026-11-14 起 `readOrderOf` 多一个"本地记忆"参数（勾只增不减），
  // 所以断言用 `snapshot.required` 而不是完整的调用形状。
  assert.match(bar, /readOrderOf\(snapshot\.required/, '条的数据源必须是 snapshot.required')
  assert.doesNotMatch(bar, /readOrderOf\(snapshot\.all/, '不许改成 all（W3 已拍板用 required）')
})

test('回归：**条挂在 BodyWith 的 footer 上**（挂在外面会在没选项目根时显示假进度）', () => {
  const page = readFileSync(join(CLIENT_SRC, 'index.tsx'), 'utf8')
  // footer 必须是 BodyWith 的入参，而不是 BoardPage 里平铺的兄弟节点。
  assert.match(page, /footer:\s*\(snapshot\)\s*=>/, 'BoardPage/BoardPanel 必须通过 footer 传条')
  assert.match(page, /footer\?:/, 'BodyWith 必须接受 footer 入参')
  // 两个席位都要有（少一个就是"主栏有、右栏没有"）。
  const footers = [...page.matchAll(/footer:\s*\(snapshot\)\s*=>/g)]
  assert.equal(footers.length, 2, `应当两个席位各一个 footer，实际 ${footers.length} 个`)
})

test('回归：**已读标记不许用绿色**（否则与置信度的 🟢 撞成两个绿圆）', () => {
  // 2026-11-14 用户实测指出：「绿点指的应该是高置信度，右侧空着的白点才应该是 ai 读过的标识。」
  //
  // 这是**视觉语义**的 bug，不是文案 bug：
  // chip 上 `🟢` 表示置信度（statusMarkOf），后面的圆表示已读。
  // 旧版已读画成**实心绿点**，于是已读 chip 变成 `🟢 … 🟢` 两个绿圆，分不清。
  const bar = readFileSync(join(CLIENT_SRC, 'read-order-bar.tsx'), 'utf8')
  const code = bar.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  // 已读样式的块里**不许**出现 success 色 / 任何绿色。
  const readMarkBlock = /readMark:\s*\{([\s\S]*?)\n\s*\},/.exec(code)
  assert.ok(readMarkBlock !== null, '找不到 readMark 样式块')
  assert.ok(
    !/state-success/.test(readMarkBlock[1]),
    'readMark 用了 success 色 —— 会和置信度的 🟢 撞车（2026-11-14 用户指出的歧义）',
  )
  // 已读用形状（✓），不是色块。
  assert.match(code, /item\.read \? '✓' : ''/, '已读标记必须是 ✓ 这种形状，不能是色块')
})

test('回归：**置信度与已读是两个独立标识**（文案必须分开说）', () => {
  const bar = readFileSync(join(CLIENT_SRC, 'read-order-bar.tsx'), 'utf8')
  // 先剥注释：注释里**故意**引用了旧文案作为历史说明，不该让断言红。
  const code = bar.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  // 旧文案「绿点 = AI 读过」把置信度说成了已读 —— 代码里必须已经改掉。
  assert.ok(
    !code.includes('绿点 = AI 读过'),
    '旧文案「绿点 = AI 读过」还在代码里 —— 它把置信度说成了已读（用户 2026-11-14 指出）',
  )
  // 新文案要同时说清两者。
  assert.match(code, /🟢 状态/, '文案必须说明 🟢 是文档状态，不是读取标记')
  // 2026-11-14 第二轮：措辞从「AI 读过」改成「AI 已读完」——
  // 因为语义变成了"接手时的阅读已完成"，而不是实时读数。
  assert.match(code, /✓ = AI 读过/, '文案必须显式说明 ✓ 只记录 AI 曾读取')
  // 并且必须说明"只增不减"（否则用户会以为改文档后勾该消失）。
  assert.match(code, /只增不减/, '必须说明勾不会因为改文档而撤销')
  // 置信度那格必须带 title（鼠标悬停能确认它是什么）。
  assert.match(code, /title: `文档状态：\$\{item\.status\}`/, '状态徽标必须带 title 说明')
})

test('回归：**chip 在 root 面板里不可点**（不许"看起来能点、点了没反应"）', () => {
  const bar = readFileSync(join(CLIENT_SRC, 'read-order-bar.tsx'), 'utf8')
  // 必须存在一个 cursor: default 的静态 chip 样式，且由 previewDisabled 切换。
  assert.match(bar, /chipStatic/, '必须有不可点的 chip 样式')
  assert.match(bar, /const clickable = !previewDisabled/, '可点与否必须由 previewDisabled 决定')
  assert.match(bar, /cursor: 'default'/, '不可点的 chip 必须是 cursor: default')
})

// ---- 2026-11-14 演练复盘 D4（用户第二次澄清）：勾只增不减 ----
//
// 用户原话：「ai 在编辑文档后，文档的勾会失效，但按阅读顺序阅读并画勾
// 是**一开始被交接时**应该做完的，它大概不应该因为工作就被取消掉。
// ai 自己工作时新加的文档大概也应该默认画勾。」
//
// 核心：条上的 ✓ 是"接手时的阅读完成了"这个**收尾状态**，不是实时门禁读数。

test('**D4：改文档后 `read` 变 false，但记忆里的勾要保住**（用户报告的现象）', () => {
  // 场景：接手时读过 spec（read=true）→ 工作里改了它（read 变 false）。
  // 期望：条上**仍然是勾**，因为"接手时读过"这个事实没变。
  const afterEdit = readOrderOf([doc({ id: 'spec', read: false })], ['spec'])
  assert.equal(afterEdit.length, 1, '夹具没读到数据')
  assert.equal(afterEdit[0].read, true, '改过文档后勾被撤销了 —— 正是用户报告的问题')
})

test('**D4：AI 自己新加的文档（read=true）也要画勾**', () => {
  const items = readOrderOf([doc({ id: 'brand-new', read: true })], [])
  assert.equal(items[0].read, true, '新文档读过却没有勾')
})

test('**D4：记忆与当前读数取并集**（任一为真就算读过）', () => {
  const items = readOrderOf(
    [doc({ id: 'a', read: true }), doc({ id: 'b', read: false }), doc({ id: 'c', read: false })],
    ['b'],
  )
  assert.deepEqual(items.map((item) => item.read), [true, true, false])
})

test('**D4：rememberReadOf 只增不减**（不会因为这次没读到就忘掉）', () => {
  const before = ['a', 'b']
  // 这次渲染里 b 因为被改过而 read=false，c 是新读的。
  const items = [
    { seq: 1, id: 'a', role: '', status: '', read: true, hasError: false, summary: '' },
    { seq: 2, id: 'b', role: '', status: '', read: false, hasError: false, summary: '' },
    { seq: 3, id: 'c', role: '', status: '', read: true, hasError: false, summary: '' },
  ]
  const next = rememberReadOf(items, before)
  assert.deepEqual([...next].sort(), ['a', 'b', 'c'], 'b 被忘掉了 —— 勾会回退')
})

test('**D4：rememberReadOf 保留已不在清单里的 id**（历史不该因文档状态变化而消失）', () => {
  const next = rememberReadOf([], ['gone-doc'])
  assert.ok(next.has('gone-doc'), '已经不在 required 里的 id 也该保留记忆')
})

test('**D4：rememberReadOf 不记空 id**（坏文档不该污染记忆）', () => {
  const next = rememberReadOf(
    [{ seq: 1, id: '', role: '', status: '', read: true, hasError: false, summary: '' }],
    [],
  )
  assert.equal(next.size, 0, '空 id 被记进去了')
})

test('**D4：本地记忆存储往返一致**（写进去能读回来）', () => {
  const storage = memoryStorage()
  writeMemoryTo(storage, 's1', ['a', 'b'])
  assert.deepEqual(readMemoryOf(storage, 's1'), ['a', 'b'])
  // 空集也要能存能读。
  writeMemoryTo(storage, 's1', [])
  assert.deepEqual(readMemoryOf(storage, 's1'), [])
})

test('**D4：记忆读写的坏输入一律不抛**（隐私模式下 storage 是抛）', () => {
  const throwing = {
    getItem: () => { throw new Error('SecurityError') },
    setItem: () => { throw new Error('SecurityError') },
  }
  assert.deepEqual(readMemoryOf(throwing, 's1'), [], '读失败要退化成空集')
  assert.doesNotThrow(() => writeMemoryTo(throwing, 's1', ['a']))
  assert.deepEqual(readMemoryOf(undefined, 's1'), [])
  assert.doesNotThrow(() => writeMemoryTo(undefined, 's1', ['a']))
})

test('**D4：损坏的存储值退化成空集**（不猜、不抛）', () => {
  const storage = memoryStorage({ [memoryKeyOf('s1')]: ',,  ,' })
  assert.deepEqual(readMemoryOf(storage, 's1'), [], '全是空项时要返回空数组')
  const storage2 = memoryStorage({ [memoryKeyOf('s1')]: ' a , b ,' })
  assert.deepEqual(readMemoryOf(storage2, 's1'), ['a', 'b'], '要能容忍多余空白')
})

// ---- 2026-11-14 演练复盘 D4 第三次澄清：**记忆必须按会话隔离** ----
//
// 用户原话：「阅读顺序的勾应该在换一个会话（也就是下一个交接会话）时被清空，
// 因为 ai 还没读过它们。」
//
// 他截图看到的症状：API 返回 gate=0/3（全未读），但条上 3 个 chip **全打了勾**。
// 根因：第一版所有会话共用一个 localStorage 键，工作者的勾渗到了接手者。

test('**D4：不同会话的记忆互不可见**（用户报告的真缺陷）', () => {
  const storage = memoryStorage()
  // 会话 A（工作者）读过 3 份。
  writeMemoryTo(storage, 'session-A', ['read-order', 'spec-report', 'handover-002'])

  // 会话 B（接手者）**什么都没读过** —— 必须看到空。
  assert.deepEqual(
    readMemoryOf(storage, 'session-B'),
    [],
    '会话 B 读到了 A 的勾 —— 这正是用户截图里的现象',
  )
  // 而 A 自己的记忆仍然在。
  assert.deepEqual(readMemoryOf(storage, 'session-A').length, 3)
})

test('**D4：root 面板（sessionId 为空）用独立命名空间**，不与任何会话共享', () => {
  const storage = memoryStorage()
  writeMemoryTo(storage, '', ['a'])
  assert.deepEqual(readMemoryOf(storage, ''), ['a'], 'root 自己存得进去')
  assert.deepEqual(readMemoryOf(storage, 'session-A'), [], 'root 的勾不能渗到会话 A')
  // 会话写入也不能渗到 root。
  writeMemoryTo(storage, 'session-A', ['b'])
  assert.deepEqual(readMemoryOf(storage, ''), ['a'], 'root 的记忆被会话污染了')
})

test('memoryKeyOf：空 sessionId → `__root__`；有 sessionId → 带 id', () => {
  assert.equal(memoryKeyOf(''), `${READ_ORDER_MEMORY_PREFIX}.${READ_ORDER_ROOT_SCOPE}`)
  assert.equal(memoryKeyOf('session-abc'), `${READ_ORDER_MEMORY_PREFIX}.session-abc`)
  // 两个不同的会话必须产生**不同**的键（这是隔离的全部机制）。
  assert.notEqual(memoryKeyOf('s1'), memoryKeyOf('s2'))
  assert.notEqual(memoryKeyOf(''), memoryKeyOf('s1'))
})

test('**D4：`memoryKeyOf` 必须以会话 id 结尾**（否则两个会话共用一个键）', () => {
  // ⚠️ 这条是变异 `memory-key-global` 存活逼出来的。
  //
  // 我原来只断言"两个键不相等"，而变异把实现改成 `return READ_ORDER_MEMORY_PREFIX`
  // （恒返回同一个常量）时，`notEqual` 会红 —— 但变异**存活**了。
  // 原因：那条变异同时让写入也走同一个键，而往返测试用的是**同一个 sessionId**，
  // 于是"键退化"这件事在单会话的测试里完全看不见。
  //
  // 所以要直接钉住**键的形状**：它必须**包含** sessionId，
  // 且必须能区分任意两个不同会话（不是靠"碰巧不等"）。
  assert.ok(memoryKeyOf('session-A').endsWith('session-A'), '键必须包含 sessionId')
  assert.ok(memoryKeyOf('s1') !== memoryKeyOf('s2'), '任意两个会话的键都不能相同')
  assert.ok(
    memoryKeyOf('s1').length > READ_ORDER_MEMORY_PREFIX.length,
    '键不能退化成只有前缀（那就成了全局键）',
  )
})

// ---- 2026-11-14 M2.5：记忆**自带归属**，堵掉切会话那一帧的泄漏 ----
//
// 背景：M2.3 已经把记忆键按 sessionId 分开了（上面那组测试钉着）。
// 但键分开**不够** —— state 里存的是"上一个会话的 id 列表"，而 sessionId 已经是新的。
// 那一帧里：
//   ① 渲染会把 A 的勾算成 B 的（用户能看见假的 ✓）；
//   ② 写盘守卫 `next.size === old.length` 会被骗过（A 的两个 ∪ B 真实读过的 > A 的两个），
//      于是 **A 的勾被写进 B 的键**，下次打开 B 仍然是假的。
// 这正是用户 2026-11-14 截图报的那条症状从另一条路回来。

test('**M2.5：记忆属于别的会话时，渲染绝不沿用它的 id**（切会话那一帧的泄漏）', () => {
  const storage = memoryStorage()
  // 会话 A 读过两份。
  writeMemoryTo(storage, 'session-A', ['handover-002', 'spec-report'])
  // 手上还是 A 的记忆（切到 B 的那一帧，effect 还没跑）。
  const staleMemory = { sessionId: 'session-A', ids: ['handover-002', 'spec-report'] }

  // 当前会话是 B —— 必须拿到 B 自己的（空的），而不是 A 的那两份。
  assert.deepEqual(
    memoryIdsOf(storage, staleMemory, 'session-B'),
    [],
    '切到会话 B 时沿用了 A 的记忆 —— 条上会出现 B 根本没读过的 ✓',
  )
  // 而 A 自己那边仍然读得到。
  assert.deepEqual(memoryIdsOf(storage, staleMemory, 'session-A'), ['handover-002', 'spec-report'])
})

test('**M2.5：只有记忆属于当前会话时才允许写盘**（否则会把 A 的勾写进 B 的键）', () => {
  // 守卫必须**拒绝**陈旧归属 —— 这是修那个竞态的关键一行。
  assert.equal(
    canPersistMemory({ sessionId: 'session-A', ids: ['a'] }, 'session-B'),
    false,
    '陈旧的记忆被允许写盘 —— A 的勾会被写进 B 的键，下次打开 B 仍是假的',
  )
  // 归属正确时必须允许（否则正常会话永远存不进勾）。
  assert.equal(canPersistMemory({ sessionId: 'session-B', ids: [] }, 'session-B'), true)
  // 没有记忆 = 还没初始化，不许写（避免用空记忆覆盖盘上已有的）。
  assert.equal(canPersistMemory(undefined, 'session-B'), false)
  assert.equal(canPersistMemory(null, 'session-B'), false)
})

test('**M2.5：归属守卫把"泄漏写盘"这条路径整条堵住**（端到端复现用户症状）', () => {
  // 完整复现：A 的记忆 + B 的快照（B 真实读过 1 份 **A 没读过的**）+ 切会话那一帧。
  //
  // ⚠️ 这份夹具的关键是第三份 `b-only`：它让"这一帧算出的集合"**真的比 A 的记忆大**，
  // 于是 `next.size === old.length` 那道守卫**拦不住** —— 这正是这个竞态能成真的前提。
  // 第一版我漏了它，于是复现失败（集合没变大，旧守卫本来就能拦），
  // 那条断言反而证明了"我复现的不是真问题"。夹具错了，结论也就错了。
  const storage = memoryStorage()
  writeMemoryTo(storage, 'session-A', ['handover-002', 'spec-report'])
  const stale = { sessionId: 'session-A', ids: readMemoryOf(storage, 'session-A') }

  const sessionId = 'session-B'
  const bSnapshot = [
    doc({ id: 'handover-002', read: false }),
    doc({ id: 'spec-report', read: true }),
    doc({ id: 'b-only', read: true }), // ← B 自己读过、A 没读过的
  ]

  // ① 渲染层：B 的 chip 不许按 A 的记忆算成已读。
  const visible = memoryIdsOf(storage, stale, sessionId)
  const items = readOrderOf(bSnapshot, visible)
  assert.deepEqual(
    items.map((item) => item.read),
    [false, true, true],
    'B 里 handover-002 显示成了已读 —— 那是 A 的记忆渗过来了',
  )

  // ② 写盘层：守卫必须拦住这一帧的写入。
  assert.equal(canPersistMemory(stale, sessionId), false, '守卫没拦住 → 接下来就会污染 B 的键')

  // ③ 证明"没有守卫时确实会被污染"（否则上面那条断言可能是恒真的）：
  //    照原实现（直接用 stale.ids 当 previous）算一遍 —— 集合确实变大，`size` 守卫拦不住。
  const naiveNext = rememberReadOf(items, stale.ids)
  assert.ok(
    naiveNext.size > stale.ids.length,
    '这条复现本身失效了：集合没变大，`size` 守卫本来就能拦住',
  )
  // 而且它把 A 的 handover-002 带进了 B 的集合 —— 这就是会写进 B 键的内容。
  assert.ok(naiveNext.has('handover-002'), '复现失效：A 的 id 没被带进来')

  // ④ 正确的收尾：B 的键必须仍然是空的（这一帧什么都没写进去）。
  assert.deepEqual(readMemoryOf(storage, 'session-B'), [], 'B 的键被污染了')
})

test('memoryIdsOf：坏输入一律退化成"现读一份"，不抛', () => {
  const storage = memoryStorage()
  writeMemoryTo(storage, 's1', ['x'])
  assert.deepEqual(memoryIdsOf(storage, undefined, 's1'), ['x'])
  assert.deepEqual(memoryIdsOf(storage, null, 's1'), ['x'])
  assert.deepEqual(memoryIdsOf(storage, { sessionId: 's1' }, 's1'), [])
  assert.deepEqual(memoryIdsOf(undefined, { sessionId: 's1', ids: ['x'] }, 's1'), ['x'])
})

test('**M2.5：组件必须真的调用归属守卫**（.tsx 进不了单测，只能静态钉）', () => {
  // ⚠️ 这条是变异 `bar-persists-without-guard` **存活**逼出来的。
  //
  // 那条变异把 `read-order-bar.tsx` 里的守卫删掉，测试仍然全绿 ——
  // 因为 Node 的类型剥离**不处理 JSX**（`ERR_UNKNOWN_FILE_EXTENSION`），
  // `.tsx` 根本进不了单测，纯逻辑层的三条 M2.5 测试**覆盖不到组件的接线**。
  //
  // 这正是交接文档 §4.1 坑 #2 说的顺序：**先确认覆盖，再确认断言**。
  // 纯逻辑对 ≠ 组件用了它。所以这里补一条静态断言钉住接线。
  const bar = readFileSync(join(CLIENT_SRC, 'read-order-bar.tsx'), 'utf8')
  // 先剥注释：注释里**故意**写了这条守卫的解释，不该让断言误判。
  const code = bar.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  assert.match(
    code,
    /if \(!canPersistMemory\(memory, sessionId\)\) return/,
    '组件写盘前必须校验记忆归属 —— 少了这一行，切会话那一帧会把上个会话的勾写进新会话的键',
  )
  assert.match(
    code,
    /memoryIdsOf\(storage, memory, sessionId\)/,
    '渲染用的记忆必须经 memoryIdsOf 过滤 —— 直接读 state 会沿用上一个会话的勾',
  )
  // 状态必须带归属（不能退回裸 `string[]`，那样无从判断它属于谁）。
  assert.match(code, /useState<ReadMemory>/, '记忆 state 必须带 sessionId，不能是裸 string[]')
})

test('statusMarkOf：六种 status 各有徽标，未知给 ❔（不静默当成正常）', () => {
  assert.equal(statusMarkOf('authoritative'), '🟢')
  assert.equal(statusMarkOf('partial'), '🟡')
  assert.equal(statusMarkOf('draft'), '⚪')
  assert.equal(statusMarkOf('superseded'), '🔵')
  assert.equal(statusMarkOf('sealed'), '🔴')
  assert.equal(statusMarkOf('void'), '🟠')
  assert.equal(statusMarkOf('bogus'), '❔')
  assert.equal(statusMarkOf(''), '❔')
})

test('字段自证：条上要用的每个字段都真的从 required 流出来（不缺、不改名）', () => {
  const [item] = readOrderOf([doc({ id: 'x', read: true, role: 'spec', status: 'partial', hasError: true, summary: 's' })])
  // 逐字段断言而不是 `assert.ok(item)`：后者在字段被改名/丢掉时仍然会绿。
  assert.deepEqual(
    {
      seq: item.seq, id: item.id, role: item.role, status: item.status,
      read: item.read, hasError: item.hasError, summary: item.summary,
    },
    { seq: 1, id: 'x', role: 'spec', status: 'partial', read: true, hasError: true, summary: 's' },
  )
})

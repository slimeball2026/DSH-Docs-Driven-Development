/**
 * 演练复盘修复的回归测试（M2.3 · 2026-11-14）。
 *
 * 每一条都对应一个**真实发生过**的问题，不是假想：
 *
 * | 缺陷 | 症状 | 本文件哪条钉住 |
 * |---|---|---|
 * | D2 | AI 被拒后又建一份交接，用户以为它不懂规矩 | 「交接文案要说清修订用新建」 |
 * | D3 | 看板不刷新，必须切走再切回 | 「必须有 visibilitychange 订阅」 |
 * | D4 | 用户以为阅读顺序会随意变动 | 「图例必须说明 ✓ 会失效」 |
 * | §5 | 用户不知道「下一步」行是什么（页签里根本没渲染） | 「页签必须渲染 nextStep」 |
 *
 * 这些是**文案与接线**的判据，不在 `core/` 里，所以单独一个文件。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { watchVisibility, watchPolling, DEFAULT_POLL_INTERVAL_MS } from '../src/client/visibility.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, '..')
const CLIENT_SRC = join(BUNDLE, 'src', 'client')
const TOOLS = join(BUNDLE, 'tools')

/** 读源码并剥注释（注释里解释"为什么这么写"不该让断言误红）。 */
function codeOf(path) {
  const raw = readFileSync(path, 'utf8')
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

// ---------------------------------------------------------------- D2

test('D2：`doc_new` 建交接时必须说清"可以直接 edit，任何状态都行"', () => {
  const code = codeOf(join(TOOLS, 'doc-new.js'))
  assert.match(code, /value\.role === 'handover'/, '必须按 role 分支（只有交接才提示）')
  // ---- 2026-11-14 M2.6：判据**第二次翻面**（策略又变了）----
  //
  // 演进：
  //   旧判据要求「一次性文档」+「不要 edit 旧的」。
  //   → 第一次改：只放开 draft，判据改成「说清 draft 可以直接改」。
  //   → 第二次改（用户拍板）：**任何状态都可以 edit**，判据再改。
  //
  // ⚠️ 判据要跟着策略翻面 —— 否则测试会一直替旧行为背书（本项目记过这条）。
  assert.match(code, /交接可以直接 `edit`|交接可以直接 edit/, '必须说清交接可以直接 edit')
  assert.match(code, /任何状态/, '必须说清"任何状态都行"（不止 draft）')
  assert.match(code, /`doc_new`/, '新建仍要指向 doc_new（那条链还在）')
  // 反向：不许再无条件禁止 edit 交接。
  assert.doesNotMatch(
    code,
    /不要 `edit` 旧的/,
    '还在无条件禁止 edit 旧交接 —— 现在任何状态都能改',
  )
})

test('D2：`doc_new` 的 output schema 必须声明 role（否则 render 拿不到它）', () => {
  const code = codeOf(join(TOOLS, 'doc-new.js'))
  // render 依赖 value.role；schema 没声明的话会被剥掉 → 提示永远不出现。
  assert.match(code, /role: \{ type: 'string', required: true \}/, 'schema 必须声明 role')
})

// ---- 2026-11-14 M2.6（第三轮）：两条"事前提醒" ----
//
// 来源：用户让 AI 自己总结难点（`session-916967d2`），它指出两条
// **校验器查不出来**的问题。两条都只能"事前说"，不能"事后查"。

test('**M2.6：`doc_new` 建交接时必须提醒「别把还没做的事写成已做」**', () => {
  const code = codeOf(join(TOOLS, 'doc-new.js'))
  // AI 自述：它建交接时（seq 97）就写了「read-order 已更新」，
  // 而 read-order 到 seq 124 才改 —— 中间 27 步那份交接在说假话。
  // 它自己的原话：「七段结构全合规、健康度全过，**但有一句话在说假话**——
  // 校验器查不出来，只有我自己知道。」
  assert.match(code, /别把还没做的事写成已做/, '缺少"别描述未来状态"的提醒')
  assert.match(code, /查不出来|只查结构/, '必须说明这条判据查不出来（否则 AI 会以为能被兜住）')
  assert.match(code, /先把要引用的东西全做完/, '必须给出正确顺序')
})

test('**M2.6：`doc_new` 必须提醒「basis 默认是未验证」**（否则标绿后要返工）', () => {
  const code = codeOf(join(TOOLS, 'doc-new.js'))
  // AI 自述：「basis 在 doc_new 时是默认值，我在建的时候完全没想它 ——
  // 因为它不是七段之一，也不影响 H1–H7。结果是定稿 → 复检 → 回头改 basis
  // → 两份文档指纹变了、又变回未读。」
  assert.match(code, /`basis` 默认是「未验证」|basis.*默认.*未验证/, '缺少 basis 默认值提醒')
  assert.match(code, /H-5/, '必须点名 H-5（那条会在标绿后才报）')
  // ⚠️ 这条提示要**对所有 role** 生效，不能被包在 `role === 'handover'` 分支里。
  // 判据：取 basis 提示前面那段代码，确认它不在 handover 条件内。
  const idx = code.indexOf('`basis` 默认是「未验证」')
  assert.ok(idx > 0, '没找到 basis 提示')
  const before = code.slice(Math.max(0, idx - 400), idx)
  const lastHandoverBranch = before.lastIndexOf("value.role === 'handover'")
  const lastBranchClose = before.lastIndexOf(': \'\')')
  assert.ok(
    lastHandoverBranch < lastBranchClose || lastHandoverBranch === -1,
    'basis 提示被包进了 handover 分支 —— 它对所有 role 都适用',
  )
})

test('D2：`doc_handover_check` 拒绝时必须给可执行的修法（直接原地 edit）', () => {
  const code = codeOf(join(TOOLS, 'doc-handover-check.js'))
  // ---- 2026-11-14 M2.6：判据第二次翻面 ----
  // 旧判据要求「如果这份交接还是 draft」；现在任何状态都能改，所以第一句变成"直接 edit"。
  assert.match(code, /直接 `edit` 这份交接|直接 edit 这份交接/, '必须给出"直接改"这条正路')
  assert.match(code, /任何状态都可以 edit|任何状态/, '必须说清"任何状态都可以"')
  assert.match(code, /doc_new/, '新建那条链仍要提到')
})

// ---------------------------------------------------------------- D3

test('D3：`watchVisibility` 只在**可见**时刷新（隐藏事件不做事）', () => {
  const listeners = []
  let refreshes = 0
  const fakeDocument = {
    visibilityState: 'hidden',
    addEventListener: (type, fn) => { if (type === 'visibilitychange') listeners.push(fn) },
    removeEventListener: () => {},
  }
  const dispose = watchVisibility({ refresh: () => { refreshes += 1 } }, fakeDocument)

  assert.equal(listeners.length, 1, '必须真的订阅 visibilitychange')

  // 隐藏状态下触发 → **不许**刷新。
  listeners[0]()
  assert.equal(refreshes, 0, '隐藏时不该刷新 —— 省掉一半无谓请求')

  // 变为可见后触发 → 刷新一次。
  fakeDocument.visibilityState = 'visible'
  listeners[0]()
  assert.equal(refreshes, 1, '可见时必须刷新一次')

  dispose()
})

test('D3：`watchVisibility` 的坏输入一律不抛、返回可调用的退订', () => {
  for (const bad of [undefined, null, {}, { addEventListener: 'not-a-function' }]) {
    const dispose = watchVisibility({ refresh: () => {} }, bad)
    assert.equal(typeof dispose, 'function', `坏输入 ${JSON.stringify(bad)} 也要返回函数`)
    assert.doesNotThrow(() => dispose())
  }
})

test('D3：controller.refresh 抛错**不许**冒到界面', () => {
  const fakeDocument = {
    visibilityState: 'visible',
    addEventListener: (type, fn) => { (fakeDocument._fn ??= []).push(fn) },
    removeEventListener: () => {},
  }
  const dispose = watchVisibility({ refresh: () => { throw new Error('boom') } }, fakeDocument)
  // 直接调监听器，不许抛。
  assert.doesNotThrow(() => fakeDocument._fn[0]())
  assert.doesNotThrow(() => dispose())
})

test('D3：两个席位都接上了 watchVisibility（主栏 BodyWith + 会话页签）', () => {
  const index = codeOf(join(CLIENT_SRC, 'index.tsx'))
  const tab = codeOf(join(CLIENT_SRC, 'session-tab.tsx'))

  // 主栏/右栏走 BodyWith，一处接线两处生效。
  assert.match(index, /watchVisibility\(controller\)/, 'index.tsx 必须接上 watchVisibility')
  // 会话页签不走 BodyWith，必须单独接。
  assert.match(tab, /watchVisibility\(controller\)/, 'session-tab.tsx 必须单独接上')
})

test('D3：watchVisibility 放在中性文件里（**不许**让 session-tab 反向 import index）', () => {
  // 这是 M2.3 事故的教训：循环依赖在单文件打包下"碰巧能跑"，出事时极难查。
  const tab = readFileSync(join(CLIENT_SRC, 'session-tab.tsx'), 'utf8')
  assert.ok(
    !/from\s+['"]\.\/index\.tsx['"]/.test(tab),
    'session-tab.tsx 不能 import index.tsx —— watchVisibility 必须放在中性文件',
  )
  const vis = readFileSync(join(CLIENT_SRC, 'visibility.ts'), 'utf8')
  assert.ok(!/from\s+['"]\.\/index\.tsx['"]/.test(vis), 'visibility.ts 也不能反向依赖')
  assert.ok(!/from\s+['"]\.\/session-tab/.test(vis), 'visibility.ts 不能依赖 session-tab')
})

// ---- 2026-11-14 第三轮：可见时低频轮询 ----
//
// 用户原话：「右侧栏的阅读顺序的勾没有实时刷新，但就在截完图之后它很快就变成 2/3 了。」
// "截图后就变了"说明 visibilitychange 生效了，但它覆盖不了"一直盯着看"。
// AI 在另一个进程里读文档，客户端无从知道 —— 只能轮询（或推送）。

test('**D3：轮询按注入的间隔真的会刷新**（不依赖真实计时器）', () => {
  let tick
  const fakeSetInterval = (fn, ms) => {
    tick = fn
    assert.equal(ms, DEFAULT_POLL_INTERVAL_MS, '必须用约定的间隔')
    return 1
  }
  let refreshes = 0
  const stop = watchPolling({ refresh: () => { refreshes += 1 } }, DEFAULT_POLL_INTERVAL_MS, { visibilityState: 'visible' }, fakeSetInterval, () => {})
  assert.equal(typeof tick, 'function', '必须真的注册了定时器')
  tick()
  assert.equal(refreshes, 1, '定时器触发时必须刷新')
  stop()
})

test('**D3：后台标签页一次都不请求**（轮询不该昂贵）', () => {
  // ⚠️ 第一版这条测试是**恒真的**：我写 `refresh: () => { throw }` 并
  // `assert.doesNotThrow(tick)`，但 `watchPolling` 内部有 try/catch 把抛吞掉了
  // —— 于是"隐藏时也刷新"的变异**存活**了。
  //
  // 正确做法：**数调用次数**，而不是指望异常冒出来。
  let refreshes = 0
  let tick
  const stop = watchPolling(
    { refresh: () => { refreshes += 1 } },
    DEFAULT_POLL_INTERVAL_MS,
    { visibilityState: 'hidden' },
    (fn) => { tick = fn; return 1 },
    () => {},
  )
  tick()
  tick()
  assert.equal(refreshes, 0, '后台标签页一次都不该请求（实际请求了，说明没检查可见性）')
  stop()
})

test('**D3：可见时轮询真的会调 refresh**（与上一条配对，证明不是恒真）', () => {
  let refreshes = 0
  let tick
  const stop = watchPolling(
    { refresh: () => { refreshes += 1 } },
    DEFAULT_POLL_INTERVAL_MS,
    { visibilityState: 'visible' },
    (fn) => { tick = fn; return 1 },
    () => {},
  )
  tick()
  assert.equal(refreshes, 1, '可见时必须真的刷新 —— 否则上一条"0 次"就是恒真的')
  stop()
})

test('**D3：intervalMs = 0 表示关闭**（不注册任何定时器）', () => {
  let called = false
  const stop = watchPolling({ refresh: () => {} }, 0, { visibilityState: 'visible' }, () => { called = true; return 1 }, () => {})
  assert.equal(called, false, '间隔为 0 时不该注册定时器')
  stop()
})

test('D3：轮询的坏输入不抛，且 stop 可重复调用', () => {
  for (const bad of [undefined, null, {}, 'x']) {
    const stop = watchPolling({ refresh: () => {} }, 1000, bad, (fn) => 1, () => {})
    assert.equal(typeof stop, 'function')
    assert.doesNotThrow(() => stop())
    assert.doesNotThrow(() => stop())
  }
})

test('D3：刷新抛错不许中断后续轮询', () => {
  let tick
  let calls = 0
  const stop = watchPolling(
    { refresh: () => { calls += 1; throw new Error('boom') } },
    1000,
    { visibilityState: 'visible' },
    (fn) => { tick = fn; return 1 },
    () => {},
  )
  assert.doesNotThrow(() => tick())
  assert.doesNotThrow(() => tick())
  assert.equal(calls, 2, '第一次抛错后，第二次仍要执行')
  stop()
})

test('D3：**两个席位都接上了轮询**（主栏 BodyWith + 会话页签）', () => {
  const index = codeOf(join(CLIENT_SRC, 'index.tsx'))
  const tab = codeOf(join(CLIENT_SRC, 'session-tab.tsx'))
  assert.match(index, /watchPolling\(controller/, 'index.tsx 必须接上轮询')
  assert.match(tab, /watchPolling\(controller/, 'session-tab.tsx 必须接上轮询')
})

// ---------------------------------------------------------------- D4

test('D4：图例必须说明「接手清单」定位，且说明 ✓ **只增不减**', () => {
  const code = codeOf(join(CLIENT_SRC, 'read-order-bar.tsx'))
  // 用户 2026-11-14 第一次：「阅读顺序应该是个适用于被交接者初次接手项目的显示指标」
  assert.match(code, /接手清单/, '图例必须给出"接手清单"这个定位')
  // 第二次澄清：「按阅读顺序阅读并画勾是一开始被交接时应该做完的，
  // 它大概不应该因为工作就被取消掉」→ 所以要写"只增不减"，**不是**"会失效"。
  assert.match(code, /只增不减/, '必须说明勾不会因为改文档而撤销')
  assert.ok(
    !/会因文档被修改而失效/.test(code),
    '旧文案说"会失效"，与用户的真实意图相反 —— 已按第二次澄清改成"只增不减"',
  )
})

test('D4：图例**不许**再说成"绿点 = AI 读过"（2026-11-14 之前的歧义）', () => {
  const code = codeOf(join(CLIENT_SRC, 'read-order-bar.tsx'))
  assert.ok(!code.includes('绿点 = AI 读过'), '旧文案会把置信度说成已读')
  assert.match(code, /🟢 置信度/, '必须显式说明 🟢 是置信度')
})

// ---------------------------------------------------------------- §5 下一步

test('§5：会话页签必须渲染 `nextStep`（上一轮为了不挤把它拿掉了）', () => {
  const code = codeOf(join(CLIENT_SRC, 'session-tab.tsx'))
  // ⚠️ 只断言「出现了 snapshot.nextStep」**不够**：变异用 `false && snapshot.nextStep !== ''`
  // 也能通过（文本还在，但永远不渲染）。我实测过 —— 那条变异存活了。
  //
  // 所以这里断言**三件事**：
  //   1. 条件里真的有 nextStep 判空；
  //   2. 条件**没有被短路**（不许 `false &&` / `if (false)`）；
  //   3. 真的渲染了一个带 nextStep 样式的块（证明不是只写在表达式里）。
  assert.match(code, /snapshot\.nextStep !== ''/, '空值时必须整行不显示')
  assert.ok(!/false\s*&&\s*snapshot\.nextStep/.test(code), '条件被短路了 —— 那一行永远不渲染')
  assert.ok(!/if\s*\(\s*false\s*\)/.test(code), '出现了 if (false) 之类的短路')
  assert.match(code, /styles\.nextStep/, '必须真的渲染一个带 nextStep 样式的块')
  // 内容必须是交接的下一步本身（不是占位符）。
  assert.match(code, /h\('span', null, snapshot\.nextStep\)/, '必须把 nextStep 的文本渲染出来')
})

test('**D4：三处调用点都必须传 sessionId**（不传 = 记忆跨会话泄漏）', () => {
  // 2026-11-14 用户截图：API 返回 gate=0/3（全未读），但条上 3 个 chip 全打了勾 ——
  // 因为记忆存在全局键里，会话 A 的勾渗到了会话 B。
  // 光修 `read-order.ts` 的键不够：**调用点必须真的把 sessionId 传进来**。
  const tab = codeOf(join(CLIENT_SRC, 'session-tab.tsx'))
  assert.match(
    tab,
    /h\(ReadOrderBar, \{[^}]*sessionId/s,
    '会话页签必须把 sessionId 传给 ReadOrderBar',
  )

  const index = codeOf(join(CLIENT_SRC, 'index.tsx'))
  const calls = [...index.matchAll(/h\(ReadOrderBar, \{([\s\S]*?)\}\)/g)]
  assert.ok(calls.length >= 2, `应当有两个调用点（主栏 + 右栏），实际 ${calls.length}`)
  for (const [i, call] of calls.entries()) {
    assert.match(call[1], /sessionId/, `第 ${i + 1} 个 ReadOrderBar 调用没传 sessionId —— 勾会跨会话泄漏`)
  }
})

test('**D4：界面必须明说「重启会清空」**（方案 C，用户 2026-11-14 拍板）', () => {
  // 背景：`readSet` 是 host 侧 WeakMap 的内存态，宿主重启后归零。
  // 用户实测撞过一次（"会话 1 的勾怎么没了"）。
  //
  // 三个方案里用户选了 C：**不落盘，只在界面上明说**。
  //   否掉 B（落盘）的理由：会引入第二份真源，可能与索引/门禁漂移。
  const code = codeOf(join(CLIENT_SRC, 'read-order-bar.tsx'))
  assert.match(code, /重启会清空/, '界面必须明说重启会清空已读')
  // 细节解释放 title（条太窄，正文放不下）。
  assert.match(code, /title:.*宿主重启/, '完整解释必须在 title 里')
  // 不许改成落盘（那是被否掉的 B 方案）。
  assert.ok(
    !/readset.*\.json|writeFileSync.*readSet/i.test(code),
    '不许把 readSet 落盘 —— B 方案已被否（会引入第二份真源）',
  )
})

test('§5：`下一步` 的样式必须用主题 token（不许硬编码色）', () => {
  const raw = readFileSync(join(CLIENT_SRC, 'session-tab.tsx'), 'utf8')
  const block = /nextStep:\s*\{([\s\S]*?)\n\s*\},/.exec(raw)
  assert.ok(block !== null, '找不到 nextStep 样式块')
  for (const m of block[1].matchAll(/var\((--[a-z0-9-]+)/g)) {
    assert.match(m[1], /^--dsw-/, `用了非宿主 token：${m[1]}`)
  }
})

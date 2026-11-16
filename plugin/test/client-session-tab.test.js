/**
 * 会话右栏页签的测试（M2.3 · 需求 3）。
 *
 * ---- 这个文件要钉住的五件事（每一条都对应一个"会静默出错"的错法）----
 *
 * 1. **三处键必须逐字一致**：`sidebarRightTabs.register({id})`、
 *    `sidebar.right.pane.tab` 的 key、`sidebar.right.pane.tab.title` 的 key。
 *    不一致的症状是"点开页签一片空白"，**且不报错**。
 * 2. **不许声明 `patterns`**：我们是 `priority: 'extension'`（最高档），
 *    一旦声明了 `dsh-resource://file/**` 之类的 glob，就会把
 *    **所有文件预览**从 `documentpreview` 手里抢走 —— 那是严重回归。
 * 3. **cwd 拿不到就留空**，绝不猜（猜错会显示别的项目的门禁读数）。
 * 4. **`title` 是 `(address) => string`**，不是 thunk（与 `guide[].title` 不同）。
 * 5. **两个注册互不连累**：tab 注册失败时主栏面板仍然注册。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DDD_GUIDE_ENTRY_ID,
  DDD_TAB_ID,
  DDD_TAB_KIND,
  cwdOfSession,
  cwdOfUseSessions,
  dddTabDefinition,
  resolveCwd,
} from '../src/client/session-tab.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_SRC = join(HERE, '..', 'src', 'client')

/** 一个"照 cordis 行为"的假 ctx：读未声明服务会抛（M2.2 的教训）。 */
function throwingCtx(services = {}) {
  return new Proxy({ get: (name) => services[name] }, {
    get(target, prop) {
      if (prop in target) return target[prop]
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
}

/** 造一个假的 sessions 服务。 */
function sessionsWith(byId) {
  return { list: { getSnapshot: () => ({ ids: Object.keys(byId), byId }) } }
}

test('契约：`id` / `kind` 是非空字符串，且**不是**同一个值（两者语义不同）', () => {
  assert.equal(typeof DDD_TAB_ID, 'string')
  assert.ok(DDD_TAB_ID.length > 0)
  assert.equal(typeof DDD_TAB_KIND, 'string')
  assert.ok(DDD_TAB_KIND.length > 0)
  assert.notEqual(DDD_TAB_ID, DDD_TAB_KIND, 'id 是"这个实现"，kind 是"这类页签"，不能混用')
})

test('dddTabDefinition：**不许有 patterns**（否则会抢走 documentpreview 的所有文件）', () => {
  const definition = dddTabDefinition()
  assert.equal(
    definition.patterns,
    undefined,
    '声明了 patterns —— 我们是 extension 档（最高），会抢走所有匹配的文件预览',
  )
  assert.equal(definition.priority, 'extension', '外部类型的默认档')
})

test('dddTabDefinition：`title` 是 `(address) => string`，**不是 thunk**', () => {
  const definition = dddTabDefinition()
  assert.equal(typeof definition.title, 'function')
  // 关键区别：传一个 address 进去，必须能拿到字符串；thunk 写法会忽略参数、也能返回字符串，
  // 所以这里再钉一次**arity**：thunk 的 length 是 0。
  assert.equal(definition.title.length, 1, 'title 必须接受 address 参数（thunk 是 0 个参数）')
  assert.equal(typeof definition.title('sidebar://ddd-board'), 'string')
})

test('dddTabDefinition：guide 胶囊的 title/description 是 **thunk**（语言切换不用重注册）', () => {
  const [entry] = dddTabDefinition().guide
  assert.equal(entry.id, DDD_GUIDE_ENTRY_ID)
  assert.equal(typeof entry.title, 'function')
  assert.equal(typeof entry.description, 'function')
  // guide 的签名是 `() => string`：length 必须是 0。
  assert.equal(entry.title.length, 0, 'guide[].title 必须是 thunk（与 definition.title 相反）')
  assert.equal(typeof entry.title(), 'string')
  assert.ok(entry.title().length > 0, '胶囊标题不能是空串（否则用户看到一张空白卡）')
})

test('dddTabDefinition：每次调用都是**新对象**（注册器会改它，不能共享引用）', () => {
  const first = dddTabDefinition()
  const second = dddTabDefinition()
  assert.notEqual(first, second)
  assert.notEqual(first.guide, second.guide, 'guide 数组也必须每次新建')
})

test('cwdOfSession：从 `sessions.list.byId[id].cwd` 读，且**去掉尾部分隔符**', () => {
  const ctx = throwingCtx({ sessions: sessionsWith({ 's-1': { cwd: 'C:\\proj\\' } }) })
  assert.equal(cwdOfSession(ctx, 's-1'), 'C:\\proj')
  // 正斜杠与多级尾部都要归一。
  const ctx2 = throwingCtx({ sessions: sessionsWith({ 's-1': { cwd: '/home/me/proj///' } }) })
  assert.equal(cwdOfSession(ctx2, 's-1'), '/home/me/proj')
})

test('cwdOfSession：**拿不到就返回空串，绝不猜**', () => {
  // 1) 没有 sessions 服务
  assert.equal(cwdOfSession(throwingCtx(), 's-1'), '')
  // 2) sessionId 为空
  assert.equal(cwdOfSession(throwingCtx({ sessions: sessionsWith({ 's-1': { cwd: '/p' } }) }), ''), '')
  // 3) byId 里没有这个会话
  assert.equal(cwdOfSession(throwingCtx({ sessions: sessionsWith({}) }), 's-1'), '')
  // 4) 那一行没有 cwd
  assert.equal(cwdOfSession(throwingCtx({ sessions: sessionsWith({ 's-1': {} }) }), 's-1'), '')
  // 5) cwd 是空串
  assert.equal(cwdOfSession(throwingCtx({ sessions: sessionsWith({ 's-1': { cwd: '' } }) }), 's-1'), '')
  // 6) 服务形状不对
  assert.equal(cwdOfSession(throwingCtx({ sessions: { list: {} } }), 's-1'), '')
  // 7) ctx 是 undefined
  assert.equal(cwdOfSession(undefined, 's-1'), '')
})

test('cwdOfSession：**读未声明服务时抛错也被吞掉**（不连累页签渲染）', () => {
  // 这个 ctx 的 `get` 自己就抛。
  const ctx = { get: () => { throw new Error('boom') } }
  assert.doesNotThrow(() => cwdOfSession(ctx, 's-1'))
  assert.equal(cwdOfSession(ctx, 's-1'), '')
})

test('cwdOfUseSessions：用 `useSessions(selector)` 读，选择器真的按 sessionId 取', () => {
  // ⚠️ 2026-11-14 事故后：这个函数**只作为一次性同步读**保留（测试 + 将来），
  // 生产路径走 `cwdOfSession`（纯快照读）。绝不能把它放进 React 渲染期。
  const byId = { 's-1': { cwd: 'C:\\a\\' }, 's-2': { cwd: 'C:\\b' } }
  const useSessions = (selector) => selector({ byId })
  assert.equal(cwdOfUseSessions(useSessions, 's-1'), 'C:\\a')
  assert.equal(cwdOfUseSessions(useSessions, 's-2'), 'C:\\b')
})

test('cwdOfUseSessions：hook 缺席 / 抛错 / 没 cwd 一律返回空串', () => {
  assert.equal(cwdOfUseSessions(undefined, 's-1'), '')
  assert.equal(cwdOfUseSessions('not-a-function', 's-1'), '')
  assert.equal(cwdOfUseSessions(() => { throw new Error('boom') }, 's-1'), '')
  assert.equal(cwdOfUseSessions(() => ({ cwd: '' }), 's-1'), '')
  assert.equal(cwdOfUseSessions(() => undefined, 's-1'), '')
})

test('resolveCwd：**只走纯快照读**（不再尝试 hook —— 那是 2026-11-14 事故的根因）', () => {
  const ctx = throwingCtx({ sessions: sessionsWith({ 's-1': { cwd: 'C:\\from-service' } }) })
  assert.equal(resolveCwd(ctx, 's-1'), 'C:\\from-service')
  // 拿不到 → 空串（不猜）。
  assert.equal(resolveCwd(throwingCtx(), 's-1'), '')
  // 签名里不许有 useSessions（有的话就会诱使人在渲染期调 hook）。
  assert.equal(resolveCwd.length, 2, 'resolveCwd 只收 (ctx, sessionId)')
})

test('回归：**三处注册的键必须逐字一致**（不一致 = 点开页签一片空白，且不报错）', () => {
  const source = readFileSync(join(CLIENT_SRC, 'index.tsx'), 'utf8')
  // ① 类型注册用的是 definition（其 id 来自 DDD_TAB_ID）。
  assert.match(source, /tabs\.register\(definition\)/, '必须用 dddTabDefinition() 的产物注册类型')
  // ② 正文与 ③ 标题都用 DDD_TAB_ID 作 key，**不许写字符串字面量**。
  const paneTab = /name: 'sidebar\.right\.pane\.tab',\s*key: ([^,\n]+)/.exec(source)
  assert.ok(paneTab !== null, '找不到 sidebar.right.pane.tab 的注册')
  assert.equal(paneTab[1].trim(), 'DDD_TAB_ID', '正文的 key 必须是 DDD_TAB_ID（不能是字面量）')

  const paneTitle = /name: 'sidebar\.right\.pane\.tab\.title',\s*key: ([^,\n]+)/.exec(source)
  assert.ok(paneTitle !== null, '找不到 sidebar.right.pane.tab.title 的注册')
  assert.equal(paneTitle[1].trim(), 'DDD_TAB_ID', '标题的 key 必须是 DDD_TAB_ID')
})

test('回归：**sidebarRightTabs 必须在插件 inject 里**（否则拿不到，页签不出现）', () => {
  const text = readFileSync(join(CLIENT_SRC, 'entry.tsx'), 'utf8')
  const match = /inject:\s*\[([^\]]*)\]/.exec(text)
  assert.ok(match !== null, 'entry.tsx 里找不到 inject 声明')
  const injects = match[1].split(',').map((item) => item.trim().replace(/['"]/g, '')).filter(Boolean)
  assert.ok(injects.includes('slots'), 'slots 是硬依赖')
  assert.ok(injects.includes('sidebarRight'), 'sidebarRight 是预览的硬依赖')
  assert.ok(injects.includes('sidebarRightTabs'), `inject 里缺 sidebarRightTabs —— 页签不会出现。当前：${injects.join(', ')}`)
})

test('回归：**页签注册失败不连累主栏**（两个注册各自 try，且都返回 disposer）', () => {
  const text = readFileSync(join(CLIENT_SRC, 'entry.tsx'), 'utf8')
  assert.match(text, /const disposePanel = registerPanel\(/, '主栏注册必须独立成一个变量')
  assert.match(text, /registerSessionTab\(ctx, \{/, '页签注册必须独立调用')
  // ⚠️ 关键：`registerSessionTab` **必须包在 try 里**。
  // 只靠"它内部不会抛"是不够的 —— 变异检验证明过：把 registerSessionTab 改成抛错，
  // 没有这层 try 时**主栏面板会跟着消失**（apply 抛 = 双注册永不执行，M2.2 的原症状）。
  const guarded = /try\s*\{[\s\S]*?registerSessionTab\(ctx, \{[\s\S]*?\}\s*\)[\s\S]*?\}\s*catch/.test(text)
  assert.ok(guarded, 'registerSessionTab 必须包在 try/catch 里 —— 否则页签注册失败会让主栏一起消失')
  // 释放时两个都要放。
  assert.match(text, /disposeTab\(\)/, '释放时必须调用 disposeTab')
  assert.match(text, /disposePanel\(\)/, '释放时必须调用 disposePanel')
})

test('回归：**cwd 拿不到一律空串**（任何一条路径都不许猜目录）', () => {
  // 这条是"变异存活"逼出来的：只测 catch 分支不够，
  // 真正危险的是"拿不到就退回到某个总能拿到的值"。
  const src = readFileSync(join(CLIENT_SRC, 'session-tab.ts'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  // 函数体里不许出现盘符字面量 / process.cwd / 硬编码路径。
  for (const banned of ['process.cwd', 'C:\\\\guessed', '/tmp', 'os.homedir']) {
    assert.ok(!code.includes(banned), `session-tab.ts 里出现了猜测性的路径来源：${banned}`)
  }
  // 逐个喂坏输入，返回必须是空串（不是 undefined，也不是任何路径）。
  const cases = [
    [undefined, 's-1'],
    [throwingCtx(), 's-1'],
    [throwingCtx({ sessions: sessionsWith({}) }), 's-1'],
    [throwingCtx({ sessions: sessionsWith({ 's-1': {} }) }), 's-1'],
    [throwingCtx({ sessions: sessionsWith({ 's-1': { cwd: '' } }) }), 's-1'],
    [throwingCtx({ sessions: sessionsWith({ 's-1': { cwd: '/p' } }) }), ''],
  ]
  for (const [ctx, id] of cases) {
    assert.equal(cwdOfSession(ctx, id), '', `坏输入没有返回空串：${JSON.stringify(id)}`)
  }
})

test('回归：**页签里不传项目选择器**（会话已经决定了是哪个项目）', () => {
  const text = readFileSync(join(CLIENT_SRC, 'session-tab.tsx'), 'utf8')
  // 先**剥掉注释**再检查：否则注释里解释"为什么不传 projectsOf"反而会让这条测试红
  // （我第一次写这条时就撞上了 —— 断言必须看代码，不能看散文）。
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  // controller 现在通过 `wiring.makeController(...)` 造（避免与 index.tsx 循环依赖）。
  const call = /makeController\(\{([\s\S]*?)\}\)/.exec(code)
  assert.ok(call !== null, 'session-tab.tsx 里找不到 makeController 调用')
  for (const banned of ['projectsOf', 'pickDirectoryOf', 'initOf', 'recheckOf']) {
    assert.ok(
      !call[1].includes(banned),
      `页签里传了 ${banned} —— 会话已经决定了项目根，多一个选择器只会让人困惑`,
    )
  }
})

test('回归：**页签里保留可点预览**（这是需求 3 的核心红利）', () => {
  const text = readFileSync(join(CLIENT_SRC, 'session-tab.tsx'), 'utf8')
  assert.match(text, /wiring\.openDoc\(/, '页签里必须真的调 openDoc')
  // 不许像主栏那样把预览关掉。
  assert.ok(
    !/previewDisabled/.test(text),
    '页签里不该有 previewDisabled —— 会话作用域里预览是能打开的',
  )
})

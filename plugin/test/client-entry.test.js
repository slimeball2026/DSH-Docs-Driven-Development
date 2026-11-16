/**
 * client 入口**纯逻辑层**的单测（`src/client/entry-logic.ts`）。
 *
 * ---- 这份测试为什么必须存在（2026-11-13 实机事故）----
 *
 * M2 的 client 半侧「已实现、未启用」卡了很久，最后在真宿主上定位到这一行：
 *
 * ```
 * web boot: warning: 1 entry did not activate
 * @local/ddd: failed: Error: cannot get property "sidebarRight" without inject
 * ```
 *
 * `apply()` 第一句是 `wirePreview(ctx)`，而它读的是 `ctx?.sidebarRight`。
 * **cordis 的 `ctx` 是 Proxy**：读一个没写进插件 `inject` 的服务时，
 * 它**不返回 `undefined`，而是直接抛**。`?.` 完全拦不住 ——
 * 抛错发生在**属性读取**那一刻。
 *
 * 后果链条非常隐蔽：
 *   `apply()` 第一行抛 → `registerPanel` 永不执行 → 双注册不发生 →
 *   **面板不出现**，但 entry 仍是 active、factory 仍已注册、
 *   **且不写 crash 日志**（`@local/ddd` 不在前端 required 集合里，只走 warning）。
 *
 * 所以这份测试的核心不是"测功能"，而是**用一个会抛错的 Proxy 复刻真实的 ctx**，
 * 把"读未声明服务就炸"钉进测试。谁把 `ctx.get(...)` 改回 `ctx.xxx`，这里立刻红。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { pickProjectDirectory, sessionCwdsOf, sessionInfoOf, softService, wirePreviewOf } from '../src/client/entry-logic.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 造一个**行为与 cordis 一致的 ctx Proxy**。
 *
 * @param services 已提供的服务名 → 实例
 * @param inject 插件声明依赖的服务名
 *
 * 规则照抄 cordis：
 *   * 读 `inject` 里的服务 → 返回该服务；
 *   * 读**不在** `inject` 里、且**未提供**的服务 → **抛** `cannot get property "x" without inject`；
 *   * `get(name)` → 软取，返回 `undefined` 不抛；
 *   * `effect` / `on` → 空实现。
 */
function cordisLikeCtx(services, inject = []) {
  const declared = new Set(inject)
  const base = {
    get(name) { return services[name] },
    effect() { return () => {} },
    on() { return () => {} },
  }
  return new Proxy(base, {
    get(target, property) {
      if (typeof property === 'symbol') return undefined
      if (property in target) return target[property]
      if (declared.has(property) && property in services) return services[property]
      // ⚠️ 就是这一行：未声明 → 抛，而不是 undefined
      throw new Error(`cannot get property "${property}" without inject`)
    },
  })
}

test('桩本身可信：直接读未声明服务会抛（否则下面的「不抛」毫无意义）', () => {
  // M1.5 的教训：一个恒真的断言等于没测。所以先证明这个桩真的会炸。
  const ctx = cordisLikeCtx({}, [])
  assert.throws(() => ctx.sidebarRight, /without inject/)
  assert.throws(() => ctx.layout, /without inject/)
})

test('softService：服务缺席返回 undefined，**不抛**', () => {
  const ctx = cordisLikeCtx({}, [])
  assert.equal(softService(ctx, 'sidebarRight'), undefined)
  assert.equal(softService(ctx, 'layout'), undefined)
  assert.equal(softService(undefined, 'sidebarRight'), undefined, 'ctx 本身缺席也要能兜住')
  assert.equal(softService({}, 'anything'), undefined, '没有 get 方法也要能兜住')
})

test('softService：服务在场就能拿到', () => {
  const sidebarRight = { openResource() {} }
  const ctx = cordisLikeCtx({ sidebarRight }, [])
  assert.equal(softService(ctx, 'sidebarRight'), sidebarRight)
})

test('回归：**所有可选服务都缺席**时，sessionInfoOf 不抛且返回空串（不猜）', () => {
  const ctx = cordisLikeCtx({}, [])
  let info
  assert.doesNotThrow(() => { info = sessionInfoOf(ctx) })
  assert.equal(info.cwdOf(), '', '没选项目就返回空串，绝不猜一个路径')
  assert.equal(info.sessionIdOf(), '', '拿不到 sessionId 就返回空串')
})

test('sessionInfoOf：**用户选定的 cwd 就是真源**（不看任何服务）', () => {
  // 这是 M2.2 的核心修正：cwd 只能来自用户显式选择。
  // 宿主不给 root-scope 面板会话绑定，所以"从上下文里读 cwd"这条路根本不存在。
  const ctx = cordisLikeCtx({}, [])
  const info = sessionInfoOf(ctx, 'C:\\proj')
  assert.equal(info.cwdOf(), 'C:\\proj')
})

test('sessionInfoOf：选定 cwd 优先于任何服务（即使在场的服务给出别的值）', () => {
  // 防回归：旧实现会去读 workingDirectory / layout，读到什么就用什么。
  // 现在必须**忽略它们**，只信用户选的。
  const ctx = cordisLikeCtx({
    workingDirectory: { get: () => 'C:\\wrong' },
    layout: { panelInfo: { getSnapshot: () => ({ sessionId: 'session-x' }) } },
  }, [])
  assert.equal(sessionInfoOf(ctx, 'C:\\chosen').cwdOf(), 'C:\\chosen')
})

test('sessionInfoOf：会话恰好一个时才取它的 id；多个则留空（不猜）', () => {
  const one = cordisLikeCtx({
    sessions: { list: { getSnapshot: () => ({ ids: ['session-only'] }) } },
  }, [])
  assert.equal(sessionInfoOf(one, 'C:\\p').sessionIdOf(), 'session-only')

  const many = cordisLikeCtx({
    sessions: { list: { getSnapshot: () => ({ ids: ['a', 'b'] }) } },
  }, [])
  assert.equal(sessionInfoOf(many, 'C:\\p').sessionIdOf(), '', '多个会话时不知道用户选了哪个 —— 不许猜')
})

test('sessionCwdsOf：从会话列表里取出去重的 cwd', () => {
  const ctx = cordisLikeCtx({
    sessions: {
      list: {
        getSnapshot: () => ({
          ids: ['a', 'b', 'c'],
          byId: {
            a: { sessionId: 'a', cwd: 'C:\\one' },
            b: { sessionId: 'b', cwd: 'C:\\one\\' },
            c: { sessionId: 'c', cwd: 'C:\\two' },
          },
        }),
      },
    },
  }, [])
  assert.deepEqual(sessionCwdsOf(ctx).sort(), ['C:\\one', 'C:\\two'], '尾部分隔符归一 + 去重')
  assert.deepEqual(sessionCwdsOf(cordisLikeCtx({}, [])), [], '拿不到会话时返回空列表，不抛')
})

test('回归：wirePreviewOf 在不抛的前提下降级为 unavailable', () => {
  const ctx = cordisLikeCtx({}, [])
  let wire
  assert.doesNotThrow(() => { wire = wirePreviewOf(ctx) }, '接线时不许抛 —— 一抛面板就没了')
  assert.equal(wire.kind, 'unavailable')
  assert.match(wire.warning, /sidebarRight/)
  // 点开文档时才报错（这样"点了没反应"能留痕，而不是静默）
  assert.throws(() => wire.open('dsh-resource://file/session/x/docs/a.md'), /sidebarRight 不可用/)
})

test('wirePreviewOf：sidebarRight 在场时真的走 openResource', () => {
  const opened = []
  const ctx = cordisLikeCtx({ sidebarRight: { openResource: (a) => opened.push(a) } }, [])
  const wire = wirePreviewOf(ctx)
  assert.equal(wire.kind, 'ok')
  wire.open('dsh-resource://file/session/x/docs/a.md')
  assert.deepEqual(opened, ['dsh-resource://file/session/x/docs/a.md'])
})

test('wirePreviewOf：sidebarRight 存在但没有 openResource 也算不可用（不要半残）', () => {
  const ctx = cordisLikeCtx({ sidebarRight: {} }, [])
  const wire = wirePreviewOf(ctx)
  assert.equal(wire.kind, 'unavailable')
})

test('pickProjectDirectory：拿不到 uiWorkspace 时**降级**，不抛（按钮点了要有反馈）', async () => {
  const result = await pickProjectDirectory(cordisLikeCtx({}, []))
  assert.equal(result.kind, 'unavailable')
  assert.match(result.reason, /pickDirectory/)
})

test('pickProjectDirectory：用户选中 → picked，且尾部分隔符被归一', async () => {
  const ctx = cordisLikeCtx({ uiWorkspace: { pickDirectory: async () => 'D:\\new-proj\\' } }, [])
  assert.deepEqual(await pickProjectDirectory(ctx), { kind: 'picked', cwd: 'D:\\new-proj' })
})

test('pickProjectDirectory：用户取消（null）→ cancelled，**不是错误**', async () => {
  const ctx = cordisLikeCtx({ uiWorkspace: { pickDirectory: async () => null } }, [])
  assert.deepEqual(await pickProjectDirectory(ctx), { kind: 'cancelled' })
})

test('pickProjectDirectory：选择器自己抛错 → unavailable + 原文（不抛给 UI）', async () => {
  const ctx = cordisLikeCtx({
    uiWorkspace: { pickDirectory: async () => { throw new Error('对话框被占用') } },
  }, [])
  const result = await pickProjectDirectory(ctx)
  assert.equal(result.kind, 'unavailable')
  assert.match(result.reason, /对话框被占用/)
})

test('pickProjectDirectory：**这是"任意目录"的唯一入口**（候选只覆盖已知会话）', async () => {
  // 这条测试钉的是设计意图，不是实现细节：
  // 用户想让一个从没在 DSH 里打开过的目录成为 DDD 工作区时，
  // 它不会出现在 /api/ddd/projects 的候选里 —— 必须靠这个原生选择器。
  const ctx = cordisLikeCtx({ uiWorkspace: { pickDirectory: async () => 'D:\\never-opened' } }, [])
  const result = await pickProjectDirectory(ctx)
  assert.equal(result.kind, 'picked')
  assert.equal(result.cwd, 'D:\\never-opened')
})

test('回归：**ProjectPicker 必须自己订阅 controller**（2026-11-13 第二层真因）', () => {
  // 上一轮我只改了 `selectProject` 里的 notify 时机 —— 必要但**不够**。
  //
  // `ProjectPicker` 与 `BodyWith` 是**两个独立组件**，各自调 `controller.getXxx()`。
  // 只有 `BodyWith` 订阅了（`useControllerState`），所以 chosenCwd 变化时
  // 前者重渲染、后者纹丝不动 → `<select value={chosenCwd}>` 一直显示旧值，
  // 而下方内容已经换了。这就是用户看到的"框里路径不变、内容变了"。
  //
  // 这条断言钉的是源码形态：`ProjectPicker` 函数体里必须调用 `useControllerState`。
  const text = readFileSync(join(HERE, '..', 'src', 'client', 'index.tsx'), 'utf8')
  const start = text.indexOf('export function ProjectPicker(')
  assert.ok(start >= 0, '找不到 ProjectPicker')
  // 取到下一个顶层 export 之前为止
  const nextExport = text.indexOf('\n/** ', start + 10)
  const body = text.slice(start, nextExport > 0 ? nextExport : text.length)
  assert.match(
    body,
    /useControllerState\(controller\)/,
    'ProjectPicker 没有订阅 controller —— 下拉框会永远停在旧值上',
  )
})

test('回归：**sidebarRight 必须在插件 inject 里**（否则 ctx.get 拿不到）', () => {
  // 2026-11-13 用户实测：「鼠标放上去会变手势，但点击没有反应，打不开文档」。
  //
  // 真因：`sidebarRight` 由 ui-sidebar-right 用 `ctx.reflect.provide` 提供，
  // **不在 client 的 Service 目录里** —— `ctx.get('sidebarRight')` 恒定返回 undefined。
  // 唯一取法是写进插件级 `inject` 再 `ctx.sidebarRight`
  // （官方 ui-reference / ui-chat / ui-plan 都这么做）。
  const text = readFileSync(join(HERE, '..', 'src', 'client', 'entry.tsx'), 'utf8')
  const match = /inject:\s*\[([^\]]*)\]/.exec(text)
  assert.ok(match !== null, 'entry.tsx 里找不到 inject 声明')
  const injects = match[1].split(',').map((item) => item.trim().replace(/['"]/g, '')).filter(Boolean)
  assert.ok(injects.includes('slots'), 'slots 是硬依赖')
  assert.ok(
    injects.includes('sidebarRight'),
    `inject 里缺 sidebarRight —— 预览会永远走降级分支。当前：${injects.join(', ')}`,
  )
})

test('回归：**wirePreviewOf 读的是 ctx.sidebarRight**（不是 ctx.get）', () => {
  // `ctx.get` 对 reflect.provide 出来的服务无效。这条断言钉住取法。
  const text = readFileSync(join(HERE, '..', 'src', 'client', 'entry-logic.ts'), 'utf8')
  assert.match(text, /ctx as any\)\.sidebarRight/, '必须直接读 ctx.sidebarRight')
})

test('**预览地址：sessionId 为空时退回 absolute scope**（空 session 地址必然解析失败）', async () => {
  const { previewAddressOf, isOpenableAddress } = await import('../src/client/api.ts')

  // 1) 有 sessionId → session scope
  const withSession = previewAddressOf('session-abc', 'docs/a.md', 'C:\\proj')
  assert.equal(withSession, 'dsh-resource://file/session/session-abc/docs/a.md')
  assert.equal(isOpenableAddress(withSession), true)

  // 2) 没有 sessionId 但有 projectRoot → absolute scope
  const withoutSession = previewAddressOf('', 'docs/a.md', 'C:\\proj')
  assert.match(withoutSession, /^dsh-resource:\/\/file\/absolute\//)
  assert.equal(isOpenableAddress(withoutSession), true, 'absolute 地址必须可解析')

  // 3) 两者都没有 → 地址不可解析，UI 必须据此拦住（不许静默失败）
  const neither = previewAddressOf('', 'docs/a.md', '')
  assert.equal(isOpenableAddress(neither), false, '空 session + 空 root 的地址必须被判为不可解析')
})

test('预览地址：盘符的 `:` 保持字面量（与官方 encodeSegment 一致）', async () => {
  const { previewAddressOf } = await import('../src/client/api.ts')
  const address = previewAddressOf('', 'docs/a.md', 'C:\\proj')
  assert.match(address, /C:/, '盘符不该被编码成 %3A')
  assert.doesNotMatch(address, /%3A/)
})

test('预览地址：中文与空格被正确编码，`/` 保留', async () => {
  const { previewAddressOf } = await import('../src/client/api.ts')
  const address = previewAddressOf('s1', 'docs/中文 文档.md', 'C:\\proj')
  assert.equal(address, 'dsh-resource://file/session/s1/docs/%E4%B8%AD%E6%96%87%20%E6%96%87%E6%A1%A3.md')
})

test('回归：**模拟真实 apply 链路** —— 只提供 slots 时，双注册仍然发生', () => {
  // 这一条把 entry.tsx 里 apply() 的顺序搬过来跑一遍：
  //   wirePreview → sessionInfoOf → createController → registerPanel
  // 用真实会抛的 ctx 桩，证明「可选服务全缺席」不会挡住双注册。
  const registered = []
  const slots = {
    inject(_key, callback) { callback(); return () => {} },
    register(props) { registered.push(props); return () => {} },
  }
  const ctx = cordisLikeCtx({ slots }, ['slots'])

  let dispose
  assert.doesNotThrow(() => {
    const wire = wirePreviewOf(ctx)
    assert.equal(wire.kind, 'unavailable', '这个环境里确实没有 sidebarRight')
    const { cwdOf, sessionIdOf } = sessionInfoOf(ctx)
    assert.equal(cwdOf(), '')
    assert.equal(sessionIdOf(), '')
    // 这里不真的 createController（它会发网络请求），只验证前面的步骤不抛，
    // 以及 slots 注册能走通。
    const disposers = [
      slots.inject('sidebar.panellist', () => slots.register({ name: 'sidebar.panellist', id: 'ddd-construction-board', order: 40 })),
      slots.inject('main', () => slots.register({ name: 'main', key: 'ddd-construction-board' })),
    ]
    dispose = () => { for (const d of disposers) d() }
  })

  assert.deepEqual(registered.map((p) => p.name), ['sidebar.panellist', 'main'], '双注册必须成对')
  assert.equal(registered[0].id, registered[1].key, '入口行 id 与主栏 key 必须同值')
  assert.equal(typeof dispose, 'function')
  assert.doesNotThrow(() => dispose())
})

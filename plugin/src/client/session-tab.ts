/**
 * 会话右栏页签（M2.3 · 需求 3）的**纯逻辑层**（零 JSX、零 React、零 DOM）。
 *
 * ---- 为什么这个需求价值远超"多一个入口" ----
 *
 * 会话右侧栏是 **`session` scope**。在那里：
 *
 * | 事实 | root 面板（`main` 席位） | 会话右栏（本文件） |
 * |---|---|---|
 * | 有 `sessionId` | ❌ 宿主不给 root 席位会话绑定 | ✅ 框架作为 standard prop 注入 |
 * | 有 `cwd` | ❌ 只能让用户手选 | ✅ `sessions.list.byId[id].cwd` |
 * | 有右栏 → 预览能开 | ❌ `openResource` 必抛 | ✅ 可用 |
 * | `gate.read` 是会话级读数 | ⚠️ 拿不到 id 时不准确 | ✅ 真正正确的读数 |
 *
 * 所以它不是"再开一个入口"，而是**把这个插件放回它本该在的位置**。
 *
 * ---- 三条纪律（与其它 client 文件一致）----
 *
 * 1. **拿不到就留空，不猜**：cwd 拿不到就**不显示数据**，绝不猜一个目录
 *    （猜错会显示**别的项目**的门禁读数 —— 比不显示更糟）。
 * 2. **纯逻辑放 `.ts`**：`.tsx` 无法被 Node 单测 import（类型剥离不处理 JSX）。
 * 3. **契约字面量集中在这一个文件**：tab 的 `id` / `kind` / `priority` 改了就
 *    必须在测试里同步，不能散落在组件里。
 */

import type { ClientCtxLike } from './entry-logic.ts'
import { softService } from './entry-logic.ts'

/**
 * 这个 tab 实现的**唯一身份**。
 *
 * 它同时是三处的键（官方 `documentpreview` 用的是包名，照抄这个惯例）：
 *   - `ctx.sidebarRightTabs.register({ id })`
 *   - `slots.register({ name: 'sidebar.right.pane.tab', key: id })`
 *   - `slots.register({ name: 'sidebar.right.pane.tab.title', key: id })`
 *
 * ⚠️ 三处**必须逐字一致**，否则正文会渲染在"没有类型认领"的空面板里
 * （症状是"点开页签一片空白"，而且不报错）。
 */
export const DDD_TAB_ID = '@local/ddd'

/**
 * tab 的**类型判别符**（`kind`）。
 *
 * 与 `id` 不是一回事：`id` 是"这个实现"，`kind` 是"这类页签"。
 * `openTab(kind)` 用的是它；`title` / 正文注册用的是 `id`。
 */
export const DDD_TAB_KIND = 'ddd-board'

/** guide 胶囊的稳定 id（同一个 provider 内唯一）。 */
export const DDD_GUIDE_ENTRY_ID = 'construction-board'

/** guide 胶囊的排序位（排在官方胶囊之后，不抢位）。 */
export const DDD_GUIDE_ORDER = 60

/** 胶囊标题（**每次调用都读**，所以语言切换不需要重新注册）。 */
export function dddGuideTitle(): string {
  return '文档驱动开发'
}

/** 胶囊下面那行说明。 */
export function dddGuideDescription(): string {
  return '看板 + AI 阅读顺序 + 文档预览（仅 DDD 项目）'
}

/**
 * 页签标题（`definition.title(address)` 的产物会被捕获进页签记录）。
 *
 * ⚠️ **必须声明 `address` 参数**，即使不用它：
 * `SidebarRightTabDefinition.title` 的签名是 `(address: string) => string`。
 * 写成 `() => string`（thunk）在类型上不兼容，而且 `fn.length` 会变成 0 ——
 * `test/client-session-tab.test.js` 用 arity 钉住了这一点
 * （因为 thunk 与正常函数在运行期"都能返回字符串"，光看返回值分不出来）。
 *
 * @param _address 页签记录的地址（页面类型是 `sidebar://<kind>`），本类型不用它
 * @returns 页签 chip 上的文字
 */
export function dddTabTitle(_address: string): string {
  return '文档驱动开发'
}

/**
 * 构造 tab 类型定义（stage one：这个类型**是什么**）。
 *
 * 关键决定与理由：
 *
 * - **`priority: 'extension'`**：这是"来自产品之外的类型"所在的最高档
 *   （`tab-registry.ts` 的注释原文：*a type from outside the product, and the highest*）。
 *   我们的页签由 `kind` 打开（`openTab`），**不声明 `patterns`** ——
 *   它不认领任何 `dsh-resource://` 地址，所以**不会抢** `documentpreview` 的文件。
 *   （若声明了 patterns 又占 extension 档，我们就会把**所有**匹配的文件抢走，
 *   那是严重回归。`test/client-session-tab.test.js` 钉着"不许有 patterns"。）
 * - **`title` 不用 thunk**：`SidebarRightTabDefinition.title` 的签名是
 *   `(address: string) => string`，**不是** `() => string`（与 `guide[].title` 不同，
 *   后者才是 thunk）。写错会拿到 address 当标题。
 *
 * @returns 可以直接喂给 `ctx.sidebarRightTabs.register()` 的定义
 */
export function dddTabDefinition() {
  return {
    id: DDD_TAB_ID,
    kind: DDD_TAB_KIND,
    priority: 'extension' as const,
    // 刻意**不给 patterns**：页签由 kind 打开，不认领文件地址。
    title: dddTabTitle,
    guide: [
      {
        id: DDD_GUIDE_ENTRY_ID,
        order: DDD_GUIDE_ORDER,
        // ⚠️ 这两个是 **thunk**（`() => string`），与上面的 `title` 签名不同。
        title: dddGuideTitle,
        description: dddGuideDescription,
      },
    ],
  }
}

/**
 * 取某个会话的 cwd（**纯快照读，不是 hook**）。
 *
 * 官方 `ui-reference` 就是这么用的（`src/client/index.ts` L65 / L168）：
 * ```js
 * sessions.list.getSnapshot().byId[sessionId]?.cwd
 * ```
 *
 * ---- ⚠️ 2026-11-14 实机事故：**为什么不用 `useSessions` hook** ----
 *
 * 框架确实把 `useSessions`（`SnapshotSelectorHook`）作为 standard prop 注入了
 * `sidebar.right.pane.tab`，看起来"更正统"。但第一版把它放进 `React.useMemo`
 * 的回调里调，结果：**切到新会话时右栏整棵渲染树被卸载，连切回原会话也不恢复**。
 *
 * 原因是 hook 被有条件地调用（`useMemo` 回调在渲染期跑，且不同分支走不同路径），
 * React 抛 `Rendered more hooks than during the previous render` → 错误边界卸载子树。
 *
 * 所以这里刻意用**纯读**：`getSnapshot()` 是同步取值，没有 hook 顺序问题。
 * 代价是不会自动订阅会话元数据的变化 —— 可接受：
 * cwd 在建会话时就定了，之后极少变；真要变，重开页签即可。
 *
 * ⚠️ 拿不到时返回**空串**，由调用方显示"拿不到项目目录"。
 * 绝不退回 `process.cwd()` 或任何猜测 —— 那会显示别的项目的门禁读数。
 *
 * @param ctx client 根上下文
 * @param sessionId 框架注入的会话 id（可能是空串）
 * @returns cwd（已去掉尾部分隔符），拿不到时为空串
 */
export function cwdOfSession(ctx: ClientCtxLike | undefined, sessionId: string): string {
  if (typeof sessionId !== 'string' || sessionId === '') return ''
  try {
    const sessions = softService(ctx, 'sessions')
    const list = sessions?.list
    if (list === undefined || list === null || typeof list.getSnapshot !== 'function') return ''
    const state = list.getSnapshot()
    const byId = state?.byId
    if (byId === undefined || byId === null || typeof byId !== 'object') return ''
    const row = byId[sessionId]
    const cwd = row?.cwd
    if (typeof cwd !== 'string' || cwd === '') return ''
    return cwd.replace(/[\\/]+$/, '')
  } catch {
    return ''
  }
}

/**
 * 从 `useSessions` 的投影里读 cwd。
 *
 * ⚠️ **这个函数现在只用于"一次性同步读取"，绝不能在 React 渲染期调。**
 *
 * 2026-11-14 的事故就是因为它被放进了 `useMemo`：`useSessions` 是**框架 hook**，
 * 渲染期调用 + 条件分支 = hook 顺序变化 = React 抛错 = 整棵右栏卸载。
 *
 * 保留它是为了**测试与将来**：如果哪天真要订阅会话元数据的变化，
 * 正确做法是在组件**顶层无条件**调一次 `useSessions(selector)`，
 * 而不是像这样包一层函数（包一层就会诱使人把它放进 `useMemo`）。
 *
 * 生产路径请用 `cwdOfSession`（纯快照读）。
 *
 * @param useSessions 框架注入的 hook（可能是 undefined）
 * @param sessionId 当前会话 id
 * @returns cwd，拿不到时为空串
 */
export function cwdOfUseSessions(useSessions: unknown, sessionId: string): string {
  if (typeof useSessions !== 'function') return ''
  if (typeof sessionId !== 'string' || sessionId === '') return ''
  try {
    // `useSessions(selector)` —— 照 `SnapshotSelectorHook` 的签名调用。
    const row = (useSessions as (selector: (state: any) => unknown) => unknown)(
      (state: any) => state?.byId?.[sessionId],
    )
    const cwd = (row as { cwd?: unknown } | undefined)?.cwd
    if (typeof cwd !== 'string' || cwd === '') return ''
    return cwd.replace(/[\\/]+$/, '')
  } catch {
    return ''
  }
}

/**
 * 取 cwd 的**生产入口**：只走纯快照读。
 *
 * ⚠️ 2026-11-14 之后这里**不再尝试 `useSessions` hook**。
 * 那个 hook 只能在组件顶层无条件调用；而本函数是"普通函数"，
 * 任何调用点都可能处在渲染期，把 hook 藏在这里就是一个陷阱。
 *
 * 如果将来确实需要订阅会话元数据变化，做法是：在组件顶层
 * `const row = useSessions(state => state.byId[sessionId])` 无条件调一次，
 * 然后把 `row.cwd` 传进来 —— **不是**把 hook 塞进这个函数。
 *
 * @param ctx client 根上下文
 * @param sessionId 当前会话 id
 * @returns cwd，拿不到时为空串
 */
export function resolveCwd(ctx: ClientCtxLike | undefined, sessionId: string): string {
  return cwdOfSession(ctx, sessionId)
}

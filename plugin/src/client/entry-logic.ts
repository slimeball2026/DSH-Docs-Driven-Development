/**
 * client 入口的**纯逻辑层**（零 JSX、零 React）。
 *
 * ---- 为什么要把这几行单独放一个文件 ----
 *
 * 2026-11-13 的实机事故根因就在这几行：`apply()` 里读 `ctx.sidebarRight`，
 * 而 cordis 的 `ctx` 是 Proxy，读**未声明 inject 的服务会直接抛**。
 * `apply()` 第一行抛 → 双注册永不执行 → 面板不出现，且**不写 crash 日志**。
 *
 * 症状是「entry active、factory 已注册、但面板不在」，查了很久。
 *
 * 要给它写回归测试，就必须能在 Node 里 import。而 `entry.tsx` 是 `.tsx`，
 * **Node 的类型剥离不处理 JSX**（`ERR_UNKNOWN_FILE_EXTENSION`），
 * 所以凡是想被测到的逻辑都不能留在 `.tsx` 里。
 *
 * 于是：**软取 / 会话信息 / 预览通道接线** 这三件纯逻辑搬到这里，
 * `entry.tsx` 只保留 React 组件与 `apply` 的组装。
 */

/** client 根上下文的**结构性**类型（不依赖 cordis 的类型包）。 */
export interface ClientCtxLike {
  get?: (name: string) => unknown
  [key: string]: unknown
}

/**
 * 从 cordis 上下文里**软取**一个可选服务。
 *
 * ⚠️ **这是本切片最贵的一个坑（2026-11-13 实测）**：
 * cordis 的 `ctx` 是 Proxy。访问一个**没有写进插件 `inject` 的服务**时，
 * 它**不会**返回 `undefined`，而是**直接抛**：
 *
 * ```
 * Error: cannot get property "sidebarRight" without inject
 * ```
 *
 * `?.` 救不了它 —— 抛错发生在**属性读取**那一刻，不是后续调用。
 * 唯一正确的软取法是 `ctx.get('<service>')`，它在服务缺席时返回 `undefined`。
 *
 * @param ctx client 根上下文
 * @param name 服务名
 * @returns 服务实例，缺席时 undefined
 */
export function softService(ctx: ClientCtxLike | undefined, name: string): any {
  try {
    if (ctx === undefined || ctx === null) return undefined
    if (typeof ctx.get !== 'function') return undefined
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/**
 * 取当前会话的 cwd / sessionId。
 *
 * ---- ⚠️ 2026-11-13 实机教训：这两个都没有"自动"来源 ----
 *
 * 原实现从三处取值，**三处都错**（都只是 SPEC 里的想象，从没在真宿主上验过）：
 *
 * | 原写法 | 宿主真实情况 |
 * |---|---|
 * | `ctx.workingDirectory.get()` | **host 侧**服务，`get(session)` 需要 `Session` 对象，浏览器拿不到 |
 * | `ctx.layout.panelInfo()` | `layout` 有 `panelInfo`，但 `PanelInfo` **只有 `activePanelId`**，不含 sessionId |
 * | `ctx.sessions.active()` | `sessions` **没有 `active()`**，只有 `list` / `retain` / `binding`… |
 *
 * 更根本的一条：宿主**设计上**不给 root-scope 的 `main` 席位任何会话绑定
 * （`dsh-client-ui-layout` 注释原文：「other keys receive no Session binding」）。
 *
 * 所以 cwd **必须由用户显式选**（见 `projects.ts` 的选择器），
 * sessionId 拿不到就**留空**并在界面上说清 —— 绝不猜一个，
 * 因为显示错项目的门禁比不显示更糟（会把错误的信任可视化）。
 *
 * @param ctx client 根上下文
 * @param chosenCwd 用户显式选定的项目根（空串 = 还没选）
 */
export function sessionInfoOf(
  ctx: ClientCtxLike | undefined,
  chosenCwd = '',
): {
  cwdOf: () => string
  sessionIdOf: () => string
} {
  const cwdOf = (): string => {
    // 用户选的**就是**真源。没选就返回空串，让 UI 显示"请选择项目根"。
    if (typeof chosenCwd === 'string' && chosenCwd !== '') return chosenCwd
    return ''
  }

  const sessionIdOf = (): string => {
    try {
      // `sessions.list` 是**唯一**能在 client 侧读到会话元数据的地方。
      // 它给的是全部会话，**不含"当前选中"**（那是 UI 内部状态）。
      //
      // 这里只做一件有用的事：如果恰好只有一个会话，取它的 id；
      // 多于一个就**留空**（不猜）。`gate.read` 是会话级的，
      // 猜错会话会让门禁显示成别人的读数 —— 那正是 M2-2 要防的事。
      const sessions = softService(ctx, 'sessions')
      const list = sessions?.list
      if (list !== undefined && typeof list.getSnapshot === 'function') {
        const state = list.getSnapshot()
        const ids = Array.isArray(state?.ids) ? state.ids : []
        if (ids.length === 1 && typeof ids[0] === 'string' && ids[0] !== '') return ids[0]
      }
    } catch { /* 静默退回 */ }
    return ''
  }

  return { cwdOf, sessionIdOf }
}

/**
 * 从 `sessions.list` 里读会话元数据，给"项目选择器"当候选源。
 *
 * ⚠️ 这只在 client 侧能拿到的东西范围内：**会话的 cwd**。
 * 是否真的是 DDD 项目，要问 host（`/api/ddd/projects`）——
 * client 没有文件系统，判断不了有没有 `docs/`。
 *
 * @param ctx client 根上下文
 * @returns 去重后的 cwd 列表（空列表表示拿不到）
 */
export function sessionCwdsOf(ctx: ClientCtxLike | undefined): string[] {
  try {
    const sessions = softService(ctx, 'sessions')
    const list = sessions?.list
    if (list === undefined || typeof list.getSnapshot !== 'function') return []
    const state = list.getSnapshot()
    const byId = state?.byId
    if (byId === undefined || byId === null || typeof byId !== 'object') return []
    const seen = new Set<string>()
    for (const summary of Object.values(byId)) {
      const cwd = summary?.cwd
      if (typeof cwd === 'string' && cwd !== '') seen.add(cwd.replace(/[\\/]+$/, ''))
    }
    return [...seen]
  } catch {
    return []
  }
}

/** 预览接线返回什么：要么能开，要么带一条可显示的失败原因。 */
export type PreviewWire =
  | { kind: 'ok'; open: (address: string) => void }
  | { kind: 'unavailable'; warning: string; open: (address: string) => never }

/**
 * 打开宿主原生目录选择器，让用户指定**任意**项目根。
 *
 * ---- 为什么这个函数必须存在（2026-11-13 用户实测指出的缺口）----
 *
 * 早先的候选列表只来自"宿主已知会话的 cwd"。于是：
 *
 * > 用户想让一个**从没在 DSH 里打开过**的目录成为 DDD 工作区，
 * > 它永远不出现在下拉里，也就**选不到**。
 *
 * 那是"首次指定"这个最基本场景的缺失，不是用户的用法问题。
 *
 * `ctx.uiWorkspace.pickDirectory()` 是宿主**第一方**提供的原生目录选择器
 * （`@deepseek-ai/dsh-client-ui-workspace` 提供，profile 里已装）。
 * 用它就**不依赖会话历史**，任意目录都能指定。
 *
 * ⚠️ 拿不到 `uiWorkspace` 时返回 `{kind:'unavailable'}`，
 * 由 UI 降级成"只能从候选里选"，而不是让按钮点了没反应。
 *
 * @param ctx client 根上下文
 */
export type PickDirectoryResult =
  | { kind: 'picked'; cwd: string }
  | { kind: 'cancelled' }
  | { kind: 'unavailable'; reason: string }

export async function pickProjectDirectory(ctx: ClientCtxLike | undefined): Promise<PickDirectoryResult> {
  const uiWorkspace = softService(ctx, 'uiWorkspace')
  if (uiWorkspace === undefined || typeof (uiWorkspace as any)?.pickDirectory !== 'function') {
    return {
      kind: 'unavailable',
      reason: '宿主没有提供 uiWorkspace.pickDirectory，只能从已知项目里选。',
    }
  }
  try {
    const picked = await (uiWorkspace as any).pickDirectory()
    // 用户点取消时返回 null —— 那是正常结局，不是错误。
    if (picked === null || picked === undefined) return { kind: 'cancelled' }
    if (typeof picked !== 'string' || picked === '') return { kind: 'cancelled' }
    return { kind: 'picked', cwd: picked.replace(/[\\/]+$/, '') }
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: `目录选择器打不开：${(error as Error)?.message ?? String(error)}`,
    }
  }
}

/**
 * 接线预览通道（M2-B）。
 *
 * ---- ⚠️ 2026-11-13 实机事故：`ctx.get('sidebarRight')` **永远拿不到** ----
 *
 * `sidebarRight` 由 `dsh-client-ui-sidebar-right` 用 `ctx.reflect.provide('sidebarRight', …)`
 * 提供 —— 它**不在 client 的 Service 目录里**（`cordis_inspect` 的 `Service.listService`
 * 查不到它）。所以 `ctx.get('sidebarRight')` **恒定返回 undefined**。
 *
 * 症状（用户实测）：「鼠标放上去会变手势，但点击没有反应，打不开文档」——
 * 因为 `wirePreviewOf` 一直走降级分支，`openPreview` 只打一条 warn。
 *
 * **唯一正确的取法**：把 `sidebarRight` 写进**插件级 `inject`**，然后直接 `ctx.sidebarRight`。
 * 这与官方包完全一致（`ui-chat` / `ui-plan` / `ui-reference` 都这么做，
 * 例如 `dsh-client-ui-reference/src/client/index.ts` 的
 * `export const inject = [..., 'sidebarRight', ...]`）。
 *
 * ⚠️ 代价：写进 `inject` 后它是**硬依赖** —— 宿主没这个服务时插件不会激活。
 * 但 `ui-sidebar-right` 是官方基础包、profile 里常驻，所以这个代价可接受
 * （`ui-reference` 等官方包也做了同样的选择）。
 *
 * @param ctx client 根上下文（其 `inject` 必须包含 `sidebarRight`）
 */
export function wirePreviewOf(ctx: ClientCtxLike | undefined): PreviewWire {
  // 直接读 ctx.sidebarRight（已写进 inject，不会抛）。
  // 仍包一层 try：万一某个宿主把它从组合里摘掉，我们只降级、不让 apply 抛。
  let sidebarRight: any
  try {
    sidebarRight = ctx === undefined || ctx === null ? undefined : (ctx as any).sidebarRight
  } catch {
    sidebarRight = undefined
  }
  // 兜底：某些组合下它可能被 `reflect.provide` 到别处，再试一次 get。
  if (sidebarRight === undefined) sidebarRight = softService(ctx, 'sidebarRight')

  if (sidebarRight === undefined || typeof sidebarRight?.openResource !== 'function') {
    return {
      kind: 'unavailable',
      warning: '[ddd] 没有 sidebarRight 服务，文档预览不可用（M2-B 会显示"打不开"）',
      open: () => { throw new Error('sidebarRight 不可用') },
    }
  }
  return {
    kind: 'ok',
    open: (address: string) => sidebarRight.openResource(address),
  }
}

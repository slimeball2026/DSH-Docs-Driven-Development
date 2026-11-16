/**
 * client 半侧入口（M2-A/B/C/D/E）。
 *
 * ---- 这个文件的形式为什么是 `__ModuleLoader__.load({...})` ----
 *
 * SPEC §3.1：client bundle 的入口就是它。`factory(require)` 里
 * **只能 `require` 白名单里的包**（`dsh.client.inject` + `PLATFORM_MODULES`），
 * **不能 import 本地文件** —— 所以 tsdown 必须打成**单文件** `lib/client.js`。
 *
 * ---- 双注册（Q7 = C：少一个就白做）----
 *
 * | 用途 | 席位 | 关键字段 |
 * |---|---|---|
 * | 左栏入口行 | `sidebar.panellist` | `id` |
 * | 主栏整页 | `main` | `key`（**必须等于上面的 id**） |
 *
 * 少注册 `main` 的症状是「点入口行没反应」——
 * 而它与「bundle 崩了」在 UI 上**看起来一样**（都是没反应），所以 `smoke` 里有一条断言钉住成对注册。
 *
 * ---- S1 / S2：非 DDD 项目不显示 ----
 *
 * 面板**在客户端也要判断激活**：`/api/ddd/index` 返回 `projectRoot: ''` 时说明
 * 这不是 DDD 项目（或没有激活标记）→ 显示「当前项目没有启用 DDD」，而不是显示 0/0
 * （那会被误读成"没有必读文档"）。
 *
 * ⚠️ 注意：client 侧**不能**自己判断"是不是子代理会话"（拿不到那个事实）。
 * S2 的硬约束在 host 侧（`tools/when.js` 的 fail-closed + 4 个工具的执行期兜底），
 * 面板显示与否只是体验问题。
 */

import * as React from 'react'

import { fetchProjects, fetchSnapshot, isOpenableAddress, postArchive, postRestore, previewAddressOf, type GraveyardResult, type ProjectOption, type Snapshot, type SnapshotDoc } from './api.ts'
import type { PickDirectoryResult } from './entry-logic.ts'
import { Dashboard, EmptyView, ErrorView, LoadingView } from './dashboard.tsx'
import { MainPage } from './main-page.tsx'
import { ReadOrderBar } from './read-order-bar.tsx'
import { watchVisibility, watchPolling, DEFAULT_POLL_INTERVAL_MS } from './visibility.ts'
import { DDD_TAB_ID, dddTabDefinition } from './session-tab.ts'
import { SessionTab, type SessionTabWiring } from './session-tab.tsx'

const h = React.createElement

/** 面板 id：`sidebar.panellist` 的 `id` 与 `main` 的 `key` **必须是同一个常量**。 */
export const PANEL_ID = 'ddd-construction-board'

/** 入口行的排序位（排在内置项之后，避免抢位）。 */
export const PANEL_ORDER = 40

/**
 * 图标。`sidebar.panellist` 的 ownerProps 是 `{ size, active }`。
 *
 * 用内联 SVG 而不是 emoji：emoji 在不同字体下宽度不一致，会把入口行撑歪。
 */
export function PanelIcon({ size = 20, active = false }: { size?: number; active?: boolean }): React.ReactElement {
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: active ? 2 : 1.6,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    opacity: active ? 1 : 0.8,
    'aria-hidden': true,
  },
    // 三份叠起来的文档 = 「文档驱动」
    h('path', { d: 'M7 3h7l4 4v14H7z' }),
    h('path', { d: 'M14 3v4h4' }),
    h('path', { d: 'M4 7v14h10' }),
  )
}

/** 数据源：把"取数 + 重试 + 订阅"收在一处，两个席位共用。 */
interface Controller {
  getSnapshot: () => Snapshot | undefined
  getError: () => string | undefined
  isLoading: () => boolean
  refresh: () => void
  subscribe: (listener: () => void) => () => void
  /** 用户显式选定的项目根；空串 = 还没选（**不猜**）。 */
  getChosenCwd: () => string
  /** 已知项目根候选（由 host 出，client 判断不了是不是 DDD 项目）。 */
  getProjects: () => ProjectOption[]
  isProjectsLoading: () => boolean
  areProjectsLoaded: () => boolean
  /** 拉/刷候选列表。打开面板时**不自动**拉 —— 那是用户点开选择器时才需要。 */
  refreshProjects: () => void
  /** 选项目根。**必须真的重新取数**，否则会显示上一个项目的数据。 */
  selectProject: (cwd: string) => void
  /**
   * 当前会话 id（M2.2）。
   *
   * ⚠️ 它**常常是空串** —— 宿主不给 root-scope 面板会话绑定，
   * client 也没有"当前选中会话"的服务。预览地址依赖它，
   * 所以拿不到时要**明说打不开**，而不是拼一个解析不了的地址。
   */
  getSessionId: () => string
  /**
   * 打开宿主原生目录选择器，指定**任意**项目根。
   *
   * 这是"候选列表只含已知会话"的补丁：新项目从没被会话打开过，
   * 就不会出现在下拉里，只能靠这个来选。
   *
   * @returns 结果，供 UI 决定要不要报错
   */
  pickProject: () => Promise<PickDirectoryResult>
  /**
   * **真的**重新检查当前项目（M2.2）。
   *
   * 与 `refresh()` 的区别：`refresh()` 只是重取快照，
   * 而 host 侧的探测有 TTL 缓存 —— 用户刚建了 `docs/` 也不会被发现。
   * 这个会先让 host **清掉该 cwd 的探测缓存**再取数。
   *
   * 实测症状（用户 2026-11-13）：新建 docs/ 后点刷新没用，
   * 但换一个目录（走 pickDirectory）反而好了 —— 因为换了 cwd 就绕过了坏缓存。
   */
  recheck: () => Promise<void>
  /** 把当前目录**一键初始化**成 DDD 工作区（建 docs/ + 写入口索引）。 */
  initializeProject: () => Promise<InitResult>
  /**
   * 归档若干份 `status: void` 的文档（M2-E / M2.5 · W7）。
   *
   * ⚠️ 2026-11-14 之前**这个方法不存在**，`MainPage` 的 `onArchive` 也没人传 ——
   * 于是点「归档选中的 N 份」什么都不发生，且不报错。
   * 详见 `_m23/verify-built-graveyard.mjs` 与 `test/client-graveyard.test.js`。
   */
  archive: (ids: readonly string[]) => Promise<GraveyardResult>
  /** 把坟场里的文档还原回原处（按**路径**，不是 id）。 */
  restore: (paths: readonly string[]) => Promise<GraveyardResult>
  /** 是否正在归档/还原（UI 用来显示"归档中…"并禁按钮）。 */
  isBusy: () => boolean
}

/** 初始化的结果（与 host 的 `/api/ddd/init` 同形）。 */
export interface InitResult {
  ok: boolean
  error?: string
  created: string[]
  skipped: string[]
  failed: Array<{ path: string; error: string }>
  isDdd?: boolean
}

/**
 * 造一个 controller。
 *
 * ⚠️ **不做轮询**（除非 `refreshMs > 0`）：M2-6 要求"刷新怎么触发"必须写清。
 * 默认策略是**用户操作触发** + **打开面板时取一次**。理由：
 * 轮询会让 host 每秒被叫一次，而这个面板大部分时间没人看。
 *
 * @param options.cwdOf 取当前 cwd（会话级）
 * @param options.sessionIdOf 取当前会话 id（`gate.read` 依赖它）
 * @param options.refreshMs 0 = 不轮询
 */
export function createController(options: {
  cwdOf: () => string
  sessionIdOf: () => string
  refreshMs?: number
  onOpenDoc?: (doc: SnapshotDoc) => void
  /**
   * 已知项目根列表的来源（M2.2）。
   *
   * 不传就**没有选择器**（只有 cwdOf 有值时能工作）。
   * 传了就会多一个 `projects` 状态 + `selectProject()`，
   * UI 据此渲染下拉 —— 这是面板知道"该查哪个项目"的**唯一正路**。
   */
  projectsOf?: () => Promise<ProjectOption[]>
  /**
   * 打开原生目录选择器（M2.2）。
   *
   * 不传就**没有"浏览…"按钮** —— 用户只能从候选里选，
   * 而候选只覆盖"至少有一个会话在那里跑过"的目录。
   */
  pickDirectoryOf?: () => Promise<PickDirectoryResult>
  /**
   * 让 host 重新探测某个目录（M2.2）。
   *
   * 不传就退化成普通 `refresh()`（会有 TTL 缓存的坑）。
   */
  recheckOf?: (cwd: string) => Promise<{ ok: boolean; isDdd?: boolean; projectRoot?: string }>
  /** 一键初始化（不传就没有"初始化"按钮）。 */
  initOf?: (cwd: string) => Promise<InitResult>
}): Controller {
  let snapshot: Snapshot | undefined
  let error: string | undefined
  let loading = false
  let inflight = 0
  /** 用户显式选定的项目根。空串 = 还没选（**不猜**）。 */
  let chosenCwd = options.cwdOf()
  /** 项目候选列表 + 它的加载状态。 */
  let projects: ProjectOption[] = []
  let projectsLoading = false
  let projectsLoaded = false
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of listeners) listener() }

  // ---- 归档 / 还原的忙碌标记（M2.5 · W7）----
  //
  // 为什么是模块级的 `let` 而不是 React state：controller 是**纯对象**，
  // 它靠 `notify()` 让订阅者重渲染。加一个 state 反而会让"谁负责重渲染"变成两个来源。
  let busy = false

  /**
   * 归档 / 还原的共用执行器。
   *
   * 三件事必须一起做，少一件就会留下"看起来没生效"的症状：
   *   1. 置忙 → 禁按钮，防止用户连点（第二次点会因"坟场已有同名"失败）；
   *   2. **真的发请求**（`postArchive` / `postRestore`）；
   *   3. 不论成败都**重新取数** —— 部分成功时界面必须反映"哪几份动了"。
   *
   * ⚠️ 第 3 条是重点：归档是**部分成功**语义（host 返回 `moved` + `failed`）。
   * 只刷"全部成功"的情况会让"3 份里成功 2 份"看起来像完全没动。
   */
  const runGraveyardAction = async (
    action: (items: readonly string[], options: { sessionId: string; cwd: string }) => Promise<GraveyardResult>,
    items: readonly string[],
  ): Promise<GraveyardResult> => {
    if (busy) return { ok: false, error: '上一次归档/还原还没结束', moved: [], failed: [] }
    busy = true
    notify()
    let result: GraveyardResult
    try {
      result = await action(items, { sessionId: options.sessionIdOf(), cwd: chosenCwd })
    } finally {
      busy = false
    }
    // 无论成功还是部分失败，都重新取一次数。
    await load()
    notify()
    return result
  }

  /** 拉项目候选列表（只在第一次需要时拉，之后靠 refreshProjects 手动刷）。 */
  const loadProjects = async () => {
    if (options.projectsOf === undefined) return
    projectsLoading = true
    notify()
    try {
      projects = await options.projectsOf()
    } catch {
      projects = []
    }
    projectsLoading = false
    projectsLoaded = true
    notify()
  }

  const load = async () => {
    const ticket = ++inflight
    loading = true
    error = undefined
    notify()
    const result = await fetchSnapshot(chosenCwd, options.sessionIdOf())
    // 过期响应丢弃：连续点两次刷新时，先回来的那个不能覆盖后回来的。
    if (ticket !== inflight) return
    loading = false
    if (result.kind === 'ok') { snapshot = result.data; error = undefined } else { error = result.message }
    notify()
  }

  /**
   * 用户选了项目根。
   *
   * ⚠️ **必须真的重新取数**：只改一个局部变量而不 reload，
   * 会让面板显示"上一个项目"的数据 + "新项目"的标题 ——
   * 那正是本项目最怕的症状（把错误的信任可视化）。
   *
   * @param cwd 选中的绝对路径；空串表示"取消选择"
   */
  const selectProject = (cwd: string) => {
    chosenCwd = typeof cwd === 'string' ? cwd : ''
    snapshot = undefined
    error = undefined
    // ⚠️ **必须先 notify 再 load**。
    // 旧实现只在 `load()` 内部 notify，而 `load()` 是异步的；
    // 结果 `<select value={chosenCwd}>` 在这中间读到的是**旧快照**，
    // React 判定 props 没变 → **不重渲染** → 下拉框停在原值上
    // （实测症状：选了别的目录，框里还显示原目录，但下方内容变了）。
    notify()
    if (chosenCwd === '') return
    void load()
  }

  /**
   * 打开原生目录选择器并选中结果。
   *
   * 选到就把该目录加进候选（标记为"未探测"，`isDdd` 先按 false 显示），
   * 然后走 `selectProject` 真的取数 —— 取数会顺便让 host 探测它是不是 DDD 项目。
   */
  const pickProject = async (): Promise<PickDirectoryResult> => {
    if (options.pickDirectoryOf === undefined) {
      return { kind: 'unavailable', reason: '当前没有接上目录选择器。' }
    }
    const result = await options.pickDirectoryOf()
    if (result.kind === 'picked') {
      // 加进候选：用户刚选的目录可能不在列表里（它从没被会话打开过）。
      if (!projects.some((project) => project.cwd === result.cwd)) {
        projects = [{ cwd: result.cwd, projectRoot: '', isDdd: false }, ...projects]
      }
      projectsLoaded = true
      selectProject(result.cwd)
    }
    notify()
    return result
  }

  /**
   * 真的重新检查：先让 host 清探测缓存，再重新取数。
   *
   * ⚠️ **顺序不能反**：如果先取数再清缓存，取到的仍是旧结果。
   */
  const recheck = async (): Promise<void> => {
    const cwd = chosenCwd
    if (cwd !== '' && options.recheckOf !== undefined) {
      try {
        await options.recheckOf(cwd)
      } catch {
        // 重新探测失败不影响后面的取数（取数会给出它自己的错误）。
      }
      // 探测结果可能变了（从"不是 DDD"变成"是"），把候选里的标记同步一下。
      try {
        const refreshed = await options.projectsOf?.()
        if (Array.isArray(refreshed)) {
          projects = refreshed
          projectsLoaded = true
        }
      } catch { /* 候选刷新失败不影响主流程 */ }
    }
    await load()
  }

  /**
   * 一键初始化当前目录。
   *
   * 成功后**必须重新探测 + 重新取数**，否则面板还是"这不是 DDD 项目"。
   */
  const initializeProject = async (): Promise<InitResult> => {
    if (options.initOf === undefined) {
      return { ok: false, error: '当前没有接上初始化功能。', created: [], skipped: [], failed: [] }
    }
    const cwd = chosenCwd
    if (cwd === '') {
      return { ok: false, error: '请先选择或浏览一个目录。', created: [], skipped: [], failed: [] }
    }
    const result = await options.initOf(cwd)
    if (result.ok || result.created.length > 0) await recheck()
    notify()
    return result
  }

  void load()

  const base: Controller = {
    getSnapshot: () => snapshot,
    getError: () => error,
    isLoading: () => loading,
    refresh: () => { void load() },
    getChosenCwd: () => chosenCwd,
    getSessionId: () => options.sessionIdOf(),
    getProjects: () => projects,
    isProjectsLoading: () => projectsLoading,
    areProjectsLoaded: () => projectsLoaded,
    refreshProjects: () => { void loadProjects() },
    selectProject,
    pickProject,
    recheck,
    initializeProject,
    archive: (ids) => runGraveyardAction(postArchive, ids),
    restore: (paths) => runGraveyardAction(postRestore, paths),
    isBusy: () => busy,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }

  if ((options.refreshMs ?? 0) > 0) {
    const timer = setInterval(() => { void load() }, options.refreshMs)
    // 组件卸载时清掉（Cordis 的 effect 会调 disposer）
    return {
      ...base,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener); if (listeners.size === 0) clearInterval(timer) }
      },
    }
  }

  return base
}

/**
 * 订阅 controller 的小 hook（不引入 react-dom，只用 react）。
 *
 * @param controller 要订阅的 controller
 * @returns 当前快照 / 错误 / 加载态
 */
function useControllerState(controller: Controller): { snapshot?: Snapshot; error?: string; loading: boolean } {
  const [, force] = React.useState(0)
  React.useEffect(() => {
    const unsubscribe = controller.subscribe(() => force((n) => n + 1))
    return unsubscribe
  }, [controller])
  return {
    snapshot: controller.getSnapshot(),
    error: controller.getError(),
    loading: controller.isLoading(),
  }
}

/**
 * 数据态三选一（loading / error / empty / 正常）—— **绝不留白**。
 *
 * @param props.footer 拿到**真快照**后渲染在底部的附加区（M2.3 的阅读顺序条）。
 *
 * 为什么把 footer 挂在这一层而不是 `BoardPage`：这里才知道"快照到底有没有到手"。
 * 挂在外面会让条在「还没选项目根」时也出现 —— 那会显示一个**假的 0/0 进度**，
 * 正是本项目最怕的症状。
 */
function BodyWith(
  { controller, render, footer }: {
    controller: Controller
    render: (snapshot: Snapshot) => React.ReactElement
    footer?: (snapshot: Snapshot) => React.ReactElement | null
  },
): React.ReactElement {
  const { snapshot, error, loading } = useControllerState(controller)

  // M2.3 演练 D3：窗口重新可见时刷新一次 + **可见时低频轮询**。
  // 放在 BodyWith 而不是各页面里：两个席位（主栏 / 右栏）都经过这里，一处接线两处生效。
  React.useEffect(() => watchVisibility(controller), [controller])
  React.useEffect(() => watchPolling(controller, DEFAULT_POLL_INTERVAL_MS), [controller])

  // ⚠️ **还没选项目**：必须明说"去上面选"，而不是显示"这个项目没启用 DDD"。
  // 两者长得像但含义完全不同：前者是"我不知道查谁"，后者是"查过了，没启用"。
  // 混为一谈会让用户以为自己的项目坏了（2026-11-13 实机就撞过这个）。
  if (controller.getChosenCwd() === '' && snapshot === undefined && !loading) {
    return h('div', { style: styles.pageEmpty },
      h('div', { style: styles.pageEmptyTitle }, '请先选择项目根'),
      h('div', { style: styles.pageEmptyBody },
        '宿主不会告诉面板"当前是哪个项目"，所以需要你在上面的下拉里选一个。',
      ),
      h('div', { style: styles.pageEmptyBody },
        '选完会立刻读取该项目的门禁与文档清单。',
      ),
    )
  }

  if (error !== undefined) return h(ErrorView, { message: error, onRetry: controller.refresh })
  if (snapshot === undefined) {
    return loading ? h(LoadingView) : h(ErrorView, { message: '没有拿到数据（这不应当发生）', onRetry: controller.refresh })
  }
  if (snapshot.projectRoot === '') return h(EmptyView, { projectRoot: snapshot.projectRoot })
  const body = render(snapshot)
  const bottom = footer === undefined ? null : footer(snapshot)
  // 没有 footer 时**保持原结构**（不要多套一层 div）：多包一层会改变
  // 既有面板的 flex 高度分配，属于无谓的回归风险。
  if (bottom === null) return body
  return h('div', { style: styles.bodyColumn },
    // 正文占满剩余高度，底部条固定高度 —— 少了这层，正文的
    // `height: 100%` 会按**整个列**算，把底条顶出可视区。
    h('div', { style: styles.bodyFill }, body),
    bottom,
  )
}

/** 左栏入口行（图标）。 */
export function EntryIcon(props: { size?: number; active?: boolean }): React.ReactElement {
  return h(PanelIcon, props)
}

/**
 * 项目根选择器（M2.2）。
 *
 * ---- 为什么必须有这个控件（而不是自动判断）----
 *
 * 宿主**设计上**不给 root-scope 的 `main` 席位任何会话绑定
 * （`dsh-client-ui-layout` 注释原文：「other keys receive no Session binding」），
 * 而 client 侧也没有任何服务暴露"用户当前选中了哪个会话"。
 *
 * 所以面板**不可能**自己知道该查哪个项目。硬猜的后果是：
 * 显示**另一个项目**的门禁读数 —— 那比不显示更糟（把错误的信任可视化）。
 *
 * 因此这里让用户**显式选**，候选由 host 的 `/api/ddd/projects` 提供
 * （只有 host 能读会话目录、判断有没有 `docs/`）。
 */
export function ProjectPicker({ controller }: { controller: Controller }): React.ReactElement {
  // ⚠️ **本组件必须自己订阅 controller**（2026-11-13 实测的第二层真因）。
  //
  // 第一版只改了 `selectProject` 里的 notify 时机 —— 那是必要的，但**不够**：
  // `ProjectPicker` 与 `BodyWith` 是**两个独立组件**，各自调 `controller.getXxx()`。
  // 只有 `BodyWith` 订阅了（`useControllerState`），所以 chosenCwd 变化时
  // `BodyWith` 重渲染、`ProjectPicker` **纹丝不动** ——
  // 于是 `<select value={chosenCwd}>` 一直显示旧值，而下方内容已经换了。
  // 这正是用户看到的"框里路径不变、内容变了"。
  useControllerState(controller)

  const chosen = controller.getChosenCwd()
  const projects = controller.getProjects()
  const loading = controller.isProjectsLoading()
  const loaded = controller.areProjectsLoaded()
  const [pickNote, setPickNote] = React.useState<string | undefined>(undefined)
  const [picking, setPicking] = React.useState(false)
  const [busy, setBusy] = React.useState<'recheck' | 'init' | undefined>(undefined)
  const [initNote, setInitNote] = React.useState<string | undefined>(undefined)
  // 预览失败的原因（"点了没反应"必须在界面上留痕）。
  const previewNote = usePreviewError()

  // 第一次渲染就把候选拉下来（用户已经打开面板，说明他确实要用）。
  React.useEffect(() => {
    if (!loaded && !loading) controller.refreshProjects()
  }, [controller, loaded, loading])

  const options = [
    h('option', { key: '', value: '', style: styles.option }, chosen === '' ? '— 请选择项目根 —' : '— 取消选择 —'),
    ...projects.map((project) => h('option', {
      key: project.cwd,
      value: project.cwd,
      // ⚠️ 每个 option 都要带样式：只给 select 设 color 时，
      // 展开列表会变成白底白字（系统不会把 hover 反色之外的行画出来）。
      style: styles.option,
    }, `${project.isDdd ? '● ' : '○ '}${project.cwd}`)),
  ]

  /** 点"浏览…"：走宿主原生目录选择器，可指定任意目录。 */
  const onBrowse = async () => {
    if (picking) return
    setPicking(true)
    setPickNote(undefined)
    try {
      const result = await controller.pickProject()
      if (result.kind === 'unavailable') setPickNote(result.reason)
      // picked / cancelled 都不需要提示：前者会立刻显示数据，后者是用户自己取消的。
    } finally {
      setPicking(false)
    }
  }

  /**
   * 点 ⟳：**真的**重新探测（不只是重取快照）。
   *
   * 旧实现只调 `refreshProjects()` + `refresh()`，而 host 的探测有 TTL 缓存，
   * 所以「刚建好 docs/ 点刷新」永远看不到变化（用户 2026-11-13 实测）。
   */
  const onRecheck = async () => {
    if (busy !== undefined) return
    setBusy('recheck')
    setInitNote(undefined)
    try {
      await controller.recheck()
      setInitNote('已重新探测。')
    } finally {
      setBusy(undefined)
    }
  }

  /** 点「初始化为 DDD 工作区」：建 docs/ + 写入口索引，然后立刻重新探测。 */
  const onInit = async () => {
    if (busy !== undefined) return
    setBusy('init')
    setInitNote(undefined)
    try {
      const result = await controller.initializeProject()
      if (result.ok) {
        const made = result.created.length > 0 ? `已创建：${result.created.join('、')}` : '没有新建任何东西'
        const skipped = result.skipped.length > 0 ? `；已跳过：${result.skipped.join('、')}` : ''
        setInitNote(`${made}${skipped}`)
      } else if (result.failed.length > 0) {
        setInitNote(`失败：${result.failed.map((item) => `${item.path}（${item.error}）`).join('；')}`)
      } else {
        setInitNote(`失败：${result.error ?? '未知原因'}`)
      }
    } finally {
      setBusy(undefined)
    }
  }

  const hasChosen = chosen !== ''

  return h('div', { style: styles.pickerWrap },
    h('div', { style: styles.picker },
      h('label', { style: styles.pickerLabel, htmlFor: 'ddd-project-picker' }, '项目根'),
      h('select', {
        id: 'ddd-project-picker',
        style: styles.select,
        value: chosen,
        disabled: loading,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
          controller.selectProject(event.target.value)
        },
      }, options),
      // "浏览…"：候选只覆盖"被会话打开过"的目录，新项目必须靠它才能指定。
      h('button', {
        type: 'button',
        style: styles.actionButton,
        onClick: () => { void onBrowse() },
        disabled: picking,
        title: '选择一个还没出现在列表里的目录',
      }, picking ? '选择中…' : '浏览…'),
      // ⟳：**真的重新探测**（清掉 host 侧的探测缓存），不是只重取快照。
      h('button', {
        type: 'button',
        style: styles.actionButton,
        onClick: () => { void onRecheck() },
        disabled: busy !== undefined,
        title: '重新探测当前目录（新建了 docs/ 之后点这个）',
      }, busy === 'recheck' ? '探测中…' : '⟳'),
      // 一键初始化：只在选了目录时可用。
      h('button', {
        type: 'button',
        style: hasChosen ? styles.primaryButton : styles.actionButtonDisabled,
        onClick: () => { void onInit() },
        disabled: busy !== undefined || !hasChosen,
        title: '在这个目录里建 docs/ 并写一份入口索引',
      }, busy === 'init' ? '初始化中…' : '初始化为 DDD 工作区'),
    ),
    // 图例 + 加载状态。
    // ⚠️ **候选是异步长出来的**：宿主还在加载会话清单时列表会偏少，
    // 必须把这件事说出来，否则用户会以为"我的项目不见了"（实测就是这个问题）。
    h('div', { style: styles.pickerMeta },
      loading
        ? '正在读取已知项目…（宿主可能还在加载会话，稍后点 ⟳ 会更全）'
        : `● 已启用 DDD ｜ ○ 尚未启用 ｜ 共 ${projects.length} 个已知目录`,
      pickNote === undefined ? null : h('span', { style: styles.pickerWarn }, ` ｜ ${pickNote}`),
      initNote === undefined ? null : h('span', { style: styles.pickerNote }, ` ｜ ${initNote}`),
      previewNote === undefined ? null : h('span', { style: styles.pickerWarn }, ` ｜ 预览：${previewNote}`),
    ),
    // ⚠️ **一直显示**的边界说明（不是错误）。
    // 这个面板里点文档**永远**打不开预览 —— 右栏是会话作用域的，root 面板没有会话。
    // 不说清楚的话，用户只会觉得"点了没反应"，而那是本项目最忌讳的症状。
    h('div', { style: styles.pickerBoundary }, PREVIEW_BOUNDARY_NOTE),
  )
}

/** 主栏整页。 */
export function BoardPage({ controller }: { controller: Controller }): React.ReactElement {
  return h('div', { style: styles.page },
    h(ProjectPicker, { controller }),
    h(BodyWith, {
      controller,
      render: (snapshot) => h(MainPage, {
        snapshot,
        // 这个面板是 root scope，没有会话 → 右栏不存在 → 预览必抛。
        // 所以直接禁用点击手势，而不是让用户点了没反应。
        previewDisabled: PREVIEW_UNAVAILABLE_IN_ROOT_PANEL,
        onOpenDoc: (doc: SnapshotDoc) => openDoc(controller, snapshot, doc),
        // ---- M2.6：交付页的接线 ----
        //
        // ⚠️ 2026-11-14 用户实测「交付页面点文件点不开」。
        // 真因与 W7 **一模一样**：`MainPage` 声明了 `onOpenFile`，
        // 但这里没传 → `DeliverableCell` 的 `onOpen?.()` 把点击静默吞掉。
        //
        // 这里**故意不传 onOpenFile**，而传 `previewDisabled`：
        // root 面板没有会话上下文，`openResource` 一调就抛
        // （见 `PREVIEW_UNAVAILABLE_IN_ROOT_PANEL` 的注释）。
        // 传一个"点了会抛"的 handler 比不传更糟 —— 那是"看起来能点、点了报错"。
        //
        // ⇒ 交付卡片改成**不可点**（`cursor: default` + 不给 onClick），
        //   并在页面上明说「预览只能在会话页打开」。
        //   `_m23/verify-built-deliverables.mjs` 钉住这两条。
        // ---- M2.5 · W7：归档/还原的接线 ----
        //
        // ⚠️ 2026-11-14 之前这里**什么都没传**，于是 `onArchive?.()` 的可选链
        // 把点击吞掉 —— 点「归档选中的 N 份」什么都不发生，且不报错。
        // 产物级验证抓到了这条（`_m23/verify-built-graveyard.mjs`）。
        onArchive: (ids: readonly string[]) => { void controller.archive(ids) },
        onRestore: (paths: readonly string[]) => { void controller.restore(paths) },
        archiving: controller.isBusy(),
      }),
      // M2.3 · 需求 2：底部「AI 阅读顺序」条（数据源 = `required`，顺序由 host 给）。
      footer: (snapshot) => h(ReadOrderBar, {
        snapshot,
        previewDisabled: PREVIEW_UNAVAILABLE_IN_ROOT_PANEL,
        // ⚠️ root 面板拿不到会话 id（宿主不绑）→ 用独立命名空间，不与任何会话共享勾。
        sessionId: controller.getSessionId(),
        // 从快照里**查回**完整的那一条，而不是拼一个缺字段的假对象。
        onOpenDoc: (item) => {
          const doc = snapshot.required.find((each) => each.id === item.id)
          if (doc !== undefined) openDoc(controller, snapshot, doc)
        },
      }),
    }),
  )
}

/** 右栏看板。 */
export function BoardPanel({ controller }: { controller: Controller }): React.ReactElement {
  return h('div', { style: styles.page },
    h(ProjectPicker, { controller }),
    h(BodyWith, {
      controller,
      render: (snapshot) => h(Dashboard, {
        snapshot,
        onOpenDoc: (doc: SnapshotDoc) => openDoc(controller, snapshot, doc),
      }),
      footer: (snapshot) => h(ReadOrderBar, {
        snapshot,
        previewDisabled: PREVIEW_UNAVAILABLE_IN_ROOT_PANEL,
        sessionId: controller.getSessionId(),
        onOpenDoc: (item) => {
          const doc = snapshot.required.find((each) => each.id === item.id)
          if (doc !== undefined) openDoc(controller, snapshot, doc)
        },
      }),
    }),
  )
}

/**
 * 打开一份文档的预览。
 *
 * ---- 为什么要把这段抽出来（2026-11-13 用户实测）----
 *
 * 用户：「鼠标放上去会变手势，但点击没有反应，打不开文档」。
 *
 * 两个原因叠在一起：
 *   1. `sidebarRight` 从来没被拿到（`ctx.get` 对它无效，必须写进 `inject`）；
 *   2. 就算拿到了，地址里的 `sessionId` 是空串时 `parseFileAddress` **直接返回 undefined**
 *      —— 那是一个"看起来有地址、实际解析不了"的字符串。
 *
 * 所以这里做三件事：**取真 sessionId → 拼可解析地址 → 打不开就明说**，
 * 而不是让用户点了没反应。
 */
function openDoc(controller: Controller, snapshot: Snapshot, doc: SnapshotDoc): void {
  const sessionId = controller.getSessionId() || snapshot.sessionId
  const address = previewAddressOf(sessionId, `docs/${doc.id}.md`, snapshot.projectRoot)
  if (!isOpenableAddress(address)) {
    // eslint-disable-next-line no-console
    console.warn(`[ddd] 预览地址不可解析（sessionId='${sessionId}'）：${address}`)
    setPreviewError('拿不到会话 id，预览打不开。')
    return
  }
  setPreviewError(undefined)
  openPreview(address)
}

/**
 * 预览在本面板里是否**根本不可能**（设计边界，不是临时故障）。
 *
 * 判据来自源码：右栏席位全是 `scope:'session'`，而 `main` 面板是 `scope:'root'`。
 * root 面板上没有会话挂载 → `sidebarRight.openResource` 必抛
 * `no session surface is mounted`。
 *
 * ⚠️ 所以这里返回 `true` 时，**文档行不该显示可点击手势** ——
 * 否则就是"看起来能点、点了没反应"，那是本项目最忌讳的症状。
 */
export const PREVIEW_UNAVAILABLE_IN_ROOT_PANEL = true

/**
 * 这条提示要一直显示（不是错误，是边界说明）。
 *
 * ---- 2026-11-14 M2.6：改成用户能照做的说法 ----
 *
 * 旧文案：「预览只能在会话页打开：本面板没有会话上下文（右栏是会话作用域的）。」
 * 那是**给开发者看的**。用户读完仍然不知道"会话页在哪、我该点什么"。
 *
 * 新文案要回答三个问题：**为什么点不开**、**文件在哪**、**去哪儿点能打开**。
 *
 * ⚠️ 这是硬边界，不是能修的 bug（已核实 `_ref/asar` 里 sidebar-right 的源码）：
 *    `openResource(address)` 第一行 `this.require()` 里 `this.mounted.getSnapshot()`
 *    取的是**屏幕上挂载的会话**；root 面板没有会话 → 必然抛
 *    `sidebarRight: no session surface is mounted`。
 *    换 scope 拼地址也没用 —— 那是服务内部的前置条件。
 */
const PREVIEW_BOUNDARY_NOTE =
  '文件在项目的 `docs/` 与 `deliverables/` 目录下。'
  + '本面板（主栏）没有会话上下文，点不开预览 —— '
  + '要打开文件，请到**会话页右侧栏**的 DDD 页签里点同一份。'

/**
 * 预览为什么在这个面板里打不开（**设计边界，不是 bug**）。
 *
 * ---- 2026-11-13 用户实测 + 源码核实 ----
 *
 * 用户：「鼠标放上去会变手势，但点击没有反应，打不开文档」。
 *
 * 核实结论（`dsh-client-ui-sidebar-right/src/client/service.ts` L854-864）：
 *
 * ```js
 * private require() {
 *   const sessionId = this.mounted.getSnapshot()   // ← 屏幕上的会话
 *   const actions = sessionId === undefined ? undefined : this.actionsFor(sessionId)
 *   if (sessionId === undefined || actions === undefined) {
 *     throw new Error('sidebarRight: no session surface is mounted')
 *   }
 *   ...
 * }
 * ```
 *
 * 而右栏的所有席位（`sidebar.right.pane.tab` 等）都是 **`scope: 'session'`**。
 *
 * DDD 的主栏面板是 **root scope**（`main` 席位的 `scope: 'root'`），
 * 它上面**没有会话在屏幕上** —— 所以：
 *
 *   * 右栏不存在；
 *   * `openResource` 一调就**抛** `no session surface is mounted`。
 *
 * ⇒ **在这个面板里永远打不开预览。** 不是拼错了地址，也不是没拿到 sidebarRight。
 *
 * ---- 那正确的出路是什么 ----
 *
 * **在会话页右侧栏注册一个 DDD 页签**（需求 3）。那里是 session scope，
 * 有 `sessionId`、有右栏、`openResource` 能用 —— 而且**不需要用户手选项目根**。
 * 详见交接文档的「需求 3」。
 */

/**
 * 最近一次"打不开"的原因（M2.2）。
 *
 * 用一个模块级订阅点把它暴露给 `ProjectPicker` 下方的提示行 ——
 * "点了没反应"是最难查的症状，所以失败必须**在界面上留痕**，不能只打 console。
 */
let previewError: string | undefined
const previewErrorListeners = new Set<() => void>()
function setPreviewError(message: string | undefined): void {
  previewError = message
  for (const listener of previewErrorListeners) listener()
}
/** 订阅预览错误（供 `ProjectPicker` 用）。 */
function usePreviewError(): string | undefined {
  const [, force] = React.useState(0)
  React.useEffect(() => {
    const listener = () => force((n) => n + 1)
    previewErrorListeners.add(listener)
    return () => { previewErrorListeners.delete(listener) }
  }, [])
  return previewError
}

/** 选择器那几行的样式（与 main-page 一致地走主题变量，不写死颜色）。 */
const styles = {
  page: { height: '100%', display: 'flex', flexDirection: 'column' as const, minHeight: 0 },
  /**
   * `BodyWith` 带 footer 时的列容器（M2.3 需求 2）。
   *
   * `minHeight: 0` 是关键：flex 子项默认 `min-height: auto`，
   * 不写它的话内容撑高后**底部那条会被挤出可视区**，
   * 用户会以为"没有这个功能"。
   */
  bodyColumn: {
    flex: '1 1 auto',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column' as const,
  },
  /** 正文区：吃掉剩余高度，允许内部滚动（底条因此不会被顶出去）。 */
  bodyFill: { flex: '1 1 auto', minHeight: 0, overflow: 'hidden' as const },
  pickerWrap: {
    flexShrink: 0,
    borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))',
  },
  picker: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 20px 4px',
    flexShrink: 0,
  },
  pickerMeta: {
    padding: '0 20px 8px',
    fontSize: '11px',
    opacity: 0.5,
  },
  pickerWarn: { color: 'var(--dsw-alias-state-warn-primary, #d29922)', opacity: 1 },
  pickerNote: { color: 'var(--dsw-alias-label-secondary, #9a9a9a)', opacity: 1 },
  pickerBoundary: {
    padding: '0 20px 8px',
    fontSize: '11px',
    color: 'var(--dsw-alias-label-secondary, #9a9a9a)',
    opacity: 0.8,
  },
  pickerLabel: { fontSize: '12px', opacity: 0.65, flexShrink: 0 },
  select: {
    flex: '1 1 auto',
    minWidth: 0,
    font: 'inherit',
    fontSize: '12px',
    padding: '4px 6px',
    // ⚠️ **原生 `<select>` 的 `<option>` 列表由操作系统绘制，不继承页面样式**。
    // 只设 `color` 会让展开后的选项变成「白底白字」（实测：只有鼠标悬停那一行可见）。
    // 必须**同时**给 `option` 显式指定 `backgroundColor` + `color`。
    color: 'var(--dsw-alias-label-primary, #e6e6e6)',
    background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.08))',
    border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))',
    borderRadius: '4px',
  },
  // 展开后的选项行（Chromium/Electron 认这两个属性）。
  option: {
    color: 'var(--dsw-alias-label-primary, #e6e6e6)',
    background: 'var(--dsw-alias-bg-overlay, #1e1e1e)',
  },
  pickerHint: { fontSize: '11px', opacity: 0.5, flexShrink: 0 },
  actionButton: {
    font: 'inherit',
    fontSize: '12px',
    padding: '3px 8px',
    color: 'var(--dsw-alias-label-primary, #e6e6e6)',
    background: 'transparent',
    border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))',
    borderRadius: '4px',
    cursor: 'pointer',
    flexShrink: 0,
  },
  actionButtonDisabled: {
    font: 'inherit',
    fontSize: '12px',
    padding: '3px 8px',
    color: 'var(--dsw-alias-label-secondary, #9a9a9a)',
    background: 'transparent',
    border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))',
    borderRadius: '4px',
    cursor: 'not-allowed',
    opacity: 0.5,
    flexShrink: 0,
  },
  primaryButton: {
    font: 'inherit',
    fontSize: '12px',
    padding: '3px 10px',
    color: 'var(--dsw-alias-bg-base, #1e1e1e)',
    background: 'var(--dsw-alias-brand-primary, #58a6ff)',
    border: '1px solid var(--dsw-alias-brand-primary, #58a6ff)',
    borderRadius: '4px',
    cursor: 'pointer',
    flexShrink: 0,
    fontWeight: 600,
  },
  pageEmpty: {
    flex: '1 1 auto',
    padding: '28px 24px',
    font: '13px/1.7 system-ui, -apple-system, "Segoe UI", sans-serif',
    color: 'var(--dsw-alias-label-primary, #e6e6e6)',
    maxWidth: '560px',
  },
  pageEmptyTitle: { fontSize: '15px', fontWeight: 600, marginBottom: '10px' },
  pageEmptyBody: { opacity: 0.72, marginBottom: '8px' },
}

/** `BodyWith` 的容器：占满剩余高度并允许内部滚动。 */
const bodyBox = { flex: '1 1 auto', minHeight: 0, overflow: 'auto' as const }

/**
 * 开预览（M2-B）。
 *
 * 走 `ctx.sidebarRight.openResource(address)` —— **不自己写渲染器**（SPEC §3.12）。
 * 但 `ctx` 不在这个模块作用域里，所以由 `apply` 时把 opener 注进来。
 */
let previewOpener: ((address: string) => void) | undefined

/** 由 `apply()` 注入真正的 opener。 */
export function setPreviewOpener(opener: (address: string) => void): void {
  previewOpener = opener
}

/** 内部：调 opener。拿不到时**不静默**——打一条 warn（不然"点了没反应"没法查）。 */
function openPreview(address: string): void {
  if (previewOpener === undefined) {
    // eslint-disable-next-line no-console
    console.warn(`[ddd] 预览通道不可用（sidebarRight 未注入），地址是：${address}`)
    return
  }
  try {
    previewOpener(address)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[ddd] 打开预览失败：${(error as Error)?.message ?? error}`)
  }
}

/**
 * 注册两个席位（Q7 双注册）。
 *
 * ⚠️ **每个注册都包在 `slots.inject` 里**（照 skill-explorer）：
 * 席位由我们不依赖的 shell 插件声明，`inject` 的回调只在它声明之后才跑。
 * 一个从未声明该席位的 shell 会让面板**简单地不存在**，而不是启动失败。
 *
 * @returns disposer（两个注册一起释放）
 */
export function registerPanel(ctx: any, controller: Controller): () => void {
  // ⚠️ 用 `ctx.get('slots')` 而不是 `ctx.slots`：cordis 的 ctx 是 Proxy，
  // 读一个**未在 inject 里声明**的服务会直接抛（不是返回 undefined）。
  // `slots` 虽然已写进 entry 的 inject，但这里保持与 `entry.tsx` 同一条纪律：
  // **可选服务一律软取**，这样即使将来 inject 变了，也只是"面板不出现"而不是"apply 抛错"。
  let slots: any
  try {
    slots = typeof ctx?.get === 'function' ? ctx.get('slots') : undefined
  } catch {
    slots = undefined
  }
  if (slots === undefined || typeof slots.inject !== 'function') {
    // eslint-disable-next-line no-console
    console.warn('[ddd] 没有 slots 服务，面板未注册')
    return () => {}
  }

  const disposers: Array<() => void> = []
  disposers.push(slots.inject('sidebar.panellist', () => slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: PANEL_ORDER,
    label: () => '文档驱动开发',
  }, EntryIcon)))

  disposers.push(slots.inject('main', () => slots.register({
    name: 'main',
    key: PANEL_ID,
    inject: () => ({ controller }),
  }, BoardPage)))

  return () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* 释放失败不影响其它 */ }
    }
  }
}

/**
 * 注册**会话右栏页签**（M2.3 · 需求 3）。
 *
 * ---- 两段式注册（照官方 `ui-sidebar-documentpreview`）----
 *
 * | 阶段 | 去哪 | 键 |
 * |---|---|---|
 * | ① 类型 | `ctx.sidebarRightTabs.register(definition)` | `definition.id` |
 * | ② 正文 | keyed `sidebar.right.pane.tab` | `definition.id` |
 *
 * ⚠️ **两段的键必须逐字一致**（都是 `DDD_TAB_ID`）。不一致的症状是
 * "点开页签一片空白"，而且**不报错** —— 因为宿主的判据是
 * "没有类型认领这个 kind → 渲染 owner 的 'nothing can view this' 提示"。
 *
 * ---- 与 `registerPanel` 的分工 ----
 *
 * `registerPanel` 管的是 **root scope** 的两个席位（左栏入口 + 主栏整页），
 * 本函数管的是 **session scope** 的右栏页签。两者**互不影响**：
 * root 面板里预览永远打不开（事实没变），右栏页签里能打开。
 *
 * @param ctx client 根上下文（`inject` 必须含 `sidebarRightTabs` 与 `slots`）
 * @param wiring 交给组件的取数/开预览能力
 * @returns disposer（三个注册一起释放）
 */
export function registerSessionTab(ctx: any, wiring: SessionTabWiring): () => void {
  const disposers: Array<() => void> = []

  // ---- ① 类型 ----
  // `sidebarRightTabs` 是 `reflect.provide` 出来的（不在 Service 目录里），
  // 所以 `ctx.get('sidebarRightTabs')` 可能因 strict 时序返回 undefined。
  // 写进 inject 后 `ctx.sidebarRightTabs` 才是正路；这里仍做软取兜底，
  // 保证"没有这个服务"时只是**页签不出现**，而不是 apply 抛错。
  let tabs: any
  try {
    tabs = ctx?.sidebarRightTabs
  } catch {
    tabs = undefined
  }
  if (tabs === undefined) {
    try {
      tabs = typeof ctx?.get === 'function' ? ctx.get('sidebarRightTabs') : undefined
    } catch {
      tabs = undefined
    }
  }
  if (tabs === undefined || typeof tabs.register !== 'function') {
    // eslint-disable-next-line no-console
    console.warn('[ddd] 没有 sidebarRightTabs 服务，会话右栏页签未注册（主栏不受影响）')
    return () => {}
  }

  const definition = dddTabDefinition()
  try {
    disposers.push(tabs.register(definition))
  } catch (error) {
    // 重复注册 / kind 冲突会 throw。**只 warn**：页签不出现不该连累主栏。
    // eslint-disable-next-line no-console
    console.warn(`[ddd] 注册 tab 类型失败：${(error as Error)?.message ?? error}`)
    return () => {}
  }

  // ---- ② 正文 + ③ 标题 ----
  let slots: any
  try {
    slots = typeof ctx?.get === 'function' ? ctx.get('slots') : undefined
  } catch {
    slots = undefined
  }
  if (slots === undefined || typeof slots.inject !== 'function') {
    // eslint-disable-next-line no-console
    console.warn('[ddd] 没有 slots 服务，会话右栏页签正文未注册')
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* 忽略 */ }
    }
    return () => {}
  }

  disposers.push(slots.inject('sidebar.right.pane.tab', () => slots.register({
    name: 'sidebar.right.pane.tab',
    key: DDD_TAB_ID,
    // ⚠️ `sessionId` 由框架作为 **standard prop** 注入，**不要**自己从 ctx 里找。
    //
    // 签名照官方两个实现：`(sessionId, actions) => face`。
    // 但注意：**`inject` 的返回值只是私有输入**，`sessionId` 真正的来源是
    // 框架随后注入给组件的 standard props（见 `SessionTabProps`）。
    // 所以这里只回传 wiring —— 少回传一个字段不会让组件拿不到 sessionId，
    // 而**多回传**反而会覆盖框架注入的同名 prop（那是第一版 `active: false` 的嫌疑之一）。
    inject: () => ({ wiring }),
  }, SessionTab)))

  // 标题：不注册也行（会退回 `definition.title` 捕获的文本），
  // 但注册了才能跟随语言切换。这里给一个恒定的中文标题，保持与主栏一致。
  disposers.push(slots.inject('sidebar.right.pane.tab.title', () => slots.register({
    name: 'sidebar.right.pane.tab.title',
    key: DDD_TAB_ID,
  }, DddTabTitle)))

  return () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* 释放失败不影响其它 */ }
    }
  }
}

/** 页签标题（chip 上显示的字）。 */
function DddTabTitle(): React.ReactElement {
  return h('span', null, '文档驱动开发')
}

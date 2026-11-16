/**
 * 会话右栏的 DDD 页签正文（M2.3 · 需求 3）。
 *
 * ---- 与主栏整页（`BoardPage`）的三处关键差异 ----
 *
 * | | 主栏整页 | 本页签 |
 * |---|---|---|
 * | scope | `root` | **`session`** |
 * | 项目根 | 用户手选（宿主不给 root 席位会话绑定） | **自动**从会话的 cwd 来 |
 * | 预览 | 注定打不开 → 禁用点击 | **能打开** → 保留点击 |
 *
 * ---- ⚠️ 2026-11-14 实机事故：**这里曾经在 `useMemo` 里调 hook，把整个右栏炸空** ----
 *
 * 症状（用户实测）：
 *   1. 在**已经开始工作**的会话里点开页签 → 正常；
 *   2. 切到一个**还没发过任何话**的新会话 → 右栏**纯空页**；
 *   3. 再切回原来那个正常的会话 → **它也变空了**。
 *
 * 第 3 句是决定性的：数据取不到只会让**这一格**显示"没有数据"，
 * 不可能让**已经渲染好的另一格**变空。能让整棵子树消失的只有一件事：
 * **React 在渲染期抛错 → 错误边界卸载整棵树**。
 *
 * 真因：`useSessions` 是框架注入的 **hook**（`SnapshotSelectorHook`），
 * 而我把 `wiring.cwdOf(useSessions, sessionId)` 放进了 `React.useMemo` 的回调里。
 * `useMemo` 回调在**渲染期**执行，于是 hook 被"有条件地"调用：
 * 新会话 cwd 为空时走的路径与有 cwd 时不同 → hook 调用序列变了 →
 * React 抛 `Rendered more hooks than during the previous render` → 右栏整棵卸载。
 *
 * **现在的做法（记住这条纪律）**：
 * > **组件里一个框架 hook 都不调**。cwd 走 `cwdOfSession(ctx, sessionId)` ——
 * > 那是纯快照读（`sessions.list.getSnapshot()`），官方 `ui-reference` L65/L168 就这么用。
 * >
 * > 理由不只是"这次修 bug"：页签是**窄栏、按会话切换**的，
 * > 任何"有时调、有时不调"的 hook 都会在切换会话时炸；纯读没有这个风险。
 *
 * ---- 拿不到 cwd 时怎么办 ----
 *
 * 明说拿不到，并给一个"回主栏手选"的出口。**绝不猜目录**：
 * 猜错会显示别的项目的门禁读数，比不显示更糟（把错误的信任可视化）。
 */

import * as React from 'react'

import type { Snapshot, SnapshotDoc } from './api.ts'
import { Dashboard, EmptyView, ErrorView, LoadingView } from './dashboard.tsx'
import { MainPage } from './main-page.tsx'
import { ReadOrderBar } from './read-order-bar.tsx'
// ⚠️ 从 `visibility.ts` import，**不是**从 `index.tsx`（那会循环依赖）。
import { watchVisibility, watchPolling, DEFAULT_POLL_INTERVAL_MS } from './visibility.ts'

const h = React.createElement

/**
 * 页签正文的 props。
 *
 * ⚠️ 框架会给一大票 standard props（`useSessions` / `useResource` / `useChat` …），
 * 这里**刻意只声明用得到的**。别为了"以后可能用"把它们解构出来 ——
 * 解构出来就很容易顺手在 `useMemo` 里调（见文件头的事故）。
 *
 * 注意：`sessionId` **不在**这里显式传，而是靠框架的 standard prop。
 * 这是官方 `documentpreview` 的用法（它的 `inject` 只返回 face，不回传 sessionId）。
 */
export interface SessionTabProps {
  /** 框架注入：当前会话 id（`sidebar.right.pane.tab` 的 standard prop）。 */
  sessionId?: string
  /** 由 `apply()` 注入的装配（拿 cwd / 取数 / 开预览）。 */
  wiring?: SessionTabWiring
}

/** 一个最小的 controller 形状（避免 `session-tab.tsx` 反过来 import `index.tsx` 造成循环依赖）。 */
export interface TabController {
  getSnapshot: () => Snapshot | undefined
  getError: () => string | undefined
  isLoading: () => boolean
  refresh: () => void
  subscribe: (listener: () => void) => () => void
  /**
   * 归档 / 还原（M2.5 · W7）。
   *
   * ⚠️ 这两个**可选**：页签只要求 controller 满足最小形状，
   * 而单测里的假 controller 不必实现它们。
   * 真 controller（`createController`）一定实现。
   */
  archive?: (ids: readonly string[]) => Promise<unknown>
  restore?: (paths: readonly string[]) => Promise<unknown>
  isBusy?: () => boolean
}

/** `apply()` 交给组件的那些能力（组件自己拿不到 `ctx`）。 */
export interface SessionTabWiring {
  /** 取 cwd（**纯函数**，只读快照，不是 hook）。 */
  cwdOf: (sessionId: string) => string
  /** 取快照。 */
  fetchSnapshot: (cwd: string, sessionId: string) => Promise<{ kind: 'ok'; data: Snapshot } | { kind: 'error'; message: string }>
  /** 开预览（**会话作用域里可用**）。 */
  openDoc: (address: string) => void
  /** 拼预览地址。 */
  addressOf: (sessionId: string, relativePath: string, projectRoot: string) => string
  /**
   * 造 controller。
   *
   * ⚠️ **通过 wiring 传进来，不直接 import `index.tsx`**：
   * `index.tsx` 要 import 本文件的 `SessionTab`，两边互相 import 就是**循环依赖**。
   * 单文件 CJS 打包下函数声明会提升、通常能跑，但那属于"碰巧能跑" ——
   * 一旦哪天打包顺序变了就是 `undefined is not a function`，而且极难查。
   */
  makeController: (options: { cwdOf: () => string; sessionIdOf: () => string }) => TabController
}

/**
 * 页签内部的**错误边界**。
 *
 * ---- 为什么必须有这一层（2026-11-14 事故的直接教训）----
 *
 * 那次事故里，我的组件在渲染期抛错，结果是**整个右栏变空**，
 * 而且切到别的会话也回不来（错误边界卸载了整棵子树）。
 *
 * 本项目有一条更根本的纪律：**插件故障不能变成宿主故障**
 * （`adapters/guard.js` 的注释、`server/routes.ts` 的 `registerRoutes` 都写着）。
 * 右栏是宿主的 UI，我的页签只是其中一格 —— 我抛错不该让别人的页签一起消失。
 *
 * 有了这层：我的页签最多显示一句"这个页签出错了"，**其余右栏不受影响**。
 */
class TabErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { message: string | undefined }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { message: undefined }
  }

  static getDerivedStateFromError(error: unknown): { message: string } {
    return { message: (error as Error)?.message ?? String(error) }
  }

  override componentDidCatch(error: unknown): void {
    // 留痕：这类错误不写 crash 日志（非 required 条目），只能靠 console。
    // eslint-disable-next-line no-console
    console.error('[ddd] 会话右栏页签渲染失败（其余右栏不受影响）：', error)
  }

  override render(): React.ReactNode {
    if (this.state.message !== undefined) {
      return h('div', { style: styles.note },
        h('div', { style: styles.noteTitle }, '这个页签出错了'),
        h('div', { style: styles.mono }, this.state.message),
        h('div', { style: { marginTop: '8px', opacity: 0.7 } },
          '其余右栏不受影响。刷新页面可重试；若反复出现请把上面这句报给插件作者。'),
      )
    }
    return this.props.children
  }
}

/**
 * 页签正文（**带错误边界的外壳**）。
 *
 * ⚠️ 所有 hook 都在 `SessionTabInner` 里，而外壳本身**没有 hook**
 * （class 组件的 `state` 不参与 hook 序列），所以抛错不会打乱 hook 顺序。
 */
export function SessionTab(props: SessionTabProps): React.ReactElement {
  return h(TabErrorBoundary, null, h(SessionTabInner, props))
}

/**
 * 真正的正文。
 *
 * 数据流：`sessionId`（框架给）→ `cwd`（会话元数据快照）→ `GET /api/ddd/index`。
 * 三者任一缺失都**显式说明缺哪一环**，不留白、不猜。
 *
 * ⚠️ **本组件的所有 hook 都在顶层无条件调用**（`useMemo` / `useState` / `useEffect`），
 * 早退分支只决定"渲染什么"，不决定"调不调 hook"。这是修 2026-11-14 事故的核心纪律。
 */
function SessionTabInner({ sessionId = '', wiring }: SessionTabProps): React.ReactElement {
  // ① 纯读 cwd（**不是 hook**，可以安全放进 useMemo）。
  const cwd = React.useMemo(
    () => (wiring === undefined ? '' : wiring.cwdOf(sessionId)),
    [wiring, sessionId],
  )

  // ② controller 的生命周期跟着 cwd 走：cwd 变了就换一个（旧数据必须丢）。
  //    这里**必须在顶层无条件调用 useMemo**（不能写在 if 里）。
  const controller = React.useMemo(() => {
    if (wiring === undefined || cwd === '') return undefined
    return wiring.makeController({
      cwdOf: () => cwd,
      sessionIdOf: () => sessionId,
      // 页签里**不要**项目选择器：会话已经决定了是哪个项目。
    })
  }, [wiring, cwd, sessionId])

  // ③ 订阅 controller（hook 也无条件调用）。
  const [, force] = React.useState(0)
  React.useEffect(() => {
    if (controller === undefined) return undefined
    return controller.subscribe(() => force((n) => n + 1))
  }, [controller])

  // ④ 窗口重新可见时刷新一次 + 可见时低频轮询（M2.3 演练 D3）。
  //    ⚠️ 仍然不是实时，但"AI 读了文档"最多 5 秒后能看到 —— 见 `watchPolling` 的注释。
  React.useEffect(() => {
    if (controller === undefined) return undefined
    return watchVisibility(controller)
  }, [controller])

  React.useEffect(() => {
    if (controller === undefined) return undefined
    return watchPolling(controller, DEFAULT_POLL_INTERVAL_MS)
  }, [controller])

  // ---- 以下只决定"渲染什么"，不再碰任何 hook ----

  if (wiring === undefined) {
    return h('div', { style: styles.note }, '页签没有接上数据源（装配缺失，这是插件的问题）。')
  }
  if (sessionId === '') {
    // 框架没给 sessionId = 这个席位被挂在了非会话上下文里。明说，不猜。
    return h('div', { style: styles.note },
      '拿不到会话 id：这个页签只能在会话页的右栏里用。')
  }
  if (cwd === '') {
    // 真实会发生：刚创建、宿主还没回填 cwd 的会话。
    return h('div', { style: styles.note },
      h('div', { style: styles.noteTitle }, '拿不到这个会话的项目目录'),
      h('div', null,
        'DDD 需要知道项目根才能读门禁。会话元数据里暂时没有 cwd —— '
        + '等宿主回填后重开这个页签，或到主栏「文档驱动开发」里手动选一个目录。'),
    )
  }
  if (controller === undefined) return h(LoadingView)

  const snapshot = controller.getSnapshot()
  const error = controller.getError()
  const loading = controller.isLoading()

  if (error !== undefined) return h(ErrorView, { message: error, onRetry: controller.refresh })
  if (snapshot === undefined) {
    return loading
      ? h(LoadingView)
      : h(ErrorView, { message: '没有拿到数据（这不应当发生）', onRetry: controller.refresh })
  }
  if (snapshot.projectRoot === '') {
    // 会话有 cwd，但那个目录不是 DDD 项目 —— 这是**正常结局**，不是错误。
    return h('div', null,
      h(EmptyView, { projectRoot: snapshot.projectRoot }),
      h('div', { style: styles.note }, `会话目录：${cwd}`),
    )
  }

  /** 会话作用域里**能**开预览 —— 这是需求 3 最大的红利。 */
  const onOpenDoc = (doc: SnapshotDoc): void => {
    const address = wiring.addressOf(sessionId, `docs/${doc.id}.md`, snapshot.projectRoot)
    try {
      wiring.openDoc(address)
    } catch (openError) {
      // eslint-disable-next-line no-console
      console.warn(`[ddd] 打开预览失败：${(openError as Error)?.message ?? openError}`)
    }
  }

  /**
   * 交付区点文件 → 开预览（M2.6）。
   *
   * ---- 为什么这里能开、主栏不能 ----
   *
   * 右栏页签是 **session scope**，`openResource` 内部的 `this.mounted.getSnapshot()`
   * 能拿到"屏幕上挂载的会话" → 不抛。
   * 而主栏是 **root scope**，没有会话 → 必抛 `no session surface is mounted`。
   *
   * ---- 2026-11-14 用户第二次报同一个症状 ----
   *
   * 用户：「我去右侧侧边栏打开 ddd 的交付页面，我的鼠标移上去连手势都没变，
   *       也不能在右侧跳转出新窗口」。
   *
   * 我上一轮只修了主栏（`index.tsx` 的 `BoardPage`），**漏了这个页签**。
   * `session-tab.tsx` 挂 `MainPage` 时既没传 `onOpenFile`（→ 不可点）
   * 也没传那个禁用预览的 prop（→ 连提示语都没有），于是表现就是
   * "没手势、点了没反应、也不告诉你为什么"——**三样全占**。
   *
   * ⚠️ 教训：`MainPage` 有**两个**调用点（主栏 + 右栏页签），
   * 改一处不传递 = 只修一半。`_m23/verify-built-deliverables.mjs` 现在两处都查。
   */
  const onOpenFile = (path: string): void => {
    // `path` 是快照给的相对路径（`deliverables/xxx.md`），与 `onOpenDoc` 同一种拼法。
    const address = wiring.addressOf(sessionId, path, snapshot.projectRoot)
    try {
      wiring.openDoc(address)
    } catch (openError) {
      // eslint-disable-next-line no-console
      console.warn(`[ddd] 打开交付文件失败：${(openError as Error)?.message ?? openError}`)
    }
  }

  return h('div', { style: styles.page },
    h('div', { style: styles.meta },
      `会话目录：${cwd}`,
      h('span', { style: styles.metaDim }, '（自动，无需手选）')),
    // ---- `下一步`：交接 §3「下一刀」的第一条（M2.3 演练复盘 §5）----
    //
    // 上一轮为了"窄栏不挤"把整个 `Dashboard` 从页签里拿掉了，
    // 结果**把最该给接手者看的东西也拿掉了**。用户原话：「我不知道『下一步 行』是什么」——
    // 因为他压根没在页签里见过它。
    //
    // 现在只补这一行（单行、占位很小），不把整个 Dashboard 塞回来：
    // `nextStep === ''` 时**整行不显示**（取不到就不猜）。
    snapshot.nextStep !== ''
      ? h('div', { style: styles.nextStep, title: '交接文档 §3「下一刀」的第一条' },
        h('span', { style: styles.nextStepLabel }, '下一步'),
        h('span', null, snapshot.nextStep))
      : null,
    // ⚠️ **只渲染一个主内容区**。曾经把 `MainPage` 与 `Dashboard` 并列渲染，
    // 两者都带 `height: 100%`，在窄栏里会互相挤压 —— 那属于"看起来像布局 bug"的重复渲染。
    // 现在：`MainPage` 负责图谱/交付/归档三个 tab；门禁进度由底部 `ReadOrderBar` 承担。
    h('div', { style: styles.bodyFill }, h(MainPage, {
      snapshot,
      onOpenDoc,
      // ---- M2.6：交付区点文件 → 开预览 ----
      // 页签是 session scope，**能**开预览（主栏不行，见 `onOpenFile` 的注释）。
      //
      // ⚠️ 这里**故意不写**那个禁用预览的 prop（名字见 `main-page.tsx`）。
      // 本项目有一条既有判据：「页签里不许出现它」——
      // 连注释里出现都会被那条正则匹配到（**这是第三次踩同一个坑**：
      // M2.5 的"不许让人确认工作目录"、M2.6 的"不许自己写 AGENTS.md"、以及这里）。
      onOpenFile,
      // ---- M2.5 · W7：归档/还原接线（与主栏同一个缺陷，两处都要修）----
      onArchive: (ids: readonly string[]) => { void controller.archive?.(ids) },
      onRestore: (paths: readonly string[]) => { void controller.restore?.(paths) },
      archiving: controller.isBusy?.() === true,
    })),
    // ⚠️ 必须传 `sessionId`：阅读顺序的勾**按会话隔离**，
    // 否则上一个会话的勾会渗到这个会话（用户 2026-11-14 抓到的缺陷）。
    h(ReadOrderBar, { snapshot, onOpenDoc, sessionId }),
  )
}

const styles = {
  page: { height: '100%', display: 'flex', flexDirection: 'column' as const, minHeight: 0 },
  meta: {
    flexShrink: 0,
    padding: '6px 12px',
    fontSize: '11px',
    opacity: 0.65,
    borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  metaDim: { opacity: 0.6 },
  /** `下一步` 那一行（M2.3 演练复盘 §5）：交接 §3 的第一条。 */
  nextStep: {
    flexShrink: 0,
    padding: '6px 12px',
    fontSize: '12px',
    lineHeight: 1.5,
    borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))',
    background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.06))',
  },
  nextStepLabel: {
    fontSize: '10px',
    letterSpacing: '0.04em',
    textTransform: 'uppercase' as const,
    opacity: 0.55,
    marginRight: '6px',
  },
  bodyFill: { flex: '1 1 auto', minHeight: 0, overflow: 'auto' as const },
  note: {
    padding: '14px 16px',
    fontSize: '12px',
    lineHeight: 1.7,
    opacity: 0.8,
  },
  noteTitle: { fontSize: '13px', fontWeight: 600 as const, marginBottom: '6px', opacity: 1 },
  /** 错误边界里显示原始错误文本（等宽，方便用户照抄给我）。 */
  mono: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '11px',
    opacity: 0.85,
    wordBreak: 'break-word' as const,
  },
}

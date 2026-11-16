/**
 * 「窗口重新可见时刷新」的小工具（M2.3 演练复盘 D3）。
 *
 * ---- 为什么单独一个文件 ----
 *
 * 它被**两个**地方用：主栏/右栏的 `BodyWith`（在 `index.tsx`）和
 * 会话右栏页签（在 `session-tab.tsx`）。
 *
 * 而 `session-tab.tsx` **不能 import `index.tsx`** —— 那是循环依赖
 * （`index.tsx` 要 import `SessionTab`，两边互引在单文件打包下"碰巧能跑"，
 * 一旦打包顺序变了就是 `undefined is not a function`，且极难查）。
 * 这个教训在 `M2.3-事故记录-右栏被炸空.md` 里记着。
 *
 * 所以：**共享逻辑放中性文件**，两边都 import 它。
 *
 * ---- 它解决什么（2026-11-14 用户实测）----
 *
 * 用户原话：「右侧看板不会随时更新，必须点到别的窗口再切回来才会更新。」
 *
 * 核实后确认：`uiRefreshMs` 默认 **0 = 不轮询**（`config.js`），
 * 而 controller 只在「创建 / 点⟳ / 选项目根 / 点初始化」时取数，
 * **没有任何"窗口重新可见"的订阅**。
 *
 * "切走再切回来会更新"是因为 **React 子树被重建**（重新挂载 = 重新取数），
 * 不是因为有什么可见性监听 —— 它**碰巧**能用，而不是**设计成**能用。
 *
 * ---- 为什么不改成轮询 ----
 *
 * `createController` 的注释已写明不做轮询的理由（"这个面板大部分时间没人看"），
 * 那个理由**成立**。而"窗口重新可见"是**一次**事件、不是周期开销，
 * 正好覆盖用户的实际场景（切回来看看变了没）。
 *
 * ⚠️ **仍然不是实时**：用户一直盯着面板不动时，AI 读了文档它也不会跳。
 * 那是架构限制（HTTP 拉取 vs 推送）。所以 UI 文案不该暗示"实时"。
 */

/** 只要求有 `refresh`，不绑死整个 Controller 类型（便于单测）。 */
export interface Refreshable {
  refresh: () => void
}

/** `document` 的结构性子集（不依赖 DOM 类型包，单测可喂假对象）。 */
export interface DocumentLike {
  visibilityState?: string
  addEventListener?: (type: string, listener: () => void) => void
  removeEventListener?: (type: string, listener: () => void) => void
}

/**
 * 订阅「窗口重新可见」时刷新一次。
 *
 * @param controller 要刷新的 controller（只需 `refresh`）
 * @param documentObj 注入的 document（不传就用全局；单测可传假对象）
 * @returns 退订函数（**绝不抛**）
 */
export function watchVisibility(
  controller: Refreshable,
  documentObj: DocumentLike | undefined = (globalThis as { document?: DocumentLike })?.document,
): () => void {
  try {
    if (documentObj === undefined || documentObj === null) return () => {}
    if (typeof documentObj.addEventListener !== 'function') return () => {}

    const onVisibilityChange = (): void => {
      // 只有真的"可见"时才刷新：隐藏事件不做事（省掉一半无谓请求）。
      if (documentObj.visibilityState !== 'visible') return
      try {
        controller.refresh()
      } catch {
        // 刷新失败不该影响界面 —— 这是一次后台补充，不是用户主动操作。
      }
    }

    documentObj.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      try {
        documentObj.removeEventListener?.('visibilitychange', onVisibilityChange)
      } catch { /* 退订失败不影响其它 */ }
    }
  } catch {
    return () => {}
  }
}

/**
 * 面板可见时的**低频轮询**（M2.3 演练复盘 D3 第二轮）。
 *
 * ---- 它解决什么（2026-11-14 用户实测）----
 *
 * 用户原话：「右侧栏的阅读顺序的勾没有实时刷新，但就在截完图之后它很快就变成 2/3 了。」
 *
 * "截完图就变了"是因为截图让窗口失焦再回来 → 触发了 `watchVisibility` 的刷新。
 * 也就是说：**`visibilitychange` 只能覆盖"切走再切回"，覆盖不了"一直盯着看"**。
 *
 * 而 `gate.read` 变化的主要原因是 **AI 在另一个进程里读了文档** ——
 * 纯 HTTP 拉取架构下，客户端**根本无从知道**。所以要么推送，要么轮询。
 *
 * ---- 为什么不推翻"不轮询"的原设计 ----
 *
 * `createController` 的注释说「轮询会让 host 每秒被叫一次，而这个面板大部分时间没人看」。
 * 那个理由**成立**，所以这里做了三件事来守住它：
 *
 *   1. **间隔长**（默认 5 秒，不是每秒）；
 *   2. **只在页面可见时轮询**（`document.hidden` 时跳过 —— 后台标签页零请求）；
 *   3. **单次请求很轻**（一个 GET，返回几百字节）。
 *
 * 代价换算：看板显示时 5 秒一次 ≈ 每分钟 12 次；不看时 **0 次**。
 * 比"每秒一次、永不停"低两个数量级。
 *
 * ⚠️ 它**仍然不是实时**（最坏延迟 = 一个间隔）。所以 UI 上不该暗示"实时"。
 *
 * @param controller 要刷新的 controller
 * @param intervalMs 轮询间隔（毫秒）；传 0 表示关闭
 * @param documentObj 注入的 document（便于单测）
 * @param setIntervalFn / clearIntervalFn 注入的定时器（便于单测，不必真等 5 秒）
 * @returns 停止函数（**绝不抛**）
 */
export function watchPolling(
  controller: Refreshable,
  intervalMs: number,
  documentObj: DocumentLike | undefined = (globalThis as { document?: DocumentLike })?.document,
  setIntervalFn: (fn: () => void, ms: number) => unknown = (fn, ms) => setInterval(fn, ms),
  clearIntervalFn: (handle: unknown) => void = (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
): () => void {
  try {
    if (!(typeof intervalMs === 'number' && intervalMs > 0)) return () => {}
    if (typeof setIntervalFn !== 'function') return () => {}

    const tick = (): void => {
      // 后台标签页**一次都不请求** —— 这是"轮询不该昂贵"的关键。
      if (documentObj !== undefined && documentObj !== null && documentObj.visibilityState === 'hidden') return
      try {
        controller.refresh()
      } catch {
        // 单次失败不该中断后续轮询（网络抖动是常态）。
      }
    }

    const handle = setIntervalFn(tick, intervalMs)
    return () => {
      try {
        if (typeof clearIntervalFn === 'function') clearIntervalFn(handle)
      } catch { /* 清理失败不影响其它 */ }
    }
  } catch {
    return () => {}
  }
}

/** 面板轮询的默认间隔（毫秒）。0 = 关闭。 */
export const DEFAULT_POLL_INTERVAL_MS = 5000

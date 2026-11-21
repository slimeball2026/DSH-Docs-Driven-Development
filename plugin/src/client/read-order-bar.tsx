/**
 * 「AI 阅读顺序」条（M2.3 · 需求 2）。
 *
 * ---- 它要回答的问题 ----
 *
 * 用户最初的设想里最核心的一句是「**AI 现在读到第几篇**」。
 * 索引块把这件事写进了模型上下文，但**人看不见**。
 * 这条就是把同一份数据搬到屏幕上：`GET /api/ddd/index` 的 `required`。
 *
 * ---- 三条纪律 ----
 *
 * 1. **顺序不许自己排**：`required` 已经是 host 按 `order` 排好的真源
 *    （见 `read-order.ts` 文件头）。client 再排一次就会造出第二套顺序。
 * 2. **点击不改变已读**（R-5）：条上的**已读标记**记的是 **AI 的读取**。
 *    用户点 chip 只开预览，**不会**让它变"已读" —— 这句话必须写在条上，
 *    否则会被反复当成 bug 报（看板已经栽过一次）。
 *
 * ---- ⚠️ 2026-11-14 用户指出的歧义：**一个 chip 上有两个圆** ----
 *
 * 用户原话：「绿点指的应该是高置信度，右侧空着的白点才应该是 ai 读过的标识。」
 *
 * 完全正确。旧版每个 chip 是 `1 🟢 read-order ○`：
 *   - **`🟢` = 置信度**（`statusMarkOf(status)`，`authoritative` 就是绿）；
 *   - **后面的圆点 = AI 读没读**。
 *
 * 而旧文案写的是「绿点 = AI 读过」—— 那句话把**置信度**说成了**已读**。
 * 更糟的是：已读时我画的是**实心绿点**，于是已读的 chip 会变成 `🟢 … 🟢`
 * 两个绿圆，用户根本分不清哪个是哪个。
 *
 * 修法（三件事一起做，只改文案不够）：
 *   1. 已读**不再用绿色**，改用「✓」这个**形状**；
 *   2. 未读用**空心圆**（没有颜色，只有轮廓）；
 *   3. 文案改成「🟢 置信度 ｜ ✓ = AI 读过」——**明确把两者分开说**。
 * 3. **绝不假装**：没数据时整条不渲染（由 `BodyWith` 保证只在有快照时挂载）；
 *    收起状态存在 `localStorage`，存不进去就退化成"本次有效"。
 *
 * ---- 为什么 chip 默认不可点 ----
 *
 * 与 `main-page.tsx` 的图谱同一个理由：本面板是 `root` scope，**没有会话**，
 * 右栏不存在 → `openResource` 必抛（`sidebar-right` 的 `require()`）。
 * 所以这里也走 `previewDisabled`：没有 pointer 手势，`title` 里说清为什么。
 */

import * as React from 'react'

import type { Snapshot } from './api.ts'
import {
  canPersistMemory,
  defaultStorage,
  memoryIdsOf,
  readCollapsedOf,
  readMemoryOf,
  readOrderOf,
  readOrderProgressOf,
  rememberReadOf,
  statusMarkOf,
  writeCollapsedTo,
  writeMemoryTo,
  type ReadMemory,
  type ReadOrderItem,
} from './read-order.ts'

const h = React.createElement

/**
 * 阅读顺序条。
 *
 * @param props.snapshot 已取到的快照（`required` 就是顺序的真源）
 * @param props.onOpenDoc 点 chip 时开预览（本面板里通常禁用，见文件头）
 * @param props.previewDisabled 预览是否**根本不可能**（root 面板 = true）
 *
 * ⚠️ `onOpenDoc` 收到的是 `ReadOrderItem`，**不是** `SnapshotDoc`。
 * 不要为了让签名对上去伪造一个 `SnapshotDoc`（填 `title: ''` 之类）——
 * 那会把"我手上没有这个字段"伪装成"这个字段是空的"，正是本项目最忌讳的事。
 * 调用方若需要完整字段，应当拿 `id` 回快照里查。
 */
export function ReadOrderBar({
  snapshot,
  onOpenDoc,
  previewDisabled = false,
  sessionId = '',
}: {
  snapshot: Snapshot
  onOpenDoc?: (item: ReadOrderItem) => void
  previewDisabled?: boolean
  /**
   * 当前会话 id（M2.3 演练 D4 第三次澄清）。
   *
   * ---- 为什么必须传 ----
   *
   * 用户抓到：「阅读顺序的勾应该在换一个会话时被清空，因为 ai 还没读过它们。」
   *
   * 第一版记忆存在**全局**键里，于是会话 A（工作者）的勾渗到了会话 B（接手者）。
   * 现在记忆按 `sessionId` 隔离 —— **不同会话互不可见**。
   *
   * 空串 = root 面板（宿主不给它会话绑定），用独立命名空间，不与任何会话共享。
   */
  sessionId?: string
}): React.ReactElement | null {
  const storage = React.useMemo(() => defaultStorage(), [])

  // ---- 本地记忆：接手时画过的勾不因工作而撤销，但**按会话隔离** ----
  //
  // 用户两次澄清（2026-11-14）：
  //   ①「按阅读顺序阅读并画勾是一开始被交接时应该做完的，不该因为工作被取消掉」
  //     → 勾只增不减（同一会话内）；
  //   ②「勾应该在换一个会话时被清空，因为 ai 还没读过它们」
  //     → 记忆按 sessionId 分开（跨会话互不可见）。
  //
  // 这两条**不矛盾**：同一个会话里"读过就永久算读过"；换会话就是新的人接手，
  // 他确实还没读过。
  //
  // ⚠️ 2026-11-14 M2.5：记忆从 `string[]` 改成 `ReadMemory`（**自带归属**）。
  // 只把 sessionId 用来"算键"是不够的 —— 切会话那一帧里 state 还是旧会话的 id 列表，
  // 写盘守卫会被骗过，把 A 的勾写进 B 的键。详见 `read-order.ts` 的 `ReadMemory` 注释。
  const [memory, setMemory] = React.useState<ReadMemory>(() => ({
    sessionId,
    ids: readMemoryOf(storage, sessionId),
  }))

  // ⚠️ sessionId 变了（切会话）→ 必须**重新读**那个会话的记忆。
  // 不然切到新会话时，state 里还留着上一个会话的 id（同一组件实例被复用）。
  React.useEffect(() => {
    setMemory((current) => (current.sessionId === sessionId
      ? current
      : { sessionId, ids: readMemoryOf(storage, sessionId) }))
  }, [storage, sessionId])

  /**
   * 本次渲染可用的记忆。
   *
   * **渲染期只读**：手上的记忆属于别的会话时，现读当前会话的那份，
   * 绝不把上一个会话的勾当成这个会话的。
   */
  const remembered = React.useMemo(
    () => memoryIdsOf(storage, memory, sessionId),
    [storage, memory, sessionId],
  )

  const items = React.useMemo(
    () => readOrderOf(snapshot.required, remembered),
    [snapshot.required, remembered],
  )
  const progress = React.useMemo(() => readOrderProgressOf(items), [items])

  // 把这次看到的新勾写回**本会话**的记忆（只增不减）。
  React.useEffect(() => {
    // ⚠️ 只有"这份记忆确实属于当前会话"时才允许写盘。
    // 这条守卫是修上面那个竞态的关键：切会话的那一帧里 memory 还是旧会话的，
    // 此时算出的集合必然"比旧的更全"，光靠 `next.size === old.length` 拦不住。
    if (!canPersistMemory(memory, sessionId)) return
    const next = rememberReadOf(items, memory.ids)
    // 只在**真的变多**时才 setState + 写盘，否则每次渲染都会触发一轮更新。
    if (next.size === memory.ids.length) return
    const list = [...next]
    setMemory({ sessionId, ids: list })
    writeMemoryTo(storage, sessionId, list)
  }, [items, memory, storage, sessionId])

  // ⚠️ 收起状态**必须自己订阅**（用 state，不用外部 controller）：
  // 这是纯 UI 偏好，与数据无关，放进 controller 只会让它变脏。
  const [collapsed, setCollapsed] = React.useState<boolean>(() => readCollapsedOf(storage))

  const toggle = () => {
    setCollapsed((current) => {
      const next = !current
      writeCollapsedTo(storage, next)
      return next
    })
  }

  // 没有必读文档时**整条不出现**：显示一条空的"阅读顺序"等于告诉用户
  // "这里有东西但你看不见"，比不显示更糟。
  if (items.length === 0) return null

  if (collapsed) {
    // 收起后缩成右下角圆形按钮（`position: fixed`，不占布局）。
    return h('button', {
      type: 'button',
      onClick: toggle,
      style: styles.fab,
      title: `展开参考目录（${progress.read}/${progress.total} 已读）`,
      'aria-label': '展开参考目录',
    }, `${progress.read}/${progress.total}`)
  }

  return h('div', { style: styles.bar },
    h('div', { style: styles.head },
      h('span', { style: styles.title }, '参考目录'),
      h('span', { style: styles.progress },
        `${progress.read}/${progress.total}`,
        progress.ready ? ' ✅ 已读完' : ' · 按任务阅读'),
      h('span', { style: styles.hint, title: LEGEND_SUB }, LEGEND_MAIN),
      // ---- 方案 C（用户 2026-11-14 拍板）：明说"重启会清空"，不落盘 ----
      //
      // 背景：`readSet` 是 host 侧 `WeakMap`（以 session 对象为键）的**内存态**，
      // 宿主重启后会话对象是新的 → 已读全部归零。
      // 用户实测撞过一次（发问"会话 1 的勾怎么没了"）。
      //
      // 为什么不落盘（用户否掉了 B 方案）：
      //   落盘会引入**第二份真源**，可能与索引/门禁漂移 ——
      //   而本项目的铁律是"宁可留空也不造假"。
      //
      // 所以只在这里**明说**。文案必须短（条已经很窄），细节放 title。
      h('span', {
        style: styles.restartHint,
        title: '已读记录保存在会话内存里。宿主重启后会话是新的，已读会从零开始 —— '
          + '这不是 bug，是"这个会话读过什么"的语义。',
      }, '重启会清空'),
      h('button', {
        type: 'button',
        onClick: toggle,
        style: styles.collapseButton,
        title: '收起到右下角',
      }, '收起'),
    ),
    h('div', { style: styles.track },
      items.map((item) => {
        const clickable = !previewDisabled && onOpenDoc !== undefined
        return h('div', {
          key: `${item.seq}:${item.id}`,
          style: clickable ? styles.chip : styles.chipStatic,
          ...(clickable ? { onClick: () => onOpenDoc(item) } : {}),
          title: clickable
            ? `${item.summary === '' ? item.id : item.summary}`
            : `${item.summary === '' ? item.id : item.summary}（预览需在会话页打开）`,
        },
          h('span', { style: styles.seq }, String(item.seq)),
          // 置信度徽标（🟢/🟡/⚪/🔵/🔴/🟠）——**这是 status，不是已读**。
          // 与后面的已读标记**视觉上必须能分开**：它是 emoji，已读标记是几何形状。
          h('span', { title: `文档状态：${item.status}` }, statusMarkOf(item.status)),
          h('span', { style: styles.chipId }, item.id === '' ? '(无 id)' : item.id),
          // 已读标记：**不用颜色**，用形状区分。
          //
          // ⚠️ 2026-11-14 用户指出的歧义：旧版已读是**实心绿点**，
          // 于是已读的 chip 变成 `🟢 … 🟢` 两个绿圆，和前面的置信度绿圆混在一起。
          // 现在：已读 = 「✓」（对勾，语义直白），未读 = 空心圆（只有轮廓）。
          // 两者都不占用"绿色"这个通道 —— 绿色从此专属于置信度。
          h('span', {
            style: item.read ? styles.readMark : styles.unreadMark,
            title: item.read ? 'AI 曾读过（阅读记录，不代表当前版本或写权限）' : 'AI 还没读',
            'aria-label': item.read ? '已读' : '未读',
          }, item.read ? '✓' : ''),
        )
      }),
    ),
  )
}

/**
 * 图例文案。
 *
 * ---- 2026-11-14 演练复盘 D4：两轮澄清后的最终措辞 ----
 *
 * 第一轮用户说：「阅读顺序应该是个适用于被交接者初次接手项目的显示指标，
 * 它不应该在工作中发生变动。」
 *
 * 我当时只改了文案，但**没改行为** —— 所以第二轮他又说：
 * 「ai 在编辑文档后，文档的勾会失效，但按阅读顺序阅读并画勾
 * 是**一开始被交接时**应该做完的，它大概不应该因为工作就被取消掉。」
 *
 * 这才是真需求。现在的实现（`read-order.ts` 的本地记忆）：
 * **勾只增不减**，改文档不会撤销它。门禁（能不能改）另有一套，两者独立。
 *
 * 措辞要说清三件事：
 *   1. 这是**接手清单**（语义定位）；
 *   2. `✓` 是**接手时读完**的记录，**不会因为改文档而消失**；
 *   3. 你点开**不算** AI 已读（R-5，防止当 bug 报）。
 */
const LEGEND_MAIN = '参考目录 ｜ 🟢 状态 ｜ ✓ = AI 读过'
const LEGEND_SUB = '按任务选择阅读，不要求先读完整个目录。✓ 只增不减；点开不算 AI 已读。'

/**
 * 那几行的样式。
 *
 * ⚠️ **必须用 `--dsw-alias-*` token**（`client-theme-tokens.test.js` 钉着）：
 * 硬编码色在浅色主题下会看不清，而这类 bug 不会自己暴露。
 */
const styles = {
  bar: {
    flexShrink: 0,
    borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))',
    background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.06))',
    padding: '6px 20px 8px',
    font: '12px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
    color: 'var(--dsw-alias-label-primary, #e6e6e6)',
  },
  head: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '8px',
    marginBottom: '5px',
    // 窄窗口下这些元素要能一起收缩，而不是溢出把行顶高。
    minWidth: '0',
  },
  // ---- 2026-11-16 M2.9：整行的三个固定元素都不许被压成多行 ----
  //
  // `title`（"AI 阅读顺序"）与 `progress`（"1/1 ✅ 已读完"）原来没有 `nowrap`，
  // 窄窗口下同样会逐字折行。它们比图例短，但一起折会让整条顶得很高。
  // `flexShrink: 0` 是刻意的：这两个是**必须读到的状态**，
  // 宁可挤掉图例（有省略号 + 悬停兜底），也不能把状态挤没。
  title: {
    fontSize: '11px',
    letterSpacing: '0.04em',
    opacity: 0.6,
    textTransform: 'uppercase' as const,
    flexShrink: 0,
    whiteSpace: 'nowrap' as const,
  },
  progress: {
    fontSize: '12px',
    fontWeight: 600 as const,
    flexShrink: 0,
    whiteSpace: 'nowrap' as const,
  },
  /**
   * 图例文字（`接手清单 ｜ 🟢 置信度 ｜ ✓ = AI 已读完`）。
   *
   * ---- 2026-11-16 M2.9：窄窗口下它会被排成**一列**（用户报的 UI 问题）----
   *
   * 现象：右栏很窄时，这句话变成
   * ```
   * 接
   * 手
   * 清
   * 单
   * ｜
   * ```
   *
   * 根因不是缩得太小，是**允许换行**：
   *   · `flex: 1` 的 basis 是 0，所以它会被压到很小；
   *   · 但它**没有 `whiteSpace: nowrap`** —— 中文与 `｜` 之间都能断行，
   *     于是每压窄一档就多折一行，最终一字一行。
   *   · 少了 `minWidth: 0`，flex 子项还会卡在 min-content（= 一个汉字宽）。
   *
   * ⇒ 与归档列表那次同一个处方：**不换行 + 省略号 + minWidth: 0**。
   *   窄到放不下就显示「接手清单 ｜ …」，完整文字在 `title` 悬停里。
   *   这比"一字一列"好得多 —— 后者会把整条顶高，把正文挤下去。
   */
  hint: {
    fontSize: '11px',
    opacity: 0.45,
    flex: '1 1 0%',
    minWidth: '0',
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  /**
   * 「重启会清空」提示（方案 C）。
   *
   * 用 `title` 承载完整解释，这里只放 4 个字的标签 ——
   * 条本身已经很窄（右栏尤其），长句子会把正文挤掉。
   */
  restartHint: {
    fontSize: '10px',
    opacity: 0.4,
    flexShrink: 0,
    marginRight: '8px',
    whiteSpace: 'nowrap' as const,
    cursor: 'help',
  },
  collapseButton: {
    font: 'inherit',
    fontSize: '11px',
    padding: '2px 8px',
    color: 'var(--dsw-alias-label-secondary, #9a9a9a)',
    background: 'transparent',
    border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))',
    borderRadius: '4px',
    cursor: 'pointer',
    flexShrink: 0,
  },
  track: {
    display: 'flex',
    gap: '6px',
    overflowX: 'auto' as const,
    paddingBottom: '2px',
  },
  chip: {
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    padding: '3px 9px',
    borderRadius: '999px',
    border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35))',
    background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.1))',
    cursor: 'pointer',
    flexShrink: 0,
    whiteSpace: 'nowrap' as const,
  },
  /**
   * 不可点的 chip。
   *
   * 与 `chip` 的唯一区别是 **`cursor: 'default'`** 与略降的不透明度 ——
   * 没有可点击手势，用户就不会去点一个注定没反应的东西（需求 1 的教训）。
   */
  chipStatic: {
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    padding: '3px 9px',
    borderRadius: '999px',
    border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35))',
    background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.1))',
    cursor: 'default',
    flexShrink: 0,
    whiteSpace: 'nowrap' as const,
    opacity: 0.85,
  },
  seq: {
    fontSize: '10px',
    opacity: 0.55,
    fontVariantNumeric: 'tabular-nums',
    minWidth: '10px',
  },
  chipId: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '11px',
  },
  /**
   * 已读标记（**形状，不是颜色**）。
   *
   * 为什么不用绿色：chip 上已经有一个绿圆表示**置信度**（`statusMarkOf`）。
   * 两个绿圆放一起，用户没法分辨哪个是哪个 —— 2026-11-14 用户就是这么被误导的。
   *
   * 所以：绿色**专属于置信度**；已读用「✓」这个语义直白的形状，
   * 未读用空心圆。三者互不占用同一个视觉通道。
   */
  readMark: {
    width: '13px',
    height: '13px',
    lineHeight: '13px',
    borderRadius: '50%',
    textAlign: 'center' as const,
    fontSize: '10px',
    fontWeight: 700 as const,
    // 用主文字色而不是 success 色：避免与置信度的绿撞车。
    color: 'var(--dsw-alias-label-primary, #e6e6e6)',
    background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.18))',
    flexShrink: 0,
  },
  /** 未读：**空心圆**（只有轮廓，没有填充，也不带颜色）。 */
  unreadMark: {
    width: '13px',
    height: '13px',
    lineHeight: '13px',
    borderRadius: '50%',
    border: '1px solid var(--dsw-alias-label-secondary, #9a9a9a)',
    background: 'transparent',
    flexShrink: 0,
    boxSizing: 'border-box' as const,
  },
  fab: {
    position: 'fixed' as const,
    right: '16px',
    bottom: '16px',
    zIndex: 10,
    font: 'inherit',
    fontSize: '11px',
    padding: '6px 12px',
    borderRadius: '999px',
    border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.5))',
    background: 'var(--dsw-alias-bg-overlay, #1e1e1e)',
    color: 'var(--dsw-alias-label-primary, #e6e6e6)',
    cursor: 'pointer',
    boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
  },
}

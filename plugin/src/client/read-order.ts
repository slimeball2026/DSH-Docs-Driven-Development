/**
 * 「AI 阅读顺序」条的**纯逻辑层**（零 JSX、零 React、零 DOM）。
 *
 * ---- 为什么要单独一个 `.ts` ----
 *
 * Node 的类型剥离**不处理 JSX**（`ERR_UNKNOWN_FILE_EXTENSION`），
 * 所以凡是想要被单测 import 的逻辑都不能留在 `.tsx` 里。
 * 这与 `entry-logic.ts` 是同一条纪律（M2.2 的教训）。
 *
 * ---- 数据从哪来（**真源，不要自己再排一遍**）----
 *
 * `GET /api/ddd/index` 的 `required` 数组**就是** AI 的阅读顺序：
 * host 侧 `core/index.js` 的 `buildIndex()` 已经按 `order` 升序、同 order 按 id
 * 字典序排好（`byOrderThenId`），并且**只有可执行 status**（`authoritative` /
 * `partial`）才会进这个数组。
 *
 * ⚠️ 所以这里**刻意不排序**：client 再排一次就会造出**第二套顺序**，
 * 而两套顺序一旦不一致，条上显示的"第 3 篇"和索引块里的"第 3 篇"就不是同一篇 ——
 * 那正是本项目最怕的症状（把错误的信任可视化）。
 *
 * 同理，`read` 字段是**会话级 readSet** 的读数（AI 自己读没读），
 * 不是"用户点开过没有"。UI 的点击**不会**让它变绿（R-5）。
 */

import type { SnapshotDoc } from './api.ts'

/** 条上的一个 chip（顺序 = host 给的顺序，下标 +1 就是序号）。 */
export interface ReadOrderItem {
  /** 序号，从 1 开始（给用户看的"第几篇"）。 */
  seq: number
  id: string
  role: string
  status: string
  /** AI 是否已读（来自会话级 readSet；**用户点开不算**）。 */
  read: boolean
  hasError: boolean
  summary: string
}

/** 进度汇总（与看板 `gate` 同源，但**独立算一遍**以免依赖 snapshot 形状）。 */
export interface ReadOrderProgress {
  total: number
  read: number
  ready: boolean
}

/**
 * 把快照的 `required` 变成条上的 chip 列表。
 *
 * **保持给定顺序**（见文件头：顺序的真源在 host）。坏输入一律返回空数组，不抛。
 *
 * @param required `GET /api/ddd/index` 的 `required`
 * @returns chip 列表；没有必读文档时是空数组
 */
/**
 * 把快照的 `required` 变成条上的 chip 列表。
 *
 * **保持给定顺序**（见文件头：顺序的真源在 host）。坏输入一律返回空数组，不抛。
 *
 * ---- 2026-11-14 演练复盘 D4（**用户第二次澄清**）：`✓` 不该被工作撤销 ----
 *
 * 用户的原话：
 *
 * > 「ai 在编辑文档后，文档的勾会失效，但按照阅读顺序阅读文档并画勾
 * > 是**一开始被交接时**应该做完的，它大概不应该因为工作就被取消掉。
 * > ai 自己工作时新加的文档大概也应该默认画勾。」
 *
 * 这条澄清把语义定死了：**条上的 `✓` = "接手时该读的，读过了"**，
 * 是一个**完成的收尾状态**，不是"此刻能不能改"的实时读数。
 *
 * 两件事因此分开：
 *
 * | 通道 | 语义 | 变不变 |
 * |---|---|---|
 * | **门禁（`gate.read`）** | 此刻能不能改这份文档 | **必须实时**（改了就要重读，不变量） |
 * | **本条的 `✓`** | 接手时的阅读是否已完成 | **只增不减**（记住"曾经读过"） |
 *
 * 实现：客户端用一份**本地记忆**（`localStorage`）记住"这个会话里勾过的 id"，
 * 一旦勾上就不再撤销。它是**纯展示状态**，**绝不回传 host、绝不影响门禁**。
 *
 * @param required `GET /api/ddd/index` 的 `required`
 * @param remembered 之前勾过的 id 集合（可选）；给了就把它们也算作已读
 * @returns chip 列表；没有必读文档时是空数组
 */
export function readOrderOf(
  required: readonly SnapshotDoc[] | undefined | null,
  remembered?: ReadonlySet<string> | readonly string[],
): ReadOrderItem[] {
  if (!Array.isArray(required)) return []
  const everRead = remembered === undefined
    ? undefined
    : new Set<string>(Array.isArray(remembered) ? remembered : [...(remembered as ReadonlySet<string>)])
  const items: ReadOrderItem[] = []
  for (const doc of required) {
    if (doc === null || typeof doc !== 'object') continue
    const id = typeof doc.id === 'string' ? doc.id : ''
    // id 为空串时**不跳过**：它仍然占一个位置（跳过会让序号与索引块错位），
    // 但 UI 会把它显示成 `(无 id)` —— 那是坏文档的信号，不该被悄悄吞掉。
    items.push({
      seq: items.length + 1,
      id,
      role: typeof doc.role === 'string' ? doc.role : '',
      status: typeof doc.status === 'string' ? doc.status : '',
      // ⚠️ 两个来源**取并集**：
      //   - `doc.read`：**当前**门禁读数（改过文档就会退回 false）；
      //   - `everRead`：**曾经**读过（本地记忆，只增不减）。
      // 任一为真就画勾 —— 因为条的语义是"接手时的阅读完成了吗"。
      read: doc.read === true || (id !== '' && everRead?.has(id) === true),
      hasError: doc.hasError === true,
      summary: typeof doc.summary === 'string' ? doc.summary : '',
    })
  }
  return items
}

/**
 * 收集"现在该记进本地记忆"的 id（**只增不减**）。
 *
 * 规则：
 *   - 当前 `required` 里 `read === true` 的 → 记住（AI 真的读过）；
 *   - **已经记住的保持**（哪怕它现在 `read === false`）；
 *   - 已经不在 `required` 里的（比如被 supersede 了）**保留** ——
 *     历史不该因为文档状态变了就消失；渲染时自然会因为不在清单里而不显示。
 *
 * ⚠️ 为什么不"用当前 required 覆盖"：那等于每次刷新都重新学一遍，
 * 改一份文档就会丢一个勾 —— 正是用户报告的那个现象。
 *
 * @param items 本次渲染用的 chip 列表
 * @param previous 之前的记忆
 * @returns 新的记忆集合（可直接序列化）
 */
export function rememberReadOf(
  items: readonly ReadOrderItem[],
  previous: ReadonlySet<string> | readonly string[] = [],
): Set<string> {
  const next = new Set<string>(Array.isArray(previous) ? previous : [...(previous as ReadonlySet<string>)])
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue
    if (item.id === '') continue
    if (item.read === true) next.add(item.id)
  }
  return next
}

/**
 * 汇总进度。
 *
 * @param items `readOrderOf` 的产物
 */
export function readOrderProgressOf(items: readonly ReadOrderItem[]): ReadOrderProgress {
  const total = Array.isArray(items) ? items.length : 0
  const read = Array.isArray(items) ? items.filter((item) => item.read === true).length : 0
  // 与 host 的 `gate.ready` 同一条判据：**有必读项且全读完**才算 ready。
  // 0 篇必读不是"读完了"，而是"这里没有必读文档"。
  return { total, read, ready: total > 0 && read >= total }
}

/** 收起状态的存储键。改它等于让所有用户的偏好归零，别轻易改。 */
export const READ_ORDER_STORAGE_KEY = 'ddd.readOrder.collapsed'

/**
 * 「曾经勾过」的本地记忆存储键**前缀**（M2.3 演练 D4 第二次澄清）。
 *
 * ---- ⚠️ 2026-11-14 用户抓到的真缺陷：记忆必须**按会话隔离** ----
 *
 * 用户原话：
 *
 * > 「阅读顺序的勾应该在换一个会话（也就是下一个交接会话）时被清空，
 * > 因为 ai 还没读过它们。」
 *
 * 完全正确。第一版我把所有会话的记忆写进**同一个**键
 * `ddd.readOrder.everRead`，于是：
 *
 *   会话 A（工作者）读了 3 份 → 存了 3 个 id
 *   会话 B（接手者）打开面板 → **读到 A 的记忆** → 3 个勾全是假的
 *
 * 实测症状（用户截图）：API 返回 `gate=0/3`（全未读），
 * 但条上 3 个 chip **全打了勾** —— 那就是 A 的记忆渗到 B 了。
 *
 * 所以键必须带**会话标识**：`ddd.readOrder.everRead.<scope>`。
 *
 * ---- 但 `sessionId` 在 root 面板里是空串 ----
 *
 * 主栏整页是 `root` scope，宿主**不给它会话绑定**（这正是 M2.2/M2.3 反复撞的那件事）。
 * 拿不到 sessionId 时用 `__root__` 这个**独立命名空间**：
 * 它自己的勾不跨会话、也不污染任何会话 —— 与"拿不到就留空"同一条纪律。
 *
 * ⚠️ 改这个前缀 = 所有用户已画过的勾全部作废。别轻易改。
 * ⚠️ 这是**纯展示记忆**，不进索引块、不回传 host、不影响门禁。
 */
export const READ_ORDER_MEMORY_PREFIX = 'ddd.readOrder.everRead'

/** `sessionId` 为空（root 面板）时用的命名空间。 */
export const READ_ORDER_ROOT_SCOPE = '__root__'

/**
 * 把存储键拼成「按会话隔离」的形式。
 *
 * @param sessionId 当前会话 id（空串 = root 面板）
 * @returns 完整的 localStorage 键
 */
export function memoryKeyOf(sessionId: string): string {
  const scope = typeof sessionId === 'string' && sessionId !== ''
    ? sessionId
    : READ_ORDER_ROOT_SCOPE
  return `${READ_ORDER_MEMORY_PREFIX}.${scope}`
}

/**
 * 读"曾经勾过"的 id 列表（**只读某一个会话的**）。
 *
 * 存储格式刻意用**逗号分隔的字符串**而不是 JSON：
 * 它极小（几个 id），解析失败也只退化成空集，不会让整个面板炸。
 *
 * @param storage `defaultStorage()` 的产物
 * @param sessionId 当前会话 id（空串 = root 面板，用独立命名空间）
 * @returns id 列表；读不到 / 损坏时返回空数组
 */
export function readMemoryOf(storage: StorageLike | undefined, sessionId = ''): string[] {
  if (storage === undefined) return []
  try {
    const raw = storage.getItem(memoryKeyOf(sessionId))
    if (typeof raw !== 'string' || raw === '') return []
    return raw.split(',').map((item) => item.trim()).filter((item) => item !== '')
  } catch {
    return []
  }
}

/**
 * 写"曾经勾过"的 id 列表（**只写某一个会话的**）。
 *
 * **绝不抛**：存不进去只是下次不记得，不该影响这次显示。
 *
 * @param storage `defaultStorage()` 的产物
 * @param sessionId 当前会话 id（空串 = root 面板）
 * @param ids id 列表
 */
export function writeMemoryTo(
  storage: StorageLike | undefined,
  sessionId: string,
  ids: readonly string[],
): void {
  if (storage === undefined) return
  try {
    storage.setItem(memoryKeyOf(sessionId), Array.from(ids).join(','))
  } catch { /* 隐私模式 / 配额满：静默放弃 */ }
}

/** `localStorage` 的结构性类型（不依赖 DOM 的类型包，单测可以喂假对象）。 */
export interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

/**
 * 「曾经勾过」的记忆，**连同它属于哪个会话**。
 *
 * ---- 为什么必须把 sessionId 一起存（M2.5 修的一个真缺陷）----
 *
 * 第一版（M2.3）的记忆只是一个 `string[]`，`sessionId` 只用来**算键**。
 * 于是切会话时出现了一个窗口：
 *
 *   1. 会话 A 的记忆 = `['handover-002', 'spec-report']`（存在 A 的键里）；
 *   2. 用户切到会话 B，**同一帧**里 5 秒轮询也回来了（新快照）；
 *   3. 这一帧渲染时 `remembered` 的 state 还是 A 的那两个 id，
 *      而 `sessionId` 已经是 B —— 于是 `items` 里 B 的文档按 A 的记忆被算成"已读"；
 *   4. 写盘那一步算出的集合 = `A 的两个 ∪ B 真实读过的`，**比 A 的多** →
 *      通过了"只增不减才写"的守卫 → `writeMemoryTo(storage, B, ...)`。
 *
 *   结果：**A 的勾被写进了 B 的键**。下一次 B 打开面板，`handover-002` 会带着
 *   B 根本没读过的 ✓ —— 正是用户 2026-11-14 截图抓到的那条症状，从另一条路回来了。
 *
 * 所以记忆必须**自带归属**：只有"这份记忆确实属于当前会话"时，
 * 才允许把它当作已读、才允许写盘。
 */
export interface ReadMemory {
  /** 这份记忆属于哪个会话（空串 = root 面板）。 */
  sessionId: string
  /** 曾经勾过的 id。 */
  ids: string[]
}

/**
 * 取**当前会话**该用的记忆 id 列表。
 *
 * - 记忆属于当前会话 → 直接用它；
 * - 记忆属于**别的**会话（刚切过来）→ 现读一份当前会话的，**绝不沿用别人的**。
 *
 * ⚠️ 这一步是**纯读**，不写盘、不改 state —— 所以可以在渲染期调用。
 *
 * @param storage `defaultStorage()` 的产物
 * @param memory 手上的记忆（可能属于别的会话）
 * @param sessionId 当前会话 id
 * @returns 当前会话的 id 列表（读不到就是空数组）
 */
export function memoryIdsOf(
  storage: StorageLike | undefined,
  memory: ReadMemory | undefined,
  sessionId: string,
): string[] {
  const current = typeof sessionId === 'string' ? sessionId : ''
  if (memory === undefined || memory === null) return readMemoryOf(storage, current)
  if (memory.sessionId !== current) return readMemoryOf(storage, current)
  return Array.isArray(memory.ids) ? memory.ids : []
}

/**
 * 这份记忆**是否属于**当前会话 —— 只有属于才允许写盘。
 *
 * 拆成独立函数是为了让"什么时候可以写"这条不变量**能被单测与变异直接钉住**，
 * 而不是埋在组件的一个 `if` 里（组件是 `.tsx`，Node 的单测 import 不了）。
 *
 * @param memory 手上的记忆
 * @param sessionId 当前会话 id
 * @returns 可以写盘时为 true
 */
export function canPersistMemory(memory: ReadMemory | undefined, sessionId: string): boolean {
  if (memory === undefined || memory === null) return false
  return memory.sessionId === (typeof sessionId === 'string' ? sessionId : '')
}


/**
 * 取一个可用的 storage。
 *
 * `localStorage` 在三种情况下会**抛**（不是返回 null）：
 * 隐私模式、`file://` 下的某些配置、被策略禁用。
 * 所以这里整体包 try/catch，拿不到就返回 `undefined` ——
 * 调用方据此退化成"不持久化"，而不是让整个面板炸掉。
 *
 * @returns storage，或 undefined
 */
export function defaultStorage(): StorageLike | undefined {
  try {
    const storage = (globalThis as { localStorage?: StorageLike }).localStorage
    if (storage === undefined || storage === null) return undefined
    if (typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') return undefined
    return storage
  } catch {
    return undefined
  }
}

/**
 * 读"是否收起"。
 *
 * **默认展开**：一个默认藏起来的控件等于没有（用户不会去找它）。
 * 只有明确存过 `1` 才认为收起；其它一切值（包括损坏的、空串）都当展开。
 *
 * @param storage `defaultStorage()` 的产物
 * @returns 是否收起
 */
export function readCollapsedOf(storage: StorageLike | undefined): boolean {
  if (storage === undefined) return false
  try {
    return storage.getItem(READ_ORDER_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * 写"是否收起"。
 *
 * **绝不抛**：存不进去只是下次不记得，不该影响这次操作。
 *
 * @param storage `defaultStorage()` 的产物
 * @param collapsed 是否收起
 */
export function writeCollapsedTo(storage: StorageLike | undefined, collapsed: boolean): void {
  if (storage === undefined) return
  try {
    storage.setItem(READ_ORDER_STORAGE_KEY, collapsed ? '1' : '0')
  } catch { /* 存不进去就算了（隐私模式 / 配额满） */ }
}

/**
 * 状态徽标。
 *
 * 与 `dashboard.tsx` 的 `statusMark` **同一套语义**，但这里放纯逻辑层，
 * 好让"顺序 + 状态"这一对能在单测里一起断言。
 *
 * @param status frontmatter 的 status
 * @returns 一个字符的徽标
 */
export function statusMarkOf(status: string): string {
  switch (status) {
    case 'authoritative': return '🟢'
    case 'partial': return '🟡'
    case 'draft': return '⚪'
    case 'superseded': return '🔵'
    case 'sealed': return '🔴'
    case 'void': return '🟠'
    default: return '❔'
  }
}

/**
 * M2-A/B/C/D/E 的数据契约与取数层（**纯前端，零文件系统**）。
 *
 * ---- 三条硬约束 ----
 *
 * 1. **client 跑在浏览器里，没有文件系统**（SPEC §10 第 3 条）。
 *    所有文件操作都必须 POST 回 host；这里只有 `fetch`。
 * 2. **首屏必须有 loading 态，失败必须有错误态 + 重试**（SPEC §6.1）。
 *    **不许白屏** —— 白屏比报错更难查，用户会以为是插件没装。
 * 3. **`sessionId` 是请求的必需参数**（SPEC §4.2 订正 2）。
 *    缺了它 `gate.read` 会退化成"全都未读"，而且**不报错**。
 */

/** 路由路径（与 `server/routes.ts` 的 `ROUTES` 逐字一致；两边都有断言）。 */
export const ROUTES = {
  index: '/api/ddd/index',
  archive: '/api/ddd/archive',
  restore: '/api/ddd/restore',
  ping: '/api/ddd/ping',
  /** 已知项目根列表（M2.2）。**cwd 由用户显式选，不由 client 猜。** */
  projects: '/api/ddd/projects',
  /** 让 host 清掉某目录的探测缓存并重新探测（M2.2）。 */
  recheck: '/api/ddd/recheck',
  /** 一键把目录初始化成 DDD 工作区（M2.2）。 */
  init: '/api/ddd/init',
} as const

/**
 * 一个可选的"已知项目根"。
 *
 * `isDdd` 由 **host** 判定（client 没有文件系统，判断不了有没有 `docs/`）。
 */
export interface ProjectOption {
  cwd: string
  /** 探测到的 DDD 项目根（空串 = 不是 DDD 项目）。 */
  projectRoot: string
  isDdd: boolean
}

/** 快照里的一条必读/全量文档。 */
export interface SnapshotDoc {
  id: string
  role: string
  order: number | null
  status: string
  summary: string
  title: string
  fingerprint: string
  read: boolean
  verifiedAt: string | null
  hasError: boolean
}

/** `GET /api/ddd/index` 的响应（SPEC §4.2）。 */
export interface Snapshot {
  ok: boolean
  version: number
  projectRoot: string
  sessionId: string
  generatedAt: number
  gate: { read: number; required: number; ready: boolean }
  project: string
  slice: string
  nextStep: string
  basisDoc: { id: string; section: string; fingerprint: string } | null
  /** ⚠️ 字段名是 `over`，不是 `overflow`（SPEC §4.2 订正 1）。 */
  budget: { required: number; tokens: number; limit: number; over: boolean; overBy: number } | null
  required: SnapshotDoc[]
  all: SnapshotDoc[]
  forbidden: Array<{ id: string; summary: string }>
  anomalies: Array<{ id: string; message: string }>
  deliverables: Array<{ path: string; presented: boolean; size: number; mtime: number }>
  graveyardCandidates: Array<{ id: string; summary: string; status: string; reason?: string }>
  graveyard: Array<{ path: string; archivedAt: number }>
}

/** 取数结果：要么有数据，要么有可显示的错。**没有第三种**（不许白屏）。 */
export type FetchResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'error'; message: string }

/**
 * 拼查询串。
 *
 * `cwd` 与 `sessionId` 都**必须**带：前者决定看哪个项目，后者决定 `gate.read`。
 *
 * @param cwd 项目工作目录（绝对路径）
 * @param sessionId 会话 id
 */
export function indexUrl(cwd: string, sessionId: string): string {
  const params = new URLSearchParams()
  if (cwd !== '') params.set('cwd', cwd)
  if (sessionId !== '') params.set('sessionId', sessionId)
  return `${ROUTES.index}?${params.toString()}`
}

/**
 * 取快照。
 *
 * ⚠️ **超时是自己实现的**（`AbortController`）：一个卡住的请求会让看板永远停在
 * loading，而那看起来和"正在加载"一模一样。
 *
 * @param cwd
 * @param sessionId
 * @param timeoutMs 默认 8 秒
 */
export async function fetchSnapshot(
  cwd: string,
  sessionId: string,
  timeoutMs = 8000,
): Promise<FetchResult<Snapshot>> {
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined
  const timer = controller === undefined
    ? undefined
    : setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(indexUrl(cwd, sessionId), {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller?.signal,
    })

    if (!response.ok) {
      return { kind: 'error', message: `HTTP ${response.status}${await statusHintOf(response.status)}` }
    }

    const text = await response.text()
    if (text.trim() === '') {
      return { kind: 'error', message: 'host 返回了空响应（路由注册了但处理失败？）' }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { kind: 'error', message: `host 返回的不是 JSON：${text.slice(0, 120)}` }
    }

    const snapshot = parsed as Snapshot
    if (snapshot === null || typeof snapshot !== 'object' || snapshot.ok !== true) {
      return { kind: 'error', message: 'host 返回的快照形状不对（缺 ok:true）' }
    }
    return { kind: 'ok', data: snapshot }
  } catch (error) {
    const name = (error as { name?: string })?.name
    if (name === 'AbortError') {
      return { kind: 'error', message: `请求超时（>${timeoutMs}ms）。host 可能卡住了，点重试。` }
    }
    return { kind: 'error', message: `请求失败：${(error as Error)?.message ?? String(error)}` }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 取已知项目根列表（M2.2）。
 *
 * ---- 为什么这个请求没有参数 ----
 *
 * 它问的是"这台机器上**有哪些**项目"，不是"当前是哪个"。
 * 后者 client 不可能知道（宿主不给 root-scope 面板会话绑定），
 * 所以列表必须由 host 出、由用户选。
 *
 * 失败时返回 `[]` 而不是抛：项目选择器为空只意味着"没法选"，
 * 不该让整个面板炸掉。
 *
 * @param timeoutMs 默认 8 秒
 */
export async function fetchProjects(timeoutMs = 8000): Promise<ProjectOption[]> {
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined
  const timer = controller === undefined
    ? undefined
    : setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(ROUTES.projects, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller?.signal,
    })
    if (!response.ok) return []
    const parsed = await response.json() as { ok?: boolean; projects?: unknown }
    if (parsed?.ok !== true || !Array.isArray(parsed.projects)) return []
    return parsed.projects.filter((item): item is ProjectOption => (
      item !== null
      && typeof item === 'object'
      && typeof (item as ProjectOption).cwd === 'string'
      && (item as ProjectOption).cwd !== ''
    ))
  } catch {
    return []
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
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
 * 让 host 重新探测某个目录（M2.2）。
 *
 * ⚠️ **这个函数存在的理由**：host 的探测有 TTL 缓存（`PROBE_TTL_MS`）。
 * 用户在目录里新建 `docs/` 之后点"刷新"，如果只重取快照，
 * 探测结果仍命中旧缓存 → 面板一直说"这不是 DDD 项目"。
 *
 * @param cwd 要重新探测的目录
 */
export async function postRecheck(cwd: string, timeoutMs = 15000): Promise<{ ok: boolean; isDdd?: boolean; projectRoot?: string }> {
  try {
    const response = await fetch(ROUTES.recheck, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ cwd }),
      signal: typeof AbortController === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
    })
    if (!response.ok) return { ok: false }
    return await response.json() as { ok: boolean; isDdd?: boolean; projectRoot?: string }
  } catch {
    return { ok: false }
  }
}

/**
 * 归档 / 还原的结果（M2-E 的 client 半侧）。
 *
 * ⚠️ **三个数组必须永远存在**：UI 会读 `.length`，缺了就会炸在 `undefined.length`
 * （M2.1 踩过这个坑，`postInit` 的注释里也记着）。
 */
export interface GraveyardResult {
  ok: boolean
  error?: string
  /** 成功移动的条目。 */
  moved: Array<{ from: string; to: string }>
  /** 失败的条目（**每条都有原因**，不许静默跳过）。 */
  failed: Array<{ path?: string; id?: string; error: string }>
}

/**
 * 把一份"坏结果"补齐成 `GraveyardResult` 形状。
 *
 * 三条路径都会用到（网络失败 / 非 2xx / JSON 解析失败），抽出来是为了
 * **形状只有一处定义** —— 三处各写一遍就会有一处漏掉某个数组。
 *
 * @param error 给用户看的一句话
 * @returns 形状合法的失败结果
 */
function graveyardFailure(error: string): GraveyardResult {
  return { ok: false, error, moved: [], failed: [] }
}

/**
 * 把 host 返回的任意对象**规范化**成 `GraveyardResult`。
 *
 * 为什么不在 UI 里直接读 `parsed.moved.length`：host 的两处早退
 * （"不是 DDD 项目" / "路由未装配"）历史上曾经**不带数组**，
 * 直接读会白屏。规范化放在这一层，UI 就永远拿到安全形状。
 *
 * @param parsed host 返回的 JSON
 * @returns 规范化结果
 */
export function normalizeGraveyardResult(parsed: unknown): GraveyardResult {
  const data = (parsed !== null && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>
  return {
    ok: data.ok === true,
    error: typeof data.error === 'string' ? data.error : undefined,
    moved: Array.isArray(data.moved) ? data.moved as GraveyardResult['moved'] : [],
    failed: Array.isArray(data.failed) ? data.failed as GraveyardResult['failed'] : [],
  }
}

/**
 * 归档：把若干份 `status: void` 的文档物理移到 `docs/_graveyard/`（M2-E）。
 *
 * ---- 为什么 client 只发 id，不发路径 ----
 *
 * 这是 M2-Q6 的权限分工：**client 永远不碰文件**，它只 POST 一组 id；
 * 路径解析、移动、元数据写入全部在 host 侧（`server/write-engine.ts`）。
 * 所以这里连 `cwd` 都不用传 —— host 从 `sessionId` 定位项目。
 *
 * @param ids 要归档的文档 id
 * @param options.sessionId 当前会话 id（host 用它定位项目与 readSet）
 * @param options.cwd 项目根（**兜底**：root 面板没有 sessionId 时用）
 * @returns 规范化结果（**绝不抛**）
 */
export async function postArchive(
  ids: readonly string[],
  options: { sessionId?: string; cwd?: string; timeoutMs?: number } = {},
): Promise<GraveyardResult> {
  return postGraveyardAction(ROUTES.archive, ids, options)
}

/**
 * 还原：把坟场里的文档放回原处（M2-E）。
 *
 * ⚠️ 参数是**坟场里的相对路径**（`docs/_graveyard/xxx.md`），不是 id ——
 * 因为坟场里的文件已经不在注册表里了，没有 id 可查。
 * 这一点与 `postArchive` 不同，别为了"对称"把两者写成一样。
 *
 * @param paths 坟场里的相对路径
 * @param options 同 `postArchive`
 * @returns 规范化结果（**绝不抛**）
 */
export async function postRestore(
  paths: readonly string[],
  options: { sessionId?: string; cwd?: string; timeoutMs?: number } = {},
): Promise<GraveyardResult> {
  return postGraveyardAction(ROUTES.restore, paths, options)
}

/**
 * 归档 / 还原的**共用请求体**。
 *
 * 两者 host 侧都接受 `ids` 或 `paths`，所以这里两个键都带上 ——
 * 少带一个会让 host 认为"没有要处理的条目"而返回成功空数组，
 * 那种"成功但什么都没做"比报错更难查。
 *
 * @param route 路由
 * @param items id 或路径
 * @param options 选项
 * @returns 规范化结果
 */
async function postGraveyardAction(
  route: string,
  items: readonly string[],
  options: { sessionId?: string; cwd?: string; timeoutMs?: number } = {},
): Promise<GraveyardResult> {
  const list = Array.isArray(items) ? items.filter((item) => typeof item === 'string' && item !== '') : []
  // 空列表**不发请求**：那只会得到一次"成功但什么都没做"，白白让 UI 闪一下。
  if (list.length === 0) return graveyardFailure('没有选中任何条目')

  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 20000
  try {
    const response = await fetch(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        ids: [...list],
        paths: [...list],
        sessionId: options.sessionId ?? '',
        cwd: options.cwd ?? '',
      }),
      signal: typeof AbortController === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
    })
    if (!response.ok) {
      return graveyardFailure(`请求失败（HTTP ${response.status}）${statusHintOf(response.status)}`)
    }
    return normalizeGraveyardResult(await response.json())
  } catch (error) {
    return graveyardFailure(`请求失败：${(error as Error)?.message ?? String(error)}`)
  }
}

/**
 * 一键把目录初始化成 DDD 工作区（M2.2）。
 *
 * 目标已存在时 host 会**跳过而不覆盖**，并在 `skipped` 里说清 ——
 * 这个函数只是把那个结果原样带回来，不做任何判断。
 */
export async function postInit(cwd: string, timeoutMs = 20000): Promise<InitResult> {
  try {
    const response = await fetch(ROUTES.init, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ cwd }),
      signal: typeof AbortController === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
    })
    const parsed = await response.json() as Partial<InitResult>
    return {
      ok: parsed?.ok === true,
      error: typeof parsed?.error === 'string' ? parsed.error : undefined,
      // ⚠️ 三个数组必须**永远存在**：client 会读 `.length`，
      // 缺了就会炸在 `undefined.length`（M2.1 踩过这个坑）。
      created: Array.isArray(parsed?.created) ? parsed.created : [],
      skipped: Array.isArray(parsed?.skipped) ? parsed.skipped : [],
      failed: Array.isArray(parsed?.failed) ? parsed.failed : [],
      isDdd: parsed?.isDdd === true,
    }
  } catch (error) {
    return {
      ok: false,
      error: `初始化请求失败：${(error as Error)?.message ?? String(error)}`,
      created: [],
      skipped: [],
      failed: [],
    }
  }
}

/** 给常见状态码补一句人话（401 最常见：那是宿主的认证，不是我们的 bug）。 */
function statusHintOf(status: number): string {
  if (status === 401) return ' —— 未通过宿主认证（这个路由要在 DSH 自己的界面里访问）'
  if (status === 404) return ' —— 路由不存在（host 侧没注册成功？）'
  if (status === 405) return ' —— 方法不对'
  if (status >= 500) return ' —— host 侧处理失败'
  return ''
}

/**
 * 预览地址（M2-B）。
 *
 * ---- 地址格式（照 `dsh-util-workspace-path` 的真实实现抄，不再靠文档猜）----
 *
 * `src/file-address.ts` 的 `sessionFileAddress(sessionId, path)` 产出：
 *
 * ```
 * dsh-resource://file/session/<encodeSegment(sessionId)>/<encodePath(path)>
 * ```
 *
 * 其中 `encodeSegment` 是 `encodeURIComponent` **再把 `%3A` 还原成 `:`**
 * （让盘符 `C:` 读起来是原样）。`encodePath` 是逐段编码、保留 `/`。
 *
 * ---- ⚠️ 2026-11-13 实机事故：sessionId 为空串时**必然打不开** ----
 *
 * `parseFileAddress` 里有一句 `if (id === undefined || id === '' || segments.length === 0) return undefined`。
 * 也就是说 **sessionId 是空串时，地址直接无效**，`openResource` 拿到的就是一个解析不了的东西
 * —— 用户看到的是「鼠标变手势但点击没反应」。
 *
 * 所以：**拿不到 sessionId 时，宁可用 `absolute` scope，也不拼一个空 session 的地址**。
 * `absolute` scope 不带会话（`dsh-resource://file/absolute/<去掉前导斜杠的绝对路径>`），
 * 只要路径是绝对的就能打开。
 *
 * @param sessionId 会话 id（空串 = 不知道，退到 absolute scope）
 * @param relativePath 相对项目根的路径，`docs/x.md` 这种
 * @param projectRoot 项目根绝对路径（absolute scope 需要它）
 */
export function previewAddressOf(sessionId: string, relativePath: string, projectRoot = ''): string {
  const normalize = (text: string): string => text.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '')

  /** 与官方 `encodeSegment` 一致：编码后把 `%3A` 还原成 `:`。 */
  const encodeSegment = (segment: string): string => encodeURIComponent(segment).replace(/%3A/gi, ':')
  /** 逐段编码，保留 `/`。 */
  const encodePath = (path: string): string => path.split('/').map(encodeSegment).join('/')

  const path = normalize(relativePath)

  // 1) 有 sessionId → session scope（官方首选：Host 用它为该会话持有的根解析路径）。
  if (typeof sessionId === 'string' && sessionId !== '') {
    return `dsh-resource://file/session/${encodeSegment(sessionId)}/${encodePath(path)}`
  }

  // 2) 没有 sessionId → absolute scope（不带会话，只要有绝对路径就能开）。
  //    这比拼一个空 session 的地址好：后者**必然**解析失败。
  if (typeof projectRoot === 'string' && projectRoot !== '') {
    const absolute = normalize(`${projectRoot.replace(/[/\\]+$/, '')}/${path}`)
    const unc = absolute.startsWith('//')
    const trimmed = absolute.replace(/^\/+/, '')
    return `dsh-resource://file/absolute/${unc ? '/' : ''}${encodePath(trimmed)}`
  }

  // 3) 两者都没有 —— 返回 session scope 的空 id 形态，但调用方应当先拦住。
  //    这里不抛，让 UI 的"打不开"提示去解释。
  return `dsh-resource://file/session/${encodeSegment('')}/${encodePath(path)}`
}

/**
 * 预览地址是否**可解析**（与宿主 `parseFileAddress` 同一条判据）。
 *
 * 用于在点开之前就判断"这个地址打不开"，而不是让用户点了没反应。
 *
 * @param address `previewAddressOf` 的产物
 */
export function isOpenableAddress(address: string): boolean {
  const PREFIX = 'dsh-resource://file/'
  if (!address.startsWith(PREFIX)) return false
  const end = address.search(/[?#]/)
  const [scope, ...rest] = address.slice(PREFIX.length, end === -1 ? undefined : end).split('/')
  if (scope === 'session') {
    const [id, ...segments] = rest
    return id !== undefined && id !== '' && segments.length > 0
  }
  if (scope === 'absolute') {
    const unc = rest[0] === '' && rest.length > 1
    const segments = unc ? rest.slice(1) : rest
    return segments.length > 0 && segments[0] !== ''
  }
  return false
}

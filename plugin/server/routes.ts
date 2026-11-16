/**
 * host 侧 HTTP 路由（M2-A / M2-B 的数据通道）。
 *
 * ---- 为什么走 HTTP 而不是工具 ----
 *
 * M2-Q3（用户 2026-11-12 拍板）：**host 注册 HTTP 路由，client 用 `fetch` 取**。
 * 理由里最硬的一条是 **Q13：工具上限 4 个，M1 已用满** ——
 * 看板数据如果走工具，就会进模型上下文（每轮都花 token），而它**只该给人看**。
 *
 * ---- R-1 已经核实过了（别再重新调研）----
 *
 * `ctx.webServer.register` 是**第一方公开服务**，不是第三方私有约定：
 * - `cordis_inspect` 的 host Service `webServer` 给出签名
 *   `register(route: WebRoute | WebResourceRoute): () => void`；
 * - `WebRoute = { kind: 'exact' | 'prefix', path: string,
 *   handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }`；
 * - skill-explorer 的活用法：插件级 `inject: ['webServer']` +
 *   `ctx.effect(() => routes.map((r) => ctx.webServer.register(r)))`
 *   （`lib/index.js:1947` 与 `:1999-2004`）。
 *
 * ⚠️ **不要**去反编译 `app.asar`（交接 §3.1 的警告：那是不划算的路）。
 *
 * ---- 硬约束（SPEC §5.3）----
 *
 * 1. **注册必须 try/catch**：拿不到 `webServer` / 端口冲突 / 任何异常 → **只 warn，不抛**。
 *    理由与 M1-L8 同源：**插件故障不能变成宿主故障**。
 * 2. **本文件不许 import `node:` 内置模块**（SPEC §5.3-3）。
 *    写响应只用 `res.writeHead` / `res.end`，那是 Node 的 `ServerResponse` 形状，
 *    不是内置模块的 import。
 * 3. 只读优先：`GET /api/ddd/index` 是纯读。
 *    归档/还原是 POST，但那是 **host 拿着 `ctx.fs` 做事**，不是 client 改文件（M2-Q6）。
 */

import { buildSnapshot } from './snapshot.ts'

/** 路由路径（client bundle 会镜像这些字面量；两边都要有断言）。 */
export const ROUTES = Object.freeze({
  index: '/api/ddd/index',
  archive: '/api/ddd/archive',
  restore: '/api/ddd/restore',
  ping: '/api/ddd/ping',
  /**
   * 已知项目根列表（M2.2 新增）。
   *
   * ---- 为什么需要这条（2026-11-13 实机暴露的缺口）----
   *
   * 面板必须知道"当前项目是哪个"才能查门禁。但宿主**设计上不给 root-scope 的
   * `main` 席位任何会话绑定**（`dsh-client-ui-layout` 的注释原文：
   * 「other keys receive no Session binding」）。
   *
   * client 侧能拿到会话列表（`sessions.list`，含每个会话的 `cwd`），但它
   * **不知道用户当前选中了哪个**——那是 UI 内部状态，没有任何服务暴露它。
   *
   * 所以"猜一个"是错的（会显示错项目的门禁，比不显示更糟）。正确做法是
   * **让用户显式选**，而候选列表必须在 host 侧算：只有 host 能读会话目录。
   */
  projects: '/api/ddd/projects',
  /**
   * 把某个目录**一键初始化**成 DDD 工作区（M2.2）。
   *
   * POST `{ cwd }` → 建 `docs/` + 写一份合规的入口索引。
   * 目标已存在时**跳过而不覆盖**，并在 `skipped` 里说清。
   */
  init: '/api/ddd/init',
  /**
   * 让某个目录的探测缓存失效，强制下次重新读盘（M2.2）。
   *
   * POST `{ cwd }` → 用户点了"刷新"时调它。
   * 没有它的话，用户在目录里新建了 `docs/` 之后，
   * 面板会一直说"这不是 DDD 项目"，直到探测 TTL 过期或重启宿主。
   */
  recheck: '/api/ddd/recheck',
})

/**
 * 写一个 JSON 响应。
 *
 * @param {object} res Node 的 ServerResponse
 * @param {number} status
 * @param {unknown} body
 */
function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * 从 `req.url` 里取一个查询参数（`new URL` 需要基址，给个假的就行）。
 *
 * @param {string | undefined} rawUrl
 * @param {string} name
 * @returns {string | undefined}
 */
function queryParam(rawUrl, name) {
  try {
    const url = new URL(typeof rawUrl === 'string' && rawUrl !== '' ? rawUrl : '/', 'http://x')
    const value = url.searchParams.get(name)
    return value === null || value === '' ? undefined : value
  } catch {
    return undefined
  }
}

/**
 * 建三个路由。
 *
 * `deps` 里的每一项都是**函数**而不是值 —— 因为看板要反映**当前**状态，
 * 不能在挂载时就把注册表快照冻住（那会重造 D1 那个 bug：AGENTS.md 永远停在第一次）。
 *
 * @param {object} deps
 * @param {(cwd: string | undefined, sessionId: string | undefined) => Promise<object> | object} deps.snapshotOf
 *   由 index.js 提供的装配函数：给定 cwd + sessionId，返回 `buildSnapshot` 的入参。
 * @param {(request: object) => Promise<object>} [deps.archive]
 * @param {(request: object) => Promise<object>} [deps.restore]
 * @param {{warn: Function}} [deps.logger]
 * @returns {object[]} `WebRoute[]`
 */
export function makeRoutes(deps) {
  const snapshotOf = typeof deps?.snapshotOf === 'function' ? deps.snapshotOf : undefined
  const logger = deps?.logger

  /** 统一的错误收尾：**永远返回 JSON**，不让 client 拿到一个空响应。 */
  const fail = (res, error, where) => {
    logger?.warn?.(`[ddd] ${where} 失败：${error?.message ?? error}`)
    writeJson(res, 500, { ok: false, error: error?.message ?? String(error) })
  }

  const routes = [
    {
      kind: 'exact',
      path: ROUTES.ping,
      handler: (req, res) => {
        writeJson(res, 200, { ok: true, pong: true, version: 1 })
      },
    },
    {
      kind: 'exact',
      path: ROUTES.index,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method}` })
          return
        }
        try {
          if (snapshotOf === undefined) {
            // 装配没接上时**不要**抛：给一个结构合法的空快照，
            // client 那边会显示"没有数据"而不是白屏。
            writeJson(res, 200, buildSnapshot({ sessionId: '' }))
            return
          }
          const cwd = queryParam(req.url, 'cwd')
          const sessionId = queryParam(req.url, 'sessionId')
          const input = await snapshotOf(cwd, sessionId)
          writeJson(res, 200, buildSnapshot(input))
        } catch (error) {
          fail(res, error, 'GET /api/ddd/index')
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.archive,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method}` })
          return
        }
        try {
          if (typeof deps?.archive !== 'function') {
            writeJson(res, 501, { ok: false, error: '归档未装配' })
            return
          }
          const body = await readJsonBody(req)
          const result = await deps.archive(body)
          writeJson(res, result?.ok === false ? 400 : 200, result)
        } catch (error) {
          fail(res, error, 'POST /api/ddd/archive')
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.restore,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method}` })
          return
        }
        try {
          if (typeof deps?.restore !== 'function') {
            writeJson(res, 501, { ok: false, error: '还原未装配' })
            return
          }
          const body = await readJsonBody(req)
          const result = await deps.restore(body)
          writeJson(res, result?.ok === false ? 400 : 200, result)
        } catch (error) {
          fail(res, error, 'POST /api/ddd/restore')
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.projects,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method}` })
          return
        }
        try {
          if (typeof deps?.projects !== 'function') {
            // 装配没接上：给一个**结构合法**的空列表，让 client 显示
            // "没有可选项目"而不是白屏（与 index 的装配缺失同一处置）。
            writeJson(res, 200, { ok: true, version: 1, projects: [] })
            return
          }
          const list = await deps.projects()
          writeJson(res, 200, { ok: true, version: 1, projects: Array.isArray(list) ? list : [] })
        } catch (error) {
          fail(res, error, 'GET /api/ddd/projects')
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.init,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method}` })
          return
        }
        try {
          if (typeof deps?.init !== 'function') {
            // 与 archive/restore 同一条纪律：**失败形状必须与成功同形**。
            writeJson(res, 501, { ok: false, error: '初始化未装配', created: [], skipped: [], failed: [] })
            return
          }
          const body = await readJsonBody(req)
          const result = await deps.init(body)
          writeJson(res, result?.ok === false ? 400 : 200, result)
        } catch (error) {
          fail(res, error, 'POST /api/ddd/init')
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.recheck,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method}` })
          return
        }
        try {
          if (typeof deps?.recheck !== 'function') {
            writeJson(res, 501, { ok: false, error: '重新探测未装配' })
            return
          }
          const body = await readJsonBody(req)
          const result = await deps.recheck(body)
          writeJson(res, result?.ok === false ? 400 : 200, result)
        } catch (error) {
          fail(res, error, 'POST /api/ddd/recheck')
        }
      },
    },
  ]

  return routes
}

/** 单次请求体的字节上限（防止一个坏 client 把 host 内存吃光）。 */
const MAX_BODY_BYTES = 64 * 1024

/**
 * 读一个 JSON 请求体。
 *
 * 不用 `node:` 模块：`IncomingMessage` 本身是异步可迭代的。
 *
 * @param {object} req
 * @returns {Promise<object>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0

    const onData = (chunk) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        cleanup()
        reject(new Error(`请求体超过 ${MAX_BODY_BYTES} 字节`))
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => {
      cleanup()
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      req.off?.('data', onData)
      req.off?.('end', onEnd)
      req.off?.('error', onError)
    }

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

/**
 * 把路由注册到宿主。
 *
 * ⚠️ **这个函数绝不抛**（SPEC §5.3-1）。三种失败都只是 warn：
 * 1. 拿不到 `webServer` 服务（宿主的组合里没有它）；
 * 2. `register` 本身抛（重复 `(kind, path)` 会 throw，见 service catalog）；
 * 3. `ctx.effect` 不可用（极老/极简的宿主）。
 *
 * @param {object} ctx Cordis 上下文
 * @param {object[]} routes `makeRoutes` 的产物
 * @param {{warn?: Function, debug?: Function}} [logger]
 * @returns {(() => void) | undefined} 释放函数；没注册成功时返回 undefined
 */
export function registerRoutes(ctx, routes, logger) {
  let disposers
  try {
    const webServer = ctx?.webServer ?? ctx?.get?.('webServer', false)
    if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
      logger?.warn?.('[ddd] 拿不到 webServer 服务，M2 的 HTTP 路由未注册（看板会显示无数据）')
      return undefined
    }

    const install = () => {
      const made = []
      for (const route of routes) {
        try {
          made.push(webServer.register(route))
        } catch (error) {
          // 单条路由失败不能连累其它条（更不能连累门禁）。
          logger?.warn?.(`[ddd] 注册路由 ${route?.path} 失败：${error?.message ?? error}`)
        }
      }
      // 注册成功时打一条 **info**（不是 warn）。
      //
      // 为什么要这条日志：R-1 的判据是「路由真的被宿主接上了」，
      // 而外部 HTTP 探测**做不到**——宿主的认证在路由匹配**之前**发生，
      // 所以 `/api/ddd/ping` 与一个不存在的路径都返回 401，两者不可区分。
      // 这条日志是**唯一**能从宿主内部证明"注册发生了"的观测点。
      if (made.length > 0) {
        logger?.info?.(`[ddd] HTTP 路由已注册 ${made.length} 条：${routes.map((route) => route.path).join('、')}`)
      }
      return made
    }

    // 注册由 effect 持有（与 skill-explorer 同形），宿主卸载时自动摘掉。
    if (typeof ctx?.effect === 'function') {
      ctx.effect(() => {
        disposers = install()
        return () => {
          for (const dispose of disposers ?? []) {
            try { dispose() } catch { /* 释放失败不影响其它 */ }
          }
        }
      }, 'ddd.routes.register()')
      return () => {
        for (const dispose of disposers ?? []) {
          try { dispose() } catch { /* 忽略 */ }
        }
      }
    }

    // 没有 effect 的宿主：直接注册，返回一个手写的释放函数。
    disposers = install()
    return () => {
      for (const dispose of disposers ?? []) {
        try { dispose() } catch { /* 忽略 */ }
      }
    }
  } catch (error) {
    logger?.warn?.(`[ddd] HTTP 路由注册整体失败（不影响门禁）：${error?.message ?? error}`)
    return undefined
  }
}

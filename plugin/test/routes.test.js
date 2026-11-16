/**
 * `server/routes.ts` 的单测。
 *
 * ---- 这一组测试的重点 ----
 *
 * 1. **注册绝不抛**（SPEC §5.3-1）。这是"插件故障不能变成宿主故障"的落点：
 *    拿不到 `webServer`、`register` 抛、`ctx.effect` 不存在 —— 三种都要只 warn。
 *    修之前的形态会让整个插件在宿主启动时挂掉，那时**连门禁也不工作了**。
 * 2. **永远返回 JSON**，不返回空响应。client 拿到空响应会白屏，而白屏比报错更难查。
 * 3. **路由的 kind/path 必须与 client 镜像的字面量一致**（两边都要有断言）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { makeRoutes, registerRoutes, ROUTES } from '../server/routes.ts'

// ---------------------------------------------------------------- 假宿主

/**
 * 假 `ServerResponse`：记下 status / body。
 * @returns {object}
 */
function fakeRes() {
  const res = {
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) {
      res.status = status
      res.headers = headers
    },
    end(text) {
      res.body = text
    },
  }
  return res
}

/**
 * 假 `IncomingMessage`：`GET` 时没有 body，`POST` 时把 body 灌进去。
 * @param {string} url
 * @param {string} [method]
 * @param {string} [body]
 * @returns {object}
 */
function fakeReq(url, method = 'GET', body = undefined) {
  const listeners = new Map()
  const req = {
    url,
    method,
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
      // POST：注册后立刻把 body 推下去（下一 tick，模拟真实流）。
      if (body !== undefined && event === 'data') {
        queueMicrotask(() => {
          for (const each of listeners.get('data') ?? []) each(Buffer.from(body, 'utf8'))
          for (const each of listeners.get('end') ?? []) each()
        })
      }
      if (body === undefined && event === 'end') {
        queueMicrotask(() => {
          for (const each of listeners.get('end') ?? []) each()
        })
      }
      return req
    },
    off(event, fn) {
      const list = listeners.get(event)
      if (list !== undefined) {
        const at = list.indexOf(fn)
        if (at >= 0) list.splice(at, 1)
      }
      return req
    },
  }
  return req
}

/**
 * 跑一条路由的 handler。
 * @param {object[]} routes
 * @param {string} path
 * @param {object} req
 * @returns {Promise<object>} 假 res
 */
async function callRoute(routes, path, req) {
  const route = routes.find((item) => item.path === path)
  assert.ok(route !== undefined, `没有 ${path} 这条路由`)
  const res = fakeRes()
  await route.handler(req, res)
  return res
}

/** 解出 JSON 响应体。 */
function jsonOf(res) {
  assert.equal(typeof res.body, 'string', '响应体不是字符串（可能是空响应）')
  return JSON.parse(res.body)
}

// ---------------------------------------------------------------- 1. 路由表

test('routes：七条路由都在，且 kind 都是 exact', () => {
  const routes = makeRoutes({})
  assert.deepEqual(
    routes.map((item) => item.path).sort(),
    [ROUTES.archive, ROUTES.index, ROUTES.ping, ROUTES.projects, ROUTES.restore, ROUTES.init, ROUTES.recheck].sort(),
  )
  assert.ok(routes.every((item) => item.kind === 'exact'))
})

test('**routes：路径字面量与 SPEC / client 的约定一致**（改一处就会两边不同步）', () => {
  // 这些字符串 client bundle 会镜像一份；两边不一致的症状是"看板永远空"。
  assert.equal(ROUTES.index, '/api/ddd/index')
  assert.equal(ROUTES.archive, '/api/ddd/archive')
  assert.equal(ROUTES.restore, '/api/ddd/restore')
  assert.equal(ROUTES.ping, '/api/ddd/ping')
  assert.equal(ROUTES.projects, '/api/ddd/projects')
})

// ---------------------------------------------------------------- M2.2 项目列表

test('M2.2：projects 未装配时返回**结构合法**的空列表（不是 500、不是白屏）', async () => {
  // 与 index 的装配缺失同一处置：client 会显示"没有可选项目"，而不是炸掉。
  const routes = makeRoutes({})
  const res = await callRoute(routes, ROUTES.projects, fakeReq(ROUTES.projects, 'GET'))
  assert.equal(res.status, 200)
  const body = jsonOf(res)
  assert.equal(body.ok, true)
  assert.deepEqual(body.projects, [])
})

test('M2.2：projects 装配后原样转发 host 的判定结果（isDdd 由 host 出）', async () => {
  const projects = [
    { cwd: 'C:\\a', projectRoot: 'C:\\a', isDdd: true },
    { cwd: 'C:\\b', projectRoot: '', isDdd: false },
  ]
  const routes = makeRoutes({ projects: async () => projects })
  const res = await callRoute(routes, ROUTES.projects, fakeReq(ROUTES.projects, 'GET'))
  assert.equal(res.status, 200)
  assert.deepEqual(jsonOf(res).projects, projects)
})

test('M2.2：projects 的 host 实现抛错 → 500 且**仍是 JSON**', async () => {
  const routes = makeRoutes({ projects: async () => { throw new Error('boo') } })
  const res = await callRoute(routes, ROUTES.projects, fakeReq(ROUTES.projects, 'GET'))
  assert.equal(res.status, 500)
  assert.equal(jsonOf(res).ok, false)
})

test('M2.2：projects 只接 GET（POST → 405）', async () => {
  const routes = makeRoutes({})
  const res = await callRoute(routes, ROUTES.projects, fakeReq(ROUTES.projects, 'POST', '{}'))
  assert.equal(res.status, 405)
})

// ---------------------------------------------------------------- 2. ping（最廉价的活体探针）

test('routes：GET /ping → 200 + pong（R-1 的"10 分钟验证"用它）', async () => {
  const routes = makeRoutes({})
  const res = await callRoute(routes, ROUTES.ping, fakeReq(ROUTES.ping))
  assert.equal(res.status, 200)
  assert.equal(jsonOf(res).ok, true)
})

// ---------------------------------------------------------------- 3. index

test('routes：GET /index → 200，且 body 是完整快照', async () => {
  const routes = makeRoutes({
    snapshotOf: () => ({ entries: [], sessionId: 'session-abc123', projectRoot: 'C:\\proj' }),
  })
  const res = await callRoute(routes, ROUTES.index, fakeReq(`${ROUTES.index}?cwd=C%3A%5Cproj`))
  assert.equal(res.status, 200)
  const body = jsonOf(res)
  assert.equal(body.ok, true)
  assert.equal(body.sessionId, 'session-abc123')
  assert.equal(body.projectRoot, 'C:\\proj')
})

test('**routes：cwd 与 sessionId 都透传给 snapshotOf**（缺 sessionId 会让 gate.read 静默错）', async () => {
  let seen
  const routes = makeRoutes({
    snapshotOf: (cwd, sessionId) => {
      seen = { cwd, sessionId }
      return { entries: [], sessionId: sessionId ?? '' }
    },
  })
  await callRoute(
    routes,
    ROUTES.index,
    fakeReq(`${ROUTES.index}?cwd=C%3A%5Cproj&sessionId=session-2dd5116a`),
  )
  assert.deepEqual(seen, { cwd: 'C:\\proj', sessionId: 'session-2dd5116a' })
})

test('**routes：snapshotOf 抛错 → 500 + JSON**（不许让 client 拿到空响应）', async () => {
  const routes = makeRoutes({
    snapshotOf: () => { throw new Error('炸了') },
    logger: { warn: () => {} },
  })
  const res = await callRoute(routes, ROUTES.index, fakeReq(ROUTES.index))
  assert.equal(res.status, 500)
  const body = jsonOf(res)
  assert.equal(body.ok, false)
  assert.ok(body.error.includes('炸了'))
})

test('**routes：没装配 snapshotOf → 返回结构合法的空快照，不是 500**', async () => {
  const routes = makeRoutes({})
  const res = await callRoute(routes, ROUTES.index, fakeReq(ROUTES.index))
  assert.equal(res.status, 200)
  const body = jsonOf(res)
  assert.equal(body.ok, true)
  assert.equal(body.gate.required, 0)
})

test('routes：GET /index 用 POST 方法 → 405', async () => {
  const routes = makeRoutes({ snapshotOf: () => ({ entries: [], sessionId: '' }) })
  const res = await callRoute(routes, ROUTES.index, fakeReq(ROUTES.index, 'POST', ''))
  assert.equal(res.status, 405)
  assert.equal(jsonOf(res).ok, false)
})

// ---------------------------------------------------------------- 4. archive / restore

test('routes：POST /archive 没装配 → 501（明确"还没做"，不是 500）', async () => {
  const routes = makeRoutes({})
  const res = await callRoute(routes, ROUTES.archive, fakeReq(ROUTES.archive, 'POST', '{}'))
  assert.equal(res.status, 501)
  assert.equal(jsonOf(res).ok, false)
})

test('routes：POST /archive 装配了 → 透传结果', async () => {
  const routes = makeRoutes({
    archive: (body) => ({ ok: true, moved: body.ids }),
  })
  const res = await callRoute(
    routes,
    ROUTES.archive,
    fakeReq(ROUTES.archive, 'POST', JSON.stringify({ ids: ['old-plan'] })),
  )
  assert.equal(res.status, 200)
  assert.deepEqual(jsonOf(res).moved, ['old-plan'])
})

test('routes：POST /archive 收到坏 JSON → 500 + JSON（不抛到宿主）', async () => {
  const routes = makeRoutes({
    archive: () => ({ ok: true }),
    logger: { warn: () => {} },
  })
  const res = await callRoute(routes, ROUTES.archive, fakeReq(ROUTES.archive, 'POST', '{不是 JSON'))
  assert.equal(res.status, 500)
  assert.equal(jsonOf(res).ok, false)
})

test('routes：POST /archive 用 GET 方法 → 405', async () => {
  const routes = makeRoutes({ archive: () => ({ ok: true }) })
  const res = await callRoute(routes, ROUTES.archive, fakeReq(ROUTES.archive, 'GET'))
  assert.equal(res.status, 405)
})

// ---------------------------------------------------------------- 5. registerRoutes：**绝不抛**

test('**registerRoutes：拿不到 webServer → 只 warn，返回 undefined，不抛**（SPEC §5.3-1）', () => {
  const warned = []
  const ctx = { get: () => undefined }
  let result
  assert.doesNotThrow(() => {
    result = registerRoutes(ctx, makeRoutes({}), { warn: (message) => warned.push(message) })
  })
  assert.equal(result, undefined)
  assert.equal(warned.length, 1, '应当恰好 warn 一次')
  // ⚠️ **必须断言文案说的是「webServer」而不是笼统的「整体失败」。**
  //
  // 第一版这条只断言了 `doesNotThrow` + 文案含 'webServer'，看起来够严，
  // 但我实测变异（把这一支改成 `throw`）时它**仍然全绿** ——
  // 因为函数最外层的 catch 把那个 throw 兜住了，`doesNotThrow` 自然成立。
  // 也就是说：那条断言证明的是"外层 catch 有效"，**不是**"这一支走的是 warn 分支"。
  //
  // 外层 catch 的文案是「HTTP 路由注册整体失败（不影响门禁）」，不含 webServer 以外的语义；
  // 所以下面这条断言能把两个分支区分开：**变异后文案会变成"整体失败"**。
  assert.ok(
    warned[0].includes('webServer') && !warned[0].includes('整体失败'),
    `拿不到 webServer 时走的不是"缺服务"分支，而是别的分支：${warned[0]}`,
  )
})

test('**registerRoutes：webServer.register 抛 → 单条失败不连累其它条**', () => {
  const warned = []
  let registered = 0
  const ctx = {
    webServer: {
      register(route) {
        if (route.path === ROUTES.index) throw new Error('duplicate (kind, path)')
        registered += 1
        return () => {}
      },
    },
    effect(fn) { fn(); return () => {} },
  }
  assert.doesNotThrow(() => {
    registerRoutes(ctx, makeRoutes({}), { warn: (message) => warned.push(message) })
  })
  assert.equal(registered, 6, '其它六条应当仍然注册成功')
  assert.ok(warned.some((message) => message.includes(ROUTES.index)))
})

test('**registerRoutes：ctx 是垃圾 → 不抛**（宿主传什么都不能炸）', () => {
  for (const ctx of [undefined, null, {}, { get: () => { throw new Error('x') } }]) {
    assert.doesNotThrow(() => {
      registerRoutes(ctx, makeRoutes({}), { warn: () => {} })
    })
  }
})

test('registerRoutes：注册成功时返回可用的释放函数', () => {
  const disposed = []
  const ctx = {
    webServer: {
      register(route) {
        return () => disposed.push(route.path)
      },
    },
    effect(fn) { fn(); return () => {} },
  }
  const dispose = registerRoutes(ctx, makeRoutes({}), { warn: () => {} })
  assert.equal(typeof dispose, 'function')
  dispose()
  assert.equal(disposed.length, 7, '七条路由都应当被释放')
})

test('registerRoutes：没有 ctx.effect 的宿主也能注册（退回手写释放）', () => {
  const disposed = []
  const ctx = {
    webServer: { register: () => () => disposed.push(1) },
  }
  const dispose = registerRoutes(ctx, makeRoutes({}), { warn: () => {} })
  assert.equal(typeof dispose, 'function')
  dispose()
  assert.equal(disposed.length, 7)
})

test('registerRoutes：ctx.get("webServer") 也能拿到服务（可选依赖路径）', () => {
  let count = 0
  const ctx = {
    get: (name) => (name === 'webServer' ? { register: () => { count += 1; return () => {} } } : undefined),
    effect(fn) { fn(); return () => {} },
  }
  registerRoutes(ctx, makeRoutes({}), { warn: () => {} })
  assert.equal(count, 7)
})

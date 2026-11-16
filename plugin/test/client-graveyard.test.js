/**
 * 归档 / 还原的 **client 半侧**（M2.5 · W7）。
 *
 * ---- 这个文件为什么存在 ----
 *
 * 交接文档把 W7 记成「M2-5 的 UI 半侧从未在界面上点过」。我读代码后发现
 * 问题比"没点过"更严重 —— **功能根本没接通**：
 *
 *   1. `MainPage` 声明了 `onArchive` / `archiving` 两个 prop，
 *      但**两个调用点都没传**（`index.tsx` 的 `BoardPage`、`session-tab.tsx` 的页签）；
 *   2. client 侧**根本没有还原的调用** —— `api.ts` 里只有 `ROUTES.restore` 常量，
 *      没有任何地方真的 POST 它。
 *
 * 后果：点「归档选中的 N 份」会**什么都不发生**（`onArchive?.()` 的可选链把它吞掉），
 * 且**不报错**。那正是本项目最忌讳的症状。
 *
 * 我第一次用产物级渲染验证这件事时，`MainPage` 收到的 `onArchive` 是 `undefined` ——
 * 见 `_m23/verify-built-graveyard.mjs`。
 *
 * ---- 为什么这些断言在 `.js` 里而不是渲染测试 ----
 *
 * 组件是 `.tsx`，Node 的类型剥离**不处理 JSX**（`ERR_UNKNOWN_FILE_EXTENSION`）。
 * 所以能进单测的只有两件事：
 *   - **纯逻辑层**（`normalizeGraveyardResult` 这类，真跑）；
 *   - **接线层**（静态断言"调用点真的把 handler 传下去了"）。
 * 这与本轮修跨会话泄漏时用的是同一套办法。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  ROUTES,
  normalizeGraveyardResult,
  postArchive,
  postRestore,
} from '../src/client/api.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_SRC = join(HERE, '..', 'src', 'client')

/** 读源码并**剥掉注释**（注释里故意引用了错法，不该让断言误红）。 */
function codeOf(path) {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/** 一个记录请求的 fetch 桩。 */
function fakeFetch(response) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    return response
  }
  return { calls, impl }
}

// ---------------------------------------------------------------- 1. 形状规范化

test('normalizeGraveyardResult：**三个数组永远存在**（缺了会让 UI 炸在 undefined.length）', () => {
  // 这是 M2.1 踩过的坑：host 的两处早退（"不是 DDD 项目" / "路由未装配"）
  // 历史上曾经不带数组，UI 直接读 .length 就白屏。
  const cases = [
    undefined, null, {}, { ok: true }, { ok: false, error: 'x' }, 'not-an-object', 42,
  ]
  for (const input of cases) {
    const result = normalizeGraveyardResult(input)
    assert.equal(Array.isArray(result.moved), true, `输入 ${JSON.stringify(input)} 的 moved 不是数组`)
    assert.equal(Array.isArray(result.failed), true, `输入 ${JSON.stringify(input)} 的 failed 不是数组`)
  }
})

test('normalizeGraveyardResult：`ok` 只认 === true（字符串 "true" 不算成功）', () => {
  assert.equal(normalizeGraveyardResult({ ok: true }).ok, true)
  assert.equal(normalizeGraveyardResult({ ok: 'true' }).ok, false, '字符串 "true" 被当成了成功')
  assert.equal(normalizeGraveyardResult({ ok: 1 }).ok, false, '1 被当成了成功')
  assert.equal(normalizeGraveyardResult(undefined).ok, false)
})

test('normalizeGraveyardResult：正常的 host 响应原样保留', () => {
  const result = normalizeGraveyardResult({
    ok: true,
    moved: [{ from: 'docs/a.md', to: 'docs/_graveyard/a.md' }],
    failed: [{ path: 'docs/b.md', error: '不是 void' }],
  })
  assert.deepEqual(result.moved, [{ from: 'docs/a.md', to: 'docs/_graveyard/a.md' }])
  assert.deepEqual(result.failed, [{ path: 'docs/b.md', error: '不是 void' }])
})

// ---------------------------------------------------------------- 2. 请求形状

test('**postArchive：真的 POST 到 archive 路由**，且 body 带 ids', async () => {
  const { calls, impl } = fakeFetch({ ok: true, json: async () => ({ ok: true, moved: [], failed: [] }) })
  const original = globalThis.fetch
  try {
    globalThis.fetch = impl
    const result = await postArchive(['old-plan'], { sessionId: 's1', cwd: 'C:/proj' })
    assert.equal(result.ok, true)
    assert.equal(calls.length, 1, '没有发出请求')
    assert.equal(calls[0].url, ROUTES.archive)
    assert.equal(calls[0].init.method, 'POST')
    const body = JSON.parse(calls[0].init.body)
    assert.deepEqual(body.ids, ['old-plan'])
    assert.equal(body.sessionId, 's1')
    assert.equal(body.cwd, 'C:/proj')
  } finally {
    globalThis.fetch = original
  }
})

test('**postRestore：真的 POST 到 restore 路由**，且 body 带 paths', async () => {
  // 这条守的是"还原根本没有调用"那个缺陷：`ROUTES.restore` 一直存在，
  // 但没有任何地方真的 POST 它。
  const { calls, impl } = fakeFetch({ ok: true, json: async () => ({ ok: true, moved: [], failed: [] }) })
  const original = globalThis.fetch
  try {
    globalThis.fetch = impl
    const result = await postRestore(['docs/_graveyard/gone.md'], { sessionId: 's1' })
    assert.equal(result.ok, true)
    assert.equal(calls.length, 1, '还原没有发出请求 —— 正是 W7 暴露的缺陷')
    assert.equal(calls[0].url, ROUTES.restore)
    assert.equal(calls[0].init.method, 'POST')
    assert.deepEqual(JSON.parse(calls[0].init.body).paths, ['docs/_graveyard/gone.md'])
  } finally {
    globalThis.fetch = original
  }
})

test('**空列表不发请求**（否则会得到"成功但什么都没做"，UI 还会闪一下）', async () => {
  const { calls, impl } = fakeFetch({ ok: true, json: async () => ({ ok: true }) })
  const original = globalThis.fetch
  try {
    globalThis.fetch = impl
    const empty = await postArchive([], { sessionId: 's1' })
    assert.equal(empty.ok, false)
    assert.match(empty.error, /没有选中/)
    assert.equal(calls.length, 0, '空列表竟然发了请求')

    // 全是空串 / 非字符串，同样不发。
    const junk = await postArchive(['', null, 42], { sessionId: 's1' })
    assert.equal(junk.ok, false)
    assert.equal(calls.length, 0, '垃圾输入竟然发了请求')
  } finally {
    globalThis.fetch = original
  }
})

// ---------------------------------------------------------------- 3. 失败路径

test('**非 2xx → 显式失败，不抛**（且带一句人话）', async () => {
  const { impl } = fakeFetch({ ok: false, status: 500, json: async () => ({}) })
  const original = globalThis.fetch
  try {
    globalThis.fetch = impl
    const result = await postArchive(['a'], {})
    assert.equal(result.ok, false)
    assert.match(result.error, /HTTP 500/)
    assert.equal(Array.isArray(result.moved), true, '失败时形状也必须合法')
    assert.equal(Array.isArray(result.failed), true)
  } finally {
    globalThis.fetch = original
  }
})

test('**网络抛错 → 显式失败，不抛**', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () => { throw new Error('boom') }
    const result = await postRestore(['docs/_graveyard/x.md'], {})
    assert.equal(result.ok, false)
    assert.match(result.error, /boom/)
  } finally {
    globalThis.fetch = original
  }
})

test('**JSON 解析失败 → 显式失败，不抛**', async () => {
  const { impl } = fakeFetch({ ok: true, json: async () => { throw new Error('bad json') } })
  const original = globalThis.fetch
  try {
    globalThis.fetch = impl
    const result = await postArchive(['a'], {})
    assert.equal(result.ok, false)
    assert.match(result.error, /bad json/)
  } finally {
    globalThis.fetch = original
  }
})

// ---------------------------------------------------------------- 4. 接线（静态）

test('**两个调用点都必须把 onArchive 传给 MainPage**（W7 的核心缺陷）', () => {
  // 这是本轮 W7 发现的真缺陷：`MainPage` 有 onArchive prop，但没人传。
  // 后果是点「归档选中的 N 份」什么都不发生，且不报错。
  //
  // 产物级验证也证明过：渲染时 MainPage 收到的 onArchive 是 undefined
  // （`node _m23/verify-built-graveyard.mjs`）。
  const index = codeOf(join(CLIENT_SRC, 'index.tsx'))
  const tab = codeOf(join(CLIENT_SRC, 'session-tab.tsx'))

  // 主栏（BoardPage）
  const boardCall = /h\(MainPage, \{([\s\S]*?)\}\)/.exec(index)
  assert.ok(boardCall !== null, '找不到 BoardPage 里的 MainPage 调用')
  assert.match(boardCall[1], /onArchive/, '主栏的 MainPage 没传 onArchive —— 点归档不会有任何反应')

  // 会话页签
  const tabCall = /h\(MainPage, \{([\s\S]*?)\}\)/.exec(tab)
  assert.ok(tabCall !== null, '找不到页签里的 MainPage 调用')
  assert.match(tabCall[1], /onArchive/, '页签的 MainPage 没传 onArchive —— 点归档不会有任何反应')
})

test('**必须存在还原入口**（否则坟场里的文件只能靠手改磁盘）', () => {
  const main = codeOf(join(CLIENT_SRC, 'main-page.tsx'))
  assert.match(main, /onRestore/, 'GraveyardTab 没有 onRestore —— 还原功能在界面上不存在')
  // 「已在坟场」那一区必须每条都有还原按钮，而不是只显示路径。
  //
  // ⚠️ 不要用「从 `已在坟场` 匹配到 `: null`」那种区间正则：第一版就是那么写的，
  // 结果因为中间有多层括号（`h('div', ..., map(...))`）而匹配不到 ——
  // 那是**测试写错了**，不是实现错了。改成定位 `snapshot.graveyard.map(...)` 这一段。
  const block = /snapshot\.graveyard\.map\(([\s\S]*?)\n\s*\)\)\)/.exec(main)
  assert.ok(block !== null, '找不到「已在坟场」的 map 区块')
  assert.match(block[1], /还原/, '「已在坟场」的条目上没有还原操作')
  // 而且必须真的绑到 onRestore（只写个"还原"字样的 span 不算）。
  assert.match(block[1], /onRestore/, '还原按钮没有绑 onRestore')
  assert.match(block[1], /item\.path/, '还原必须传坟场里的路径（不是 id —— 坟场文件已不在注册表里）')
})

test('**还原按钮必须调 postRestore**（api 层函数真的被用上）', () => {
  const index = codeOf(join(CLIENT_SRC, 'index.tsx'))
  assert.match(index, /postRestore/, 'index.tsx 没有调用 postRestore —— 还原请求永远不会发出')
  assert.match(index, /postArchive/, 'index.tsx 没有调用 postArchive —— 归档请求永远不会发出')
})

test('归档/还原都必须**真的刷新快照**（否则点完界面还是旧的）', () => {
  const index = codeOf(join(CLIENT_SRC, 'index.tsx'))
  // 归档后不刷新 = 用户以为没生效，会再点一次（而第二次会因"坟场已有同名"失败）。
  //
  // 实现是 `runGraveyardAction` 这个共用执行器（不是 `useCallback` 的 archive）——
  // 第一版测试写死找 `const archive = useCallback(...)`，那是**测试跟着实现走**，
  // 实现一改名字就误红。改成钉"执行器里必须有刷新"。
  const runner = /const runGraveyardAction = async \(([\s\S]*?)\n  \}/.exec(index)
  assert.ok(runner !== null, '找不到 runGraveyardAction 执行器')
  assert.match(runner[1], /await load\(\)|refresh|recheck/, '归档/还原之后没有刷新快照')
  // 部分成功时也必须刷（不是只在全成功时刷）。
  assert.match(runner[1], /finally/, '没有 finally —— 请求抛错时 busy 会永远卡住')
})

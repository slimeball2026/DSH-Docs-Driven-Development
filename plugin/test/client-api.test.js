/**
 * `src/client/api.ts` 的单测（SPEC §8.1 要求 ≥ 5 条：200 / 404 / 超时 / 坏 JSON / 降级）。
 *
 * ---- 为什么纯前端的取数层值得单测 ----
 *
 * 因为它的失败模式**全是静默的**：
 * - 缺 `sessionId` → `gate.read` 变 0，**不报错**，看板显示"全都未读"；
 * - 超时没处理 → 永远停在 loading，**看起来像"正在加载"**；
 * - 坏 JSON 没兜住 → 抛到 React 里，白屏；
 * - `over` 写成 `overflow` → 看板永远不报警。
 *
 * 这四条都不会在"点了没崩"的测试里暴露。所以要逐条钉。
 *
 * ---- 这里怎么伪造 `fetch` ----
 *
 * `api.ts` 用的是全局 `fetch`，所以测试里替换 `globalThis.fetch` 即可 ——
 * 不需要引入 jsdom / msw 之类的依赖（本包零测试依赖）。
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import { fetchSnapshot, indexUrl, previewAddressOf, ROUTES } from '../src/client/api.ts'

/** 原始 fetch（用完恢复）。 */
const REAL_FETCH = globalThis.fetch

/**
 * 装一个假 fetch。
 *
 * ⚠️ **本文件是 `.js`，不许写任何 TS 类型注解**。
 * Node 的类型剥离只对 `.ts` 生效；`.js` 里的 `handler: (url: string) => unknown`
 * 会直接 `SyntaxError: Unexpected token ':'`（我第一版就写了，测试整份加载失败）。
 * 类型检查留给 `tsc --noEmit`（它读 `src/` 与 `server/`，不读 `test/`）。
 */
function stubFetch(handler) {
  globalThis.fetch = async (url, init) => handler(String(url), init)
}

afterEach(() => { globalThis.fetch = REAL_FETCH })

/** 造一个最小的合法快照。 */
function snapshotOf(overrides = {}) {
  return {
    ok: true,
    version: 1,
    projectRoot: 'C:\\proj',
    sessionId: 'session-abc123',
    generatedAt: 1794490792206,
    gate: { read: 2, required: 3, ready: false },
    project: '项目简介',
    slice: 'M2',
    nextStep: '',
    basisDoc: null,
    budget: { required: 7, tokens: 51900, limit: 30000, over: true, overBy: 21900 },
    required: [],
    all: [],
    forbidden: [],
    anomalies: [],
    deliverables: [],
    graveyardCandidates: [],
    graveyard: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------- 1. URL 与参数

test('api：路由路径与 host 侧逐字一致（改一处两边就不同步）', () => {
  assert.equal(ROUTES.index, '/api/ddd/index')
  assert.equal(ROUTES.archive, '/api/ddd/archive')
  assert.equal(ROUTES.restore, '/api/ddd/restore')
  assert.equal(ROUTES.ping, '/api/ddd/ping')
})

test('**api：indexUrl 必须同时带 cwd 与 sessionId**（缺 sessionId 会让 gate.read 静默错）', () => {
  const url = indexUrl('C:\\proj', 'session-abc123')
  assert.ok(url.includes('cwd='), url)
  assert.ok(url.includes('sessionId=session-abc123'), url)
  // 路径里的反斜杠必须被转义，否则查询串会被截断
  assert.ok(!url.includes('C:\\proj'), 'cwd 没有编码')
})

test('api：空值不进查询串（不产生 `cwd=` 这种空参数）', () => {
  const url = indexUrl('', '')
  assert.equal(url, `${ROUTES.index}?`)
  assert.ok(!url.includes('sessionId'))
})

// ---------------------------------------------------------------- 2. 200 / 正常

test('api：200 + 合法快照 → ok', async () => {
  stubFetch(async () => new Response(JSON.stringify(snapshotOf()), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))
  const result = await fetchSnapshot('C:\\proj', 'session-abc123')
  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  assert.equal(result.data.gate.read, 2)
  assert.equal(result.data.gate.required, 3)
  // ⚠️ 字段名必须是 over（SPEC §4.2 订正 1）
  assert.equal(result.data.budget?.over, true)
  assert.equal('overflow' in (result.data.budget ?? {}), false, 'budget 里出现了 overflow')
})

// ---------------------------------------------------------------- 3. 404 / 401 / 500

test('**api：404 → 错误态且提示"路由不存在"**（不许白屏）', async () => {
  stubFetch(async () => new Response('not found', { status: 404 }))
  const result = await fetchSnapshot('C:\\proj', 'session-abc123')
  assert.equal(result.kind, 'error')
  if (result.kind !== 'error') return
  assert.ok(result.message.includes('404'), result.message)
  assert.ok(result.message.includes('路由不存在'), `没有给出可诊断的提示：${result.message}`)
})

test('**api：401 → 提示"要在 DSH 自己的界面里访问"**（认证是宿主的事，不是我们的 bug）', async () => {
  stubFetch(async () => new Response('unauthorized', { status: 401 }))
  const result = await fetchSnapshot('C:\\proj', 'session-abc123')
  assert.equal(result.kind, 'error')
  if (result.kind !== 'error') return
  assert.ok(result.message.includes('401'), result.message)
  assert.ok(result.message.includes('认证'), `没有说清是认证问题：${result.message}`)
})

test('api：500 → 错误态（host 侧处理失败）', async () => {
  stubFetch(async () => new Response('boom', { status: 500 }))
  const result = await fetchSnapshot('C:\\proj', 'session-abc123')
  assert.equal(result.kind, 'error')
  if (result.kind !== 'error') return
  assert.ok(result.message.includes('500'))
})

// ---------------------------------------------------------------- 4. 坏 JSON / 空响应 / 形状不对

test('**api：坏 JSON → 错误态，不抛**（抛出去会白屏）', async () => {
  stubFetch(async () => new Response('{不是 JSON', { status: 200 }))
  const result = await fetchSnapshot('C:\\proj', 'session-abc123')
  assert.equal(result.kind, 'error')
  if (result.kind !== 'error') return
  assert.ok(result.message.includes('不是 JSON'), result.message)
})

test('**api：空响应 → 明确说"host 处理失败"**（不许把它当成空数据）', async () => {
  stubFetch(async () => new Response('', { status: 200 }))
  const result = await fetchSnapshot('C:\\proj', 'session-abc123')
  assert.equal(result.kind, 'error')
  if (result.kind !== 'error') return
  assert.ok(result.message.includes('空响应'), result.message)
})

test('**api：形状不对（缺 ok:true）→ 错误态**（不能把任何 JSON 都当快照）', async () => {
  stubFetch(async () => new Response(JSON.stringify({ gate: {} }), { status: 200 }))
  const result = await fetchSnapshot('C:\\proj', 'session-abc123')
  assert.equal(result.kind, 'error')
  if (result.kind !== 'error') return
  assert.ok(result.message.includes('形状'), result.message)
})

// ---------------------------------------------------------------- 5. 超时

test('**api：超时 → 错误态，且提示可以重试**（否则永远停在 loading）', async () => {
  stubFetch(async (_url, init) => {
    // 永不 resolve，等到被 abort：这模拟"host 卡住"。
    return await new Promise((_resolve, reject) => {
      const signal = init?.signal
      signal?.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })
  })
  const result = await fetchSnapshot('C:\\proj', 'session-abc123', 30)
  assert.equal(result.kind, 'error')
  if (result.kind !== 'error') return
  assert.ok(result.message.includes('超时'), result.message)
  assert.ok(result.message.includes('重试'), result.message)
})

test('api：网络错误（fetch 抛）→ 错误态，不抛', async () => {
  stubFetch(async () => { throw new TypeError('Failed to fetch') })
  const result = await fetchSnapshot('C:\\proj', 'session-abc123')
  assert.equal(result.kind, 'error')
  if (result.kind !== 'error') return
  assert.ok(result.message.includes('请求失败'), result.message)
})

// ---------------------------------------------------------------- 6. 预览地址（M2-B）

test('**api：预览地址必须是 session scope**（documentpreview 只接 session 地址）', () => {
  const address = previewAddressOf('session-abc123', 'docs/00. 阅读顺序.md')
  assert.ok(address.startsWith('dsh-resource://file/session/'), address)
  assert.ok(address.includes('session-abc123'), address)
  // 裸绝对路径不是合法地址（会被 liveshare 抢走渲染成 unavailable）
  assert.ok(!address.startsWith('dsh-resource://file/C:'), '用了绝对路径形态')
})

test('api：预览地址逐段编码，但保留 `/`（否则路径层级丢失）', () => {
  const address = previewAddressOf('session-abc123', 'docs/00. 阅读顺序.md')
  const tail = address.slice('dsh-resource://file/session/session-abc123/'.length)
  assert.ok(tail.startsWith('docs/'), `路径层级丢了：${tail}`)
  // 文件名里的空格与中文必须编码
  assert.ok(!tail.includes(' '), `空格没有编码：${tail}`)
  assert.ok(tail.includes('%'), `中文没有编码：${tail}`)
})

test('api：预览地址把 Windows 反斜杠统一成 `/`', () => {
  const address = previewAddressOf('session-abc123', 'docs\\sub\\x.md')
  assert.ok(address.endsWith('/docs/sub/x.md'), address)
})

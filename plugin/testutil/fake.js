/**
 * 测试共享：**宿主无损 JSON 断言**（v0.3.4 事故的回归）。
 *
 * 为什么放在 `testutil/` 而不是 `test/`：
 * `node --test --test-isolation=none` 会把 `test/` 下**所有** `.js` 当测试文件执行
 * （实测：放一个只有 console.log 的文件进去，tests 计数从 307 变 309）。
 * 辅助模块放进 `test/` 会被当成空测试文件跑，污染计数、也让 `test/` 目录不再"一个文件一组测试"。
 * `testutil/` 不在发现范围内（实测仍是 307）。
 *
 * 断言规则**照抄宿主**（`dsh-tools/lib/shared-*.js` 的 `isJsonValue` / `snapshotJsonValue`）：
 * - 只允许 null / string / boolean / 有限数字 / 普通数组 / 普通对象
 * - **不允许 undefined / 函数 / Symbol / BigInt / 类实例 / 循环引用 / 数组空槽**
 *
 * 这不是"我们的偏好"，是宿主写 `request/header` 时的硬约束：
 * 一个 `undefined` 会让整轮请求失败，而症状是"这一轮没有回复"，极难定位。
 */

import assert from 'node:assert/strict'

/**
 * 递归断言一个值能被宿主无损序列化。
 *
 * @param {unknown} value 待检查的值
 * @param {string} [path] 报错路径
 * @param {Set<object>} [seen] 循环检测
 */
export function assertLosslessJson(value, path = 'value', seen = new Set()) {
  if (value === null) return
  const type = typeof value

  if (type === 'string' || type === 'boolean') return
  if (type === 'number') {
    assert.ok(Number.isFinite(value), `${path} 不是有限数字：${String(value)}`)
    return
  }
  assert.notEqual(type, 'undefined', `${path} 是 undefined —— 宿主写 request/header 会失败`)
  assert.notEqual(type, 'function', `${path} 是函数 —— 不是 JSON 值`)
  assert.notEqual(type, 'symbol', `${path} 是 Symbol —— 不是 JSON 值`)
  assert.notEqual(type, 'bigint', `${path} 是 BigInt —— 不是 JSON 值`)
  assert.equal(type, 'object', `${path} 不是 JSON 值（${type}）`)

  assert.ok(!seen.has(value), `${path} 出现循环引用`)
  seen.add(value)

  if (Array.isArray(value)) {
    assert.equal(Object.getPrototypeOf(value), Array.prototype, `${path} 不是普通数组`)
    assert.equal(Reflect.ownKeys(value).length, value.length + 1, `${path} 有额外属性或空槽`)
    for (let index = 0; index < value.length; index += 1) {
      assert.ok(Object.hasOwn(value, index), `${path}[${index}] 是空槽`)
      assertLosslessJson(value[index], `${path}[${index}]`, seen)
    }
  } else {
    assert.equal(Object.getPrototypeOf(value), Object.prototype, `${path} 不是 plain object`)
    for (const key of Object.keys(value)) {
      assertLosslessJson(value[key], `${path}.${key}`, seen)
    }
  }

  seen.delete(value)
}

/**
 * 断言一棵对象树里**任何位置**都不出现 `undefined`（比 `assertLosslessJson` 更直白，
 * 报错信息也更贴近 v0.3.4 事故的叙述）。
 *
 * @param {unknown} value
 * @param {string} [path]
 */
export function assertNoUndefined(value, path = 'value') {
  if (value === undefined) {
    assert.fail(`${path} 是 undefined —— 宿主写 request/header 时会失败（v0.3.4 事故）`)
  }
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUndefined(item, `${path}[${index}]`))
    return
  }
  for (const [key, item] of Object.entries(value)) assertNoUndefined(item, `${path}.${key}`)
}

/**
 * 造一份最小的假 `ctx`，够 `apply()` 装配用。
 *
 * 与 `_ref/smoke-ddd.mjs` 的 `fakeCtx()` 是**同一套思路**，但这里只做单测需要的最小面：
 * 单测关心的是「注册了什么、参数对不对」，不关心完整时序。
 *
 * @param {object} [options]
 * @param {(def: object, opts: object) => void} [options.onRegister] 记录工具注册
 * @returns {object}
 */
export function fakeToolCtx(options = {}) {
  const registrations = []
  const guards = []
  const contexts = []
  const listeners = new Map()
  const effects = []
  const logs = []

  const ctx = {
    registrations,
    guards,
    contexts,
    listeners,
    effects,
    logs,
    logger: {
      debug: (message) => logs.push({ level: 'debug', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
      info: (message) => logs.push({ level: 'info', message }),
    },
    tools: {
      register: (definition, registerOptions) => {
        registrations.push({ definition, options: registerOptions })
        if (typeof options.onRegister === 'function') options.onRegister(definition, registerOptions)
        return () => {}
      },
      guard: (fn) => { guards.push(fn); return () => {} },
    },
    systemPrompt: {
      context: (spec) => { contexts.push(spec); return () => {} },
      section: () => { throw new Error('不应该用 section()') },
    },
    on: (event, handler) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {}
    },
    effect: (fn) => {
      const disposer = typeof fn === 'function' ? fn() : undefined
      effects.push(disposer)
      return () => {}
    },
    get: () => undefined,
  }
  return ctx
}

/**
 * 造一份合法 frontmatter 的文档文本。
 *
 * @param {string} id
 * @param {object} [extra] 覆盖或追加字段（值按 YAML 子集写法序列化）
 * @param {string} [body] 正文
 * @returns {string}
 */
export function docText(id, extra = {}, body) {
  const fields = {
    id,
    title: extra.title ?? `${id} 的标题`,
    role: extra.role ?? 'spec',
    order: extra.order ?? 20,
    status: extra.status ?? 'authoritative',
    summary: extra.summary ?? `${id} 的摘要`,
    basis: extra.basis ?? '实测',
    ...extra,
  }
  const lines = ['---']
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    lines.push(`${key}: ${yamlValue(value)}`)
  }
  lines.push('---', '')
  lines.push(body === undefined ? `# ${id}` : body)
  return lines.join('\n')
}

/**
 * 把 JS 值写成插件解析器认得的 YAML 子集形态。
 * @param {unknown} value
 * @returns {string}
 */
export function yamlValue(value) {
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'string' && /^[A-Za-z0-9_\-.#/]+$/.test(item))) {
      return `[${value.join(', ')}]`
    }
    return JSON.stringify(value)
  }
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') {
    // 含冒号 / 引号 / 反引号 / 中文标点都直接引起来，避免解析歧义。
    return /^[A-Za-z0-9_\-.]+$/.test(value) ? value : JSON.stringify(value)
  }
  return JSON.stringify(value)
}

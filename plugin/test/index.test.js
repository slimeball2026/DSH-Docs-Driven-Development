/**
 * `core/index.js` 的单测：required / forbidden / anomalies 的划分（SPEC §12.1）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { anomalyLine, buildIndex, isExecutable, requiredNotRead } from '../core/index.js'

/** 造一条注册表条目。 */
function entry(meta, overrides = {}) {
  return {
    path: `docs/${meta?.id ?? 'unknown'}.md`,
    meta,
    issues: [],
    hasError: false,
    fingerprint: 'abcdef123456',
    ...overrides,
  }
}

/** 合法元数据。 */
function good(overrides = {}) {
  return {
    id: 'spec-tier2',
    title: '档 2 施工图',
    role: 'spec',
    order: 20,
    status: 'authoritative',
    summary: '档 2 的全部功能切片',
    basis: '实测',
    ...overrides,
  }
}

test('isExecutable：只有 authoritative / partial 可执行', () => {
  assert.equal(isExecutable('authoritative'), true)
  assert.equal(isExecutable('partial'), true)
  for (const status of ['superseded', 'sealed', 'void', 'draft']) {
    assert.equal(isExecutable(status), false, `${status} 不该可执行`)
  }
})

test('authoritative 进必读清单', () => {
  const result = buildIndex([entry(good())])
  assert.equal(result.required.length, 1)
  assert.equal(result.forbidden.length, 0)
  assert.equal(result.anomalies.length, 0)
})

test('partial 进必读清单（限 scope 执行）', () => {
  const result = buildIndex([entry(good({ status: 'partial', scope: ['tier2'] }))])
  assert.equal(result.required.length, 1)
})

test('sealed 进禁止清单，**不进**必读、**不进**异常（M0-10）', () => {
  const result = buildIndex([entry(good({ status: 'sealed' }))])
  assert.equal(result.required.length, 0)
  assert.equal(result.forbidden.length, 1)
  assert.equal(result.anomalies.length, 0)
})

test('superseded / void / draft 三份都不进（不可执行但也无异常）', () => {
  const result = buildIndex([
    entry(good({ id: 'a', status: 'superseded', supersededBy: ['b'] })),
    entry(good({ id: 'b', status: 'void' })),
    entry(good({ id: 'c', status: 'draft' })),
  ])
  assert.equal(result.required.length, 0)
  assert.equal(result.forbidden.length, 0)
  assert.equal(result.anomalies.length, 0)
  // 但仍然能按 id 查到（门禁要用）。
  assert.equal(result.byId.size, 3)
})

test('有 error 的文档只进 anomalies，不进必读（M0-7）', () => {
  const bad = entry(good({ id: 'decision-log' }), {
    hasError: true,
    issues: [{ rule: 'V1', level: 'error', message: '缺少 role 字段' }],
  })
  const result = buildIndex([bad])
  assert.equal(result.required.length, 0)
  assert.equal(result.anomalies.length, 1)
})

test('meta 为 null（解析失败）也进 anomalies', () => {
  const result = buildIndex([entry(null, { hasError: true })])
  assert.equal(result.anomalies.length, 1)
})

test('有 error 的 sealed 文档进 anomalies 而不是 forbidden（error 优先）', () => {
  const bad = entry(good({ status: 'sealed' }), { hasError: true })
  const result = buildIndex([bad])
  assert.equal(result.forbidden.length, 0)
  assert.equal(result.anomalies.length, 1)
})

test('required 按 order 升序，再按 id（渲染稳定 → KV 缓存友好）', () => {
  const result = buildIndex([
    entry(good({ id: 'z-last', order: 30 })),
    entry(good({ id: 'a-first', order: 10 })),
    entry(good({ id: 'm-mid', order: 20 })),
  ])
  assert.deepEqual(result.required.map((item) => item.meta.id), ['a-first', 'm-mid', 'z-last'])
})

test('order 相同时按 id 字典序', () => {
  const result = buildIndex([
    entry(good({ id: 'bbb', order: 10 })),
    entry(good({ id: 'aaa', order: 10 })),
  ])
  assert.deepEqual(result.required.map((item) => item.meta.id), ['aaa', 'bbb'])
})

test('byId 索引可用（门禁要按 id 反查元数据）', () => {
  const result = buildIndex([entry(good({ id: 'x' }))])
  assert.equal(result.byId.get('x').meta.id, 'x')
})

test('空输入 / 非数组 / 夹杂 null 都不抛', () => {
  assert.deepEqual(buildIndex([]).required, [])
  assert.deepEqual(buildIndex(null).required, [])
  assert.deepEqual(buildIndex('nope').required, [])
  assert.equal(buildIndex([null, undefined, 1]).required.length, 0)
})

// ---------------------------------------------------------------- requiredNotRead

test('requiredNotRead：没读过的都算缺', () => {
  const { required } = buildIndex([entry(good({ id: 'a' })), entry(good({ id: 'b' }))])
  const missing = requiredNotRead(required, new Map())
  assert.deepEqual(missing.map((item) => item.meta.id), ['a', 'b'])
})

test('requiredNotRead：读过的且指纹一致就不算缺', () => {
  const { required } = buildIndex([entry(good({ id: 'a' }), { fingerprint: 'aaa111' })])
  const readSet = new Map([['a', { fingerprint: 'aaa111' }]])
  assert.deepEqual(requiredNotRead(required, readSet, () => 'aaa111'), [])
})

test('requiredNotRead：**指纹变了视为未读**（M0-8）', () => {
  const { required } = buildIndex([entry(good({ id: 'a' }), { fingerprint: 'bbb222' })])
  const readSet = new Map([['a', { fingerprint: 'aaa111' }]])
  const missing = requiredNotRead(required, readSet, () => 'bbb222')
  assert.deepEqual(missing.map((item) => item.meta.id), ['a'])
})

test('requiredNotRead：readSet 是普通对象也能用', () => {
  const { required } = buildIndex([entry(good({ id: 'a' }), { fingerprint: 'fff' })])
  assert.deepEqual(requiredNotRead(required, { a: { fingerprint: 'fff' } }, () => 'fff'), [])
})

// ---------------------------------------------------------------- anomalyLine

test('anomalyLine 取第一条 error 渲染成一行', () => {
  const line = anomalyLine({
    meta: { id: 'decision-log' },
    issues: [
      { rule: 'V2', level: 'warn', message: 'warn first' },
      { rule: 'V1', level: 'error', message: '缺少 role 字段' },
    ],
  })
  assert.equal(line, 'decision-log: 缺少 role 字段')
})

test('anomalyLine：没有 id 时退回路径', () => {
  const line = anomalyLine({ meta: null, path: 'docs/bad.md', issues: [] })
  assert.match(line, /bad\.md/)
})

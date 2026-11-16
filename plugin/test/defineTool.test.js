/**
 * `tools/define-tool.js` 的单测（M1 地基）。
 *
 * 这一组测试要挡住三类事故：
 *   1. **v0.3.4**：工具定义里出现 `undefined` → 宿主写 `request/header` 失败 → 整轮没有回复；
 *   2. **注册期 JsonSchemaError**：schema 用了宿主封闭子集之外的键（`pattern` / `minLength` …）
 *      → `ctx.tools.register()` 直接抛 → 4 个工具一起消失；
 *   3. **required 提升写错**：模型漏传必填参数却通过 schema 校验，然后在 execute 里炸。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertHostCompatible,
  compileParameters,
  compileValueSchema,
  defineTool,
} from '../tools/define-tool.js'
import { assertLosslessJson, assertNoUndefined } from '../testutil/fake.js'

/** 造一个最小可用工具，`extra` 覆盖任意字段。 */
function minimalTool(extra = {}) {
  return defineTool({
    name: 'demo_tool',
    description: '一个用来测 defineTool 的假工具。',
    parameters: {
      id: { type: 'string', required: true, description: '文档 id' },
      limit: { type: 'number' },
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean', required: true } },
      },
      render: () => [{ type: 'text', text: 'ok' }],
    },
    execute: async () => ({ ok: true }),
    ...extra,
  })
}

// ---------------------------------------------------------------- 1. 形状

test('产物形状：只有宿主认识的五个键（name/description/parameters/output/execute）', () => {
  const tool = minimalTool()
  assert.deepEqual(Object.keys(tool).sort(), ['description', 'execute', 'name', 'output', 'parameters'])
  assert.deepEqual(Object.keys(tool.output).sort(), ['render', 'schema'])
})

test('**产物里没有任何 undefined / function**（v0.3.4 回归）', () => {
  const tool = minimalTool()
  // parameters 与 output.schema 是会被宿主快照进 request/header 的两块。
  assertNoUndefined(tool.parameters, 'parameters')
  assertNoUndefined(tool.output.schema, 'output.schema')
  // 整份定义（除 execute/render 两个函数外）都必须是无损 JSON。
  assertLosslessJson({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    output: { schema: tool.output.schema },
  })
})

test('漏写 description → 直接抛（不是留一个 undefined 给宿主）', () => {
  assert.throws(() => minimalTool({ description: undefined }), /description 必须是非空字符串/)
  assert.throws(() => minimalTool({ description: '   ' }), /description 必须是非空字符串/)
})

test('漏写 output.render → 直接抛（宿主注册期强制要求）', () => {
  assert.throws(
    () => minimalTool({ output: { schema: { type: 'object', properties: {} } } }),
    /output\.render 必须是函数/,
  )
})

test('工具名 run_code 被拒（PTC 保留名）', () => {
  assert.throws(() => minimalTool({ name: 'run_code' }), /保留名/)
})

test('execute 收到 null / undefined 参数时兜成 {}', async () => {
  const tool = minimalTool({
    execute: async (args) => ({ ok: args !== null && typeof args === 'object' }),
  })
  assert.deepEqual(await tool.execute(null), { ok: true })
  assert.deepEqual(await tool.execute(undefined), { ok: true })
})

// ---------------------------------------------------------------- 2. required 提升

test('required 被提升到父级，且**不**留在子节点上', () => {
  const schema = compileParameters({
    a: { type: 'string', required: true },
    b: { type: 'number' },
    c: { type: 'boolean', required: true },
  })
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.required, ['a', 'c'])
  // 关键：子节点上不能残留 `required: true` —— 宿主的 schema 校验会把它当成非法键。
  assert.equal(Object.hasOwn(schema.properties.a, 'required'), false)
  assert.equal(Object.hasOwn(schema.properties.b, 'required'), false)
})

test('全部可选时**不生成** required 键（而不是空数组）', () => {
  const schema = compileParameters({ a: { type: 'string' } })
  assert.equal(Object.hasOwn(schema, 'required'), false)
})

test('required 只能写 true；写 false 直接抛', () => {
  assert.throws(() => compileParameters({ a: { type: 'string', required: false } }), /required 只能是 true/)
})

test('空参数表 → 合法的空 object schema', () => {
  assert.deepEqual(compileParameters(), { type: 'object', properties: {} })
})

// ---------------------------------------------------------------- 3. enum / 类型

test('enum 原样保留（不排序、不去重、不转字符串）', () => {
  const values = ['sealed', 'void', 'draft', 'authoritative']
  const schema = compileParameters({ status: { type: 'string', enum: values, required: true } })
  assert.deepEqual(schema.properties.status.enum, values)
  // 深拷贝：改产物不影响作者传进来的数组
  schema.properties.status.enum.push('x')
  assert.equal(values.length, 4)
})

test('enum 为空数组 → 抛（宿主也拒空 enum）', () => {
  assert.throws(() => compileParameters({ a: { type: 'string', enum: [] } }), /enum 必须是非空数组/)
})

test('支持的 7 种 type 都能编译；其它 type 抛', () => {
  for (const type of ['string', 'number', 'integer', 'boolean', 'null']) {
    assert.equal(compileValueSchema({ type }).type, type)
  }
  assert.equal(compileValueSchema({ type: 'array', items: { type: 'string' } }).items.type, 'string')
  assert.throws(() => compileValueSchema({ type: 'json' }), /type 必须是/)
  assert.throws(() => compileValueSchema({ type: 'date' }), /type 必须是/)
})

test('object 节点默认写 additionalProperties:false（参数封闭）', () => {
  const schema = compileValueSchema({ type: 'object', properties: { a: { type: 'string' } } })
  assert.equal(schema.additionalProperties, false)
})

test('嵌套 object / array 的 required 提升各归各层', () => {
  const schema = compileValueSchema({
    type: 'object',
    properties: {
      outer: {
        type: 'object',
        properties: {
          inner: { type: 'string', required: true },
          other: { type: 'number' },
        },
      },
    },
  })
  assert.equal(Object.hasOwn(schema, 'required'), false)
  assert.deepEqual(schema.properties.outer.required, ['inner'])
  assert.equal(Object.hasOwn(schema.properties.outer.properties.inner, 'required'), false)
})

// ---------------------------------------------------------------- 4. 宿主子集（注册期炸弹）

test('**用了宿主不支持的键 → 编译期就抛**（否则注册期 JsonSchemaError）', () => {
  assert.throws(() => compileValueSchema({ type: 'string', minLength: 3 }), /不是支持的字段/)
  assert.throws(() => compileValueSchema({ type: 'string', pattern: '^a' }), /不是支持的字段/)
  assert.throws(() => compileValueSchema({ type: 'number', minimum: 0 }), /不是支持的字段/)
  assert.throws(() => compileValueSchema({ type: 'array', minItems: 1 }), /不是支持的字段/)
})

test('assertHostCompatible：接受注解键，拒绝 undefined 值', () => {
  assertHostCompatible({ type: 'string', description: '说明', title: 'T', default: 'x', examples: ['a'] })
  assert.throws(() => assertHostCompatible({ type: 'string', description: undefined }), /是 undefined/)
})

test('assertHostCompatible：oneOf 需要至少两个分支且逐支检查', () => {
  assertHostCompatible({
    oneOf: [
      { type: 'object', properties: { a: { type: 'string' } } },
      { type: 'object', properties: { b: { type: 'number' } } },
    ],
  })
  assert.throws(() => assertHostCompatible({ oneOf: [{ type: 'string' }] }), /至少两个分支/)
})

test('oneOf 与 type 不能同时声明', () => {
  assert.throws(
    () => compileValueSchema({ type: 'string', oneOf: [{ type: 'string' }, { type: 'number' }] }),
    /不能同时声明 type 与 oneOf/,
  )
})

// ---------------------------------------------------------------- 5. 与宿主同构的对照

test('编译产物逐键落在宿主的 SCHEMA_TYPES / 键表内（手写对照表，防止宿主升级后静默漂移）', () => {
  const HOST_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
  const HOST_KEYS = [
    'type', 'oneOf', 'properties', 'required', 'additionalProperties',
    'items', 'enum', 'const', 'description', 'title', 'default', 'examples',
  ]
  const tool = minimalTool({
    parameters: {
      role: { type: 'string', enum: ['a', 'b'], required: true, description: '角色' },
      ids: { type: 'array', items: { type: 'string' } },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          issues: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                rule: { type: 'string', required: true },
                level: { type: 'string', enum: ['error', 'warn'] },
              },
            },
          },
        },
      },
      render: () => [],
    },
  })

  const walk = (node, path) => {
    for (const key of Object.keys(node)) {
      assert.ok(HOST_KEYS.includes(key), `${path}.${key} 不在宿主键表内`)
    }
    if (Object.hasOwn(node, 'type')) assert.ok(HOST_TYPES.includes(node.type), `${path}.type=${node.type}`)
    for (const [key, child] of Object.entries(node.properties ?? {})) walk(child, `${path}.properties.${key}`)
    if (node.items !== undefined) walk(node.items, `${path}.items`)
  }
  walk(tool.parameters, 'parameters')
  walk(tool.output.schema, 'output.schema')
})

// ---------------------------------------------------------------- 6. 渲染

test('render 被原样透传（参数与值都到达作者函数）', () => {
  let seen
  const tool = minimalTool({
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean', required: true } } },
      render: (args, value) => { seen = { args, value }; return [{ type: 'text', text: 'x' }] },
    },
  })
  tool.output.render({ id: 'a' }, { ok: true })
  assert.deepEqual(seen, { args: { id: 'a' }, value: { ok: true } })
})

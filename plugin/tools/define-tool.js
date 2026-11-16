/**
 * 本地工具定义助手 —— **不 import 任何 `@deepseek-ai/*`**（M1 的地基）。
 *
 * 为什么自己写（`test/decoupling.test.js` 强制）：profile 里装的 bundle 与 dsh 自己的包
 * **不在同一棵 node_modules 里**（dsh 的包装在 `app.asar` 内），所以想用宿主包
 * `@deepseek-ai/dsh-tools` 里的 `defineTool` 助手会 `ERR_MODULE_NOT_FOUND`，
 * 整行插件加载失败。M0 期间这条已经用测试钉死，M1 想用宿主 helper 就会撞上它。
 *
 * 本文件做两件事：
 *   1. 把「属性表 DSL」编译成**宿主直接接受的原始 JSON Schema**；
 *   2. 产出 `{ name, description, parameters, output, execute }` 的原始 `ToolDefinition`。
 *
 * ---- 宿主契约（反编译 `dsh-tools@0.2.2-rc.1` 确认，2026-11-11）----
 *
 * `ctx.tools.register(definition, { when })` 在**注册期**就校验两件事：
 *
 * ```js
 * assertSupportedJsonSchema(output.schema)                       // ①
 * if (output === void 0 || typeof output.render !== 'function') throw new TypeError(...)   // ②
 * ```
 *
 * ① 的封闭子集（`checkSchemaNode`）只允许这些键：
 *    `type` / `oneOf` / `properties` / `required` / `additionalProperties` / `items` / `enum` / `const`
 *    ＋ 四个注解键 `description` / `title` / `default` / `examples`。
 *    `type` 只能是 object / array / string / number / integer / boolean / null。
 *    传 `minLength` / `pattern` / `format` 之类会被 `JsonSchemaError` 拒掉 —— **注册期就炸**。
 *
 * ② 意味着 `output.render` **必须存在**。只有 schema 不够。
 *
 * 另外两条来自实测的事故记录（教练模式 v0.3.4）：
 *   - 宿主对工具 schema 做**无损 JSON 快照**，对象里只要有一个 `undefined`，
 *     整轮 `request/header` 写盘就失败（`carries non-JSON-serializable data`）。
 *     **所以本文件一律用「有值才写入」的写法，绝不写 `description: undefined`。**
 *   - `execute` 抛错会被宿主转成 `{isError:true, content:[{text:'Error: …'}]}`，
 *     **不会结束回合** —— 所以「拒绝」可以直接 throw，模型看得到原因并能改。
 *
 * ---- 为什么校验器比 coach-mode 的更严 ----
 *
 * coach-mode 的 `define-tool.js` 只做到「把属性表编译成 schema」。M1 多一层：
 * **编译完再自己跑一遍 `assertSupportedJsonSchema` 的等价检查**（本文件内的
 * `assertHostCompatible`）。理由：宿主是**注册期**校验，一旦写错，整个插件的
 * 4 个工具会一起注册失败——而症状是「工具不见了」，不是「这里写错了」。
 * 在单测里先炸一次，比在实机上排查「为什么模型看不到 doc_new」便宜得多。
 */

/** 宿主允许出现在 schema 节点上的**纯注解**键（`ANNOTATION_KEYWORDS`）。 */
const ANNOTATION_KEYS = Object.freeze(['description', 'title', 'default', 'examples'])

/** 宿主支持的 `type` 取值（`SCHEMA_TYPES`，封闭集合）。 */
const SCHEMA_TYPES = Object.freeze([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
])

/** 一个 schema 节点允许出现的**全部**键（宿主封闭子集）。 */
const NODE_KEYS = Object.freeze([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  ...ANNOTATION_KEYS,
])

/** 抛编译期错误（作者写错了，不是模型写错了）。 */
function authorError(message) {
  throw new Error(`工具 schema 不合法：${message}`)
}

/**
 * 复制注解字段。
 *
 * ⚠️ 只在 `Object.hasOwn` 时复制，**绝不复制 `undefined`**（v0.3.4 事故）。
 * 注意 `description: undefined` 与「没有这个键」在 `hasOwn` 上是不同的：
 * 前者会把自己复制过去，所以下面用 `value === undefined` 再挡一次。
 */
function copyAnnotations(source, target) {
  for (const key of ANNOTATION_KEYS) {
    if (!Object.hasOwn(source, key)) continue
    if (source[key] === undefined) continue
    target[key] = source[key]
  }
}

/** 拒绝声明之外的键（作者多写一个 `pattern` 就会被这里拦住）。 */
function assertAuthorKeys(source, path, allowed) {
  for (const key of Object.keys(source)) {
    if (allowed.includes(key)) continue
    authorError(`${path}.${key} 不是支持的字段（允许：${allowed.join(', ')}）`)
  }
}

/**
 * 编译一个值 schema 节点。
 *
 * @param {object} input 作者写的节点。
 * @param {string} path 报错用的路径。
 * @param {boolean} allowRequired 该位置是否允许 `required: true`（只有属性表里的元素允许）。
 * @returns {object} 原始 JSON Schema 节点（全是 JSON 值，无 undefined）。
 */
function compileValue(input, path, allowRequired) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    authorError(`${path} 必须是对象`)
  }
  // `required` 只允许出现在属性表的值上，且只能是 `true`（提升到父级的 required 数组）。
  if (Object.hasOwn(input, 'required') && input.required !== true) {
    authorError(`${path}.required 只能是 true（写成 true 会被提升到父级的 required 数组）`)
  }
  if (Object.hasOwn(input, 'required') && !allowRequired) {
    authorError(`${path} 这个位置不允许 required`)
  }

  const node = {}
  copyAnnotations(input, node)

  // ---- oneOf：宿主支持，但我们自己的 4 个工具用不到。
  // 保留它是因为「支持」和「用到」是两件事，砍掉会让将来的工具被迫绕路。
  if (Object.hasOwn(input, 'oneOf')) {
    // 冲突判定要**先于**键表检查：否则报错会变成「type 不是支持的字段」，
    // 把真正的问题（同时声明了两个互斥的判别器）藏起来。
    if (Object.hasOwn(input, 'type')) authorError(`${path} 不能同时声明 type 与 oneOf`)
    assertAuthorKeys(input, path, [...ANNOTATION_KEYS, 'oneOf', 'required'])
    if (!Array.isArray(input.oneOf) || input.oneOf.length < 2) {
      authorError(`${path}.oneOf 至少要有两个分支`)
    }
    node.oneOf = input.oneOf.map((branch, index) => compileValue(branch, `${path}.oneOf[${index}]`, false))
    return node
  }

  if (!Object.hasOwn(input, 'type')) authorError(`${path}.type 缺失（或改用 oneOf）`)
  const type = input.type
  if (!SCHEMA_TYPES.includes(type)) {
    authorError(`${path}.type 必须是 ${SCHEMA_TYPES.join('/')} 之一，收到：${String(type)}`)
  }

  switch (type) {
    case 'object': {
      assertAuthorKeys(input, path, [...ANNOTATION_KEYS, 'type', 'properties', 'additionalProperties', 'required'])
      node.type = 'object'
      // 宿主不强制要求写 additionalProperties，但**显式写出**能让模型少编参数。
      // 作者不写时默认 false（我们的工具都是"参数封闭"的）。
      const additional = Object.hasOwn(input, 'additionalProperties') ? input.additionalProperties : false
      if (typeof additional !== 'boolean') {
        authorError(`${path}.additionalProperties 必须是 true 或 false`)
      }
      node.additionalProperties = additional
      if (Object.hasOwn(input, 'properties')) {
        const compiled = compilePropertyMap(input.properties, `${path}.properties`)
        node.properties = compiled.properties
        if (compiled.required !== undefined) node.required = compiled.required
      }
      return node
    }

    case 'array': {
      assertAuthorKeys(input, path, [...ANNOTATION_KEYS, 'type', 'items', 'required'])
      node.type = 'array'
      if (Object.hasOwn(input, 'items')) {
        node.items = compileValue(input.items, `${path}.items`, false)
      }
      return node
    }

    default: {
      // string / number / integer / boolean / null
      assertAuthorKeys(input, path, [...ANNOTATION_KEYS, 'type', 'enum', 'const', 'required'])
      node.type = type
      if (Object.hasOwn(input, 'enum')) {
        if (!Array.isArray(input.enum) || input.enum.length === 0) {
          authorError(`${path}.enum 必须是非空数组`)
        }
        // **原样保留**：不排序、不去重、不转字符串（枚举是契约，不是展示）。
        node.enum = [...input.enum]
      }
      if (Object.hasOwn(input, 'const') && input.const !== undefined) node.const = input.const
      return node
    }
  }
}

/**
 * 编译一张属性表：把每个属性上的 `required: true` **提升**成父级的 `required` 数组。
 *
 * 这是整个 DSL 唯一"不直观"的地方，也是 `required` 提升最容易写错的地方
 * （写错的表现：模型漏传必填参数却通过了 schema 校验，然后在 execute 里炸）。
 *
 * @returns {{properties: object, required?: string[]}}
 */
function compilePropertyMap(input, path) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    authorError(`${path} 必须是"属性名 → schema"的对象`)
  }
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(input)) {
    if (value !== null && typeof value === 'object' && value.required === true) required.push(key)
    properties[key] = compileValue(value, `${path}.${key}`, true)
  }
  return required.length === 0 ? { properties } : { properties, required }
}

/**
 * 参数表 → 原始 JSON Schema（object 根）。
 *
 * @param {object} [spec] 形如 `{ 参数名: { type, required?: true, enum?, description? } }`。
 * @returns {object}
 */
export function compileParameters(spec) {
  const compiled = compilePropertyMap(spec === undefined ? {} : spec, 'parameters')
  // 根节点**不写 additionalProperties:false**：模型偶尔会多带一个参数，
  // 宿主的校验会把它判成 `isError`，整次调用就废了。多一个参数比多一次往返便宜。
  return {
    type: 'object',
    properties: compiled.properties,
    ...(compiled.required === undefined ? {} : { required: compiled.required }),
  }
}

/**
 * 输出 schema → 原始 JSON Schema。
 * @param {object} spec 值 schema 节点。
 * @returns {object}
 */
export function compileValueSchema(spec) {
  return compileValue(spec, 'schema', false)
}

/**
 * 断言一个已编译好的 schema 落在宿主支持的子集内。
 *
 * 与宿主的 `assertSupportedJsonSchema` **同构**（同样的键表、同样的类型表），
 * 但我们不 import 它（import 不到）。差别：我们**额外**拒绝 `undefined`，
 * 因为宿主的校验对 `undefined` 值是通过的（`hasOwn` 为 true、值不参与校验），
 * 而真正的炸弹在后面写 `request/header` 的时候。
 *
 * @param {unknown} node
 * @param {string} [path]
 */
export function assertHostCompatible(node, path = 'schema') {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    authorError(`${path} 必须是对象`)
  }
  for (const key of Object.keys(node)) {
    if (!NODE_KEYS.includes(key)) {
      authorError(`${path}.${key} 不在宿主支持的 schema 子集内（会 JsonSchemaError）`)
    }
    if (node[key] === undefined) {
      authorError(`${path}.${key} 是 undefined（宿主写 request/header 时会失败）`)
    }
  }
  if (typeof node.description === 'string' && node.description.trim() === '') {
    authorError(`${path}.description 是空串（模型看不到任何说明）`)
  }

  if (Object.hasOwn(node, 'oneOf')) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) authorError(`${path}.oneOf 至少两个分支`)
    node.oneOf.forEach((branch, index) => assertHostCompatible(branch, `${path}.oneOf[${index}]`))
    return
  }

  if (!Object.hasOwn(node, 'type')) return // 纯注解节点（宿主接受）
  if (!SCHEMA_TYPES.includes(node.type)) authorError(`${path}.type 不合法：${String(node.type)}`)

  if (node.type === 'object') {
    if (Object.hasOwn(node, 'properties')) {
      if (node.properties === null || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
        authorError(`${path}.properties 必须是对象`)
      }
      for (const [key, child] of Object.entries(node.properties)) {
        assertHostCompatible(child, `${path}.properties.${key}`)
      }
    }
    if (Object.hasOwn(node, 'required')) {
      if (!Array.isArray(node.required) || node.required.some((item) => typeof item !== 'string')) {
        authorError(`${path}.required 必须是字符串数组`)
      }
    }
    if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
      authorError(`${path}.additionalProperties 必须是布尔`)
    }
  }

  if (node.type === 'array' && Object.hasOwn(node, 'items')) {
    assertHostCompatible(node.items, `${path}.items`)
  }

  if (Object.hasOwn(node, 'enum')) {
    if (!Array.isArray(node.enum) || node.enum.length === 0) authorError(`${path}.enum 必须是非空数组`)
    if (node.enum.some((item) => item === undefined)) authorError(`${path}.enum 里有 undefined`)
  }
}

/**
 * 定义一个工具（产出宿主直接接受的原始 `ToolDefinition`）。
 *
 * @param {object} options
 * @param {string} options.name 工具名（模型可见）。
 * @param {string} options.description 工具说明（**必填且非空**：漏写会让 request/header 失败）。
 * @param {object} [options.parameters] 属性表 DSL。
 * @param {object} options.output
 * @param {object} options.output.schema 输出值 schema（object 根）。
 * @param {(args: object, value: object) => Array<object>} options.output.render 渲染成文本块。
 * @param {(args: object, exec: object) => Promise<object>|object} options.execute 工具主体。
 * @returns {object} `{ name, description, parameters, output: { schema, render }, execute }`
 */
export function defineTool(options) {
  if (options === null || typeof options !== 'object') authorError('defineTool 需要 options 对象')
  const { name, description, output } = options

  if (typeof name !== 'string' || name.trim() === '') authorError('name 必须是非空字符串')
  if (name === 'run_code') authorError('run_code 是宿主保留名（PTC 传输），不能注册')
  if (typeof description !== 'string' || description.trim() === '') {
    authorError(`${name}.description 必须是非空字符串（v0.3.4 事故：undefined 会让整轮失败）`)
  }
  if (output === null || typeof output !== 'object') authorError(`${name}.output 缺失`)
  if (typeof output.render !== 'function') {
    authorError(`${name}.output.render 必须是函数（宿主注册期强制要求）`)
  }
  if (output.schema === null || typeof output.schema !== 'object') {
    authorError(`${name}.output.schema 缺失`)
  }

  const parameters = compileParameters(options.parameters)
  const schema = compileValueSchema(output.schema)

  // 自检：与宿主同构的检查，**在单测里就炸**，而不是等到实机注册失败。
  assertHostCompatible(schema, `${name}.output.schema`)
  assertHostCompatible(parameters, `${name}.parameters`)

  const tool = {
    name,
    description,
    parameters,
    output: {
      schema,
      render: (args, value) => output.render(args, value),
    },
    async execute(args, exec) {
      // 模型可能一个参数都不传 → 宿主给 `{}`，但保险起见兜一下 null。
      return options.execute(args === null || args === undefined ? {} : args, exec)
    },
  }

  // 可选：Host 本地展示元数据（我们不用，但保留扩展点，且**只在有值时**写入）。
  if (typeof output.presentationMeta === 'function') {
    tool.output.presentationMeta = (args, value) => output.presentationMeta(args, value)
  }

  return tool
}

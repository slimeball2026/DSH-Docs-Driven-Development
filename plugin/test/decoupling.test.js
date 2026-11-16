/**
 * 解耦断言（SPEC §10.2 的五条硬约束，强制执行）。
 *
 * 事故记录（教练模式继承来的）：
 * `defineTool`（来自 `@deepseek-ai/dsh-tools`）与 `Config`（来自 `@deepseek-ai/schemastery`）
 * 让插件行在 profile 里 `ERR_MODULE_NOT_FOUND`，preset 直接显示「加载失败」。
 * 原因：dsh 自己的包在 `app.asar` 内，不在 profile 的任何祖先 `node_modules` 里。
 *
 * 实测（交接 §4.2 #6）：从 bundle 真实路径 `import('js-yaml')` / `yaml` / `zod`
 * 也全部 `ERR_MODULE_NOT_FOUND`。**所以只准用 `node:` 内置模块。**
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CORE_DIR = join(ROOT, 'core')

/**
 * 递归列出目录下的源码文件（`.js` 与 `.ts`；跳过 test / node_modules）。
 *
 * **M2 起要认 `.ts`**：`server/` 是 TypeScript（M2-Q5 的边界是
 * 「只新代码用 TS，`core/`/`adapters/`/`tools/` 维持 `.js`」）。
 * 修之前这个函数只认 `.js`，于是 `server/*.ts` **整个目录被静默跳过** ——
 * 那正好是 SPEC §5.3-3 要求"必须被检查"的目录。
 * 一条检查不到新代码的解耦断言，比没有断言更危险（它会给人虚假的安全感）。
 */
function jsFiles(dir) {
  const found = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return found
  }
  for (const name of entries) {
    if (name === 'node_modules') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      found.push(...jsFiles(full))
      continue
    }
    if (name.endsWith('.js') || name.endsWith('.ts')) found.push(full)
  }
  return found
}

/**
 * 剥掉注释，只留代码。
 *
 * 为什么必须剥：本仓库的注释里**故意**写着事故复现命令
 * （`import('js-yaml')` 会 `ERR_MODULE_NOT_FOUND`）。那是文档，
 * 不是依赖声明。不剥注释会把这些说明文字当成真实 import 抓出来。
 *
 * 保守实现：同时处理块注释与行注释；字符串里的 `//` 不特殊处理
 * （本仓库的代码里没有含 `//` 的字符串字面量，够用；一旦有，宁可误报也不要漏报）。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')
}

/** 取出一个文件里所有 import / export-from / 动态 import 的模块说明符。 */
function specifiersOf(text) {
  const code = stripComments(text)
  return [
    ...[...code.matchAll(/^\s*(?:import|export)[^'"\n]*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]),
    ...[...code.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)].map((m) => m[1]),
    ...[...code.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
    ...[...code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
  ]
}

/** 非 test 的全部源码文件。 */
function sourceFiles() {
  return [
    join(ROOT, 'index.js'),
    join(ROOT, 'config.js'),
    ...jsFiles(join(ROOT, 'docs')),
    ...jsFiles(join(ROOT, 'adapters')),
    ...jsFiles(CORE_DIR),
    // M1 新增：tools/ 也必须守同样的规（它最容易想用宿主包）。
    ...jsFiles(join(ROOT, 'tools')),
    // M2 新增（SPEC §5.3-3 明写要求）：server/ 也要过"不 import node:"这一条。
    // ⚠️ `server/` 里**故意**有一个例外场景：`write-engine.ts` 要做物理移动，
    // 但它走的是注入的 `ctx.fs`，不是 `node:fs` —— 所以它同样不该出现 `node:`。
    ...jsFiles(join(ROOT, 'server')),
  ]
}

// ---------------------------------------------------------------- 1. 禁止宿主包

test('§10.2-1：整包不 import 任何 @deepseek-ai/*', () => {
  const offenders = []
  for (const file of sourceFiles()) {
    const specifiers = specifiersOf(readFileSync(file, 'utf8'))
    for (const specifier of specifiers) {
      if (specifier.startsWith('@deepseek-ai/')) {
        offenders.push(`${relative(ROOT, file)} → ${specifier}`)
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '这些文件 import 了宿主包，装到 profile 里会 ERR_MODULE_NOT_FOUND：\n' + offenders.join('\n'),
  )
})

// ---------------------------------------------------------------- 2. 禁止第三方包

test('§10.2-2：整包只允许裸的 node: 内置模块，不碰任何第三方包', () => {
  const offenders = []
  for (const file of sourceFiles()) {
    for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) continue // 相对路径
      if (specifier.startsWith('node:')) continue // Node 内置（显式前缀）
      if (specifier.startsWith('@deepseek-ai/')) continue // 上面那条已经单独抓
      offenders.push(`${relative(ROOT, file)} → ${specifier}`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '这些说明符不是 node: 前缀也不是相对路径，会是第三方包（实测解析不到）：\n' + offenders.join('\n'),
  )
})

test('§10.2-2 补：内置模块必须带 node: 前缀（避免被误认为裸包名）', () => {
  const offenders = []
  const builtins = ['fs', 'path', 'os', 'crypto', 'url', 'util', 'stream', 'events', 'assert']
  for (const file of sourceFiles()) {
    for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
      if (builtins.includes(specifier)) offenders.push(`${relative(ROOT, file)} → ${specifier}`)
    }
  }
  assert.deepEqual(offenders, [], '这些是内置模块但没写 node: 前缀：\n' + offenders.join('\n'))
})

// ---------------------------------------------------------------- 2b. server/ 更严：不许碰 node:

/**
 * `server/` 的 IO 只能走**注入口**（`ctx.fs`），不能自己 `import node:fs`。
 *
 * ---- 为什么这条比整包那条更严 ----
 *
 * 整包层面 `node:` 是**允许**的（`docs/` 与 `adapters/` 都在用 `node:path`）。
 * 但 SPEC §5.3-3 对 `server/` 有额外要求：
 *
 * > **`server/` 不得 import `node:` 内置模块，除非通过注入口。**
 *
 * 理由与归档的实现方式直接相关（M2-Q6）：host **本来就有**写权限，
 * 但它必须走 `ctx.fs` + 沙箱 policy 才安全（M1 踩过 `file access denied` 的真 bug）。
 * 一旦 `server/write-engine.ts` 自己 `import node:fs`，它就会**绕过沙箱 policy**，
 * 那个 bug 会原样回来 —— 而且是出现在一个"用户点了归档"的新路径上。
 *
 * ---- 这条断言为什么必须有（我实测过它的必要性）----
 *
 * 我先把 `jsFiles()` 扩展到认 `.ts`，然后在 `server/snapshot.ts` 顶上塞了一行
 * `import { readFileSync } from 'node:fs'` 做变异 —— **15 条断言全绿，变异存活**。
 * 原因：整包那条（§10.2-2）明确 `continue` 掉所有 `node:` 前缀。
 * 也就是说，光把 `server/` 加进 `sourceFiles()` **什么也没管住**。
 * 所以这里需要一条**专门针对 `server/`** 的断言。
 */
/**
 * `server/` 里**允许**直接 import `node:` 的文件（白名单）。
 *
 * ---- 为什么会有这个白名单（2026-11-13 用户拍板）----
 *
 * 这条纪律原本是绝对的：**IO 必须走 `ctx.fs` 注入口**，
 * 因为直接 `node:fs` 会绕过沙箱 policy（M1 踩过的真 bug）。
 *
 * 但 `ctx.fs` **没有 `mkdir`**。而"一键把目录初始化成 DDD 工作区"
 * 这个功能本质上要建 `docs/`（用户原话：「要我手动建太麻烦了」）。
 *
 * 所以破例，但把破例**收在一个文件里**，并对那个文件单独加最严的约束：
 *   * 只允许 `mkdir-bridge.ts`；
 *   * 它只允许 import `mkdir` / `realpath` / `stat` / `node:path`；
 *   * 它必须做越界检查（见 `init-workspace.test.js` 的那条测试）。
 *
 * 这样"哪里破了纪律"永远一眼可见，而不是散在 `server/` 各处。
 */
const NODE_IMPORT_ALLOWLIST = new Set(['server/mkdir-bridge.ts'])

test('**§5.3-3：server/ 不得 import 任何 node: 内置模块**（IO 必须走 ctx.fs 注入口）', () => {
  const offenders = []
  for (const file of jsFiles(join(ROOT, 'server'))) {
    const rel = relative(ROOT, file).replaceAll('\\', '/')
    if (NODE_IMPORT_ALLOWLIST.has(rel)) continue
    for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('node:')) offenders.push(`${rel} → ${specifier}`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'server/ 直接 import 了 node: 内置模块，会绕过 ctx.fs 的沙箱 policy（M1 踩过的真 bug）：\n'
      + offenders.join('\n')
      + `\n（唯一允许的是 ${[...NODE_IMPORT_ALLOWLIST].join('、')}，理由见该文件头部注释）`,
  )
})

test('**§5.3-3 例外：白名单文件必须真的存在，且只 import 它声明需要的那几个**', () => {
  // 没有这条，白名单会变成"永久放行一个已经不存在的路径"，
  // 而真正新增的越界文件会悄悄溜过去。
  for (const rel of NODE_IMPORT_ALLOWLIST) {
    const file = join(ROOT, rel)
    assert.ok(existsSync(file), `白名单里的 ${rel} 不存在 —— 白名单该删了`)

    const specs = [...specifiersOf(readFileSync(file, 'utf8'))].filter((spec) => spec.startsWith('node:'))
    assert.ok(specs.length > 0, `${rel} 已经不再 import node: 了 —— 把白名单删掉，恢复严格模式`)

    const allowed = new Set(['node:fs/promises', 'node:path'])
    const unexpected = specs.filter((spec) => !allowed.has(spec))
    assert.deepEqual(
      unexpected,
      [],
      `${rel} import 了白名单外的 node: 模块：${unexpected.join(', ')}\n`
        + '建目录只需要 mkdir / realpath / stat 与 path 工具，别的都不该要。',
    )
  }
})

test('**§5.3-3 例外：mkdir-bridge 必须做越界检查**（破纪律的代价）', () => {
  // 破了「不碰 node:fs」这条，就必须付出更严的边界检查作为代价。
  // 这条断言钉的是"检查还在"——具体行为由 init-workspace.test.js 钉。
  const text = readFileSync(join(ROOT, 'server/mkdir-bridge.ts'), 'utf8')
  assert.match(text, /realpath/, '必须 realpath 后再比（不能只比字符串）')
  assert.match(text, /项目根之外/, '必须有越界拒绝的分支')
  assert.match(text, /isInside/, '越界判断必须是一个独立、可被测试的函数')
})

test('§5.3-3 补：server/ 至少扫得到文件（断言不许空跑）', () => {
  // 没有这条，"不 import node:" 会因为"一个文件都没扫到"而永远通过。
  // 这正是上面那个变异存活过的形态：检查范围是空的，断言就永远绿。
  const files = jsFiles(join(ROOT, 'server'))
  assert.ok(files.length >= 2, `server/ 应当至少有 routes + snapshot 两个文件，实际 ${files.length}`)
  assert.ok(
    files.some((file) => file.endsWith('.ts')),
    'server/ 里应当有 .ts 文件 —— 如果全是 .js，说明 jsFiles() 又只认 .js 了',
  )
})

// ---------------------------------------------------------------- 3. core/ 的纯净性

test('§10.2-3：core/ 不出现 node:* / Date / Math.random / 文件 IO', () => {
  const forbidden = [
    'node:',
    'Date.now',
    'new Date',
    'Math.random',
    'process.env',
    'readFile',
    'readFileSync',
    'writeFile',
    'readdirSync',
  ]
  const coreFiles = jsFiles(CORE_DIR)
  assert.ok(coreFiles.length >= 5, `core/ 文件数异常：${coreFiles.length}`)

  for (const file of coreFiles) {
    const text = readFileSync(file, 'utf8')
    for (const needle of forbidden) {
      assert.ok(
        !text.includes(needle),
        `${relative(ROOT, file)} 出现了「${needle}」，core/ 必须是纯函数`,
      )
    }
  }
})

// ---------------------------------------------------------------- 4. core/ 的 import 只指向同目录

test('§10.2-4：core/ 的 import 只允许 ./xxx.js', () => {
  for (const file of jsFiles(CORE_DIR)) {
    for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
      assert.match(
        specifier,
        /^\.\/[A-Za-z0-9_-]+\.js$/,
        `${relative(ROOT, file)} 的 import "${specifier}" 不是同目录相对路径`,
      )
    }
  }
})

// ---------------------------------------------------------------- 5. 挂载方式静态检查（S1）

test('§10.2-5：cordis.patch.yml **不得**出现 @deepseek-ai/dsh-agent-preset（M0-14）', () => {
  const text = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.ok(
    !text.includes('@deepseek-ai/dsh-agent-preset'),
    'cordis.patch.yml 里出现了 dsh-agent-preset —— 这是被 S1 否决的 preset 挂载方式',
  )
})

test('§10.2-5 补：cordis.patch.yml 必须以 insert 一行 @local/ddd 的形态挂载', () => {
  const text = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  // 注释里可以出现任意文字，只看非注释行。
  const lines = text.split('\n').filter((line) => !line.trim().startsWith('#'))
  const code = lines.join('\n')
  assert.match(code, /-?\s*insert:/, '缺少 insert 段')
  assert.match(code, /name:\s*'@local\/ddd'/, '没有插入 @local/ddd 这一行')
  assert.match(code, /id:\s*ddd-engine/, '缺少行 id')
})

test('§10.2-5 补：package.json 声明 type:module 与 dsh.bundle.patch', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.name, '@local/ddd')
})

test('package.json 无 BOM（交接 §4.1 #2：BOM 会让 JSON.parse 抛）', () => {
  const raw = readFileSync(join(ROOT, 'package.json'))
  assert.notEqual(raw[0], 0xef, 'package.json 带 BOM')
})

test('cordis.patch.yml 与前端文件也无 BOM', () => {
  for (const name of ['cordis.patch.yml', 'README.md']) {
    let raw
    try {
      raw = readFileSync(join(ROOT, name))
    } catch {
      continue // README 还没写（第 9 步补），跳过；BOM 检查在文件存在时生效
    }
    assert.notEqual(raw[0], 0xef, `${name} 带 BOM`)
  }
})

// ---------------------------------------------------------------- 6. 分层方向（§10.3）

test('§10.3：docs/ 与 core/ 不得反向依赖 adapters/', () => {
  const offenders = []
  for (const file of [...jsFiles(join(ROOT, 'docs')), ...jsFiles(CORE_DIR)]) {
    const text = readFileSync(file, 'utf8')
    if (/from\s+['"][^'"]*adapters\//.test(text)) offenders.push(relative(ROOT, file))
  }
  assert.deepEqual(offenders, [], '这些文件反向依赖了 adapters/：\n' + offenders.join('\n'))
})

test('§10.3：core/ 不得依赖 docs/', () => {
  const offenders = []
  for (const file of jsFiles(CORE_DIR)) {
    const text = readFileSync(file, 'utf8')
    if (/from\s+['"][^'"]*\/docs\//.test(text)) offenders.push(relative(ROOT, file))
  }
  assert.deepEqual(offenders, [], 'core/ 反向依赖了 docs/：\n' + offenders.join('\n'))
})

// ---------------------------------------------------------------- 7. 断言有效性

test('断言不空跑：能扫到预期的文件数', () => {
  assert.ok(jsFiles(CORE_DIR).length >= 5, 'core/ 至少 5 个模块')
  assert.ok(jsFiles(join(ROOT, 'docs')).length >= 4, 'docs/ 至少 4 个模块')
  // M1：tools/ 也有内容被扫到（否则上面那几条对 tools/ 的断言是空跑）
  assert.ok(jsFiles(join(ROOT, 'tools')).length >= 5, 'tools/ 至少 5 个模块')
  // 相对 import 不该被当成外部依赖（parity check：说明正则没写反）
  assert.equal(specifiersOf("import a from './b.js'")[0], './b.js')
  assert.equal(specifiersOf("import z from 'zod'")[0], 'zod')
})

// ---------------------------------------------------------------- 8. M1：工具定义的无损 JSON

test('**tools/ 也不得依赖宿主包**（M1 最容易破的一条：想用 defineTool）', () => {
  const offenders = []
  for (const file of jsFiles(join(ROOT, 'tools'))) {
    for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('@deepseek-ai/')) offenders.push(`${relative(ROOT, file)} → ${specifier}`)
    }
  }
  assert.deepEqual(offenders, [], 'tools/ 里出现了宿主包 import：\n' + offenders.join('\n'))
})

test('**tools/ 的 import 只允许 node: / 相对路径**（与整包同规）', () => {
  const offenders = []
  for (const file of jsFiles(join(ROOT, 'tools'))) {
    for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) continue
      if (specifier.startsWith('node:')) continue
      if (specifier.startsWith('@deepseek-ai/')) continue // 上一条单独抓
      offenders.push(`${relative(ROOT, file)} → ${specifier}`)
    }
  }
  assert.deepEqual(offenders, [], 'tools/ 里出现了非内置依赖：\n' + offenders.join('\n'))
})

/**
 * M1.5 / N9：子代理写 `docs/` 的边界。
 *
 * ⚠️ **这条改的是已冻结的 S2**（`SPEC-M0 §6`，用户 2026-11-12 授权 `P14`）。
 * 它不是 bug fix，是**语义收窄**：
 *
 *   旧：S2 = 「整个插件对子代理 no-op」
 *   新：S2 = 「**子代理不注入、不记账，但不能写 `docs/`**」
 *
 * 本文件刻意把 5 条验收判据逐条钉住，**外加两条最容易漏的**：
 *   - 主 agent 的行为必须**完全不变**（改 S2 时最容易顺手改坏）；
 *   - `src/docs/` **不能**被误伤（字符串匹配 `/docs/` 的经典错误）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { decideSubagentWrite, isSubagentSession, shouldActivate, WRITE_TOOLS } from '../core/scope.js'
import { READ_TOOLS, pathArgOf } from '../core/gate.js'
import { createGuard } from '../adapters/guard.js'
import { classifyPath } from '../docs/path.js'
import { resolveConfig } from '../config.js'

const ROOT = 'C:/proj/demo'

const layout = {
  projectRoot: ROOT,
  docsDir: 'docs',
  docsAbs: `${ROOT}/docs`,
  graveyardAbs: `${ROOT}/docs/_graveyard`,
  deliverablesAbs: `${ROOT}/deliverables`,
  artifactsAbs: `${ROOT}/_artifacts`,
  agentsMdAbs: `${ROOT}/AGENTS.md`,
}

const classify = (path) => classifyPath(path, layout)
const resolvePath = (path) => (path.startsWith(ROOT) ? path : `${ROOT}/${path}`)

const config = resolveConfig({})

/** 最小注册表。 */
function makeRegistry(overrides = {}) {
  const entries = [{
    path: `${ROOT}/docs/a.md`,
    meta: { id: 'a', role: 'spec', order: 10, status: 'authoritative' },
    hasError: false,
    fingerprint: 'abcdef',
  }]
  return {
    state: 'ready',
    entries,
    index: { required: [], forbidden: [], anomalies: [] },
    entryByPath: (p) => entries.find((e) => e.path === p),
    entryById: (id) => entries.find((e) => e.meta.id === id),
    fingerprintOf: () => 'abcdef',
    textOf: () => '',
    hasError: () => false,
    readSet: new Map(),
    readSetFor: () => new Map(),
    ...overrides,
  }
}

const normalSession = { header: { cwd: ROOT } }
const subSession = { header: { cwd: ROOT, origin: 'subagent', delegationDepth: 1 } }

function makeGuard(cfg = config, registryOverrides = {}) {
  return createGuard({
    config: cfg,
    registry: () => makeRegistry(registryOverrides),
    probe: () => ({ hasMarker: true, projectRoot: ROOT }),
    classify,
    resolvePath,
  })
}

const guard = makeGuard()
const exec = (session, name, args) => ({ name, arguments: args, agent: { session } })

// ---------------------------------------------------------------- 1. 写 docs/ 被拒

test('N9-1：子代理 write docs/ → **被拒**，文案含「交回父会话」', () => {
  const verdict = guard(exec(subSession, 'write', { file_path: `${ROOT}/docs/x.md`, content: '# x' }))
  assert.equal(typeof verdict, 'string')
  assert.match(verdict, /交回父会话/)
  assert.match(verdict, /主 agent/)
})

test('N9-1：子代理 edit / str_replace_editor docs/ → 都被拒（不是只拦 write）', () => {
  for (const [tool, args] of [
    ['edit', { file_path: `${ROOT}/docs/a.md`, old_string: 'x', new_string: 'y' }],
    ['str_replace_editor', { command: 'str_replace', path: `${ROOT}/docs/a.md` }],
  ]) {
    const verdict = guard(exec(subSession, tool, args))
    assert.equal(typeof verdict, 'string', `${tool} 应当被拒`)
  }
})

test('N9-1 已知缺口：**apply_patch 抽不出单一路径 → 拦不住**（如实记账，不假装堵住）', () => {
  // 这是 M0 就登记的已知限制（`core/gate.js` 的 `pathArgOf` 注释：SPEC §7.2 的保守策略
  // ——抽不出或解析失败 → 放行，因为「M0 不实现补丁解析」）。
  //
  // M1.5 的另一条铁律是「不假装堵住」：本机 `applyPatch: false`，该工具不启用，
  // 所以这条缺口在**生产路径上不可达**。但一旦宿主启用 patches，**N9 会在这里留一个洞**。
  // 所以这条测试的用途是**钉住这个事实**（改了就红），不是保证它被拦住。
  const verdict = guard(exec(subSession, 'apply_patch', { file_path: `${ROOT}/docs/a.md`, patch: 'x' }))
  assert.equal(verdict, undefined, '抽不出路径 → 放行；这是已知缺口，见 README 的已知限制')

  // `pathArgOf` **刻意不处理** `apply_patch`（它是 M0 的决定，M1.5 没有改它）。
  assert.equal(pathArgOf({ name: 'apply_patch', arguments: { file_path: `${ROOT}/docs/a.md` } }), undefined)
})

// ---------------------------------------------------------------- 2. 写 src/ 放行

test('N9-2：子代理 write src/ → **放行**（工程活不受影响）', () => {
  assert.equal(guard(exec(subSession, 'write', { file_path: `${ROOT}/src/x.txt`, content: 'code' })), undefined)
  assert.equal(guard(exec(subSession, 'edit', { file_path: `${ROOT}/src/y.js`, old_string: 'a', new_string: 'b' })), undefined)
})

// ---------------------------------------------------------------- 3. 读 docs/ 放行

test('N9-3：子代理 **read** docs/ → 放行（拦读会让它没法理解上下文）', () => {
  assert.equal(guard(exec(subSession, 'read', { file_path: `${ROOT}/docs/a.md` })), undefined)
  assert.equal(guard(exec(subSession, 'glob', { pattern: 'docs/**' })), undefined)
})

// ---------------------------------------------------------------- 4. 仍不注入

test('N9-4：子代理**仍然不激活**（S2 的初衷没被破坏：不注入索引、不记 readSet）', () => {
  assert.equal(shouldActivate({
    hasMarker: true, hasProjectRoot: true, isSubagent: true,
    requireMarker: config.requireMarker, excludeSubagents: config.excludeSubagents,
  }), false)
})

// ---------------------------------------------------------------- 5. 主 agent 不变

test('N9-5：**主 agent 一切行为完全不变**（改 S2 最容易顺手改坏的一条）', () => {
  // 写 src/ 放行
  assert.equal(guard(exec(normalSession, 'write', { file_path: `${ROOT}/src/x.js`, content: 'a' })), undefined)
  // 写已读的 docs/ 放行
  const readSet = new Map([['a', { fingerprint: 'abcdef', text: '' }]])
  const guardWithRead = makeGuard(config, { readSetFor: () => readSet })
  assert.equal(guardWithRead(exec(normalSession, 'edit', {
    file_path: `${ROOT}/docs/a.md`, old_string: 'x', new_string: 'y',
  })), undefined)
})

test('N9-5：主 agent 改**未读**的必读文档仍然被拒（门禁没被顺手放宽）', () => {
  const required = [{
    path: `${ROOT}/docs/a.md`,
    meta: { id: 'a', role: 'spec', order: 10, status: 'authoritative' },
    fingerprint: 'abcdef',
  }]
  const guardUnread = makeGuard(config, { index: { required, forbidden: [], anomalies: [] } })
  const verdict = guardUnread(exec(normalSession, 'edit', {
    file_path: `${ROOT}/docs/a.md`, old_string: 'x', new_string: 'y',
  }))
  assert.equal(typeof verdict, 'string')
  assert.match(verdict, /必须先读/)
})

// ---------------------------------------------------------------- 6. 不误伤 src/docs/

test('N9-6：`src/docs/` **不能**被误伤（字符串匹配 `/docs/` 的经典错误）', () => {
  assert.equal(classifyPath(`${ROOT}/src/docs/note.md`, layout), 'outside')
  assert.equal(guard(exec(subSession, 'write', { file_path: `${ROOT}/src/docs/note.md`, content: '# n' })), undefined)
})

// ---------------------------------------------------------------- 7. 可关 + 坟场

test('N9-7：`excludeSubagents=false` → 恢复 M1 旧行为（开关可关）', () => {
  const loose = makeGuard(resolveConfig({ excludeSubagents: false }))
  assert.equal(loose(exec(subSession, 'write', { file_path: `${ROOT}/docs/x.md`, content: 'x' })), undefined)
})

test('N9-7：子代理写**坟场**不由 N9 管（坟场是另一条规则，别把两条混起来）', () => {
  assert.equal(guard(exec(subSession, 'write', { file_path: `${ROOT}/docs/_graveyard/old.md`, content: 'x' })), undefined)
})

// ---------------------------------------------------------------- 8. 纯函数矩阵

test('N9-8：decideSubagentWrite 的完整真值表', () => {
  const allowCases = [
    { toolName: 'write', kind: 'doc', isSubagent: false },
    { toolName: 'write', kind: 'outside', isSubagent: true },
    { toolName: 'write', kind: 'graveyard', isSubagent: true },
    { toolName: 'write', kind: 'deliverable', isSubagent: true },
    { toolName: 'read', kind: 'doc', isSubagent: true },
    { toolName: 'glob', kind: 'doc', isSubagent: true },
    { toolName: 'write', kind: 'doc', isSubagent: true, excludeSubagents: false },
    { toolName: 'write', kind: 'doc' },
    {},
  ]
  for (const input of allowCases) {
    assert.equal(decideSubagentWrite(input), undefined, `应当放行：${JSON.stringify(input)}`)
  }

  const denyCases = [
    { toolName: 'write', kind: 'doc', isSubagent: true },
    { toolName: 'edit', kind: 'doc', isSubagent: true },
    { toolName: 'str_replace_editor', kind: 'doc', isSubagent: true },
    { toolName: 'apply_patch', kind: 'doc', isSubagent: true },
  ]
  for (const input of denyCases) {
    assert.equal(typeof decideSubagentWrite(input), 'string', `应当拒绝：${JSON.stringify(input)}`)
  }
})

test('N9-8：WRITE_TOOLS 与 gate 的 READ_TOOLS **不相交**（否则读写判据会打架）', () => {
  const overlap = WRITE_TOOLS.filter((name) => READ_TOOLS.includes(name))
  assert.deepEqual(overlap, [])
})

test('N9：isSubagentSession 仍是唯一判据（不引入第二套）', () => {
  assert.equal(isSubagentSession({ header: { origin: 'subagent' } }), true)
  assert.equal(isSubagentSession({ header: { cwd: ROOT } }), false)
})

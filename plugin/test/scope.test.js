/**
 * S1 / S2 闸门的单测（SPEC §12.1 的 `scope.test.js`）。
 *
 * 这是整个 M0 最该先钉死的一组断言：它决定「要不要干活」。
 * 写反了，M0-12（普通仓库被误伤）与 M0-13（子代理被拦）会一起失败。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SCOPE_REASONS,
  activationReason,
  isSubagentSession,
  shouldActivate,
} from '../core/scope.js'

// ---------------------------------------------------------------- 四象限（S1 × S2）

test('四象限：有标记 × 非子代理 → 激活', () => {
  assert.equal(shouldActivate({ hasMarker: true, isSubagent: false }), true)
})

test('四象限：无标记 × 非子代理 → **不激活**（S1 防误伤，M0-12）', () => {
  assert.equal(shouldActivate({ hasMarker: false, isSubagent: false }), false)
  assert.equal(activationReason({ hasMarker: false, isSubagent: false }), SCOPE_REASONS.NO_MARKER)
})

test('四象限：有标记 × 子代理 → **不激活**（S2，M0-13）', () => {
  assert.equal(shouldActivate({ hasMarker: true, isSubagent: true }), false)
  assert.equal(activationReason({ hasMarker: true, isSubagent: true }), SCOPE_REASONS.SUBAGENT)
})

test('四象限：无标记 × 子代理 → 不激活', () => {
  assert.equal(shouldActivate({ hasMarker: false, isSubagent: true }), false)
})

// ---------------------------------------------------------------- S2 优先于 S1

test('S2 优先：子代理即使有标记也不加载（顺序不能反）', () => {
  assert.equal(activationReason({ hasMarker: true, isSubagent: true }), SCOPE_REASONS.SUBAGENT)
})

test('S2 关掉后子代理也会加载（配置 escape hatch，明确写进 README 作为「不建议」）', () => {
  assert.equal(
    shouldActivate({ hasMarker: true, isSubagent: true, excludeSubagents: false }),
    true,
  )
})

// ---------------------------------------------------------------- S1 的 escape hatch

test('requireMarker=false 时只凭 docs/ 就激活（调试用，危险）', () => {
  assert.equal(shouldActivate({ hasMarker: false, isSubagent: false, requireMarker: false }), true)
})

test('requireMarker=false 也仍然拦得住子代理（S2 不受影响）', () => {
  assert.equal(
    shouldActivate({ hasMarker: false, isSubagent: true, requireMarker: false }),
    false,
  )
})

// ---------------------------------------------------------------- 其它原因

test('没探到项目根 → 不激活（M0-9 静默降级）', () => {
  assert.equal(shouldActivate({ hasMarker: true, isSubagent: false, hasProjectRoot: false }), false)
  assert.equal(
    activationReason({ hasMarker: true, isSubagent: false, hasProjectRoot: false }),
    SCOPE_REASONS.NO_PROJECT_ROOT,
  )
})

test('总开关 enabled=false → 不激活，且原因优先于其它', () => {
  assert.equal(
    activationReason({ hasMarker: true, isSubagent: false, enabled: false }),
    SCOPE_REASONS.DISABLED,
  )
})

// ---------------------------------------------------------------- 非法输入

test('空对象 → 不激活（默认必须有标记）', () => {
  assert.equal(shouldActivate({}), false)
})

test('null / undefined / 非对象 → 不激活且不抛', () => {
  assert.equal(shouldActivate(null), false)
  assert.equal(shouldActivate(undefined), false)
  assert.equal(shouldActivate('yes'), false)
  assert.equal(shouldActivate(1), false)
})

test('hasMarker 只认严格 true（其余一律视为无标记）', () => {
  for (const value of [1, 'true', {}, [], 'yes']) {
    assert.equal(shouldActivate({ hasMarker: value, isSubagent: false }), false)
  }
})

// ---------------------------------------------------------------- isSubagentSession

test('isSubagentSession：origin=subagent → true', () => {
  assert.equal(isSubagentSession({ header: { origin: 'subagent' } }), true)
})

test('isSubagentSession：普通会话（无 origin）→ false', () => {
  assert.equal(isSubagentSession({ header: {} }), false)
})

test('isSubagentSession：无 header / null session → false 且不抛', () => {
  assert.equal(isSubagentSession({}), false)
  assert.equal(isSubagentSession(null), false)
  assert.equal(isSubagentSession(undefined), false)
  assert.equal(isSubagentSession({ header: null }), false)
})

test('isSubagentSession：**有 parentSession 但不是子代理**（历史 fork）→ false', () => {
  // dsh-session README：「历史普通 fork 可能仍在此字段保留来源，因此分类使用 origin」。
  // 若按 parentSession 判，普通 fork 会话会失去门禁保护 —— 这是误伤。
  assert.equal(isSubagentSession({ header: { parentSession: 'session-abc' } }), false)
})

test('isSubagentSession：origin 缺失但 delegationDepth>0 → true（兜底）', () => {
  assert.equal(isSubagentSession({ header: { delegationDepth: 1 } }), true)
})

test('isSubagentSession：delegationDepth=0（顶层）→ false', () => {
  assert.equal(isSubagentSession({ header: { delegationDepth: 0 } }), false)
})

test('isSubagentSession：origin=subagent 时即使 delegationDepth=0 也是子代理', () => {
  assert.equal(isSubagentSession({ header: { origin: 'subagent', delegationDepth: 0 } }), true)
})

/**
 * `AGENTS.md` 的渲染与合并单测（SPEC §12.1 的 `agentsMd.test.js`）。
 *
 * 必测三条：
 * - **只覆盖标记块**
 * - 无标记块时**追加**
 * - **用户内容不被冲掉**
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildIndex } from '../core/index.js'
import {
  MARKER_END,
  MARKER_START,
  hasIndexMarker,
  mergeAgentsMd,
  renderAgentsMd,
  sameBlock,
} from '../core/agentsMd.js'

function entry(meta, overrides = {}) {
  return {
    path: `docs/${meta?.id ?? 'x'}.md`,
    meta,
    issues: [],
    hasError: false,
    fingerprint: 'abcdef123456',
    ...overrides,
  }
}

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

/** 造一份块。 */
function block(entries = [entry(good())], extra = {}) {
  return renderAgentsMd(buildIndex(entries), extra)
}

// ---------------------------------------------------------------- 触发标记（T2）

test('hasIndexMarker：认 `<!-- ddd:index`（SPEC §4.3 的 T2）', () => {
  assert.equal(hasIndexMarker('<!-- ddd:index v1 · 自动生成 -->'), true)
  assert.equal(hasIndexMarker('<!--ddd:index-->'), true)
  assert.equal(hasIndexMarker('# 普通 AGENTS.md\n\n没有标记'), false)
  assert.equal(hasIndexMarker(''), false)
  assert.equal(hasIndexMarker(undefined), false)
})

// ---------------------------------------------------------------- 渲染内容

test('块以起始标记开头、以结束标记结尾', () => {
  const text = block()
  assert.ok(text.startsWith(MARKER_START), `实际开头：${text.slice(0, 40)}`)
  assert.ok(text.includes(MARKER_END))
})

test('块里有必读清单，且带 id 与状态', () => {
  const text = block()
  assert.match(text, /### 必读/)
  assert.match(text, /spec-tier2/)
  assert.match(text, /🟢/)
})

test('sealed 进【禁止执行】小节（M0-10）', () => {
  const text = block([entry(good({ id: 'trap', status: 'sealed', summary: '要求只输出 SPEC.md' }))])
  assert.match(text, /### 禁止执行/)
  assert.match(text, /trap/)
  assert.match(text, /不要执行/)
})

test('**summary 自带「🔴 不要执行：」时不重复**（实机踩到的显示 bug）', () => {
  const text = block([entry(good({
    id: 'trap',
    status: 'sealed',
    summary: '🔴 不要执行：它要求"只输出 SPEC.md"',
  }))])
  // 模板已经带了前缀，这里必须只出现一次
  assert.equal(
    (text.match(/不要执行/g) ?? []).length,
    1,
    `「不要执行」出现了多次：\n${text.split('### 禁止执行')[1]?.split('###')[0]}`,
  )
  assert.match(text, /它要求"只输出 SPEC\.md"/, '摘要正文被误删')
})

test('sealed 文档不在必读清单里', () => {
  const text = block([entry(good({ id: 'trap', status: 'sealed' }))])
  const requiredSection = text.split('### 必读')[1]?.split('### 禁止执行')[0] ?? ''
  assert.doesNotMatch(requiredSection, /trap/)
})

test('tokens 有值时渲染成 k 单位', () => {
  const text = block([entry(good({ tokens: 12400 }))])
  assert.match(text, /12\.4k tokens/)
})

test('tokens 缺失时不渲染该字段', () => {
  const text = block([entry(good())])
  assert.doesNotMatch(text, /tokens/)
})

test('有 error 的文档进【文档异常】小节，不进必读', () => {
  const bad = entry(good({ id: 'decision-log' }), {
    hasError: true,
    issues: [{ rule: 'V1', level: 'error', message: '缺少 role 字段' }],
  })
  const text = block([bad])
  assert.match(text, /### 文档异常/)
  assert.match(text, /缺少 role 字段/)
  const requiredSection = text.split('### 必读')[1]?.split('### 禁止执行')[0] ?? ''
  assert.doesNotMatch(requiredSection, /decision-log/)
})

test('术语表（可选）能渲染', () => {
  const text = block([entry(good())], { terms: ['**切片** = 「档」'] })
  assert.match(text, /### 术语/)
  assert.match(text, /切片/)
})

// ---------------------------------------------------------------- 慢变量纪律（反向断言）

test('**块里不得出现会话态内容**（快变量进 AGENTS.md 就是 R3 违规）', () => {
  const text = block()
  assert.doesNotMatch(text, /已读/, 'AGENTS.md 不能有"已读"——那是每轮都变的快变量')
  assert.doesNotMatch(text, /\d+\/\d+\s*份/, 'AGENTS.md 不能有已读计数')
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}/, 'AGENTS.md 不能有日期')
  assert.doesNotMatch(text, /当前阶段|当前切片/, 'AGENTS.md 不能有阶段/切片（M0 无此数据源）')
})

test('同样的索引 → 渲染完全相同（幂等，避免无谓重写）', () => {
  const entries = [entry(good({ id: 'a' })), entry(good({ id: 'b', order: 30 }))]
  assert.equal(block(entries), block(entries))
})

// ---------------------------------------------------------------- 合并

test('合并：已有完整标记块 → 只替换块，**用户内容前后都保留**', () => {
  const existing = [
    '# 我自己的规则',
    '',
    '这一段绝不能丢。',
    '',
    '<!-- ddd:index v1 · 自动生成，请勿手改 -->',
    '## 旧内容',
    '<!-- ddd:index end -->',
    '',
    '块后面还有用户内容。',
    '',
  ].join('\n')

  const merged = mergeAgentsMd(existing, block())
  assert.match(merged, /我自己的规则/)
  assert.match(merged, /这一段绝不能丢/)
  assert.match(merged, /块后面还有用户内容/)
  assert.doesNotMatch(merged, /## 旧内容/, '旧块内容应被替换掉')
  assert.match(merged, /spec-tier2/)
})

test('合并：没有标记块 → 追加到末尾，原有内容一字不动', () => {
  const existing = '# 我的 AGENTS.md\n\n只在 Windows 上跑测试。\n'
  const merged = mergeAgentsMd(existing, block())
  assert.ok(merged.startsWith('# 我的 AGENTS.md'), '用户内容必须在最前且原样')
  assert.match(merged, /只在 Windows 上跑测试/)
  assert.match(merged, /spec-tier2/)
})

test('合并：空文件 → 直接写块', () => {
  const merged = mergeAgentsMd('', block())
  assert.ok(merged.startsWith(MARKER_START))
})

test('合并：文件不存在（null / undefined）也不抛', () => {
  assert.doesNotThrow(() => mergeAgentsMd(null, block()))
  assert.doesNotThrow(() => mergeAgentsMd(undefined, block()))
})

test('合并：只有起始标记没有结束标记（坏文件）→ 从起始标记起到末尾替换', () => {
  const existing = '# 用户内容\n\n<!-- ddd:index v1 -->\n残块内容没有结束标记\n'
  const merged = mergeAgentsMd(existing, block())
  assert.match(merged, /# 用户内容/)
  assert.doesNotMatch(merged, /残块内容没有结束标记/)
  assert.match(merged, /spec-tier2/)
  assert.ok(merged.includes(MARKER_END))
})

test('合并是幂等的：连续合并两次结果相同（避免每次重写都变大）', () => {
  const once = mergeAgentsMd('# 用户\n', block())
  const twice = mergeAgentsMd(once, block())
  assert.equal(sameBlock(once, twice), true)
  assert.equal(once, twice)
})

test('合并：多个标记块只替换第一处之外不会全删（保守行为）', () => {
  const existing = [
    '<!-- ddd:index -->',
    'A',
    '<!-- ddd:index end -->',
    '',
    '中间用户内容',
    '',
    '<!-- ddd:index -->',
    'B',
    '<!-- ddd:index end -->',
  ].join('\n')
  const merged = mergeAgentsMd(existing, block())
  assert.match(merged, /中间用户内容/)
})

test('sameBlock：忽略行尾空白与空行差异', () => {
  assert.equal(sameBlock('a\nb\n', 'a\n\nb  \n'), true)
  assert.equal(sameBlock('a\nb', 'a\nc'), false)
})

test('sameBlock：CRLF 与 LF 等价', () => {
  assert.equal(sameBlock('a\r\nb\r\n', 'a\nb\n'), true)
})

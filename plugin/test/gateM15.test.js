/**
 * M1.5 的门禁回归（N1 / N1b）。
 *
 * 这两条是 M1 评审里**唯一阻塞级 + 与它同构的那条**。它们的共同形态是：
 * **`if` 拒绝的时候，模型没有别的路可走。**
 *
 * 所以本文件刻意按「模型视角」组织，而不是按函数组织：
 *   - 对每一类文档，先问「我能不能写它」；
 *   - 如果不能，再问「**还有没有别的路**」——这就是 N1/N1b 之前没人问的那一句。
 *
 * 四类文档（与 `_m15/fixtures.mjs` 一致）：
 *   1. unmanaged（无 frontmatter）
 *   2. broken-parse（有 `---` 但解析失败）
 *   3. broken-role（解析成功但字段非法）
 *   4. ok（完全合法）
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildIndex } from '../core/index.js'
import {
  GATE_ALLOW,
  GATE_DENY,
  decideGate,
  editTouchesOnlyFrontmatter,
  frontmatterSpan,
} from '../core/gate.js'

const FP = 'abcdef123456'
const ABS = 'C:/proj/demo/docs/plain.md'

/** 一个把 docs/xxx 判成 doc 的假 classifier。 */
function fakeClassify(path) {
  const text = String(path).replaceAll('\\', '/')
  if (text.includes('_graveyard')) return 'graveyard'
  if (/\/docs\/.+\.md$/.test(text)) return 'doc'
  return 'outside'
}

/**
 * 一次「模型想改这份文档」的完整裁决。
 *
 * @param {object} input
 * @param {'unmanaged'|'broken'|'ok'|'absent'} input.kind 文档状态
 * @param {string} [input.text] 文档原文（N1b 判定要用）
 * @param {string} [input.toolName]
 * @param {object} [input.args]
 * @param {boolean} [input.injectUnmanagedOf] 是否注入 unmanagedOf（默认 true；false 用来验降级）
 * @returns {{decision: string, reason?: string}}
 */
function gate(input) {
  const { kind, text = '', toolName = 'edit', args = {} } = input
  // ⚠️ **M1.5 复核者修正（2026-11-12）：`broken` 必须带 id。**
  //
  // 原来这行是 `kind === 'ok' ? {...} : undefined`，于是 `kind: 'broken'` 的用例
  // **meta 是 undefined、id 也是 undefined** → `decideGate` 进的是
  // `if (id === undefined)` 那条分支（**情况 3：有 `---` 但解析失败**），
  // 而**不是** `if (hasError)` 那条。
  //
  // 但 N1b 的真实缺陷（`role: bogus-role`）**是解析成功的**——它有 id、有 meta，
  // 只是字段非法（`repro-gate.mjs` 打出来的真实形状：
  // `docs/broken-role.md id=broken-role unmanaged=false hasError=true`）。
  //
  // 后果（复核实测）：把 `hasError` 分支放宽成"任何 edit 都放行"，
  // **20 条 gateM15 全绿、691 条单测全绿** —— 这批断言测的是**另一条分支**，
  // 对 N1b 的保护是假的。两条分支的拒绝文案都含 `edit`/`frontmatter`/`正文`/`spec`，
  // 所以字面断言全过。
  //
  // 修法：让 `broken` 用**生产形状**（有 id + 有 meta），这样它才真的走 `hasError` 分支。
  const meta = kind === 'ok'
    ? { id: 'plain', role: 'spec', order: 20, status: 'draft' }
    : (kind === 'broken'
      ? { id: 'broken', role: 'bogus-role', order: 60, status: 'draft' }
      : undefined)
  return decideGate({
    toolName,
    args: { file_path: ABS, old_string: 'a', new_string: 'b', ...args },
    required: [],
    readSet: new Map(),
    classify: fakeClassify,
    metaOf: () => meta,
    knownOf: () => kind !== 'absent',
    ...(input.injectUnmanagedOf === false
      ? {}
      : { unmanagedOf: () => kind === 'unmanaged' }),
    textOfPath: () => (text === '' ? undefined : text),
    errorOf: () => kind === 'broken',
  })
}

// ---------------------------------------------------------------- N1：unmanaged

test('N1：docs/ 下**完全没有 frontmatter** 的 md → 放行写入（不再是死锁）', () => {
  // 修 N1 之前这里是 GATE_DENY，理由「先补上 id / role / status 再改它」——
  // 而补字段只能用 edit/write，正被同一句话拒掉。实测死锁。
  const result = gate({ kind: 'unmanaged', toolName: 'edit' })
  assert.equal(result.decision, GATE_ALLOW)
})

test('N1：unmanaged 的 write 也放行（它是"不受管"，不是"坏了"）', () => {
  assert.equal(gate({ kind: 'unmanaged', toolName: 'write' }).decision, GATE_ALLOW)
})

test('N1 反向：**拿不到 unmanagedOf 时不猜**，保持 M1 的拒绝行为（fail-closed）', () => {
  // 这条是防"接线漏了就静默放宽门禁"。宁可退回旧行为，也不在信息不全时放行。
  const result = gate({ kind: 'unmanaged', injectUnmanagedOf: false })
  assert.equal(result.decision, GATE_DENY)
  assert.match(result.reason, /frontmatter/)
})

test('N1 边界：注册表里根本没有这份文档 → 仍然放行（M0 既有行为，不能被 N1 改坏）', () => {
  assert.equal(gate({ kind: 'absent', toolName: 'write' }).decision, GATE_ALLOW)
})

// ---------------------------------------------------------------- N1b：可修性

const BROKEN_ROLE = '---\nid: broken\nrole: bogus-role\norder: 60\n---\n\n# 正文\n'
const BROKEN_PARSE = '---\nid: broken\nverifiedAgainst:\n  dsh: 0.2.2\n---\n\n# 正文\n'

test('N1b：坏元数据的文档，**只改 frontmatter 的 edit 放行**（唯一自救路径）', () => {
  const result = gate({
    kind: 'broken',
    text: BROKEN_ROLE,
    args: { old_string: 'role: bogus-role', new_string: 'role: spec' },
  })
  assert.equal(result.decision, GATE_ALLOW)
})

test('N1b：块式嵌套也能被拍平修好（解析器明牌拒绝的那种坏法）', () => {
  const result = gate({
    kind: 'broken',
    text: BROKEN_PARSE,
    args: {
      old_string: 'verifiedAgainst:\n  dsh: 0.2.2',
      new_string: 'verifiedAgainst: {"dsh":"0.2.2"}',
    },
  })
  assert.equal(result.decision, GATE_ALLOW)
})

test('N1b 反向：**改正文**的 edit 仍然拒绝（修法不能变成后门）', () => {
  const result = gate({
    kind: 'broken',
    text: BROKEN_ROLE,
    args: { old_string: '# 正文', new_string: '# 改过的正文' },
  })
  assert.equal(result.decision, GATE_DENY)
})

test('N1b 反向：替换**跨出 frontmatter 边界** → 拒绝', () => {
  const result = gate({
    kind: 'broken',
    text: BROKEN_ROLE,
    args: { old_string: 'order: 60\n---', new_string: 'order: 61\n---' },
  })
  // 这一条落在块内（含结束行）→ 应当放行；下面的跨块用例才是拒绝
  assert.equal(result.decision, GATE_ALLOW)

  const crossing = gate({
    kind: 'broken',
    text: BROKEN_ROLE,
    args: { old_string: 'order: 60\n---\n\n# 正文', new_string: 'order: 60\n---\n\n# 别的' },
  })
  assert.equal(crossing.decision, GATE_DENY)
})

test('N1b 反向：**write 整体覆盖**坏文档 → 仍然拒绝', () => {
  const result = gate({ kind: 'broken', text: BROKEN_ROLE, toolName: 'write', args: { content: 'x' } })
  assert.equal(result.decision, GATE_DENY)
})

test('N1b 反向：old_string 匹配不到 → 拒绝（不猜）', () => {
  const result = gate({
    kind: 'broken',
    text: BROKEN_ROLE,
    args: { old_string: 'role: 不存在的值', new_string: 'role: spec' },
  })
  assert.equal(result.decision, GATE_DENY)
})

test('N1b：拒绝文案必须**给出可行出路**（M1 的那句是空头支票）', () => {
  const result = gate({ kind: 'broken', text: BROKEN_ROLE, toolName: 'write', args: { content: 'x' } })
  assert.equal(result.decision, GATE_DENY)
  // 必须说清"只有一种可行修法"，并点明正文不能动
  assert.match(result.reason, /edit/)
  assert.match(result.reason, /frontmatter/)
  assert.match(result.reason, /正文/)
  // 并且要能查到合法取值（否则模型还是只能猜）
  assert.match(result.reason, /spec/)
})

// ---------------------------------------------------------------- 四类矩阵

test('四类文档的裁决矩阵（N1/N1b 的完整口径）', () => {
  const cases = [
    { kind: 'unmanaged', text: '', expect: GATE_ALLOW },
    { kind: 'broken', text: BROKEN_ROLE, expect: GATE_ALLOW, args: { old_string: 'role: bogus-role', new_string: 'role: spec' } },
    { kind: 'broken', text: BROKEN_ROLE, expect: GATE_DENY, args: { old_string: '# 正文', new_string: '# x' } },
    { kind: 'absent', text: '', expect: GATE_ALLOW },
    { kind: 'ok', text: '', expect: GATE_ALLOW },
  ]
  for (const item of cases) {
    const result = gate(item)
    assert.equal(result.decision, item.expect, `${item.kind} ${JSON.stringify(item.args ?? {})}`)
  }
})

// ---------------------------------------------------------------- 纯函数边界

test('frontmatterSpan：只认第一行**仅由 --- 组成**的块', () => {
  // `---\nid: a\n---\n` = 14 字符，区间是 [0, 14)：含结束行之后的那个换行。
  assert.deepEqual(frontmatterSpan('---\nid: a\n---\n正文\n'), { start: 0, end: 14 })
  assert.equal(frontmatterSpan('# 标题\n---\nid: a\n---\n'), undefined)
  assert.equal(frontmatterSpan('---\nid: a\n'), undefined, '没有结束标记 → 无区间')
  assert.equal(frontmatterSpan(''), undefined)
})

test('frontmatterSpan：`...` 也是结束标记（与 docs/frontmatter.js 一致）', () => {
  const span = frontmatterSpan('---\nid: a\n...\n正文\n')
  assert.notEqual(span, undefined)
  assert.equal('---\nid: a\n...\n'.length, span.end)
})

test('frontmatterSpan：BOM 不影响区间起点', () => {
  const span = frontmatterSpan('\uFEFF---\nid: a\n---\n正文\n')
  assert.equal(span.start, 1)
})

test('frontmatterSpan：CRLF 行尾也能识别', () => {
  const span = frontmatterSpan('---\r\nid: a\r\n---\r\n正文\r\n')
  assert.notEqual(span, undefined)
  assert.equal(span.end, '---\r\nid: a\r\n---\r\n'.length)
})

test('editTouchesOnlyFrontmatter：四条拒绝理由逐条钉住', () => {
  const text = '---\nid: a\nrole: bogus\n---\n\n正文\n'
  assert.equal(editTouchesOnlyFrontmatter({ text, oldString: 'role: bogus', newString: 'role: spec' }), true)
  assert.equal(editTouchesOnlyFrontmatter({ text, oldString: '正文', newString: 'x' }), false)
  assert.equal(editTouchesOnlyFrontmatter({ text, oldString: '', newString: 'x' }), false)
  assert.equal(editTouchesOnlyFrontmatter({ text, oldString: 'a', newString: undefined }), false)
  assert.equal(editTouchesOnlyFrontmatter({ text: '', oldString: 'a', newString: 'b' }), false)
})

test('editTouchesOnlyFrontmatter：replace_all 时**任一**匹配在正文即判否', () => {
  const twice = '---\nid: a\n---\n\nid: a\n'
  assert.equal(editTouchesOnlyFrontmatter({ text: twice, oldString: 'id: a', newString: 'id: b', replaceAll: true }), false)
  assert.equal(editTouchesOnlyFrontmatter({ text: twice, oldString: 'id: a', newString: 'id: b' }), true)
})

test('editTouchesOnlyFrontmatter：**不会**因为 new_string 里含 `role:` 就被骗过', () => {
  // 判据只认位置、不认文本长相 —— 否则「把正文一句话改成 role: spec」也会放行。
  const text = '---\nid: a\n---\n\nrole: bogus 这句话在正文里\n'
  assert.equal(
    editTouchesOnlyFrontmatter({ text, oldString: 'role: bogus 这句话在正文里', newString: 'role: spec' }),
    false,
  )
})

test('N1 不影响既有门禁：合法但**未读**的必读文档仍然拒绝（回归）', () => {
  const entryDoc = {
    path: ABS,
    meta: { id: 'plain', role: 'spec', order: 20, status: 'authoritative' },
    issues: [],
    hasError: false,
    fingerprint: FP,
  }
  const index = buildIndex([entryDoc])
  const result = decideGate({
    toolName: 'edit',
    args: { file_path: ABS, old_string: 'a', new_string: 'b' },
    required: index.required,
    readSet: new Map(),
    currentFingerprint: () => FP,
    classify: fakeClassify,
    metaOf: () => entryDoc.meta,
    knownOf: () => true,
    unmanagedOf: () => false,
    errorOf: () => false,
    textOfPath: () => '',
  })
  assert.equal(result.decision, GATE_DENY)
  assert.match(result.reason, /必须先读/)
})

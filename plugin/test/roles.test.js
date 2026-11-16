/**
 * role 写策略与「仅追加」判定的单测（SPEC §12.1 的 `roles.test.js`）。
 *
 * 必测：六个 role 的 write/edit 策略；"仅追加"判定的三种边界。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ALLOW,
  APPEND_ONLY,
  APPEND_WINDOW_CHARS,
  DENY,
  EDIT,
  ROLE_WRITE_POLICY,
  WRITE,
  denyMessage,
  isAppendOnly,
  policyFor,
} from '../core/roles.js'

// ---------------------------------------------------------------- 策略表

test('策略表覆盖 SPEC §7.3 列出的全部 8 个 role', () => {
  assert.deepEqual(
    Object.keys(ROLE_WRITE_POLICY).sort(),
    ['decision', 'evidence', 'fact', 'handover', 'index', 'instruction', 'log', 'spec'],
  )
})

test('spec / log / index / fact：write 与 edit 都放行', () => {
  for (const role of ['spec', 'log', 'index', 'fact']) {
    assert.equal(policyFor(role, WRITE), ALLOW, `${role} write`)
    assert.equal(policyFor(role, EDIT), ALLOW, `${role} edit`)
  }
})

test('decision：write 拒绝，edit 仅追加', () => {
  assert.equal(policyFor('decision', WRITE), DENY)
  assert.equal(policyFor('decision', EDIT), APPEND_ONLY)
})

test('evidence：write 与 edit 都拒绝', () => {
  assert.equal(policyFor('evidence', WRITE), DENY, 'evidence write')
  assert.equal(policyFor('evidence', EDIT), DENY, 'evidence edit')
})

test('**M2.6：handover：write 拒绝，但 edit 允许**（用户第二次拍板彻底放开）', () => {
  // 原策略是 write/edit 都拒绝（「改交接 = 改历史」）。
  // 但实测证明那条策略逼出了重写与 33 000 字的冗余思考，用户两次拍板后放开 edit。
  // 完整理由见 `core/roles.js` 的 `handover` 那条注释。
  assert.equal(policyFor('handover', WRITE), DENY, 'write 必须继续拒绝（新建请走 doc_new 的 supersedes 链）')
  assert.equal(policyFor('handover', EDIT), ALLOW, 'edit 已放开 —— 否则 AI 标绿后发现哈希过时就锁死了')
})

test('instruction：默认 write / edit 都拒绝（draft 的例外在 gate 里做）', () => {
  assert.equal(policyFor('instruction', WRITE), DENY)
  assert.equal(policyFor('instruction', EDIT), DENY)
})

test('未知 role → 保守拒绝', () => {
  assert.equal(policyFor('bogus', WRITE), DENY)
  assert.equal(policyFor(undefined, EDIT), DENY)
  assert.equal(policyFor(null, WRITE), DENY)
})

// ---------------------------------------------------------------- 仅追加：三种边界

test('边界 1：末尾追加 → 是追加', () => {
  const oldText = '## 决策\n\n已有内容\n'
  const result = isAppendOnly({
    oldText,
    oldString: '已有内容',
    newString: '已有内容\n\n## 新决策\n新增的一行',
  })
  assert.equal(result.append, true)
})

test('边界 2：改中间内容 → 不是追加（new_string 不含 old_string）', () => {
  const result = isAppendOnly({
    oldText: '早期内容\n' + '填充\n'.repeat(100) + '末尾',
    oldString: '早期内容',
    newString: '被改掉的内容',
  })
  assert.equal(result.append, false)
})

test('边界 3：匹配位置离末尾太远 → 不是追加', () => {
  const filler = '填'.repeat(APPEND_WINDOW_CHARS + 50)
  const result = isAppendOnly({
    oldText: `开头\n${filler}\n尾`,
    oldString: '开头',
    newString: '开头', // 纯替换成自己，但位置在开头
  })
  assert.equal(result.append, false)
  assert.match(result.reason, /末尾/)
})

test('位置恰好在末尾窗口内 → 是追加', () => {
  const tail = '尾'.repeat(10)
  const oldText = `${'填'.repeat(APPEND_WINDOW_CHARS)}\n${tail}\n`
  const result = isAppendOnly({ oldText, oldString: tail, newString: `${tail}\n新内容` })
  assert.equal(result.append, true)
})

test('old_string 为空 → 不是追加（那是任意位置插入）', () => {
  const result = isAppendOnly({ oldText: 'abc', oldString: '', newString: 'xyz' })
  assert.equal(result.append, false)
})

test('replace_all=true → 直接判否（全量替换必然不是追加）', () => {
  const result = isAppendOnly({
    oldText: 'a\nb',
    oldString: 'a',
    newString: 'a',
    replaceAll: true,
  })
  assert.equal(result.append, false)
})

test('old_string 在文件里找不到 → 不是追加', () => {
  const result = isAppendOnly({ oldText: 'abc', oldString: 'zzz', newString: 'zzz+' })
  assert.equal(result.append, false)
})

test('拿不到缓存文本 → 降级放行并带 degenerate 理由（SPEC §7.3）', () => {
  const result = isAppendOnly({ oldText: undefined, oldString: 'a', newString: 'ab' })
  assert.equal(result.append, true)
  assert.match(result.reason, /degenerate/)
})

test('new_string 不是字符串 → 判否', () => {
  assert.equal(isAppendOnly({ oldText: 'a', oldString: 'a', newString: null }).append, false)
})

test('isAppendOnly 收到垃圾输入不抛', () => {
  assert.doesNotThrow(() => isAppendOnly(null))
  assert.equal(isAppendOnly(null).append, false)
  assert.equal(isAppendOnly({}).append, false)
})

// ---------------------------------------------------------------- 拒绝文案

test('拒绝文案：不指责、说清原因、给下一步（SPEC §7.4）', () => {
  const text = denyMessage({ id: 'evidence-a15', role: 'evidence', action: 'edit' })
  assert.doesNotMatch(text, /违反/, '不许指责')
  assert.match(text, /evidence-a15/)
  assert.match(text, /新建/, '要给出下一步')
})

test('decision 的拒绝文案要求"追加到文件末尾"', () => {
  const text = denyMessage({ id: 'decision-log', role: 'decision', action: 'edit', why: '改了中间' })
  assert.match(text, /追加到文件末尾/)
  assert.match(text, /改了中间/)
})

test('**M2.6：handover 的 write 拒绝文案要说清"用 doc_new"**（不再是"改历史"）', () => {
  // ---- 判据第二次翻面 ----
  //
  // 旧判据断言文案里有「历史」二字（因为旧策略是"改交接=改历史"，write/edit 全拒）。
  // 但用户第二次拍板**彻底放开 edit**，于是：
  //   - 「改它等于改历史」这句话**不再成立**（edit 现在允许）；
  //   - 走到这个拒绝的只可能是 `write`，理由变成"绕过 supersedes 链"。
  //
  // ⇒ 断言改成"说清该用什么、以及为什么不能用 write"。
  const text = denyMessage({ id: 'h1', role: 'handover', action: 'write' })
  assert.match(text, /doc_new/, '必须指向 doc_new 这条正路')
  assert.match(text, /superseded|链/, '必须说清 write 会绕过 supersedes 链')
  // 反向：不该再说"改它等于改历史" —— edit 已经允许了。
  assert.doesNotMatch(text, /改它就等于改历史/, 'edit 已放开，这句话不再成立')
})

test('拒绝文案对缺 id 的输入不抛', () => {
  assert.doesNotThrow(() => denyMessage({ role: 'evidence', action: 'write' }))
  assert.doesNotThrow(() => denyMessage(null))
})

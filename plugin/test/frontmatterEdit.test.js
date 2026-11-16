/**
 * `core/frontmatterEdit.js` 的单测。
 *
 * 这一组的核心判据只有一条，但它必须被**反复**验证：
 *
 * > **改完 frontmatter 之后，正文一个字节都不变。**
 *
 * 所以除了常规的"字段对不对"，还有一批反向断言：BOM 保留、CRLF 保留、
 * 正文里的同名文本不被误改、没有变化时原文逐字节相同。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  bodyOf,
  formatFrontmatterValue,
  indexBlockKeys,
  locateFrontmatter,
  setFrontmatterField,
  setFrontmatterFields,
} from '../core/frontmatterEdit.js'
import { parseFrontmatter } from '../docs/frontmatter.js'

/** 一份标准文档（LF）。 */
const SAMPLE = [
  '---',
  'id: spec-tier2',
  'title: 档 2 施工图',
  'role: spec',
  'order: 20',
  'status: draft',
  'summary: 档 2 的全部功能切片',
  'basis: 实测',
  '---',
  '',
  '# 档 2 施工图',
  '',
  '正文第一行：status: draft 这句话在正文里也出现了。',
  '正文第二行。',
  '',
].join('\n')

// ---------------------------------------------------------------- 1. 定位

test('locateFrontmatter：能定位块，且 bodyLines 是块后的全部内容', () => {
  const located = locateFrontmatter(SAMPLE)
  assert.equal(located.present, true)
  assert.equal(located.eol, '\n')
  assert.equal(located.bom, '')
  assert.equal(located.end, 8) // 第 0 行是 `---`，第 8 行是收尾 `---`
  // bodyLines 从收尾 `---` 的**下一行**开始：SAMPLE 里那是空行，再下一行才是标题。
  assert.equal(located.bodyLines[0], '')
  assert.equal(located.bodyLines[1], '# 档 2 施工图')
})

test('locateFrontmatter：没有 frontmatter → present=false', () => {
  assert.equal(locateFrontmatter('# 只是一份普通 markdown\n').present, false)
  assert.equal(locateFrontmatter('').present, false)
})

test('locateFrontmatter：有起没止 → present=false（不猜块在哪结束）', () => {
  assert.equal(locateFrontmatter('---\nid: a\n\n正文\n').present, false)
})

test('locateFrontmatter：`...` 也是合法结束标记（与解析器一致）', () => {
  const located = locateFrontmatter('---\nid: a\n...\n正文\n')
  assert.equal(located.present, true)
  assert.equal(located.end, 2)
})

test('locateFrontmatter：识别 BOM 与 CRLF', () => {
  const crlf = '\ufeff---\r\nid: a\r\n---\r\n正文\r\n'
  const located = locateFrontmatter(crlf)
  assert.equal(located.present, true)
  assert.equal(located.bom, '\ufeff')
  assert.equal(located.eol, '\r\n')
})

test('indexBlockKeys：键 → 下标，重复键取第一次', () => {
  const keys = indexBlockKeys(['id: a', '', 'status: draft', 'status: sealed', '- 块式列表'])
  assert.equal(keys.get('id'), 0)
  assert.equal(keys.get('status'), 2)
  assert.equal(keys.size, 2)
})

// ---------------------------------------------------------------- 2. 只改目标字段

test('改一个已存在的键：只有那一行变，其它行原样', () => {
  const result = setFrontmatterField(SAMPLE, 'status', 'authoritative')
  assert.equal(result.ok, true)
  assert.deepEqual(result.changed, ['status'])
  assert.deepEqual(result.added, [])
  assert.ok(result.text.includes('status: authoritative'))
  // ⚠️ 不能用 `!text.includes('status: draft')`：正文里那句也含这个子串。
  // 判据要精确到「frontmatter 块里不再有 status: draft」——这正是本模块存在的理由。
  const located = locateFrontmatter(result.text)
  const block = result.text.split('\n').slice(1, located.end)
  assert.equal(block.some((line) => line === 'status: draft'), false, 'frontmatter 里还留着旧值')
  // 正文里那句 `status: draft` **必须还在**（这是本模块存在的理由）
  assert.ok(result.text.includes('正文第一行：status: draft 这句话在正文里也出现了。'))
})

test('**正文一个字节都不变**（最核心的断言）', () => {
  const result = setFrontmatterField(SAMPLE, 'status', 'sealed')
  assert.equal(result.ok, true)
  assert.equal(bodyOf(result.text), bodyOf(SAMPLE))
})

test('CRLF 文件：正文逐字节不变，且行尾**没有**被改成 LF', () => {
  const crlf = SAMPLE.replaceAll('\n', '\r\n')
  const result = setFrontmatterField(crlf, 'status', 'sealed')
  assert.equal(result.ok, true)
  assert.equal(bodyOf(result.text), bodyOf(crlf))
  // 不含孤立的 \n（每个 \n 前面都得有 \r）
  assert.equal(/(?<!\r)\n/.test(result.text), false, '出现了裸 LF，行尾被改了')
  assert.ok(result.text.includes('\r\nstatus: sealed\r\n'))
})

test('BOM 文件：BOM 保留且正文不变', () => {
  const withBom = `\ufeff${SAMPLE}`
  const result = setFrontmatterField(withBom, 'status', 'sealed')
  assert.equal(result.ok, true)
  assert.equal(result.text.charCodeAt(0), 0xfeff)
  assert.equal(bodyOf(result.text), bodyOf(withBom))
})

test('不存在的键 → 追加到块尾（收尾 `---` 之前）', () => {
  const result = setFrontmatterFields(SAMPLE, { supersededBy: ['spec-tier3'] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.added, ['supersededBy'])
  const lines = result.text.split('\n')
  const close = lines.indexOf('---', 1)
  assert.equal(lines[close - 1], 'supersededBy: ["spec-tier3"]')
  assert.equal(bodyOf(result.text), bodyOf(SAMPLE))
})

test('值为 null / undefined → **删除该键**（不是写成空值）', () => {
  const withScope = setFrontmatterFields(SAMPLE, { scope: ['tier2'] }).text
  const result = setFrontmatterField(withScope, 'scope', null)
  assert.equal(result.ok, true)
  assert.deepEqual(result.removed, ['scope'])
  assert.equal(result.text.includes('scope:'), false)
  assert.equal(bodyOf(result.text), bodyOf(withScope))
})

test('多个字段一次写：位置保持、新增追加、删除移除', () => {
  const result = setFrontmatterFields(SAMPLE, {
    status: 'superseded',
    supersededBy: ['spec-tier3'],
    order: 30,
    basis: null,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.changed.sort(), ['order', 'status'])
  assert.deepEqual(result.added, ['supersededBy'])
  assert.deepEqual(result.removed, ['basis'])
  // status 仍在原来的第 5 行（位置不变 = diff 最小）
  const lines = result.text.split('\n')
  assert.equal(lines[5], 'status: superseded')
  assert.equal(lines[4], 'order: 30')
  assert.equal(bodyOf(result.text), bodyOf(SAMPLE))
})

// ---------------------------------------------------------------- 3. 幂等与"没变化就不动"

test('**值没变 → 原文逐字节相同**（避免无谓写入触发指纹变化）', () => {
  const result = setFrontmatterField(SAMPLE, 'status', 'draft')
  assert.equal(result.ok, true)
  assert.equal(result.text, SAMPLE)
  assert.deepEqual(result.changed, [])
})

test('重复写同一个值 → 第二次不再变化', () => {
  const once = setFrontmatterField(SAMPLE, 'status', 'sealed').text
  const twice = setFrontmatterField(once, 'status', 'sealed')
  assert.equal(twice.text, once)
  assert.deepEqual(twice.changed, [])
})

test('写回读：改完的 frontmatter 仍能被解析器解析，且字段值正确', () => {
  const result = setFrontmatterFields(SAMPLE, {
    status: 'superseded',
    supersededBy: ['spec-tier3', 'spec-tier4'],
    sections: [{ anchor: '#7', status: 'authoritative', reason: '这一节已复核' }],
  })
  assert.equal(result.ok, true)
  const parsed = parseFrontmatter(result.text)
  assert.equal(parsed.error, null)
  assert.equal(parsed.meta.status, 'superseded')
  assert.deepEqual(parsed.meta.supersededBy, ['spec-tier3', 'spec-tier4'])
  assert.deepEqual(parsed.meta.sections, [{ anchor: '#7', status: 'authoritative', reason: '这一节已复核' }])
})

// ---------------------------------------------------------------- 4. 拒绝路径

test('没有 frontmatter → 返回错误，**不替用户造一个**', () => {
  const result = setFrontmatterField('# 普通文档\n\n正文\n', 'status', 'draft')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'DOC_FM_MISSING')
})

test('字段名不合法 → 返回错误（不写进文件）', () => {
  const result = setFrontmatterFields(SAMPLE, { 'bad key': 'x' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'DOC_FM_BAD_KEY')
})

test('值里含函数 → 返回错误（不能把非 JSON 值写进文件）', () => {
  const result = setFrontmatterFields(SAMPLE, { scope: [() => {}] })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'DOC_FM_BAD_VALUE')
})

test('非有限数 → 返回错误', () => {
  const result = setFrontmatterField(SAMPLE, 'order', Number.POSITIVE_INFINITY)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'DOC_FM_BAD_VALUE')
})

// ---------------------------------------------------------------- 5. 序列化形态

test('formatFrontmatterValue：与解析器往返一致', () => {
  const cases = [
    ['spec-tier2', 'spec-tier2'],
    ['含冒号的 summary: 这里有冒号', '"含冒号的 summary: 这里有冒号"'],
    ['有 # 号的值', '"有 # 号的值"'],
    [20, '20'],
    [['a', 'b'], '["a","b"]'],
    [[], '[]'],
    ['', ''],
    [null, ''],
  ]
  for (const [input, expected] of cases) {
    assert.equal(formatFrontmatterValue(input), expected, `序列化 ${JSON.stringify(input)}`)
  }
})

test('formatFrontmatterValue：字符串值经解析器读回仍是原字符串', () => {
  for (const value of ['档 2 施工图', 'a: b', '带"引号"的值', '用 # 号标记', 'tab\there']) {
    const text = `---\nid: a\nsummary: ${formatFrontmatterValue(value)}\n---\n`
    const parsed = parseFrontmatter(text)
    assert.equal(parsed.error, null, `解析失败：${value}`)
    assert.equal(parsed.meta.summary, value)
  }
})

test('bodyOf：没有 frontmatter 时返回全文（不丢内容）', () => {
  const plain = '# 标题\n\n正文\n'
  assert.equal(bodyOf(plain), plain)
})

/**
 * frontmatter 最小子集解析器的单测。
 *
 * 覆盖 SPEC §5.1 的每一种形态、每一类显式拒绝，以及 §12.1 点名的边界：
 * `#` 在引号内不误判为注释、BOM 开头、缺结束 `---`。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { FM_UNSUPPORTED, parseFrontmatter } from '../docs/frontmatter.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 包一层 frontmatter。 */
function doc(frontmatter, body = '# 正文\n') {
  return `---\n${frontmatter}\n---\n${body}`
}

// ---------------------------------------------------------------- 五种支持形态

test('形态 1：标量 `key: value` 取字符串', () => {
  const { present, meta, error } = parseFrontmatter(doc('title: 档 2 施工图'))
  assert.equal(present, true)
  assert.equal(error, null)
  assert.equal(meta.title, '档 2 施工图')
})

test('形态 2：数字 `order: 20` 取有限数', () => {
  const { meta } = parseFrontmatter(doc('order: 20'))
  assert.equal(meta.order, 20)
  assert.equal(typeof meta.order, 'number')
})

test('形态 2b：版本号不是数字，保留为字符串', () => {
  const { meta } = parseFrontmatter(doc('verifiedDsh: 0.2.2-rc.1\nratio: 1.5'))
  assert.equal(meta.verifiedDsh, '0.2.2-rc.1')
  assert.equal(meta.ratio, 1.5)
})

test('形态 3：流式 JSON 列表与对象数组', () => {
  const { meta, error } = parseFrontmatter(doc([
    'scope: ["tier2"]',
    'sections: [{"anchor":"#7","status":"authoritative"},{"anchor":"#2","status":"superseded","supersededBy":"spec-tier1#13"}]',
  ].join('\n')))
  assert.equal(error, null)
  assert.deepEqual(meta.scope, ['tier2'])
  assert.equal(meta.sections.length, 2)
  assert.equal(meta.sections[0].anchor, '#7')
  assert.equal(meta.sections[1].supersededBy, 'spec-tier1#13')
})

test('形态 4：裸词列表 `[a, b]` 在 JSON 失败时兜底按逗号切', () => {
  const { meta } = parseFrontmatter(doc('scope: [tier2, tier1]'))
  assert.deepEqual(meta.scope, ['tier2', 'tier1'])
})

test('形态 4b：裸词列表里的引号词会去引号', () => {
  const { meta } = parseFrontmatter(doc(`scope: ['tier2', "tier 1"]`))
  assert.deepEqual(meta.scope, ['tier2', 'tier 1'])
})

test('形态 4c：空列表 `[]` 是空数组，不是 null', () => {
  const { meta } = parseFrontmatter(doc('scope: []'))
  assert.deepEqual(meta.scope, [])
})

test('形态 5：空值 `key:` 解析成 null', () => {
  const { meta } = parseFrontmatter(doc('note:'))
  assert.equal(meta.note, null)
})

test('引号标量：双引号与单引号都去引号', () => {
  const { meta } = parseFrontmatter(doc('a: "带 空格"\nb: \'单引号\''))
  assert.equal(meta.a, '带 空格')
  assert.equal(meta.b, '单引号')
})

test('引号标量：YAML 单引号里的 \'\' 表示一个单引号', () => {
  const { meta } = parseFrontmatter(doc(`a: 'it''s fine'`))
  assert.equal(meta.a, "it's fine")
})

// ---------------------------------------------------------------- 显式拒绝（五类）

test('拒绝：块式列表（`- item` 另起一行）报 DOC_FM_UNSUPPORTED', () => {
  const { present, error } = parseFrontmatter(doc('scope:\n  - tier2'))
  assert.equal(present, true)
  assert.equal(error?.code, FM_UNSUPPORTED)
})

test('拒绝：顶格块式列表也报错', () => {
  const { error } = parseFrontmatter(doc('- tier2'))
  assert.equal(error?.code, FM_UNSUPPORTED)
})

test('拒绝：块式嵌套（缩进子键）报 DOC_FM_UNSUPPORTED', () => {
  const { error } = parseFrontmatter(doc('verifiedAgainst:\n  dsh: 0.2.2'))
  assert.equal(error?.code, FM_UNSUPPORTED)
})

test('拒绝：多行字符串 `|` 与 `>` 都报 DOC_FM_UNSUPPORTED', () => {
  assert.equal(parseFrontmatter(doc('summary: |\n  第一行')).error?.code, FM_UNSUPPORTED)
  assert.equal(parseFrontmatter(doc('summary: >\n  第一行')).error?.code, FM_UNSUPPORTED)
})

test('拒绝：锚点 `&a` 与别名 `*a` 都报 DOC_FM_UNSUPPORTED', () => {
  assert.equal(parseFrontmatter(doc('a: &anchor 1')).error?.code, FM_UNSUPPORTED)
  assert.equal(parseFrontmatter(doc('a: *anchor')).error?.code, FM_UNSUPPORTED)
})

test('拒绝：不是 `key: value` 的行报错而不是静默跳过', () => {
  const { error } = parseFrontmatter(doc('这一行没有冒号'))
  assert.equal(error?.code, FM_UNSUPPORTED)
})

test('拒绝：键名不合法（含空格 / 中文）报错', () => {
  assert.equal(parseFrontmatter(doc('bad key: 1')).error?.code, FM_UNSUPPORTED)
  assert.equal(parseFrontmatter(doc('中文键: 1')).error?.code, FM_UNSUPPORTED)
})

test('拒绝时 meta 为 null 且 body 仍可读（坏文档不该让整份文件不可用）', () => {
  const { meta, body, error } = parseFrontmatter(doc('scope:\n  - tier2', '# 正文仍然可读\n'))
  assert.equal(meta, null)
  assert.equal(error?.code, FM_UNSUPPORTED)
  assert.match(body, /正文仍然可读/)
})

test('报错带行号，且行号是 1 基、含起始 `---` 行', () => {
  const { error } = parseFrontmatter('---\nid: a\nscope:\n  - b\n---\n')
  assert.equal(error?.line, 4)
})

// ---------------------------------------------------------------- 边界

test('边界：BOM 开头的文件仍能识别 frontmatter', () => {
  const { present, meta } = parseFrontmatter(`\uFEFF${doc('id: spec-tier2')}`)
  assert.equal(present, true)
  assert.equal(meta.id, 'spec-tier2')
})

test('边界：`#` 在引号内不算注释，原样保留', () => {
  const { meta, error } = parseFrontmatter(doc('anchor: "#7"\nsummary: "见 #3 节"'))
  assert.equal(error, null)
  assert.equal(meta.anchor, '#7')
  assert.equal(meta.summary, '见 #3 节')
})

test('边界：`#` 不在引号内时也原样保留（不静默截断）', () => {
  const { meta } = parseFrontmatter(doc('summary: 用 # 号标记'))
  assert.equal(meta.summary, '用 # 号标记')
})

test('边界：缺结束 `---` 报错，且 body 为空（不把正文当 frontmatter 吞掉）', () => {
  const { present, meta, body, error } = parseFrontmatter('---\nid: a\n\n这是正文\n')
  assert.equal(present, true)
  assert.equal(meta, null)
  assert.equal(body, '')
  assert.equal(error?.code, FM_UNSUPPORTED)
  assert.match(error.message, /结束标记/)
})

test('边界：没有 frontmatter 时 present=false 且 body 是原文', () => {
  const { present, meta, body } = parseFrontmatter('# 纯 Markdown\n\n没有元数据\n')
  assert.equal(present, false)
  assert.equal(meta, null)
  assert.match(body, /纯 Markdown/)
})

test('边界：空 frontmatter 块 `---\\n---` 是合法空对象', () => {
  const { present, meta, error } = parseFrontmatter('---\n---\n正文\n')
  assert.equal(present, true)
  assert.equal(error, null)
  assert.deepEqual(Object.keys(meta), [])
})

test('边界：CRLF 换行与 LF 等价', () => {
  const { meta } = parseFrontmatter('---\r\nid: spec-tier2\r\norder: 20\r\n---\r\n正文\r\n')
  assert.equal(meta.id, 'spec-tier2')
  assert.equal(meta.order, 20)
})

test('边界：`---` 之后的正文原样保留（含空行与分隔线）', () => {
  const { body } = parseFrontmatter('---\nid: a\n---\n\n# 标题\n\n---\n\n正文\n')
  assert.equal(body, '\n# 标题\n\n---\n\n正文\n')
})

test('边界：`...` 也能作结束标记（与 DSH 文档预览一致）', () => {
  const { meta, body } = parseFrontmatter('---\nid: a\n...\n正文\n')
  assert.equal(meta.id, 'a')
  assert.equal(body, '正文\n')
})

test('边界：重复键取最后一次（YAML 语义），不报错', () => {
  const { meta } = parseFrontmatter(doc('id: a\nid: b'))
  assert.equal(meta.id, 'b')
})

test('边界：前导零与带符号数字', () => {
  const { meta } = parseFrontmatter(doc('a: -3\nb: +4'))
  assert.equal(meta.a, -3)
  assert.equal(meta.b, '+4')
})

// ---------------------------------------------------------------- 规模约束

/**
 * 剥掉块注释、行注释与空行，只留**代码行**。
 * SPEC §5.1 的「解析器规模预期 ≤120 行」约束的是代码本体，不是文档注释——
 * 把注释算进去会逼着删掉那些解释「为什么砍掉嵌套」的注释，正好反了。
 */
function codeLines(text) {
  const out = []
  let inBlock = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (inBlock) {
      if (line.includes('*/')) inBlock = false
      continue
    }
    if (line.startsWith('/**') || line.startsWith('/*')) {
      if (!line.includes('*/')) inBlock = true
      continue
    }
    if (line === '' || line.startsWith('//') || line.startsWith('*')) continue
    out.push(line)
  }
  return out
}

test('解析器代码本体 ≤120 行（SPEC §5.1 的规模预期）', () => {
  const text = readFileSync(join(HERE, '..', 'docs', 'frontmatter.js'), 'utf8')
  const lines = codeLines(text)
  assert.ok(lines.length <= 120, `frontmatter.js 代码行 ${lines.length}，超过 120 行预期`)
})

test('规模断言本身有效（不会因为剥离逻辑写错而空跑）', () => {
  const text = readFileSync(join(HERE, '..', 'docs', 'frontmatter.js'), 'utf8')
  assert.ok(codeLines(text).length >= 40, '代码行统计疑似失效：剥完只剩不到 40 行')
})

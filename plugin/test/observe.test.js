/**
 * `adapters/observe.js` 的 `textFromReadResult` 单测。
 *
 * 这个函数是 M0-8 的地基：指纹必须来自**模型真正读到的字节**。
 * 抽错了会导致指纹永远对不上，表现就是"读完立刻改也被拒"——比不检测更糟。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { partialReadOf, textFromReadResult } from '../adapters/observe.js'

/** 按 `dsh-tool-fs` 的信封格式造一个 read 结果。 */
function envelope(content, footer) {
  return `<path>C:\\p\\docs\\a.md</path>\n<type>file</type>\n<content>\n${content}\n${footer}\n</content>`
}

test('能还原整份文件（剥掉行号前缀）', () => {
  const text = textFromReadResult({
    content: [{ type: 'text', text: envelope('1: # 标题\n2: 正文', '(End of file - total 2 lines)') }],
  })
  assert.equal(text, '# 标题\n正文\n')
})

test('**窗口读取（非全文）→ 返回 undefined**（不能拿局部内容算指纹）', () => {
  const text = textFromReadResult({
    content: [{
      type: 'text',
      text: envelope('10: 中间某行\n11: 下一行', '(Showing lines 10-11 of 100. Use offset=12 to continue.)'),
    }],
  })
  assert.equal(text, undefined, '窗口读取不该被当成全文')
})

test('被截断的输出（Output capped）→ 返回 undefined', () => {
  const text = textFromReadResult({
    content: [{
      type: 'text',
      text: envelope('1: 长行', '(Output capped. Showing lines 1-1. Use offset=2 to continue.)'),
    }],
  })
  assert.equal(text, undefined)
})

test('没有 <content> 信封 → 返回 undefined', () => {
  assert.equal(textFromReadResult({ content: [{ type: 'text', text: '随便什么' }] }), undefined)
})

test('空 content / 非数组 / null → 返回 undefined 且不抛', () => {
  assert.equal(textFromReadResult({ content: [] }), undefined)
  assert.equal(textFromReadResult({}), undefined)
  assert.equal(textFromReadResult(null), undefined)
  assert.equal(textFromReadResult(undefined), undefined)
})

test('单行文件也能还原', () => {
  const text = textFromReadResult({
    content: [{ type: 'text', text: envelope('1: 只有一行', '(End of file - total 1 lines)') }],
  })
  assert.equal(text, '只有一行\n')
})

test('行号是多位数时也能正确剥掉（**必须从第 1 行开始**）', () => {
  // ⚠️ 2026-11-15 M2.7：原来这条用的是 `98: a\n99: b\n100: c` ——
  // 那是**从第 98 行开始读**，按新判据（首行必须是第 1 行）本来就不算全文。
  // 测试数据写错了，不是新判据的 bug：改成从 1 开始、共 100 行的场景，
  // 用紧凑写法只展示末几行是 3 位数。
  const body = []
  for (let i = 1; i <= 100; i += 1) body.push(`${i}: ${i >= 98 ? `第${i}行` : `填充${i}`}`)
  const text = textFromReadResult({
    content: [{ type: 'text', text: envelope(body.join('\n'), '(End of file - total 100 lines)') }],
  })
  assert.ok(text !== undefined, '从第 1 行开始的 100 行文件应当能还原')
  assert.equal(text.trimEnd().split('\n').pop(), '第100行', '三位数行号没剥干净')
})

test('正文里本身带数字冒号时不会被误剥（只剥行首行号）', () => {
  const text = textFromReadResult({
    content: [{ type: 'text', text: envelope('1: 时间 12:30 开会', '(End of file - total 1 lines)') }],
  })
  assert.equal(text, '时间 12:30 开会\n')
})

test('多个 text block 会被拼接后解析', () => {
  const text = textFromReadResult({
    content: [
      { type: 'text', text: '<path>x</path>\n<type>file</type>\n<content>\n1: a' },
      { type: 'text', text: '\n(End of file - total 1 lines)\n</content>' },
    ],
  })
  assert.equal(text, 'a\n')
})

// ---------------------------------------------------------------- M2.7 · partialReadOf
//
// ---- 2026-11-15 M2.7：`windowReadOf` 已删除，改成 `partialReadOf` ----
//
// 为什么改名 + 改语义（用户拍板「停用窗口读记账」）：
//
// 旧 `windowReadOf` 只看 footer 是不是 `End of file`，于是
// `read(offset=55, limit=15)` **读到文件末尾**时被判成"整份读完"，
// 还原出片段正文、算出**片段指纹**，把注册表和 readSet 同时改掉 ——
// 实测（`_m27/minExp.mjs`）这会让"自己改完没重读"这个正确拒绝**变成放行**。
//
// 新判据：**首行行号必须是 1** 且 footer 存在，才算全文。
// 判据只在一处（`envelopeOf`），不会再出现"两处各判一遍、都判错"。

test('partialReadOf：**从中间开始读** → true（即使读到了文件末尾）', () => {
  // 这就是缺陷的触发条件：offset 生效 + footer 是 End of file。
  assert.equal(partialReadOf({
    content: [{
      type: 'text',
      text: envelope('55: 后半段\n56: 结尾', '(End of file - total 67 lines)'),
    }],
  }), true, '从第 55 行读到末尾仍被判成全文 —— 正是缺陷本身')
})

test('partialReadOf：只读了前一段（footer 是 Showing） → true', () => {
  assert.equal(partialReadOf({
    content: [{
      type: 'text',
      text: envelope('1: 第一行\n2: 第二行', '(Showing lines 1-2 of 100. Use offset=3 to continue.)'),
    }],
  }), true)
})

test('partialReadOf：被截断的输出 → true', () => {
  assert.equal(partialReadOf({
    content: [{
      type: 'text',
      text: envelope('1: 长行', '(Output capped. Showing lines 1-1. Use offset=2 to continue.)'),
    }],
  }), true)
})

test('partialReadOf：整份读完（首行是 1 + footer 是 End of file）→ false', () => {
  assert.equal(partialReadOf({
    content: [{ type: 'text', text: envelope('1: # 标题\n2: 正文', '(End of file - total 2 lines)') }],
  }), false)
})

test('partialReadOf：**没有 <content> 信封 → false**（宿主没给正文，不是片段读）', () => {
  // ⚠️ 这条就是冒烟抓到的那个回归：`{ isError: false }`（没有 content）
  // 曾经被当成窗口读，于是"刚读过却说没读"。
  assert.equal(partialReadOf({ isError: false }), false)
  assert.equal(partialReadOf({ content: [{ type: 'text', text: '随便什么' }] }), false)
  assert.equal(partialReadOf({ content: [] }), false)
  assert.equal(partialReadOf({}), false)
  assert.equal(partialReadOf(null), false)
  assert.equal(partialReadOf(undefined), false)
})

test('**M2.7：片段读时 textFromReadResult 必须返回 undefined**（不许还原出片段）', () => {
  // 这一条是 A 方案的核心保障：即使调用方忘了用 partialReadOf 拦截，
  // textFromReadResult 自己也不会吐出片段正文 —— 两道保险。
  assert.equal(textFromReadResult({
    content: [{
      type: 'text',
      text: envelope('55: 后半段\n56: 结尾', '(End of file - total 67 lines)'),
    }],
  }), undefined, 'offset 读被当成了全文 —— 会算出片段指纹')
})

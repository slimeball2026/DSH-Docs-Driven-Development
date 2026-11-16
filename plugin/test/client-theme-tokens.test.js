/**
 * client 源码的**主题 token 契约**测试。
 *
 * ---- 为什么这条值得单独一个测试文件 ----
 *
 * 2026-11-13 实机发现：整个面板的 CSS 变量名**全写错了**。
 * 代码里写的是 `--dsh-text-primary` / `--dsh-border` / `--dsh-accent` 一类，
 * 而宿主**真实**的主题 token 是 `--dsw-alias-*` 系列
 * （用 `cordis_inspect_query` 的 client `Theme.listTokens` 核过）。
 *
 * 后果很隐蔽：`var(--dsh-border, rgba(128,128,128,0.3))` 有 fallback，
 * 所以**看不出错** —— 页面照常渲染，只是一直用着硬编码的灰色，
 * **主题切换到浅色时不会跟着变**。这类 bug 不会自己暴露。
 *
 * 更直接的坑是下拉框：原生 `<select>` 的 `<option>` 不继承页面样式，
 * 只设 `color` 会让展开列表变成**白底白字**（只有鼠标悬停那行可见）。
 *
 * 所以这里钉两件事：
 *   1. 源码里**不许**出现不存在的 `--dsh-*` token；
 *   2. `<option>` 必须**显式**带背景色（不能靠继承）。
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_SRC = join(HERE, '..', 'src', 'client')

/** 宿主真实存在的主题 token（来自 client `Theme.listTokens`）。 */
const REAL_TOKENS = new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-brand-primary',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-specific-sidebar-fill',
])

function sourceFiles() {
  return readdirSync(CLIENT_SRC)
    .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))
    .map((name) => ({ name, text: readFileSync(join(CLIENT_SRC, name), 'utf8') }))
}

test('回归：源码里出现的每一个 `var(--…)` 都必须是宿主真实存在的 token', () => {
  const bad = []
  for (const { name, text } of sourceFiles()) {
    for (const match of text.matchAll(/var\((--[a-z0-9-]+)/g)) {
      const token = match[1]
      if (!REAL_TOKENS.has(token)) bad.push(`${name} → ${token}`)
    }
  }
  assert.deepEqual(
    bad,
    [],
    `用了不存在的主题 token（会静默走 fallback，主题切换时不变）：\n${bad.join('\n')}`,
  )
})

test('回归：**不许**再出现 `--dsh-` 前缀（那是我们瞎编的，宿主没有这一族）', () => {
  const bad = []
  for (const { name, text } of sourceFiles()) {
    for (const match of text.matchAll(/--dsh-[a-z0-9-]+/g)) bad.push(`${name} → ${match[0]}`)
  }
  assert.deepEqual(bad, [], `出现了不存在的 --dsh-* token：\n${bad.join('\n')}`)
})

test('回归：`<option>` 必须显式带 background（否则展开列表白底白字）', () => {
  // 原生 select 的 option 由系统绘制，**不继承** select 的 color/background。
  // 实测症状：下拉展开后每一行只有"白栏目"，文字要鼠标移上去才出现。
  const picker = readFileSync(join(CLIENT_SRC, 'index.tsx'), 'utf8')
  assert.match(picker, /option:\s*\{/, '必须有 option 专用样式块')
  const optionBlock = /option:\s*\{([\s\S]*?)\}/.exec(picker)
  assert.ok(optionBlock !== null, 'option 样式块解析失败')
  assert.match(optionBlock[1], /color:/, 'option 必须显式设 color')
  assert.match(optionBlock[1], /background:/, 'option 必须显式设 background —— 少这一条就是白底白字')
})

test('回归：每个渲染出来的 <option> 都带上那份样式（不能只写在 select 上）', () => {
  const picker = readFileSync(join(CLIENT_SRC, 'index.tsx'), 'utf8')
  // 找出所有 h('option', ...) 调用，检查都带了 style
  const calls = [...picker.matchAll(/h\('option',\s*\{([\s\S]*?)\}\s*,/g)]
  assert.ok(calls.length >= 2, `应当至少有两个 option（占位 + 列表项），实际 ${calls.length}`)
  for (const [, props] of calls) {
    assert.match(props, /style:\s*styles\.option/, `有 option 没带 styles.option：\n${props}`)
  }
})

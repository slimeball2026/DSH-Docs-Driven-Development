/**
 * 扫描管线的单测（`docs/scan.js`）。
 *
 * SPEC §12.1 的测试表里没单列它，但它串联 frontmatter → schema → 指纹，
 * 是"磁盘 → 内存"的唯一通路，必须有正反例。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildIndex } from '../core/index.js'
import { finalizeDocs, listDocFiles, readDoc, scanProject } from '../docs/scan.js'

const JOIN = (a, b) => `${a}\\${b}`

/** 内存文件系统。 */
function fakeFs(tree) {
  const files = new Map(Object.entries(tree))
  return {
    readText: async (path) => files.get(path),
    listDir: async (dir) => {
      const seen = new Map()
      for (const key of files.keys()) {
        if (!key.startsWith(`${dir}\\`)) continue
        const rest = key.slice(dir.length + 1)
        const [head, ...tail] = rest.split('\\')
        seen.set(head, tail.length === 0 ? 'file' : 'directory')
      }
      return [...seen].map(([name, type]) => ({ name, type }))
    },
  }
}

const DOC = (id, extra = '') => [
  '---',
  `id: ${id}`,
  'title: 标题',
  'role: spec',
  'order: 20',
  'status: authoritative',
  'summary: 摘要',
  'basis: 实测',
  extra,
  '---',
  '# 正文',
  '',
].filter((line) => line !== '').join('\n')

// ---------------------------------------------------------------- listDocFiles

test('listDocFiles：递归列出 .md', async () => {
  const fs = fakeFs({
    'D:\\p\\docs\\a.md': '',
    'D:\\p\\docs\\sub\\b.md': '',
    'D:\\p\\docs\\c.txt': '',
  })
  const { files } = await listDocFiles({ listDir: fs.listDir, docsAbs: 'D:\\p\\docs', joinPath: JOIN })
  assert.equal(files.length, 2)
  assert.ok(files.every((path) => path.endsWith('.md')))
})

test('**listDocFiles 跳过坟场**（SPEC §4.1：坟场不扫描）', async () => {
  const fs = fakeFs({
    'D:\\p\\docs\\a.md': '',
    'D:\\p\\docs\\_graveyard\\old.md': '',
  })
  const { files } = await listDocFiles({ listDir: fs.listDir, docsAbs: 'D:\\p\\docs', joinPath: JOIN })
  assert.deepEqual(files.map((path) => path.split('\\').pop()), ['a.md'])
})

test('listDocFiles 跳过 node_modules / .git', async () => {
  const fs = fakeFs({
    'D:\\p\\docs\\a.md': '',
    'D:\\p\\docs\\node_modules\\x.md': '',
    'D:\\p\\docs\\.git\\y.md': '',
  })
  const { files } = await listDocFiles({ listDir: fs.listDir, docsAbs: 'D:\\p\\docs', joinPath: JOIN })
  assert.equal(files.length, 1)
})

test('listDocFiles：文档数超上限时截断并标记', async () => {
  const tree = {}
  for (let i = 0; i < 20; i += 1) tree[`D:\\p\\docs\\d${i}.md`] = ''
  const fs = fakeFs(tree)
  const { files, truncated } = await listDocFiles({
    listDir: fs.listDir, docsAbs: 'D:\\p\\docs', joinPath: JOIN, maxFiles: 5,
  })
  assert.equal(files.length, 5)
  assert.equal(truncated, true)
})

test('listDocFiles：目录不存在时返回空而不是抛', async () => {
  const fs = fakeFs({})
  const { files } = await listDocFiles({ listDir: fs.listDir, docsAbs: 'D:\\nope', joinPath: JOIN })
  assert.deepEqual(files, [])
})

// ---------------------------------------------------------------- readDoc

test('readDoc：正常文档带指纹与 meta', async () => {
  const fs = fakeFs({ 'D:\\p\\docs\\a.md': DOC('a') })
  const item = await readDoc({ path: 'D:\\p\\docs\\a.md', readText: fs.readText })
  assert.equal(item.meta, null, 'readDoc 只做 provisional，meta 在 finalize 里填')
  assert.match(item.fingerprint, /^[0-9a-f]{8}$/)
  assert.equal(item.raw.id, 'a')
  assert.equal(item.parseError, null)
})

test('readDoc：文件不存在 → null', async () => {
  const fs = fakeFs({})
  assert.equal(await readDoc({ path: 'D:\\p\\docs\\gone.md', readText: fs.readText }), null)
})

test('readDoc：坟场里的文件即使被扫到也返回 null', async () => {
  const fs = fakeFs({ 'D:\\p\\docs\\_graveyard\\x.md': DOC('x') })
  const item = await readDoc({
    path: 'D:\\p\\docs\\_graveyard\\x.md',
    readText: fs.readText,
    classify: () => 'graveyard',
  })
  assert.equal(item, null)
})

test('readDoc：没有 frontmatter 的文件也能读出（present=false）', async () => {
  const fs = fakeFs({ 'D:\\p\\docs\\plain.md': '# 纯 Markdown\n' })
  const item = await readDoc({ path: 'D:\\p\\docs\\plain.md', readText: fs.readText })
  assert.equal(item.present, false)
  assert.equal(item.raw, null)
})

// ---------------------------------------------------------------- finalizeDocs

test('finalizeDocs：合法文档 hasError=false', async () => {
  const fs = fakeFs({ 'D:\\p\\docs\\a.md': DOC('a') })
  const item = await readDoc({ path: 'D:\\p\\docs\\a.md', readText: fs.readText })
  const [done] = finalizeDocs([item])
  assert.equal(done.hasError, false)
  assert.equal(done.meta.id, 'a')
})

test('**没有 frontmatter 的文件标 unmanaged，不算异常**', async () => {
  const fs = fakeFs({ 'D:\\p\\docs\\plain.md': '# 纯 Markdown\n' })
  const item = await readDoc({ path: 'D:\\p\\docs\\plain.md', readText: fs.readText })
  const [done] = finalizeDocs([item])
  assert.equal(done.unmanaged, true)
  assert.equal(done.hasError, false)
  // 且它不该进 anomalies。
  const index = buildIndex([done])
  assert.equal(index.anomalies.length, 0)
  assert.equal(index.required.length, 0)
})

test('**frontmatter 坏了（块式列表）→ hasError=true 且进 anomalies**', async () => {
  const fs = fakeFs({
    'D:\\p\\docs\\bad.md': '---\nid: bad\nrole: spec\nstatus: authoritative\nscope:\n  - x\n---\n正文\n',
  })
  const item = await readDoc({ path: 'D:\\p\\docs\\bad.md', readText: fs.readText })
  const [done] = finalizeDocs([item])
  assert.equal(done.hasError, true)
  assert.equal(done.meta, null)
  assert.equal(buildIndex([done]).anomalies.length, 1)
})

test('finalizeDocs：V5 跨文档校验能生效（引用不存在的 id 报 error）', async () => {
  const fs = fakeFs({
    'D:\\p\\docs\\a.md': DOC('a', 'supersedes: ["ghost"]'),
    'D:\\p\\docs\\b.md': DOC('b'),
  })
  const items = [
    await readDoc({ path: 'D:\\p\\docs\\a.md', readText: fs.readText }),
    await readDoc({ path: 'D:\\p\\docs\\b.md', readText: fs.readText }),
  ]
  const done = finalizeDocs(items)
  const a = done.find((item) => item.meta?.id === 'a')
  assert.equal(a.hasError, true)
  assert.ok(a.issues.some((issue) => issue.rule === 'V5'))
})

test('finalizeDocs：V6 跨文档 id 重复能生效', async () => {
  const fs = fakeFs({
    'D:\\p\\docs\\a.md': DOC('dup'),
    'D:\\p\\docs\\b.md': DOC('dup'),
  })
  const items = [
    await readDoc({ path: 'D:\\p\\docs\\a.md', readText: fs.readText }),
    await readDoc({ path: 'D:\\p\\docs\\b.md', readText: fs.readText }),
  ]
  const done = finalizeDocs(items)
  assert.ok(done.every((item) => item.hasError === true))
  assert.ok(done.every((item) => item.issues.some((issue) => issue.rule === 'V6')))
})

test('finalizeDocs：空输入不抛', () => {
  assert.deepEqual(finalizeDocs([]), [])
  assert.deepEqual(finalizeDocs(null), [])
})

// ---------------------------------------------------------------- scanProject（整条通路）

test('scanProject：端到端把磁盘变成可划分的条目', async () => {
  const fs = fakeFs({
    'D:\\p\\docs\\a.md': DOC('a'),
    'D:\\p\\docs\\b.md': DOC('b', 'status: sealed'),
    'D:\\p\\docs\\plain.md': '# 无 frontmatter\n',
    'D:\\p\\docs\\_graveyard\\old.md': DOC('old'),
  })
  const { entries } = await scanProject({
    listDir: fs.listDir,
    readText: fs.readText,
    docsAbs: 'D:\\p\\docs',
    joinPath: JOIN,
  })
  // 坟场被排除，plain.md 保留但 unmanaged。
  assert.equal(entries.length, 3)
  const index = buildIndex(entries)
  assert.deepEqual(index.required.map((item) => item.meta.id), ['a'])
  assert.deepEqual(index.forbidden.map((item) => item.meta.id), ['b'])
  assert.equal(index.anomalies.length, 0)
})

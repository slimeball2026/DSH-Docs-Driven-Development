/**
 * `server/init-workspace.ts` 与 `server/mkdir-bridge.ts` 的单测。
 *
 * ---- 这两个文件为什么必须有测试 ----
 *
 * 1. **`mkdir-bridge.ts` 是本项目唯一直接用 `node:fs` 的地方** ——
 *    它破了「插件从不创建目录」这条既有纪律（用户 2026-11-13 拍板允许）。
 *    破纪律的地方必须有最严的边界检查，否则一个 `..` 就能往项目外写。
 * 2. **初始化写下的 frontmatter 必须能被 `looksLikeDddDoc` 认出来** ——
 *    少一个字段就不构成激活标记，而症状是"面板说这不是 DDD 项目"，
 *    用户完全看不出哪里错了。
 * 3. **失败形状必须与成功同形**（都带 created/skipped/failed），
 *    client 会读 `.length`（M2.1 踩过 `undefined.length`）。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ensureDirectory } from '../server/mkdir-bridge.ts'
import { INIT_DOC_ID, initWorkspace, initialIndexDoc } from '../server/init-workspace.ts'
import { looksLikeDddDoc } from '../docs/marker.js'

/** 建一个临时项目根，用完删。 */
function tempProject() {
  const root = mkdtempSync(join(tmpdir(), 'ddd-init-'))
  return {
    root,
    cleanup() { rmSync(root, { recursive: true, force: true }) },
  }
}

/**
 * 假的 `ctx.fs`：只实现初始化用到的三件事，**行为对齐宿主的 target 形态**。
 *
 * 注意 `resolve(path)` 返回 `{ targetKey, displayPath }`，
 * `writeText` 的第一个参数是 target 而不是路径 —— 这就是真实形状。
 */
function fakeFs() {
  return {
    async resolve(path) {
      return { targetKey: `key:${path}`, displayPath: path }
    },
    async stat(target) {
      if (!existsSync(target.displayPath)) return undefined
      return { version: 'v1', type: 'file' }
    },
    async writeText(target, content, expected) {
      if (expected?.kind === 'createIfAbsent' && existsSync(target.displayPath)) {
        const error = new Error('FS_STALE_VERSION: target already exists')
        error.code = 'FS_STALE_VERSION'
        throw error
      }
      writeFileSync(target.displayPath, content, 'utf8')
      return { operation: 'create', version: 'v2', before: null, after: content }
    },
  }
}

// ---------------------------------------------------------------- 标记契约

test('**生成的入口索引必须构成激活标记**（否则面板说"这不是 DDD 项目"）', () => {
  const text = initialIndexDoc({ projectName: 'my-proj' })
  // 这一条是整份文件里最重要的：`looksLikeDddDoc` 就是探测用的那个判定。
  assert.equal(looksLikeDddDoc(text), true, '生成的 frontmatter 不被 looksLikeDddDoc 认 —— 初始化等于白做')
})

test('生成的入口索引含 id / role / status / summary（缺一个就不算标记）', () => {
  const text = initialIndexDoc({ projectName: 'my-proj' })
  assert.match(text, new RegExp(`^id: ${INIT_DOC_ID}$`, 'm'))
  assert.match(text, /^role: index$/m)
  assert.match(text, /^status: authoritative$/m)
  assert.match(text, /^summary: .+$/m)
  assert.match(text, /^basis: .+$/m)
})

test('生成的正文带项目名，且不含"编造"的必读项；必读清单是**自动块**（M3）', () => {
  const text = initialIndexDoc({ projectName: 'my-proj' })
  assert.match(text, /my-proj/, '正文应当提到项目名，方便用户确认写对了地方')
  // M3：成员与顺序由插件按 frontmatter 渲染，模板只留一个空标记块 + 人手写的「为什么读」。
  // 空块 = "还没渲染过"，第一次 doc_new/doc_mark 之后会被填上真实成员。
  assert.match(text, /<!-- ddd:auto:begin v1 -->/, '模板里没有自动块起点 —— M3 的功能不会生效')
  assert.match(text, /<!-- ddd:auto:end -->/, '模板里没有自动块终点')
  assert.match(text, /为什么读/, '没给"为什么读"留位置 —— 那块是判断，必须人手写')
  assert.doesNotMatch(text, /1\. `\w+`/, '模板里不该编造具体成员（应由 frontmatter 渲染）')
})

// ---------------------------------------------------------------- 建目录

test('mkdir-bridge：建一层目录，幂等', async () => {
  const { root, cleanup } = tempProject()
  try {
    const target = join(root, 'docs')
    const first = await ensureDirectory(root, target)
    assert.equal(first.ok, true)
    assert.equal(first.created, true)
    assert.equal(existsSync(target), true)

    const second = await ensureDirectory(root, target)
    assert.equal(second.ok, true)
    assert.equal(second.created, false, '已存在时不许说"创建了"')
  } finally { cleanup() }
})

test('**mkdir-bridge：拒绝在项目根之外建目录**（这条是破纪律的代价，必须钉死）', async () => {
  const { root, cleanup } = tempProject()
  try {
    for (const outside of [
      join(root, '..', 'evil'),
      join(root, '..', '..', 'evil2'),
    ]) {
      const result = await ensureDirectory(root, outside)
      assert.equal(result.ok, false, `居然允许建 ${outside}`)
      assert.match(result.error, /项目根之外/)
    }
    // 前缀陷阱：`<root>-evil` 不是 `<root>` 的子路径
    const sibling = `${root}-evil`
    const result = await ensureDirectory(root, sibling)
    assert.equal(result.ok, false, '前缀相同的兄弟目录不是子路径')
  } finally { cleanup() }
})

test('mkdir-bridge：目标是文件而不是目录 → 拒绝（不静默）', async () => {
  const { root, cleanup } = tempProject()
  try {
    const filePath = join(root, 'not-a-dir')
    writeFileSync(filePath, 'x', 'utf8')
    const result = await ensureDirectory(root, filePath)
    assert.equal(result.ok, false)
    assert.match(result.error, /不是目录/)
  } finally { cleanup() }
})

test('mkdir-bridge：父目录不存在 → 明说是父目录的问题（不 recursive 猜）', async () => {
  const { root, cleanup } = tempProject()
  try {
    const deep = join(root, 'a', 'b', 'c')
    const result = await ensureDirectory(root, deep)
    assert.equal(result.ok, false)
    assert.match(result.error, /父目录不存在/)
  } finally { cleanup() }
})

// ---------------------------------------------------------------- 初始化

test('initWorkspace：空目录 → 建 docs/ + 写入口索引，且结果可被探测', async () => {
  const { root, cleanup } = tempProject()
  try {
    const result = await initWorkspace({
      fs: fakeFs(),
      projectRoot: root,
      docsDir: 'docs',
      joinPath: join,
      basenameOf: (path) => path.split(/[\\/]/).filter(Boolean).pop() ?? path,
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(result.created.sort(), ['docs/', `docs/${INIT_DOC_ID}.md`])
    assert.deepEqual(result.skipped, [])
    assert.deepEqual(result.failed, [])

    // 真的写进去了，而且内容构成标记
    const written = readFileSync(join(root, 'docs', `${INIT_DOC_ID}.md`), 'utf8')
    assert.equal(looksLikeDddDoc(written), true, '写下的文件必须构成激活标记')
  } finally { cleanup() }
})

test('**initWorkspace：目标已存在 → 跳过，绝不覆盖**（用户文档优先）', async () => {
  const { root, cleanup } = tempProject()
  try {
    mkdirSync(join(root, 'docs'))
    const userText = '---\nid: mine\nrole: spec\nstatus: draft\n---\n\n用户自己的内容\n'
    writeFileSync(join(root, 'docs', `${INIT_DOC_ID}.md`), userText, 'utf8')

    const result = await initWorkspace({
      fs: fakeFs(),
      projectRoot: root,
      docsDir: 'docs',
      joinPath: join,
      basenameOf: () => 'proj',
    })
    assert.deepEqual(result.created, [], '什么都不该创建')
    assert.equal(result.skipped.length, 2, 'docs/ 与 read-order.md 都应记为跳过')
    // 最硬的一条：用户原文逐字不变
    assert.equal(readFileSync(join(root, 'docs', `${INIT_DOC_ID}.md`), 'utf8'), userText)
  } finally { cleanup() }
})

test('initWorkspace：没给项目根 → 失败形状仍带三个数组（client 会读 .length）', async () => {
  const result = await initWorkspace({
    fs: fakeFs(), projectRoot: '', docsDir: 'docs', joinPath: join, basenameOf: () => 'x',
  })
  assert.equal(result.ok, false)
  assert.ok(Array.isArray(result.created))
  assert.ok(Array.isArray(result.skipped))
  assert.ok(Array.isArray(result.failed))
  assert.equal(result.failed.length, 1)
})

test('initWorkspace：没有 fs → 失败但不抛，形状仍合法', async () => {
  const result = await initWorkspace({
    fs: undefined, projectRoot: 'C:\\x', docsDir: 'docs', joinPath: join, basenameOf: () => 'x',
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /文件系统/)
  assert.ok(Array.isArray(result.failed))
})

test('initWorkspace：写文件抛错 → 记进 failed，但**不抛给调用方**', async () => {
  const { root, cleanup } = tempProject()
  try {
    const brokenFs = {
      ...fakeFs(),
      async writeText() { throw new Error('磁盘满了') },
    }
    const result = await initWorkspace({
      fs: brokenFs, projectRoot: root, docsDir: 'docs', joinPath: join, basenameOf: () => 'proj',
    })
    assert.equal(result.ok, false)
    assert.equal(result.failed.length, 1)
    assert.match(result.failed[0].error, /磁盘满了/)
    // 目录仍然建好了（部分成功要如实反映）
    assert.equal(existsSync(join(root, 'docs')), true)
  } finally { cleanup() }
})

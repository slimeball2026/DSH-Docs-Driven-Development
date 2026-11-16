/**
 * M1.5 的**第 10 个缺陷**：`supersedes` 反填（M1.5 复核者补单测，2026-11-12）。
 *
 * ---- 这个缺陷是什么 ----
 *
 * `doc_new` 的自动取代第一版**只往旧的那份**写 `supersededBy: [新id]`，
 * **没往新的那份写 `supersedes: [旧id]`**。
 * 而 `doc_health` 的 **H-1** 判据要求**双向**
 * （「A.supersededBy 含 B，但 B.supersedes 不含 A」→ 报）。
 *
 * **后果**：任何一个正常交接的项目，**H-1 会随交接次数线性增长**。
 *
 * 施工者在 `live-evidence-v2.md` 里给了一张「决定性对比」表：
 *
 * | 时点 | 受管文档 | H-1 条数 |
 * |---|---|---|
 * | 修复前，建一份交接后 | 10 → 11 | 5 → 6（+1） |
 * | 修复后，建第一份 | 10 → 11 | 6 → **6**（+0） |
 * | 修复后，建第二份 | 11 → 12 | 6 → **6**（+0） |
 *
 * ---- 为什么必须补单测 ----
 *
 * 复核实测：把反填改成 `const backfilled = { ok: false }`（等于关掉反填），
 * **691 条单测全绿**，而且 **`repro-e2e.mjs` 仍 23/23 全过**。
 *
 * 也就是说：这个"第 10 个缺陷"的修法 **单测层和脚本层都抓不住**，
 * 它当时**只有实机证据**（`doc_health` 的输出）。改坏了没有任何自动化守卫。
 *
 * 本文件补上单测层。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { supersedeOldHandovers } from '../tools/doc-new.js'

/** 造一个记账用的假 fs。 */
function makeFs() {
  const files = new Map()
  return {
    files,
    fs: {
      resolve: async (p) => ({ displayPath: p, targetKey: p }),
      writeText: async (target, content) => { files.set(target.targetKey ?? target, content) },
    },
  }
}

/** 造一份交接条目。 */
function handover(id, order, status = 'draft', extraFields = '') {
  const text = `---\nid: ${id}\norder: ${order}\nstatus: ${status}\n${extraFields}---\n\n正文\n`
  return {
    path: `C:/proj/docs/${id}.md`,
    meta: { id, role: 'handover', order, status },
    text,
    hasError: false,
  }
}

// ---------------------------------------------------------------- 1. 反填的正面证据

test('反填：取代之后，**新那份的 `supersedes` 必须含旧 id**（H-1 的双向要求）', async () => {
  const { files, fs } = makeFs()
  const entries = [
    handover('h-old', -10, 'draft'),
    handover('h-new', -20, 'draft'),
  ]

  const done = await supersedeOldHandovers({
    reg: { entries, rescan: async () => {} },
    fs,
    selfId: 'h-new',
    projectRoot: 'C:/proj',
    exec: {},
  })

  assert.deepEqual(done, ['h-old'], '旧交接必须被取代')

  // ① 旧的：status + supersededBy（这一半 M1.5 第一版就有）
  const oldText = files.get('C:/proj/docs/h-old.md')
  assert.match(oldText, /^status: superseded$/m)
  assert.match(oldText, /supersededBy: \["h-new"\]/)

  // ② 新的：supersedes 反填（**这一半是第 10 个缺陷的修法**）
  const newText = files.get('C:/proj/docs/h-new.md')
  assert.notEqual(newText, undefined, '新那份也必须被写一次（反填）')
  assert.match(newText, /^supersedes: \["h-old"\]$/m, `新那份缺少 supersedes 反填：\n${newText}`)
})

test('反填：**两份**旧交接时，`supersedes` 是含两个 id 的列表', async () => {
  const { files, fs } = makeFs()
  const entries = [
    handover('h-a', 10, 'draft'),
    handover('h-b', 20, 'authoritative'),
    handover('h-new', -10, 'draft'),
  ]

  const done = await supersedeOldHandovers({
    reg: { entries, rescan: async () => {} },
    fs,
    selfId: 'h-new',
    projectRoot: 'C:/proj',
    exec: {},
  })

  assert.deepEqual(done.sort(), ['h-a', 'h-b'])
  const newText = files.get('C:/proj/docs/h-new.md')
  // 列表顺序取决于 entries 顺序，两种都接受，但**两个 id 都必须在**
  assert.match(newText, /^supersedes: /m, '必须有 supersedes 行')
  assert.ok(newText.includes('h-a'), `supersedes 里缺 h-a：\n${newText}`)
  assert.ok(newText.includes('h-b'), `supersedes 里缺 h-b：\n${newText}`)
})

// ---------------------------------------------------------------- 2. 不该反填的时候

test('反填：**没有旧交接**时，新那份一个字节都不写（无变化就不写盘）', async () => {
  const { files, fs } = makeFs()
  const entries = [handover('h-new', -10, 'draft')]

  const done = await supersedeOldHandovers({
    reg: { entries, rescan: async () => {} },
    fs,
    selfId: 'h-new',
    projectRoot: 'C:/proj',
    exec: {},
  })

  assert.deepEqual(done, [])
  assert.equal(files.size, 0, '没有要取代的，就一次写盘都不该发生')
})

test('反填：旧的都是**终态**时，同样不写盘', async () => {
  const { files, fs } = makeFs()
  const entries = [
    handover('h-sup', 10, 'superseded'),
    handover('h-void', 20, 'void'),
    handover('h-sealed', 30, 'sealed'),
    handover('h-new', -10, 'draft'),
  ]

  const done = await supersedeOldHandovers({
    reg: { entries, rescan: async () => {} },
    fs,
    selfId: 'h-new',
    projectRoot: 'C:/proj',
    exec: {},
  })

  assert.deepEqual(done, [])
  assert.equal(files.size, 0)
})

// ---------------------------------------------------------------- 3. 失败不回滚

test('反填：写**新**那份失败时，**取代本身已完成的结论不被推翻**（只 warn）', async () => {
  // 反填失败不影响"取代已完成"这个事实。H-1 会继续报，那是**可见的**，不是静默的。
  const written = []
  const fs = {
    resolve: async (p) => ({ displayPath: p, targetKey: p }),
    writeText: async (target, content) => {
      const key = target.targetKey ?? target
      // 只拒绝写「新的那份」，旧的照常写
      if (key.includes('h-new')) throw new Error('模拟写失败')
      written.push(key)
    },
  }
  const entries = [
    handover('h-old', -10, 'draft'),
    handover('h-new', -20, 'draft'),
  ]

  let warned = ''
  const done = await supersedeOldHandovers({
    reg: { entries, rescan: async () => {} },
    fs,
    selfId: 'h-new',
    projectRoot: 'C:/proj',
    exec: {},
    logger: { warn: (message) => { warned = message }, debug: () => {} },
  })

  assert.deepEqual(done, ['h-old'], '取代本身成功了，返回值不该被反填失败污染')
  assert.deepEqual(written, ['C:/proj/docs/h-old.md'], '旧的被写了')
  assert.match(warned, /反填/, `反填失败必须 warn（可见），实际：${JSON.stringify(warned)}`)
})

test('反填：`rescan` 抛错也不把异常冒出去（取代已完成）', async () => {
  const { fs } = makeFs()
  const entries = [
    handover('h-old', -10, 'draft'),
    handover('h-new', -20, 'draft'),
  ]

  const done = await supersedeOldHandovers({
    reg: { entries, rescan: async () => { throw new Error('模拟 rescan 失败') } },
    fs,
    selfId: 'h-new',
    projectRoot: 'C:/proj',
    exec: {},
    logger: { warn: () => {}, debug: () => {} },
  })

  assert.deepEqual(done, ['h-old'])
})

// ---------------------------------------------------------------- 4. 与 H-1 判据的对接

test('反填：反填之后，`doc_health` 的 H-1 **不再报**这份（端到端的那个因果）', async () => {
  // 这条把"反填"与"H-1 不报"直接连起来 —— 施工者的实机对比表说的就是这个因果。
  const { checkHealth } = await import('../core/health.js')

  const before = {
    path: 'C:/proj/docs/h-old.md',
    meta: { id: 'h-old', role: 'handover', order: -10, status: 'superseded', supersededBy: ['h-new'], basis: '实测' },
    text: '---\nid: h-old\n---\n',
    hasError: false,
  }
  const newWithoutBackfill = {
    path: 'C:/proj/docs/h-new.md',
    meta: { id: 'h-new', role: 'handover', order: -20, status: 'draft', basis: '实测' },
    text: '---\nid: h-new\n---\n',
    hasError: false,
  }

  const h1Before = checkHealth({ entries: [before, newWithoutBackfill] }).issues.filter((i) => i.rule === 'H-1')
  assert.equal(h1Before.length, 1, '没有反填时 H-1 必须报 1 条（这是缺陷的原形）')

  const newWithBackfill = {
    ...newWithoutBackfill,
    meta: { ...newWithoutBackfill.meta, supersedes: ['h-old'] },
  }
  const h1After = checkHealth({ entries: [before, newWithBackfill] }).issues.filter((i) => i.rule === 'H-1')
  assert.equal(h1After.length, 0, '反填之后 H-1 必须不报')
})

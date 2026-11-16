/**
 * `server/write-engine.ts` 的单测（M2-E：归档 / 还原的物理移动）。
 *
 * ---- 这一组测试要守住的东西（每一条都对应一个真实的失败面）----
 *
 * | # | 判据 | 不守会怎样 |
 * |---|---|---|
 * | 1 | 归档真的**移动**（源消失、目标出现） | "归档了"只是返回了一句 ok，文件还在原地 |
 * | 2 | 保留**原路径元数据**，且正文一个字节不变 | 还原时无处可回；或归档顺手把正文改了 |
 * | 3 | 还原能**放回原处**，并清掉元数据 | "归档 → 还原"不可逆，用户丢文件 |
 * | 4 | 目标已存在 → **拒绝覆盖** | 坟场里的旧文件被静默覆盖（数据丢失） |
 * | 5 | 源不存在 / id 不存在 → 显式失败，**不抛** | 一次坏输入让整批归档炸掉，HTTP 500 |
 * | 6 | 非 `void` 状态 → 拒绝 | 门禁/AI 提议那两段式被绕过 |
 * | 7 | 沙箱 policy 每次都传，且**模式是 workspace-write** | 撞 M1 踩过的 `file access denied`（真 bug） |
 * | 8 | 删源失败 → **显式失败**（不许静默成功） | 文件在两处都有，用户以为挪走了 |
 *
 * ---- 假 fs 为什么必须模拟 `createIfAbsent` 与 `stat` ----
 *
 * 真宿主的 `ctx.fs` 语义是：`writeText` 带 `{kind:'createIfAbsent'}` 时，目标已存在会**抛**；
 * `deleteFile` 带 `{version}` 守卫时会检查版本。假 fs 如果不模拟这两条，
 * 那么"目标已存在 → 拒绝覆盖"这条测试就会**在错误的实现上也是绿的**（假绿）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ARCHIVE_META,
  ARCHIVABLE_STATUS,
  archiveDocuments,
  archiveRefusalOf,
  archivedFromOf,
  baseNameOf,
  joinPath,
  normalizeSlashes,
  relativeToRoot,
  restoreDocuments,
  sandboxPolicyFor,
  withArchiveMeta,
  withoutArchiveMeta,
} from '../server/write-engine.ts'
import { parseFrontmatter } from '../docs/frontmatter.js'

const ROOT = 'C:/proj'

/**
 * 造一份假 `ctx.fs`：内存里的文件表 + 记录每次写/删的 policy。
 *
 * @param {Record<string, string>} [initial] 初始文件（键是绝对路径，`/` 分隔）
 * @returns {object}
 */
function fakeFs(initial = {}) {
  /** @type {Map<string, {text: string, version: number}>} */
  const files = new Map()
  let counter = 0
  for (const [path, text] of Object.entries(initial)) {
    files.set(normalizeSlashes(path), { text, version: (counter += 1) })
  }

  const writes = []
  const deletes = []

  const api = {
    /** 测试用：直接看文件表。 */
    files,
    writes,
    deletes,

    /** 测试用：读一份（不存在返回 undefined）。 */
    peek(path) {
      return files.get(normalizeSlashes(path))?.text
    },
    /** 测试用：文件是否存在。 */
    has(path) {
      return files.has(normalizeSlashes(path))
    },
    /** 测试用：让下一次 `deleteFile` 抛错（模拟删源失败）。 */
    failDelete: false,

    async resolve(path, opts) {
      const raw = normalizeSlashes(path)
      const absolute = raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)
        ? raw
        : joinPath(normalizeSlashes(opts?.cwd ?? ROOT), raw)
      // targetKey 是**不透明身份**：这里用路径本身代替，够断言用。
      return { targetKey: absolute, displayPath: absolute }
    },

    async stat(target) {
      const record = files.get(target.targetKey)
      return record === undefined ? undefined : { version: record.version, type: 'file', size: record.text.length }
    },

    async readText(target) {
      const record = files.get(target.targetKey)
      if (record === undefined) throw new Error('FS_NOT_FOUND')
      return record.text
    },

    async writeText(target, content, expected, _signal, policy) {
      writes.push({ path: target.targetKey, policy, expected })
      const exists = files.has(target.targetKey)
      if (expected?.kind === 'createIfAbsent' && exists) {
        throw new Error('FS_EXISTS')
      }
      if (expected?.kind === 'replaceIfVersion' && exists) {
        const record = files.get(target.targetKey)
        if (record.version !== expected.version) throw new Error('FS_STALE_VERSION')
      }
      files.set(target.targetKey, { text: content, version: (counter += 1) })
      return { operation: exists ? 'update' : 'create', version: (counter += 1), before: null, after: content }
    },

    async deleteFile(target, expected, _signal, policy) {
      deletes.push({ path: target.targetKey, policy })
      if (api.failDelete) throw new Error('FS_DENIED')
      const record = files.get(target.targetKey)
      if (record === undefined) throw new Error('FS_STALE_VERSION')
      if (expected?.version !== undefined && record.version !== expected.version) throw new Error('FS_STALE_VERSION')
      files.delete(target.targetKey)
      return { before: record.text }
    },
  }
  return api
}

/** 一份合法 `void` 文档的正文。 */
const VOID_DOC = [
  '---',
  'id: old-plan',
  'title: 一个被放弃的方案',
  'role: decision',
  'order: 90',
  'status: void',
  'summary: 已作废：这个方案从来没被采纳',
  'basis: 实测',
  '---',
  '',
  '# 一个被放弃的方案',
  '',
  '正文里有 **markdown**、有 `code`、还有中文。',
  '',
].join('\n')

/** 造一条注册表条目（只给 write-engine 用到的字段）。 */
function entryOf(id, path, status, extra = {}) {
  return {
    path,
    meta: { id, status, ...(extra.meta ?? {}) },
    inGraveyard: extra.inGraveyard === true,
  }
}

// ---------------------------------------------------------------- 1. 纯函数（拼路径 / 元数据）

test('relativeToRoot：项目内路径按 `/` 返回；不在根下返回空串（**不猜**）', () => {
  assert.equal(relativeToRoot('C:/proj/docs/a.md', ROOT), 'docs/a.md')
  assert.equal(relativeToRoot('C:\\proj\\docs\\a.md', 'C:\\proj'), 'docs/a.md')
  // 前缀陷阱：`docs-old/` 不是 `docs/`（与 docs/path.js 同一条纪律）
  assert.equal(relativeToRoot('C:/proj2/docs/a.md', ROOT), '')
  assert.equal(relativeToRoot('D:/elsewhere/a.md', ROOT), '')
  assert.equal(relativeToRoot('C:/proj', ROOT), '', '根本身不算"根下的一份文件"')
  assert.equal(relativeToRoot('', ROOT), '')
})

test('joinPath / baseNameOf / normalizeSlashes：不 import node:path 也要拼得对', () => {
  assert.equal(joinPath('C:/proj', 'docs/_graveyard/x.md'), 'C:/proj/docs/_graveyard/x.md')
  assert.equal(joinPath('C:/proj/', '/docs/x.md'), 'C:/proj/docs/x.md')
  assert.equal(joinPath('C:/proj', ''), 'C:/proj')
  assert.equal(baseNameOf('docs/a/b/x.md'), 'x.md')
  assert.equal(baseNameOf('x.md'), 'x.md')
  assert.equal(baseNameOf(''), '')
  assert.equal(normalizeSlashes('a\\b\\c'), 'a/b/c')
})

test('withArchiveMeta → archivedFrom / archivedAt 写进 frontmatter，**正文一个字节不变**', () => {
  const edited = withArchiveMeta(VOID_DOC, { from: 'docs/old-plan.md', at: '2026-11-13T20:00:00.000Z' })
  assert.equal(edited.ok, true)

  const parsed = parseFrontmatter(edited.text)
  assert.equal(parsed.error, null, '写完之后 frontmatter 必须仍然可解析')
  assert.equal(parsed.meta[ARCHIVE_META.from], 'docs/old-plan.md')
  assert.equal(parsed.meta[ARCHIVE_META.at], '2026-11-13T20:00:00.000Z')

  // 正文（frontmatter 之后的部分）必须逐字相同 —— 这是"归档不改内容"的判据。
  const before = parseFrontmatter(VOID_DOC).body
  assert.equal(parsed.body, before, '正文被改动了')

  // 原有字段一个都不许丢
  for (const key of ['id', 'title', 'role', 'order', 'status', 'summary', 'basis']) {
    assert.deepEqual(parsed.meta[key], parseFrontmatter(VOID_DOC).meta[key], `字段 ${key} 变了`)
  }
})

test('withoutArchiveMeta：清干净两个字段，其它字段与正文不动（**可逆**）', () => {
  const archived = withArchiveMeta(VOID_DOC, { from: 'docs/old-plan.md', at: '2026-11-13T20:00:00.000Z' }).text
  const restored = withoutArchiveMeta(archived)
  assert.equal(restored.ok, true)

  const parsed = parseFrontmatter(restored.text)
  assert.equal(parsed.meta[ARCHIVE_META.from], undefined, 'archivedFrom 没被删掉')
  assert.equal(parsed.meta[ARCHIVE_META.at], undefined, 'archivedAt 没被删掉')
  assert.equal(parsed.body, parseFrontmatter(VOID_DOC).body, '还原后正文变了')

  // 往返断言：归档→还原之后，**正文与全部业务字段都与原始一致**。
  // （frontmatter 的行序可能因为"删键再拼"而变化，所以这里比字段而不是比字节。）
  const original = parseFrontmatter(VOID_DOC).meta
  for (const key of Object.keys(original)) {
    assert.deepEqual(parsed.meta[key], original[key], `往返之后 ${key} 变了`)
  }
})

test('archivedFromOf：没有元数据就返回空串，**绝不猜路径**', () => {
  assert.equal(archivedFromOf(VOID_DOC), '')
  assert.equal(archivedFromOf('没有 frontmatter 的文本'), '')
  assert.equal(archivedFromOf(''), '')
  assert.equal(archivedFromOf('---\nid: x\n---\n'), '')
  // 有元数据就取出来（并做 trim）
  assert.equal(archivedFromOf('---\nid: x\narchivedFrom: "  docs/x.md  "\n---\n'), 'docs/x.md')
})

test('archiveRefusalOf：只有 `void` 可以归档，且已经在坟场里的不再归档', () => {
  assert.equal(archiveRefusalOf(entryOf('a', 'C:/proj/docs/a.md', 'void')), undefined)
  for (const status of ['authoritative', 'partial', 'draft', 'superseded', 'sealed']) {
    assert.notEqual(archiveRefusalOf(entryOf('a', 'C:/proj/docs/a.md', status)), undefined, `${status} 不该被放行`)
  }
  assert.notEqual(archiveRefusalOf(entryOf('a', 'C:/proj/docs/a.md', 'void', { inGraveyard: true })), undefined)
  assert.notEqual(archiveRefusalOf({ path: 'C:/proj/docs/a.md', meta: null }), undefined)
  // `superseded` ≠ 待归档（SPEC §8.4 的明文：两者不能互相替代）
  assert.notEqual(archiveRefusalOf(entryOf('a', 'C:/proj/docs/a.md', 'superseded')), undefined)
})

test('sandboxPolicyFor：**永远是 workspace-write**，绝不放宽成 danger-full-access', () => {
  const policy = sandboxPolicyFor('C:/proj')
  assert.equal(policy.mode, 'workspace-write')
  assert.equal(policy.workspaceRoot, 'C:/proj')
})

test('ARCHIVABLE_STATUS 与 `docs/schema.js` 的 status 枚举一致（写错会静默永不匹配）', async () => {
  const { STATUSES } = await import('../docs/schema.js')
  assert.ok(STATUSES.includes(ARCHIVABLE_STATUS), `${ARCHIVABLE_STATUS} 不在 status 枚举里`)
})

// ---------------------------------------------------------------- 2. 归档：真的移动

test('**归档：真的移动**（源消失、目标出现、正文原样）', async () => {
  const fs = fakeFs({ 'C:/proj/docs/old-plan.md': VOID_DOC })
  const result = await archiveDocuments({
    ids: ['old-plan'],
    entries: [entryOf('old-plan', 'C:/proj/docs/old-plan.md', 'void')],
    fs,
    projectRoot: ROOT,
    graveyardDir: 'docs/_graveyard',
    docsDir: 'docs',
    now: () => '2026-11-13T20:00:00.000Z',
  })

  assert.equal(result.ok, true, JSON.stringify(result.failed))
  assert.equal(result.moved.length, 1)
  assert.equal(result.moved[0].from, 'docs/old-plan.md')
  assert.equal(result.moved[0].to, 'docs/_graveyard/old-plan.md')

  assert.equal(fs.has('C:/proj/docs/old-plan.md'), false, '源文件还在 —— 没有真的移动')
  assert.equal(fs.has('C:/proj/docs/_graveyard/old-plan.md'), true, '坟场里没有文件')

  // 正文必须原样（除了新增的两个元数据字段）
  const moved = fs.peek('C:/proj/docs/_graveyard/old-plan.md')
  assert.equal(parseFrontmatter(moved).body, parseFrontmatter(VOID_DOC).body)
  assert.equal(archivedFromOf(moved), 'docs/old-plan.md')
})

test('**归档：每次都把沙箱 policy 传下去**（不传就是 M1 那个 file access denied 真 bug）', async () => {
  const fs = fakeFs({ 'C:/proj/docs/old-plan.md': VOID_DOC })
  await archiveDocuments({
    ids: ['old-plan'],
    entries: [entryOf('old-plan', 'C:/proj/docs/old-plan.md', 'void')],
    fs,
    projectRoot: ROOT,
    graveyardDir: 'docs/_graveyard',
    docsDir: 'docs',
  })

  assert.equal(fs.writes.length, 1)
  assert.deepEqual(fs.writes[0].policy, { mode: 'workspace-write', workspaceRoot: ROOT })
  assert.deepEqual(fs.writes[0].expected, { kind: 'createIfAbsent' }, '目标必须用原子存在性守卫')
  assert.equal(fs.deletes.length, 1)
  assert.deepEqual(fs.deletes[0].policy, { mode: 'workspace-write', workspaceRoot: ROOT })
})

test('**归档：目标已存在 → 拒绝覆盖**（坟场里旧的那份不能被静默吃掉）', async () => {
  const fs = fakeFs({
    'C:/proj/docs/old-plan.md': VOID_DOC,
    'C:/proj/docs/_graveyard/old-plan.md': '---\nid: older\n---\n坟场里早就有一份\n',
  })
  const result = await archiveDocuments({
    ids: ['old-plan'],
    entries: [entryOf('old-plan', 'C:/proj/docs/old-plan.md', 'void')],
    fs,
    projectRoot: ROOT,
    graveyardDir: 'docs/_graveyard',
    docsDir: 'docs',
  })

  assert.equal(result.ok, false)
  assert.equal(result.moved.length, 0)
  assert.equal(result.failed.length, 1)
  assert.match(result.failed[0].error, /已有|拒绝覆盖/)

  // 源还在（没有半途而废）、旧的那份也没被改
  assert.equal(fs.peek('C:/proj/docs/old-plan.md'), VOID_DOC)
  assert.match(fs.peek('C:/proj/docs/_graveyard/old-plan.md'), /坟场里早就有一份/)
})

test('归档：源不存在 → 显式失败，**不抛**', async () => {
  const fs = fakeFs({})
  const result = await archiveDocuments({
    ids: ['old-plan'],
    entries: [entryOf('old-plan', 'C:/proj/docs/old-plan.md', 'void')],
    fs,
    projectRoot: ROOT,
    graveyardDir: 'docs/_graveyard',
    docsDir: 'docs',
  })
  assert.equal(result.ok, false)
  assert.match(result.failed[0].error, /源文件不存在/)
})

test('归档：id 不存在 / 非 void / 不在 docs 下 → 逐条失败，**一份坏的不连累其它份**', async () => {
  const fs = fakeFs({
    'C:/proj/docs/keep.md': VOID_DOC.replace('id: old-plan', 'id: keep'),
    'C:/proj/docs/live.md': VOID_DOC.replace('id: old-plan', 'id: live').replace('status: void', 'status: authoritative'),
    'C:/proj/src/weird.md': VOID_DOC.replace('id: old-plan', 'id: weird'),
  })
  const result = await archiveDocuments({
    ids: ['keep', 'ghost', 'live', 'weird'],
    entries: [
      entryOf('keep', 'C:/proj/docs/keep.md', 'void'),
      entryOf('live', 'C:/proj/docs/live.md', 'authoritative'),
      entryOf('weird', 'C:/proj/src/weird.md', 'void'),
    ],
    fs,
    projectRoot: ROOT,
    graveyardDir: 'docs/_graveyard',
    docsDir: 'docs',
  })

  assert.equal(result.moved.length, 1, '只有 keep 应当成功')
  assert.equal(result.moved[0].id, 'keep')
  assert.equal(result.failed.length, 3)
  const byId = new Map(result.failed.map((item) => [item.id, item.error]))
  assert.match(byId.get('ghost'), /找不到 id/)
  assert.match(byId.get('live'), /不是 `void`/)
  assert.match(byId.get('weird'), /不在 `docs\/` 之下/)
  assert.equal(result.ok, false, '有失败时 ok 必须是 false')
})

test('**归档：删源失败 → 显式失败**（不许静默说"归档成功"）', async () => {
  const fs = fakeFs({ 'C:/proj/docs/old-plan.md': VOID_DOC })
  fs.failDelete = true
  const result = await archiveDocuments({
    ids: ['old-plan'],
    entries: [entryOf('old-plan', 'C:/proj/docs/old-plan.md', 'void')],
    fs,
    projectRoot: ROOT,
    graveyardDir: 'docs/_graveyard',
    docsDir: 'docs',
    logger: { warn: () => {} },
  })

  assert.equal(result.ok, false, '源没删掉却报成功 —— 用户会以为已经挪走了')
  assert.equal(result.moved.length, 0)
  assert.equal(result.failed[0].sourceStillThere, true)
  assert.match(result.failed[0].error, /删不掉/)
})

test('归档：坏输入一律不抛（fs 缺失 / 项目根空 / ids 空 / 垃圾参数）', async () => {
  const cases = [
    undefined,
    {},
    { ids: ['x'] },
    { fs: fakeFs(), projectRoot: '' },
    { fs: fakeFs(), projectRoot: ROOT, ids: [] },
    { fs: fakeFs(), projectRoot: ROOT, ids: [null, 42, ''] },
    { fs: { resolve: 'not-a-function' }, projectRoot: ROOT, ids: ['x'] },
  ]
  for (const input of cases) {
    // ⚠️ 失败形状必须与成功**同形**（都带三个数组）。
    // 第一版早退分支只给 `{ok:false, error}`，于是 client 读 `failed.length` 会炸在
    // `undefined.length` —— 而那条路径正是"参数不对"时最常走的一条。
    const result = await archiveDocuments(input)
    assert.equal(result.ok, false, `这个输入不该成功：${JSON.stringify(input)}`)
    assert.deepEqual(result.moved, [], '失败时 moved 必须是空数组，不是 undefined')
    assert.equal(Array.isArray(result.failed), true, '失败时 failed 必须是数组')
    assert.equal(typeof result.error, 'string')
  }
})

// ---------------------------------------------------------------- 3. 还原

test('**还原：能放回原处，并清掉归档元数据**', async () => {
  const archived = withArchiveMeta(VOID_DOC, { from: 'docs/old-plan.md', at: '2026-11-13T20:00:00.000Z' }).text
  const fs = fakeFs({ 'C:/proj/docs/_graveyard/old-plan.md': archived })

  const result = await restoreDocuments({
    paths: ['docs/_graveyard/old-plan.md'],
    fs,
    projectRoot: ROOT,
  })

  assert.equal(result.ok, true, JSON.stringify(result.failed))
  assert.equal(result.restored[0].to, 'docs/old-plan.md')
  assert.equal(fs.has('C:/proj/docs/old-plan.md'), true, '没有放回原处')
  assert.equal(fs.has('C:/proj/docs/_graveyard/old-plan.md'), false, '坟场里那份没删')

  const back = fs.peek('C:/proj/docs/old-plan.md')
  assert.equal(archivedFromOf(back), '', '还原后还留着 archivedFrom')
  assert.equal(parseFrontmatter(back).body, parseFrontmatter(VOID_DOC).body, '还原后正文变了')
})

test('**还原：原位已有文件 → 拒绝覆盖**（绝不丢用户数据）', async () => {
  const archived = withArchiveMeta(VOID_DOC, { from: 'docs/old-plan.md', at: 'x' }).text
  const fs = fakeFs({
    'C:/proj/docs/_graveyard/old-plan.md': archived,
    'C:/proj/docs/old-plan.md': '---\nid: old-plan\n---\n新写的版本\n',
  })

  const result = await restoreDocuments({
    paths: ['docs/_graveyard/old-plan.md'],
    fs,
    projectRoot: ROOT,
  })

  assert.equal(result.ok, false)
  assert.equal(result.restored.length, 0)
  assert.match(result.failed[0].error, /拒绝覆盖/)
  assert.match(fs.peek('C:/proj/docs/old-plan.md'), /新写的版本/, '原位那份被覆盖了')
})

test('**还原：没有 archivedFrom → 显式失败，不猜路径**', async () => {
  const fs = fakeFs({ 'C:/proj/docs/_graveyard/manual.md': '---\nid: manual\nstatus: void\n---\n手工扔进来的\n' })
  const result = await restoreDocuments({
    paths: ['docs/_graveyard/manual.md'],
    fs,
    projectRoot: ROOT,
  })
  assert.equal(result.ok, false)
  // ⚠️ 断言必须**区分两条失败**：这条说"没有元数据"，下一条说"元数据不安全"。
  // 第一版这里只断言 `/archivedFrom/`，而两条文案都含它 —— 于是变异
  // `W-restore-no-origin`（把这一支关掉）**存活**了（M2.1 实测）。
  // 判据要锚定到**这一支特有**的那半句：
  assert.match(result.failed[0].error, /没有 `archivedFrom` 元数据/)
  assert.doesNotMatch(result.failed[0].error, /不安全|不安全的项目外路径/, '走的不是"缺元数据"那一支')
  assert.equal(fs.has('C:/proj/docs/_graveyard/manual.md'), true, '被拒绝时不该删源')
})

test('还原：`archivedFrom` 带 `..` → 拒绝（不许逃出项目根）', async () => {
  const fs = fakeFs({
    'C:/proj/docs/_graveyard/evil.md': '---\nid: evil\narchivedFrom: "../../etc/evil.md"\n---\n',
  })
  const result = await restoreDocuments({ paths: ['docs/_graveyard/evil.md'], fs, projectRoot: ROOT })
  assert.equal(result.ok, false)
  assert.match(result.failed[0].error, /不安全的项目外路径/)
  assert.equal(fs.has('C:/proj/docs/_graveyard/evil.md'), true, '被拒绝时不该删源')
})

test('还原：坟场里没有那个文件 → 显式失败，不抛', async () => {
  const fs = fakeFs({})
  const result = await restoreDocuments({ paths: ['docs/_graveyard/nope.md'], fs, projectRoot: ROOT })
  assert.equal(result.ok, false)
  assert.match(result.failed[0].error, /没有这个文件/)
})

test('还原：坏输入一律不抛', async () => {
  for (const input of [undefined, {}, { fs: fakeFs(), projectRoot: ROOT, paths: [] }, { paths: ['x'] }]) {
    const result = await restoreDocuments(input)
    assert.equal(result.ok, false)
  }
})

test('**失败形状必须与成功同形**（client 会读 `failed.length`，undefined 会让 UI 炸）', async () => {
  // 这条是 `_m21/probe-routes-wired.mjs` 抓出来的真 bug 的回归：
  // `index.js` 在"不是 DDD 项目"时早退，第一版只给 `{ok:false, error}`，
  // 于是 client 读 `result.failed.length` → `undefined.length` → 整个面板崩在
  // **"用户在非 DDD 项目里点了归档"** 这条最普通的路径上。
  //
  // 判据：**任何一个失败返回**（早退 / 逐条失败）都必须带三个数组。
  const failCases = [
    await archiveDocuments(undefined),
    await archiveDocuments({ ids: ['x'] }),
    await archiveDocuments({ fs: fakeFs(), projectRoot: '' }),
    await archiveDocuments({ fs: fakeFs(), projectRoot: ROOT, ids: [] }),
    await restoreDocuments(undefined),
    await restoreDocuments({ fs: fakeFs(), projectRoot: ROOT, paths: [] }),
  ]
  for (const [index, result] of failCases.entries()) {
    assert.equal(result.ok, false, `case ${index} 不该成功`)
    assert.equal(Array.isArray(result.failed), true, `case ${index} 的 failed 不是数组`)
    assert.equal(Array.isArray(result.moved), true, `case ${index} 的 moved 不是数组`)
    assert.equal(Array.isArray(result.restored), true, `case ${index} 的 restored 不是数组`)
  }
})

// ---------------------------------------------------------------- 4. 往返（这一条是 M2-5 的核心判据）

test('**往返：归档 → 还原，文件回到原处且正文逐字一致**', async () => {
  const fs = fakeFs({ 'C:/proj/docs/old-plan.md': VOID_DOC })
  const entries = [entryOf('old-plan', 'C:/proj/docs/old-plan.md', 'void')]

  const archived = await archiveDocuments({
    ids: ['old-plan'],
    entries,
    fs,
    projectRoot: ROOT,
    graveyardDir: 'docs/_graveyard',
    docsDir: 'docs',
    now: () => '2026-11-13T20:00:00.000Z',
  })
  assert.equal(archived.ok, true)

  const restored = await restoreDocuments({
    paths: [archived.moved[0].to],
    fs,
    projectRoot: ROOT,
  })
  assert.equal(restored.ok, true, JSON.stringify(restored.failed))

  assert.equal(fs.has('C:/proj/docs/old-plan.md'), true)
  assert.equal(fs.has('C:/proj/docs/_graveyard/old-plan.md'), false)
  assert.equal(parseFrontmatter(fs.peek('C:/proj/docs/old-plan.md')).body, parseFrontmatter(VOID_DOC).body)
})

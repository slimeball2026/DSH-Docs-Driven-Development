/**
 * M3 · 入口索引「必读清单」半自动渲染 + 旧交接重新记账（O1）。
 *
 * ---- 用户 2026-11-20 拍板 ----
 *
 * 1. 写入时机：`doc_new` / `doc_mark` **之后自动**（不让 AI 多付出一步）；
 *    冲突策略：**warn**（只有交接或明确要求时，人手改自动块才是合理的）。
 * 2. `doc_new` 建交接会自改别的文档（旧交接 superseded + read-order）——
 *    那些改动是**插件自己**做的，不能让模型误以为是"外部变更"而被要求重读。
 *
 * 测试分三层：
 *   · 纯函数（`core/requiredList.js`）：渲染 / 冲突 / 旧项目不接管；
 *   · 接线（`doc_new` / `doc_mark` 端到端）：块真的写进 read-order；
 *   · 反例网：外部改动仍然要被门禁拦、手写清单仍然不能被覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyRequiredList, buildRequiredForList, hashOf, renderRequiredBlock, renderRequiredBody,
} from '../core/requiredList.js'
import { createNewTool } from '../tools/doc-new.js'
import { createMarkTool } from '../tools/doc-mark.js'
import { resolveConfig } from '../config.js'
import { buildIndex } from '../core/index.js'
import { parseFrontmatter } from '../docs/frontmatter.js'
import { fingerprintOf } from '../docs/fingerprint.js'

const CONFIG = resolveConfig({})
const ROOT = 'C:/proj'

/** 造一个条目（纯函数层用；不需要真文件）。 */
function entryOf(id, extra = {}) {
  return {
    path: `${ROOT}/docs/${id}.md`,
    text: '',
    body: '',
    fingerprint: `FP-${id}`,
    hasError: false,
    unmanaged: false,
    meta: {
      id, title: `${id} 标题`, role: 'spec', order: 20, status: 'authoritative',
      summary: `${id} 摘要`, basis: '实测', ...extra,
    },
  }
}

/**
 * 内存 world：真实解析 frontmatter + 真实重扫 + 真实 readSet / selfWritten。
 *
 * 为什么不用 `tools.test.js` 那个 fakeWorld：它的 `rescan` 是空实现，
 * 而本组测试的核心恰恰是"插件写了盘 → rescan 之后指纹变了 → 门禁怎么判"。
 * 桩不跟着磁盘走，断言的就不再是真行为。
 */
function makeWorld(initialFiles) {
  const files = new Map(initialFiles)
  let entries = []
  let index = { required: [], forbidden: [], anomalies: [] }
  const reads = new Map()
  const selfWritten = new Map()
  const notes = []

  const parse = (path, text) => {
    const parsed = parseFrontmatter(text)
    return {
      path,
      text,
      body: parsed.body,
      meta: parsed.meta,
      fingerprint: fingerprintOf(text),
      hasError: parsed.present === true && parsed.meta === null,
      unmanaged: parsed.present !== true,
    }
  }

  function rescan() {
    entries = []
    for (const [path, text] of files) {
      if (!/\.md$/i.test(path)) continue
      if (!/[\\/]docs[\\/]/.test(path)) continue
      entries.push(parse(path, text))
    }
    index = buildIndex(entries)
  }

  const registry = {
    state: 'ready',
    get entries() { return entries },
    get index() { return index },
    readSetFor: () => reads,
    readSet: reads,
    entryById: (id) => entries.find((item) => item?.meta?.id === id),
    entryByPath: (path) => entries.find((item) => item?.path === path),
    fingerprintOf: (id) => entries.find((item) => item?.meta?.id === id)?.fingerprint,
    textOf: (id) => entries.find((item) => item?.meta?.id === id)?.text,
    hasError: (id) => entries.find((item) => item?.meta?.id === id)?.hasError === true,
    markRead: (path, _session, seq, freshText) => {
      const entry = entries.find((item) => item.path === path)
      if (entry === undefined) return false
      reads.set(entry.meta.id, {
        fingerprint: entry.fingerprint,
        text: typeof freshText === 'string' ? freshText : entry.text,
        at: typeof seq === 'number' ? seq : 0,
      })
      return true
    },
    noteSelfWrite: (path) => {
      const entry = entries.find((item) => item.path === path)
      if (entry === undefined) return
      notes.push(entry.meta.id)
      selfWritten.set(entry.meta.id, entry.fingerprint)
    },
    isSelfWritten: (id) => {
      const record = selfWritten.get(id)
      if (record === undefined) return false
      return record === entries.find((item) => item?.meta?.id === id)?.fingerprint
    },
    rescan: async () => { rescan() },
  }

  const fs = {
    resolve: async (path) => ({ targetKey: path, displayPath: path }),
    writeText: async (target, content) => { files.set(target.targetKey, content); return { operation: 'update' } },
    readText: async (target) => files.get(target.targetKey),
  }

  rescan()
  return { files, reads, notes, registry, fs, rescan }
}

const newTool = (world) => createNewTool({
  config: CONFIG, registry: () => world.registry, fs: world.fs,
  projectRoot: () => ROOT, cwdOf: () => ROOT,
})
const markTool = (world) => createMarkTool({
  config: CONFIG, registry: () => world.registry, fs: world.fs,
  readRecordOf: (_session, id) => world.reads.get(id),
  projectRootOf: () => ROOT, cwdOf: () => ROOT,
})
const execOf = () => ({ agent: { session: { header: { cwd: ROOT } } }, seq: 100, signal: undefined })

/** 与 `server/init-workspace.ts` 生成的 read-order 同形（M3 起模板会带标记块）。 */
function indexDocText(listBody = '') {
  return [
    '---',
    'id: read-order',
    'title: 入口索引',
    'role: index',
    'order: 0',
    'status: authoritative',
    'summary: 本项目的阅读入口。',
    'basis: 实测',
    '---',
    '',
    '# 入口索引',
    '',
    '## 必读清单',
    '',
    '<!-- 用列表列出必读文档。没有就先留空，别编。 -->',
    '',
    '- （还没有必读文档。往 `docs/` 里加一份，再在这里登记。）',
    '',
    listBody,
    '## 下一步',
    '',
    '- 先建一份施工图。',
    '',
    '## 陷阱',
    '',
    '- 别加外链。',
    '',
  ].join('\n')
}

/** 旧项目：手写清单（没有自动块）。 */
function legacyIndexText() {
  return [
    '---',
    'id: read-order',
    'title: 入口索引',
    'role: index',
    'order: 0',
    'status: authoritative',
    'summary: 入口',
    'basis: 实测',
    '---',
    '',
    '## 必读清单',
    '',
    '1. `spec-1`（order 10，spec）—— 先读它。',
    '',
    '## 下一步',
    '',
    '- 建交接。',
    '',
  ].join('\n')
}

// ---------------------------------------------------------------- 纯函数：渲染

test('hashOf：同内容同哈希、8 位十六进制、内容变了哈希就变', () => {
  assert.match(hashOf('abc'), /^[0-9a-f]{8}$/)
  assert.equal(hashOf('abc'), hashOf('abc'))
  assert.notEqual(hashOf('abc'), hashOf('abd'))
  // 归一化之外的变化必须被看见（否则冲突检测形同虚设）
  assert.notEqual(hashOf('a\nb'), hashOf('a\nb\nc'))
})

test('buildRequiredForList：可执行文档 + 非终态交接，按 order/id 排序', () => {
  const entries = [
    entryOf('spec-b', { order: 20 }),
    entryOf('spec-a', { order: 10, status: 'partial', scope: ['x'] }),
    entryOf('draft-spec', { status: 'draft', order: 30 }),
    entryOf('bad-doc', { order: 40 }),
    entryOf('old-handover', { role: 'handover', status: 'superseded', order: -20 }),
    entryOf('new-handover', { role: 'handover', status: 'draft', order: -10 }),
    entryOf('dead-doc', { order: 50, status: 'void' }),
  ]
  // `hasError` 的文档不进清单（与 buildIndex 同一口径）。
  entries.find((item) => item.meta.id === 'bad-doc').hasError = true
  const list = buildRequiredForList(entries)
  assert.deepEqual(
    list.map((item) => item.meta.id),
    ['new-handover', 'spec-a', 'spec-b'],
    '排序或成员不对：draft 交接要保留（M2.8 的"先读这份"语义），终态交接必须去掉',
  )
})

test('renderRequiredBody：每行带 id / order / status / summary，且带序号', () => {
  const body = renderRequiredBody([entryOf('spec-1', { order: 10 }), entryOf('h-1', { role: 'handover', order: -10 })])
  assert.match(body.body, /^1\. `spec-1` · order 10 · authoritative · spec-1 摘要$/m)
  assert.match(body.body, /^2\. `h-1` · order -10 · authoritative · h-1 摘要$/m)
  assert.equal(body.count, 2)
  assert.match(renderRequiredBlock([]).body, /当前没有必读文档/)
})

// ---------------------------------------------------------------- 纯函数：合并

test('applyRequiredList：空的「必读清单」→ 插入自动块，其它小节一个字节不动', () => {
  const before = indexDocText()
  const result = applyRequiredList(before, [entryOf('read-order', { role: 'index', order: 0 })])
  assert.equal(result.applied, true)
  assert.equal(result.changed, true)
  assert.match(result.text, /<!-- ddd:auto:begin v1 hash=[0-9a-f]{8} -->/)
  assert.match(result.text, /1\. `read-order` · order 0 · authoritative/)
  // 占位行被换掉；引导注释与其它小节保留
  assert.doesNotMatch(result.text, /还没有必读文档/)
  assert.match(result.text, /<!-- 用列表列出必读文档/)
  assert.match(result.text, /## 下一步\n\n- 先建一份施工图。/)
  assert.match(result.text, /## 陷阱\n\n- 别加外链。/)
})

test('applyRequiredList：第二次应用是幂等的（不产生无谓写盘）', () => {
  const entries = [entryOf('read-order', { role: 'index', order: 0 }), entryOf('spec-1', { order: 10 })]
  const first = applyRequiredList(indexDocText(), entries)
  const second = applyRequiredList(first.text, entries)
  assert.equal(second.changed, false, '同一份 frontmatter 渲染两次却变了 —— 会让每次工具调用都写盘')
  assert.equal(second.text, first.text)
})

test('applyRequiredList：状态变了 → 重渲染且 hash 跟着更新', () => {
  const entries = [entryOf('read-order', { role: 'index', order: 0 }), entryOf('spec-1', { order: 10, status: 'draft' })]
  const first = applyRequiredList(indexDocText(), entries)
  assert.doesNotMatch(first.text, /`spec-1`/, 'draft 文档不该进必读清单')

  const promoted = [entries[0], entryOf('spec-1', { order: 10, status: 'authoritative' })]
  const second = applyRequiredList(first.text, promoted)
  assert.equal(second.changed, true)
  assert.match(second.text, /`spec-1` · order 10 · authoritative/)
  const hashes = second.text.match(/hash=([0-9a-f]{8})/g)
  assert.equal(hashes.length, 1, '块里只该有一个 hash')
  assert.notEqual(hashes[0], first.text.match(/hash=[0-9a-f]{8}/)[0], 'hash 没跟着内容更新')
})

test('**人手改过自动块 → 不覆盖，只 warn**（用户拍板：冲突策略 = warn）', () => {
  const entries = [entryOf('read-order', { role: 'index', order: 0 }), entryOf('spec-1', { order: 10 })]
  const first = applyRequiredList(indexDocText(), entries)
  // 有人在块里加了一句（模拟"交接时特意写的说明"）
  const handEdited = first.text.replace(
    /(<!-- ddd:auto:begin[^>]*-->\n)/,
    '$1- 这是人手写的一句说明。\n',
  )
  const second = applyRequiredList(handEdited, entries)
  assert.equal(second.changed, false, '覆盖了人手改过的块 —— 用户明确要求冲突时只 warn')
  assert.equal(second.text, handEdited, '返回了新文本 —— 调用方会把它写进磁盘')
  assert.match(second.warning, /手改/)
  assert.match(second.warning, /hash/)
})

test('applyRequiredList：**没有 hash 的空块**（init 模板）→ 接管并填上 hash', () => {
  const templated = indexDocText().replace(
    /- （还没有必读文档。往 `docs\/` 里加一份，再在这里登记。）/,
    '<!-- ddd:auto:begin v1 -->\n<!-- ddd:auto:end -->',
  )
  const result = applyRequiredList(templated, [entryOf('read-order', { role: 'index', order: 0 })])
  assert.equal(result.applied, true)
  assert.equal(result.changed, true)
  assert.match(result.text, /hash=[0-9a-f]{8}/)
})

test('applyRequiredList：**旧项目的手写清单 → 不接管、不覆盖**', () => {
  const legacy = legacyIndexText()
  const result = applyRequiredList(legacy, [entryOf('read-order', { role: 'index', order: 0 })])
  assert.equal(result.applied, false)
  assert.equal(result.changed, false)
  assert.equal(result.text, legacy, '手写清单被改写了 —— 那是用户/AI 写的，插件不该替它判成员')
})

test('applyRequiredList：有头无尾的坏块 → 只 warn，不猜', () => {
  const broken = indexDocText().replace('<!-- ddd:auto:end -->', '')
  const withBegin = broken.replace(
    '- （还没有必读文档。往 `docs/` 里加一份，再在这里登记。）',
    '<!-- ddd:auto:begin v1 hash=deadbeef -->\n- `x` · order 1 · draft · y',
  )
  const result = applyRequiredList(withBegin, [entryOf('read-order', { role: 'index', order: 0 })])
  assert.equal(result.changed, false)
  assert.match(result.warning, /有头无尾|缺/)
})

test('applyRequiredList：没有「必读清单」小节 → 不猜结构', () => {
  const text = '---\nid: read-order\nrole: index\nstatus: authoritative\nsummary: s\nbasis: 实测\n---\n\n# 索引\n'
  const result = applyRequiredList(text, [entryOf('read-order', { role: 'index', order: 0 })])
  assert.equal(result.applied, false)
  assert.equal(result.text, text)
})

// ---------------------------------------------------------------- 接线：doc_new

test('doc_new 之后 read-order 的必读清单**自动出现块**，且不会让 read-order 变未读', async () => {
  const world = makeWorld(new Map([['C:/proj/docs/read-order.md', indexDocText()]]))
  const tool = newTool(world)

  // 会话已读过 read-order（门禁本来就会先把必读读一遍）
  world.reads.set('read-order', { fingerprint: world.registry.entryById('read-order').fingerprint })

  const value = await tool.execute(
    { role: 'spec', title: '施工图', summary: '甲', id: 'spec-1', order: 10, body: '# 施工图\n' },
    execOf(),
  )
  assert.equal(value.requiredListApplied, true, '没有接管必读清单')
  assert.equal(value.requiredListWarning, '')

  const indexText = world.files.get('C:/proj/docs/read-order.md')
  assert.match(indexText, /<!-- ddd:auto:begin v1 hash=/)
  // draft 文档不进清单（门禁的 required 也是这个口径）→ 块里只有 read-order 自己。
  assert.doesNotMatch(indexText, /`spec-1`/, 'draft 文档被列进必读清单了')

  // 关键是"它没变未读"：否则模型下一次改 docs 会被要求整份重读
  const current = world.registry.entryById('read-order').fingerprint
  assert.equal(world.reads.get('read-order').fingerprint, current,
    '自动改写 read-order 之后没刷新已读指纹 —— 每建一份文档都会逼模型重读索引')
  assert.ok(world.notes.includes('read-order'), '没记 selfWritten —— 下一次 edit 索引会被指纹拦截')
})

test('doc_new 建交接：新交接进清单（order 最小）；旧交接被取代后从清单消失', async () => {
  const oldHandover = [
    '---', 'id: handover-old', 'title: 旧交接', 'role: handover', 'order: -10',
    'status: authoritative', 'summary: 旧', 'basis: 实测', '---', '', '# 旧交接', '',
  ].join('\n')
  const world = makeWorld(new Map([
    ['C:/proj/docs/read-order.md', indexDocText()],
    ['C:/proj/docs/handover-old.md', oldHandover],
  ]))
  // 前端实机 fe2 的现场：AI 先读了旧交接
  world.reads.set('handover-old', { fingerprint: world.registry.entryById('handover-old').fingerprint })

  const tool = newTool(world)
  await tool.execute(
    { role: 'handover', title: '新交接', summary: '乙', id: 'handover-new', body: '# 新交接\n' },
    execOf(),
  )

  const indexText = world.files.get('C:/proj/docs/read-order.md')
  assert.match(indexText, /`handover-new` · order -20 · draft/, '新交接没进清单（M2.8 的"先读这份"语义丢了）')
  assert.doesNotMatch(indexText, /handover-old/, '已被取代的旧交接还留在清单里')
})

test('**O1 回归：doc_new 自动 supersede 旧交接后，同一会话 doc_mark 旧交接不许再要求重读**', async () => {
  const oldHandover = [
    '---', 'id: handover-old', 'title: 旧交接', 'role: handover', 'order: -10',
    'status: authoritative', 'summary: 旧', 'basis: 实测', '---', '', '# 旧交接', '',
  ].join('\n')
  const world = makeWorld(new Map([
    ['C:/proj/docs/read-order.md', indexDocText()],
    ['C:/proj/docs/handover-old.md', oldHandover],
  ]))
  world.reads.set('handover-old', {
    fingerprint: world.registry.entryById('handover-old').fingerprint,
    text: oldHandover,
  })

  const created = await newTool(world).execute(
    { role: 'handover', title: '新交接', summary: '乙', id: 'handover-new', body: '# 新交接\n' },
    execOf(),
  )
  assert.deepEqual(created.supersededOld, ['handover-old'], '前置：旧交接没被自动取代')
  assert.equal(world.registry.entryById('handover-old').meta.status, 'superseded')

  // 关键断言：不重读、直接 doc_mark —— 必须放行（fe2 seq198 的回归）
  await assert.doesNotReject(
    () => markTool(world).execute({ id: 'handover-old', status: 'void', reason: '被新交接取代' }, execOf()),
    '插件自己改了旧交接，却让模型以为"外部变更"而被要求整份重读',
  )
})

test('**O1 反例：外部改动旧交接 → doc_mark 仍然必须被拒**（不许误放行）', async () => {
  const oldHandover = [
    '---', 'id: handover-old', 'title: 旧交接', 'role: handover', 'order: -10',
    'status: authoritative', 'summary: 旧', 'basis: 实测', '---', '', '# 旧交接', '',
  ].join('\n')
  const world = makeWorld(new Map([
    ['C:/proj/docs/read-order.md', indexDocText()],
    ['C:/proj/docs/handover-old.md', oldHandover],
  ]))
  world.reads.set('handover-old', { fingerprint: world.registry.entryById('handover-old').fingerprint })

  // 外部改：换了正文，不经过任何工具
  world.files.set('C:/proj/docs/handover-old.md', oldHandover.replace('# 旧交接', '# 旧交接（别人改过）'))
  world.rescan()

  await assert.rejects(
    () => markTool(world).execute({ id: 'handover-old', status: 'void', reason: 'x' }, execOf()),
    /重读|旧版/,
    '外部改动被当成"自己写的"放行了 —— 模型会拿没看过的内容当依据',
  )
})

// ---------------------------------------------------------------- 接线：doc_mark

test('doc_mark 标绿之后：必读清单自动收录它（这是 status 的投影）', async () => {
  const world = makeWorld(new Map([
    ['C:/proj/docs/read-order.md', indexDocText()],
  ]))
  // 先建一份 draft spec（它在清单外）
  await newTool(world).execute(
    { role: 'spec', title: '施工图', summary: '甲', id: 'spec-1', order: 10, body: '# 施工图\n' },
    execOf(),
  )
  world.reads.set('read-order', { fingerprint: world.registry.entryById('read-order').fingerprint })
  world.reads.set('spec-1', { fingerprint: world.registry.entryById('spec-1').fingerprint })

  const value = await markTool(world).execute({ id: 'spec-1', status: 'authoritative', basis: '实测' }, execOf())
  assert.equal(value.requiredListApplied, true)
  assert.equal(value.requiredListChanged, true)
  assert.match(world.files.get('C:/proj/docs/read-order.md'), /`spec-1` · order 10 · authoritative/)

  const rendered = markTool(world).output.render({}, value).map((item) => item.text ?? '').join('\n')
  assert.match(rendered, /自动重渲染/, '回执没说"清单已自动更新" —— 模型不会知道谁改的')
})

test('doc_mark：自动块被手改过 → 回执必须说清"没覆盖"（warn），且块保持原样', async () => {
  const world = makeWorld(new Map([['C:/proj/docs/read-order.md', indexDocText()]]))
  await newTool(world).execute(
    { role: 'spec', title: '施工图', summary: '甲', id: 'spec-1', order: 10, body: '# 施工图\n' },
    execOf(),
  )
  const before = world.files.get('C:/proj/docs/read-order.md')
  // 人手在块里加一行
  const handEdited = before.replace(/(<!-- ddd:auto:begin[^>]*-->\n)/, '$1- 人手备注。\n')
  world.files.set('C:/proj/docs/read-order.md', handEdited)
  world.rescan()
  world.reads.set('read-order', { fingerprint: world.registry.entryById('read-order').fingerprint })
  world.reads.set('spec-1', { fingerprint: world.registry.entryById('spec-1').fingerprint })

  const value = await markTool(world).execute({ id: 'spec-1', status: 'authoritative', basis: '实测' }, execOf())
  assert.match(value.requiredListWarning, /手改/)
  assert.equal(world.files.get('C:/proj/docs/read-order.md'), handEdited, '手改过的块被覆盖了')
})

// ---------------------------------------------------------------- 接线：旧项目

test('旧项目（手写清单）：doc_new 建交接仍然走旧的"插一行"逻辑，且**不插入自动块**', async () => {
  const world = makeWorld(new Map([['C:/proj/docs/read-order.md', legacyIndexText()]]))
  const value = await newTool(world).execute(
    { role: 'handover', title: '交接', summary: '甲', id: 'handover-1', body: '# 交接\n' },
    execOf(),
  )
  assert.equal(value.requiredListApplied, false, '旧项目被自动接管了 —— 会覆盖手写清单')
  assert.equal(value.indexRegistered, true, '旧逻辑的兜底也失效了（交接没进索引）')
  const indexText = world.files.get('C:/proj/docs/read-order.md')
  assert.doesNotMatch(indexText, /ddd:auto:begin/, '不该给旧项目插自动块')
  assert.match(indexText, /`handover-1`/, '交接没被登记进手写清单')
})
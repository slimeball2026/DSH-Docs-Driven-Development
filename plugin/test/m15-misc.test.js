/**
 * M1.5 的收尾项单测：D3（lastWriter）、N4（异常行用相对路径）、N7（§7 关键词）、D7。
 *
 * 这四条都是"中低"级，但它们共同的特征是：
 * **改坏了不会立刻炸，只会让某个判据悄悄失效。** 所以每条都要有反向断言。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { LAST_WRITER_FILE, recordLastWriter, relativeKeyOf } from '../adapters/last-writer.js'
import { anomalyLine } from '../core/index.js'
import { renderIndexBlock } from '../core/render.js'
import { SECTIONS, parseHandoverSections } from '../core/handover.js'

// ---------------------------------------------------------------- D3：lastWriter

test('D3：relativeKeyOf 把绝对路径折成相对项目根的键', () => {
  assert.equal(relativeKeyOf('C:/proj/docs/a.md', 'C:/proj'), 'docs/a.md')
  assert.equal(relativeKeyOf('C:\\proj\\docs\\a.md', 'C:/proj'), 'docs/a.md')
  assert.equal(relativeKeyOf('C:/proj/docs/a.md', 'C:/proj/'), 'docs/a.md')
})

test('D3：项目根之外的路径 → undefined（不记）', () => {
  assert.equal(relativeKeyOf('C:/other/docs/a.md', 'C:/proj'), undefined)
  assert.equal(relativeKeyOf('C:/proj', 'C:/proj'), undefined)
  assert.equal(relativeKeyOf('', 'C:/proj'), undefined)
  assert.equal(relativeKeyOf('C:/proj/docs/a.md', ''), undefined)
})

test('D3：大小写不敏感（Windows 上 C:\\Proj 与 c:\\proj 是同一处）', () => {
  assert.equal(relativeKeyOf('C:/Proj/Docs/A.md', 'c:/proj'), 'Docs/A.md')
})

/** 造一个内存 fs。 */
function memFs(initial = {}) {
  const files = new Map(Object.entries(initial))
  return {
    files,
    resolve: async (path) => ({ displayPath: path, targetKey: path }),
    readText: async (target) => files.get(target.targetKey ?? target),
    writeText: async (target, content) => {
      files.set(target.targetKey ?? target, content)
    },
  }
}

test('D3：写一条记录，键是相对路径，且带 sessionId / seq / tool', async () => {
  const fs = memFs()
  const ok = await recordLastWriter({
    absPath: 'C:/proj/docs/a.md',
    projectRoot: 'C:/proj',
    session: { id: 'session-abc' },
    seq: 42,
    tool: 'edit',
    fs,
    now: () => '2026-11-12T10:00:00.000Z',
  })
  assert.equal(ok, true)

  const raw = fs.files.get(`C:/proj/_artifacts/${LAST_WRITER_FILE}`)
  assert.ok(raw !== undefined, '应当写进 _artifacts/last-writer.json')
  const record = JSON.parse(raw)
  assert.deepEqual(record['docs/a.md'], {
    sessionId: 'session-abc',
    seq: 42,
    at: '2026-11-12T10:00:00.000Z',
    tool: 'edit',
  })
})

test('D3：第二次写会**合并**，不覆盖别的文档的记录', async () => {
  const fs = memFs()
  const base = { projectRoot: 'C:/proj', fs, now: () => 'T' }
  await recordLastWriter({ ...base, absPath: 'C:/proj/docs/a.md', seq: 1 })
  await recordLastWriter({ ...base, absPath: 'C:/proj/docs/b.md', seq: 2 })
  const record = JSON.parse(fs.files.get(`C:/proj/_artifacts/${LAST_WRITER_FILE}`))
  assert.deepEqual(Object.keys(record).sort(), ['docs/a.md', 'docs/b.md'])
})

test('D3：**历史记录坏了也不拒绝记账**（当成空对象重来）', async () => {
  const fs = memFs({ [`C:/proj/_artifacts/${LAST_WRITER_FILE}`]: 'not json{{{' })
  const ok = await recordLastWriter({
    absPath: 'C:/proj/docs/a.md', projectRoot: 'C:/proj', seq: 9, fs, now: () => 'T',
  })
  assert.equal(ok, true)
  const record = JSON.parse(fs.files.get(`C:/proj/_artifacts/${LAST_WRITER_FILE}`))
  assert.equal(record['docs/a.md'].seq, 9)
})

test('D3：**写失败不抛**（审计线索不该让正常写入变成失败）', async () => {
  const fs = {
    resolve: async (p) => ({ targetKey: p }),
    readText: async () => undefined,
    writeText: async () => { throw new Error('file access denied under workspace-write mode') },
  }
  const ok = await recordLastWriter({
    absPath: 'C:/proj/docs/a.md', projectRoot: 'C:/proj', seq: 1, fs, now: () => 'T',
  })
  assert.equal(ok, false, '失败返回 false，但**不抛**')
})

test('D3：**没有 fs 也不抛**', async () => {
  assert.equal(await recordLastWriter({ absPath: 'C:/proj/docs/a.md', projectRoot: 'C:/proj' }), false)
  assert.equal(await recordLastWriter({}), false)
  assert.equal(await recordLastWriter(null), false)
})

// ---------------------------------------------------------------- N4：异常行

test('N4：anomalyLine 有 id 时用 id（不用路径）', () => {
  const line = anomalyLine({
    meta: { id: 'bad-doc' },
    path: 'C:/proj/docs/bad-doc.md',
    issues: [{ level: 'error', message: 'role 不在枚举内' }],
  }, 'C:/proj')
  assert.match(line, /^bad-doc:/)
  assert.equal(line.includes('C:/proj'), false, '不能出现绝对路径')
})

test('N4：没有 id 时用**相对项目根**的路径，不用绝对路径', () => {
  const line = anomalyLine({
    meta: null,
    path: 'C:/proj/docs/spec-anchored.md',
    issues: [{ level: 'error', message: '不支持块式嵌套' }],
  }, 'C:/proj')
  assert.equal(line, 'docs/spec-anchored.md: 不支持块式嵌套')
  assert.equal(line.includes('C:/proj'), false)
})

test('N4：**不给 projectRoot 时退回原路径**（向后兼容，M0 的行为不能变）', () => {
  const line = anomalyLine({
    meta: null,
    path: 'docs/bad.md',
    issues: [{ level: 'error', message: 'x' }],
  })
  assert.match(line, /bad\.md/)
})

test('N4：索引块【文档异常】里没有绝对路径', () => {
  const block = renderIndexBlock({
    index: {
      required: [],
      forbidden: [],
      anomalies: [{
        meta: null,
        path: 'C:/Users/someone/very/long/path/docs/spec-anchored.md',
        issues: [{ level: 'error', message: '不支持块式嵌套（缩进子键）' }],
      }],
    },
    readSet: new Map(),
    activated: true,
    projectRoot: 'C:/Users/someone/very/long/path',
  })
  assert.equal(block.includes('C:/Users'), false, `索引块里不该出现绝对路径：${block}`)
  assert.match(block, /docs\/spec-anchored\.md/)
})

test('N4：算不出相对路径时用 `(未知文档)`，**不截断、不猜**', () => {
  const block = renderIndexBlock({
    index: {
      required: [],
      forbidden: [],
      anomalies: [{ meta: null, path: 'D:/elsewhere/x.md', issues: [{ level: 'error', message: 'x' }] }],
    },
    readSet: new Map(),
    activated: true,
    projectRoot: 'C:/proj',
  })
  assert.match(block, /\(未知文档\)/)
  assert.equal(block.includes('D:/elsewhere'), false)
})

// ---------------------------------------------------------------- N7：§7 关键词

test('N7：§7 标题写「已拍板」→ **H1 通过**（不再判不合格）', () => {
  const body = `## 1. 我的意图

写点什么。

## 2. 现在到哪了

| a | b |
|---|---|
| 1 | 2 |

## 3. 下一刀

- 改 \`core/gate.js\`

## 4. 坑

| # | 坑 |
|---|---|
| 1 | x |

## 5. 验收

- session-abc seq=1

## 6. 刻意没做

- 无

## 7. 已拍板（2026-11-12，用户确认，冻结，不要重开）

- 无
`
  const sections = parseHandoverSections(body)
  assert.equal(sections.open.found, true, '「已拍板」必须被认成 §7')
})

test('N7：其它新关键词也认', () => {
  for (const title of ['决策台账', '拍板完毕', '已裁定']) {
    const body = `## 7. ${title}\n\n- 无\n`
    const sections = parseHandoverSections(body)
    assert.equal(sections.open.found, true, `「${title}」应当被认成 §7`)
  }
})

test('N7：旧关键词**仍然有效**（不破坏现存交接）', () => {
  for (const title of ['仍未决', '需要拍板', '未决']) {
    const body = `## 7. ${title}\n\n- 无\n`
    assert.equal(parseHandoverSections(body).open.found, true, `「${title}」应当仍然有效`)
  }
})

test('N7：§7 的关键词表确实变长了（回归：别被改回去）', () => {
  const open = SECTIONS.find((spec) => spec.key === 'open')
  assert.ok(open.keywords.includes('已拍板'))
  assert.ok(open.keywords.includes('决策台账'))
  assert.ok(open.keywords.includes('仍未决'), '旧关键词不能删')
})

// M4: seven-section cross-check retired; legacy navigation parsing above remains covered.

import assert from 'node:assert/strict'
import test from 'node:test'
import { createNewTool, renderDocText } from '../tools/doc-new.js'
import { createMarkTool } from '../tools/doc-mark.js'
import { decideGate } from '../core/gate.js'
import { replaceObserved } from '../tools/document-write.js'
import { parseFrontmatter } from '../docs/frontmatter.js'
import { fingerprintOf } from '../docs/fingerprint.js'
import { buildIndex } from '../core/index.js'
import { entryPointOf } from '../core/navigation.js'

function reviewWorld() {
  const root = 'C:/publication-review'
  const files = new Map(), versions = new Map(), readSet = new Map()
  let beforeScan = () => {}, beforeWrite = () => {}
  const put = (path, text) => { files.set(path, text); versions.set(path, (versions.get(path) ?? 0) + 1) }
  const fs = {
    resolve: async (path) => ({ targetKey: path, displayPath: path }),
    stat: async (target) => files.has(target.targetKey) ? { type: 'file', version: String(versions.get(target.targetKey)) } : undefined,
    readText: async (target) => { if (!files.has(target.targetKey)) throw new Error('ENOENT'); return files.get(target.targetKey) },
    writeText: async (target, text, intent) => {
      beforeWrite(target.targetKey, text)
      const path = target.targetKey
      if (intent?.kind === 'createIfAbsent' && files.has(path)) throw new Error('exists')
      if (intent?.kind === 'replaceIfVersion' && String(versions.get(path)) !== intent.version) throw new Error('FS_STALE_VERSION')
      put(path, text)
      return { operation: 'update', version: String(versions.get(path)), after: text, before: null }
    },
  }
  const reg = {
    state: 'ready', entries: [], index: {},
    async rescan() {
      beforeScan()
      this.entries = [...files].map(([path, text]) => {
        const parsed = parseFrontmatter(text)
        return { path, text, body: parsed.body, meta: parsed.meta, fingerprint: fingerprintOf(text), hasError: false, issues: [] }
      })
      this.index = buildIndex(this.entries)
    },
    entryById(id) { return this.entries.find((entry) => entry.meta.id === id) },
    readSetFor() { return readSet },
    noteSelfWrite() {},
    markRead(path, _session, _seq, text) {
      const item = this.entries.find((entry) => entry.path === path)
      if (item) readSet.set(item.meta.id, { fingerprint: fingerprintOf(text) })
    },
  }
  const tool = createNewTool({ registry: reg, fs, config: { docsDir: 'docs' }, projectRoot: () => root })
  const mark = createMarkTool({ registry: reg, fs, projectRootOf: () => root, readRecordOf: (_session, id) => readSet.get(id) })
  return { files, put, reg, root, mark,
    beforeScan(fn) { beforeScan = fn }, beforeWrite(fn) { beforeWrite = fn },
    create(id, status = 'authoritative') {
      return tool.execute({ id, role: 'handover', title: id, summary: id, status, body: 'original body' }, {})
    },
  }
}

test('review: multi-predecessor failure preserves externally edited predecessor and a retry works', async () => {
  const w = reviewWorld()
  await w.create('old')
  w.put(`${w.root}/docs/old-b.md`, renderDocText({ id: 'old-b', title: 'old-b', summary: 'old-b', role: 'handover', status: 'authoritative', order: -5 }, 'body b'))
  await w.reg.rescan()
  let failed = false
  w.beforeWrite((path, text) => {
    if (!failed && path.endsWith('/old-b.md') && text.includes('status: superseded')) {
      failed = true
      const oldPath = `${w.root}/docs/old.md`
      w.put(oldPath, w.files.get(oldPath) + '\nEXTERNAL AFTER SUPERSEDE\n')
      throw new Error('publication failure')
    }
  })
  const result = await w.create('next')
  assert.equal(result.published, false)
  assert.match(w.files.get(`${w.root}/docs/old.md`), /EXTERNAL AFTER SUPERSEDE/)
  assert.equal(w.reg.entryById('old-b').meta.status, 'authoritative')
  assert.match(result.warning, /未恢复/)
  w.beforeWrite(() => {})
  await w.mark.execute({ id: 'next', status: 'authoritative' }, {})
  assert.equal(entryPointOf(w.reg.entries).meta.id, 'next')
  assert.match(w.files.get(`${w.root}/docs/old.md`), /EXTERNAL AFTER SUPERSEDE/)
  assert.ok(w.reg.entryById('next').meta.supersedes.includes('old'),
    'retry must repair the back-reference for a predecessor whose supersede write could not be rolled back')
})

test('review: correct doc path category protects stale edits and allows published revisions', () => {
  const required = [{ meta: { id: 'current', role: 'handover', status: 'authoritative' } }]
  const opts = { toolName: 'edit', args: { file_path: 'C:/p/docs/current.md', old_string: 'a', new_string: 'b' },
    gateEnabled: true, classify: () => 'doc', metaOf: () => required[0].meta, required,
    readSet: new Map([['current', { fingerprint: 'before' }]]), currentFingerprint: () => 'after' }
  assert.equal(decideGate(opts).decision, 'deny')
  opts.readSet.set('current', { fingerprint: 'after' })
  assert.equal(decideGate(opts).decision, 'allow')
})

test('review: external body written after creation and before rescan must survive publication', async () => {
  const w = reviewWorld()
  await w.create('old')
  let changed = false
  w.beforeScan(() => {
    const path = `${w.root}/docs/next.md`
    if (!changed && w.files.has(path)) {
      changed = true
      w.put(path, w.files.get(path) + '\nEXTERNAL DECISION\n')
    }
  })
  const result = await w.create('next')
  assert.equal(changed, true)
  assert.match(w.files.get(`${w.root}/docs/next.md`), /EXTERNAL DECISION/,
    'publication must reject the stale staged text or preserve the external body')
  if (result.published) assert.equal(entryPointOf(w.reg.entries).meta.id, 'next')
})

test('review: missing version metadata must not fall back to unconditional overwrite', async () => {
  let text = 'observed', writes = 0
  const target = { targetKey: 'file', displayPath: 'file' }
  const fs = {
    readText: async () => { const read = text; text = 'EXTERNAL UPDATE'; return read },
    writeText: async (_target, next, intent) => { writes += 1; assert.ok(intent, 'a compare/read followed by unconditional write is not CAS'); text = next; return {} },
  }
  await assert.rejects(() => replaceObserved(fs, { target, text: 'observed' }, 'replacement', {}))
  assert.equal(text, 'observed', 'missing version must fail before any provider access or mutation')
  assert.equal(writes, 0, 'unsupported CAS should fail before entering unconditional write')
})

test('review: publication must not claim current entry if concurrent publication won order', async () => {
  const w = reviewWorld()
  await w.create('old')
  let injected = false
  w.beforeWrite((path, text) => {
    if (!injected && path.endsWith('/next.md') && text.includes('status: authoritative')) {
      injected = true
      w.put(`${w.root}/docs/concurrent.md`, renderDocText({
        id: 'concurrent', role: 'handover', title: 'concurrent', summary: 'concurrent', status: 'authoritative', order: -1000,
      }, 'another session published'))
    }
  })
  const result = await w.create('next')
  assert.equal(injected, true)
  assert.ok(!result.published || entryPointOf(w.reg.entries)?.meta.id === 'next',
    'published:true currently claims chosen entry even when another authoritative entry remains first')
})

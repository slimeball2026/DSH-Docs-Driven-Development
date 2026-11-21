import assert from 'node:assert/strict'
import test from 'node:test'
import { parseFrontmatter } from '../docs/frontmatter.js'
import { fingerprintOf } from '../docs/fingerprint.js'
import { buildIndex } from '../core/index.js'
import { entryPointOf } from '../core/navigation.js'
import { createNewTool, renderDocText } from '../tools/doc-new.js'
import { createMarkTool } from '../tools/doc-mark.js'
import { decideGate } from '../core/gate.js'

function world() {
  const root = 'C:/m4'
  const files = new Map(), versions = new Map(), reads = new Map(), self = new Map()
  const norm = (path) => path.replaceAll('\\', '/')
  let fault = () => {}, beforeWrite = () => {}
  const fs = {
    resolve: async (path) => ({ targetKey: norm(path), displayPath: norm(path) }),
    stat: async (target) => files.has(target.targetKey) ? { type: 'file', version: String(versions.get(target.targetKey)) } : undefined,
    readText: async (target) => { if (!files.has(target.targetKey)) throw new Error('ENOENT'); return files.get(target.targetKey) },
    writeText: async (target, text, intent) => {
      beforeWrite(target.targetKey, text)
      const key = target.targetKey
      if (intent?.kind === 'createIfAbsent' && files.has(key)) throw new Error('exists')
      if (intent?.kind === 'replaceIfVersion' && String(versions.get(key)) !== intent.version) throw new Error('FS_STALE_VERSION')
      fault(key, text)
      files.set(key, text); versions.set(key, (versions.get(key) ?? 0) + 1)
      return { version: String(versions.get(key)) }
    },
  }
  const reg = {
    state: 'ready', entries: [], index: {},
    async rescan() {
      this.entries = [...files].map(([path, text]) => {
        const parsed = parseFrontmatter(text)
        return { path, text, body: parsed.body, meta: parsed.meta, fingerprint: fingerprintOf(text), hasError: false, issues: [] }
      })
      this.index = buildIndex(this.entries)
    },
    entryById(id) { return this.entries.find((entry) => entry.meta.id === id) },
    readSetFor: () => reads,
    markRead(path, _session, _seq, text) {
      const entry = this.entries.find((entry) => entry.path === path)
      if (!entry) return false
      reads.set(entry.meta.id, { fingerprint: entry.fingerprint, text: text ?? entry.text }); return true
    },
    fingerprintOf(id) { return this.entryById(id)?.fingerprint },
    noteSelfWrite(path) { const entry = this.entries.find((entry) => entry.path === path); if (entry) self.set(entry.meta.id, entry.fingerprint) },
    isSelfWritten(id) { return self.get(id) === this.fingerprintOf(id) },
  }
  const session = { header: { cwd: root } }, exec = { agent: { session } }
  const deps = { config: { docsDir: 'docs' }, registry: () => reg, fs, projectRoot: () => root, projectRootOf: () => root, readRecordOf: (_s,id) => reads.get(id) }
  const newTool = createNewTool(deps), markTool = createMarkTool(deps)
  const create = (id, status = 'draft', more = {}) => newTool.execute({ id, role: 'handover', title: id, summary: id, status, body: '# 当前情况\n无后续任务，尚未运行测试。', ...more }, exec)
  return { root, files, versions, reads, self, fs, reg, exec, newTool, markTool, create,
    fault(fn) { fault = fn }, beforeWrite(fn) { beforeWrite = fn },
    async edit(id, from, to) {
      const path = `${root}/docs/${id}.md`; files.set(path, files.get(path).replace(from,to)); versions.set(path,(versions.get(path)??0)+1); await reg.rescan()
    },
  }
}

test('draft does not replace published handover; direct publication selects once and leaves index body untouched', async () => {
  const w = world()
  const indexPath = `${w.root}/docs/index.md`
  const index = renderDocText({id:'index',role:'index',title:'index',order:0,status:'authoritative',summary:'入口'}, '# 手写清单\n1. old\n<!-- ddd:auto:begin v1 -->保留<!-- ddd:auto:end -->')
  w.files.set(indexPath,index); await w.reg.rescan()
  await w.create('old','authoritative')
  await w.create('draft')
  assert.equal(entryPointOf(w.reg.entries).meta.id,'old')
  assert.equal(w.reg.entryById('old').meta.status,'authoritative')
  const result = await w.create('next','authoritative')
  assert.equal(result.published,true)
  assert.deepEqual(result.supersededOld,['old'])
  assert.deepEqual(w.reg.entryById('old').meta.supersededBy,['next'])
  assert.deepEqual(w.reg.entryById('next').meta.supersedes,['old'])
  assert.equal(w.reg.entryById('draft').meta.status,'draft')
  assert.equal(w.files.get(indexPath),index)
  assert.equal(entryPointOf(w.reg.entries).meta.id,'next')
  assert.ok(w.newTool.output.render({},result)[0].text.length < 300)
})

test('publishing an older draft reorders it; repeated publication is idempotent', async () => {
  const w = world()
  await w.create('draft')
  await w.create('later','authoritative')
  const result = await w.markTool.execute({id:'draft',status:'authoritative'},w.exec)
  assert.equal(result.published,true)
  assert.equal(entryPointOf(w.reg.entries).meta.id,'draft')
  assert.ok(w.reg.entryById('draft').meta.order < w.reg.entryById('later').meta.order)
  const before = new Map(w.files)
  await w.markTool.execute({id:'draft',status:'authoritative'},w.exec)
  assert.deepEqual(w.files,before)
})

test('published handover remains editable after further work; new session sees corrected entry', async () => {
  const w = world(); await w.create('current','authoritative')
  await w.create('spec','authoritative',{role:'spec',body:'# 工作\n第一版'})
  await w.edit('spec','第一版','第二版')
  await w.edit('current','无后续任务','补验第二版')
  const current = w.reg.entryById('current')
  assert.equal(current.meta.status,'authoritative')
  assert.equal(entryPointOf(w.reg.entries).body.includes('补验第二版'),true)
  assert.equal([...w.files.keys()].some((path)=>path.includes('snapshots')),false)
  w.reads.set('current',{fingerprint:current.fingerprint,text:current.text})
  const verdict = decideGate({ toolName:'edit',args:{file_path:current.path,old_string:'补验第二版',new_string:'已补验'},gateEnabled:true,
    classify:()=> 'doc',metaOf:()=>current.meta,knownOf:()=>true,required:[current],readSet:w.reads,currentFingerprint:(id)=>w.reg.fingerprintOf(id),textOf:()=>current.text })
  // Direct gate uses path category 'docs' in production; the key contract is publication does not change role policy.
  assert.notEqual(verdict.decision,'deny')
})

test('publication failure restores predecessors and retains a retryable draft', async () => {
  const w = world(); await w.create('old','authoritative')
  w.fault((path,text)=> { if(path.endsWith('/old.md') && text.includes('status: superseded')) throw new Error('disk failure') })
  const result=await w.create('next','authoritative')
  assert.equal(result.published,false)
  assert.match(result.warning,/发布未完成/)
  assert.equal(w.reg.entryById('old').meta.status,'authoritative')
  assert.equal(w.reg.entryById('next').meta.status,'draft')
  assert.equal(entryPointOf(w.reg.entries).meta.id,'old')
  w.fault(()=>{})
  assert.equal((await w.markTool.execute({id:'next',status:'authoritative'},w.exec)).published,true)
})

test('concurrent edit during publication is never overwritten or rolled back', async () => {
  const w=world(); await w.create('old','authoritative')
  let changed=false
  w.beforeWrite((path,text)=>{
    if(!changed && path.endsWith('/old.md') && text.includes('status: superseded')) {
      changed=true; w.files.set(path,w.files.get(path)+'\n外部决定\n');w.versions.set(path,w.versions.get(path)+1)
    }
  })
  const result=await w.create('next','authoritative')
  assert.equal(result.published,false)
  assert.match(w.files.get(`${w.root}/docs/old.md`),/外部决定/)
  assert.equal(entryPointOf(w.reg.entries).meta.id,'old')
})

test('invalid publication metadata never supersedes the working entry', async () => {
  const w = world(); await w.create('old', 'authoritative'); await w.create('broken')
  await w.edit('broken', 'summary: broken\n', '')
  const broken = w.reg.entryById('broken')
  w.reads.set('broken', { fingerprint: broken.fingerprint, text: broken.text })
  const before = new Map(w.files)
  await assert.rejects(() => w.markTool.execute({ id: 'broken', status: 'authoritative' }, w.exec), /元数据不合法/)
  assert.deepEqual(w.files, before)
  assert.equal(entryPointOf(w.reg.entries).meta.id, 'old')
})

test('create-if-absent protects an unscanned file', async () => {
  const w=world(); w.files.set(`${w.root}/docs/taken.md`,'unmanaged user text')
  await assert.rejects(()=>w.create('taken'),/exists/)
  assert.equal(w.files.get(`${w.root}/docs/taken.md`),'unmanaged user text')
})

test('mark verifies disk version even if registry has not observed external change', async () => {
  const w=world();await w.create('s','draft',{role:'spec'})
  const path=`${w.root}/docs/s.md`;w.files.set(path,w.files.get(path)+'\nexternal\n');w.versions.set(path,w.versions.get(path)+1)
  await assert.rejects(()=>w.markTool.execute({id:'s',status:'authoritative'},w.exec),/磁盘已变化/)
  assert.match(w.files.get(path),/status: draft/)
})

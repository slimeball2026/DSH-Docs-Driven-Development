/** Shared guarded writes and recoverable handover publication. No persistent sidecar. */
import { setFrontmatterFields } from '../core/frontmatterEdit.js'
import { parseFrontmatter } from '../docs/frontmatter.js'
import { currentHandoverOf } from '../core/navigation.js'
import { validateMeta, countIds } from '../docs/schema.js'

const queues = new WeakMap()
export async function withDocumentLock(reg, operation) {
  const previous = queues.get(reg) ?? Promise.resolve()
  let release
  const pending = new Promise((resolve) => { release = resolve })
  queues.set(reg, pending)
  await previous
  try { return await operation() } finally {
    release()
    if (queues.get(reg) === pending) queues.delete(reg)
  }
}

export async function readVersion(fs, path, root, signal) {
  const target = await fs.resolve(path, { cwd: root, signal })
  const before = typeof fs.stat === 'function' ? await fs.stat(target, signal) : undefined
  const text = await fs.readText(target, signal)
  const after = typeof fs.stat === 'function' ? await fs.stat(target, signal) : undefined
  if (before?.version !== after?.version) throw new Error(`文件读取期间发生变化：${path}，请重读后重试。`)
  return { target, text, version: after?.version }
}

export async function replaceObserved(fs, observed, next, policy, signal) {
  if (typeof observed.version !== 'string' || observed.version === '') {
    throw new Error(`文件系统未提供版本，未改写：${observed.target.displayPath}。请恢复支持版本保护的文件系统后重试。`)
  }
  const result = await fs.writeText(observed.target, next,
    { kind: 'replaceIfVersion', version: observed.version }, signal, policy)
  return { ...observed, text: next, version: result?.version }
}

export async function refreshDocuments(reg, session, exec, written = [], readIds = []) {
  let indexed = false
  try { await reg.rescan(); indexed = reg.state !== 'failed' } catch { /* report through indexed */ }
  for (const item of written) {
    const fresh = reg.entryById?.(item.id)
    // Never credit an unrelated edit discovered by the rescan as our own write.
    if (!fresh || fresh.text !== item.text) continue
    try {
      reg.noteSelfWrite?.(fresh.path, session)
      if (readIds.includes(item.id)) reg.markRead?.(fresh.path, session, exec?.seq, fresh.text)
    } catch { /* a missing ledger update only requires another read */ }
  }
  return indexed
}

/** Publication chooses an entry for continuation; it never seals the document or the task. */
export async function publishHandover({ reg, fs, entry, text, root, policy, session, exec }) {
  const candidates = (reg.entries ?? []).filter((each) => each?.meta?.role === 'handover'
    && each.meta.id !== entry.meta.id && each.meta.status === 'authoritative'
    && each.hasError !== true && each.unmanaged !== true && each.inGraveyard !== true)
  const original = await readVersion(fs, entry.path, root, exec?.signal)
  if (original.text !== entry.text) throw new Error(`交接 ${entry.meta.id} 已变化，请重读后重试。`)
  const old = []
  for (const each of candidates) {
    const observed = await readVersion(fs, each.path, root, exec?.signal)
    if (observed.text !== each.text) throw new Error(`旧交接 ${each.meta.id} 已变化，请重读后重试。`)
    old.push({ entry: each, observed })
  }
  const parsed = parseFrontmatter(text)
  const orders = candidates.map((each) => each.meta.order).filter(Number.isFinite)
  const minimum = orders.length ? Math.min(...orders) : undefined
  const requested = parsed.meta?.order
  const order = minimum !== undefined && (!Number.isFinite(requested) || requested >= minimum) ? minimum - 10 : requested
  const backlinks = (reg.entries ?? []).filter((each) => each?.meta?.status === 'superseded'
    && Array.isArray(each.meta.supersededBy) && each.meta.supersededBy.includes(entry.meta.id))
    .map((each) => each.meta.id)
  const supersedes = [...new Set([...(Array.isArray(parsed.meta?.supersedes) ? parsed.meta.supersedes : []), ...backlinks, ...candidates.map((each) => each.meta.id)])]
  const fields = { status: 'authoritative', supersededBy: null }
  if (Number.isFinite(order)) fields.order = order
  if (supersedes.length) fields.supersedes = supersedes
  const self = setFrontmatterFields(text, fields)
  if (!self.ok) throw new Error(self.message)
  const finalDoc = parseFrontmatter(self.text)
  const finalMeta = finalDoc.meta
  const validation = validateMeta(finalMeta, {
    body: finalDoc.body,
    knownIds: (reg.entries ?? []).map((each) => each?.meta?.id).filter((id) => typeof id === 'string'),
    idCounts: countIds(reg.entries ?? []), selfId: entry.meta.id,
  })
  if (finalDoc.error || finalMeta?.id !== entry.meta.id || finalMeta?.role !== 'handover' || validation.hasError) {
    const detail = finalDoc.error?.message ?? validation.issues.filter((item) => item.level === 'error').map((item) => item.message).join('；')
    throw new Error(`交接元数据不合法，未发布且旧入口保留：${detail || 'id / role 与目标不一致'}。请修复目标 frontmatter 后重试。`)
  }
  const changes = [{ id: entry.meta.id, observed: original, next: self.text }]
  for (const item of old) {
    const edited = setFrontmatterFields(item.observed.text, { status: 'superseded', supersededBy: [entry.meta.id] })
    if (!edited.ok) throw new Error(edited.message)
    changes.push({ id: item.entry.meta.id, observed: item.observed, next: edited.text })
  }
  const applied = []
  let warning = ''
  try {
    // Publish the replacement before touching predecessors: interruption never removes the last entry.
    for (const change of changes) {
      if (change.observed.text === change.next) continue
      const after = await replaceObserved(fs, change.observed, change.next, policy, exec?.signal)
      applied.push({ ...change, after })
    }
  } catch (error) {
    const unrestored = []
    for (const change of applied.toReversed()) {
      try { await replaceObserved(fs, change.after, change.observed.text, policy) }
      catch { unrestored.push(change.observed.target.displayPath) }
    }
    warning = `发布未完成：${error?.message ?? error}。`
      + (unrestored.length ? `部分写入未恢复：${unrestored.join('、')}。请读取这些文件确认后，对同一交接重试 doc_mark(status: authoritative)。` : '已恢复本次改写；旧入口保留。请读取目标后重试发布。')
    const indexed = await refreshDocuments(reg, session, exec)
    return { published: false, supersededOld: [], warning, indexed }
  }
  const written = changes.map((change) => ({ id: change.id, text: change.next }))
  const indexed = await refreshDocuments(reg, session, exec, written, [entry.meta.id])
  const current = indexed ? currentHandoverOf(reg.entries) : undefined
  const published = current?.meta?.id === entry.meta.id
  if (!published) warning = indexed
    ? `文件已发布，但当前入口是 ${current?.meta?.id ?? '未确认'}，可能有其他会话同时发布。请读取实时目录确认后再决定是否对本交接重试发布；未改动其他新入口。`
    : '文件已发布，但目录刷新失败，当前入口未确认；请读取目标并刷新目录后确认，不要重复新建。'
  return { published, supersededOld: candidates.map((each) => each.meta.id), warning, indexed }
}

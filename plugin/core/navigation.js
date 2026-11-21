/** Shared navigation selection. Pure: no IO, mutation, session state or guessed relevance. */
function valid(entry) {
  return entry !== null && typeof entry === 'object'
    && entry.unmanaged !== true && entry.inGraveyard !== true
    && entry.hasError !== true
    && !(Array.isArray(entry.issues) && entry.issues.some((issue) => issue?.level === 'error'))
    && typeof entry.meta?.id === 'string' && entry.meta.id.trim() !== ''
}

function compare(a, b) {
  const order = (entry) => Number.isFinite(entry.meta.order) ? entry.meta.order : Number.MAX_VALUE
  const delta = order(a) - order(b)
  if (delta !== 0) return delta
  const aId = a.meta.id
  const bId = b.meta.id
  return aId < bId ? -1 : aId > bId ? 1 : 0
}

/** Return the original valid authoritative handover entry, or undefined. */
export function currentHandoverOf(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => valid(entry) && entry.meta.role === 'handover' && entry.meta.status === 'authoritative')
    .sort(compare)[0]
}

/** Published handover first; otherwise a valid authoritative/partial index. Drafts are never current. */
export function entryPointOf(entries) {
  return currentHandoverOf(entries) ?? (Array.isArray(entries) ? entries : [])
    .filter((entry) => valid(entry) && entry.meta.role === 'index'
      && ['authoritative', 'partial'].includes(entry.meta.status))
    .sort(compare)[0]
}

/** Accept existing buildIndex output without requiring callers to duplicate its entry collection. */
export function entriesOfIndex(index) {
  const entries = [
    ...(index?.byId instanceof Map ? index.byId.values() : []),
    ...(Array.isArray(index?.required) ? index.required : []),
    ...(Array.isArray(index?.forbidden) ? index.forbidden : []),
    ...(Array.isArray(index?.anomalies) ? index.anomalies : []),
  ]
  return [...new Set(entries)]
}

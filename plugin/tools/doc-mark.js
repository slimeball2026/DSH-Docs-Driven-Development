/** Change document/section status; publication remains editable. */
import { defineTool } from './define-tool.js'
import { sandboxPolicyOf } from './doc-new.js'
import { setFrontmatterFields } from '../core/frontmatterEdit.js'
import { STATUSES, BASES } from '../docs/schema.js'
import { publishHandover, readVersion, replaceObserved, refreshDocuments, withDocumentLock } from './document-write.js'

const KNOWN_PARAMS = ['id', 'status', 'anchor', 'sectionStatus', 'reason', 'supersededBy', 'basis']
export function unknownParamsOf(args) { return args && typeof args === 'object' ? Object.keys(args).filter((key) => !KNOWN_PARAMS.includes(key)) : [] }
export function markBlock(input) {
  const parts = []
  for (const key of ['status', 'anchor', 'sectionStatus']) if (input[key]) parts.push(`${key}=${input[key]}`)
  const reason = String(input.reason ?? '').replace(/\s+/g, ' ').trim().replace(/-->/g, '-- >')
  if (reason) parts.push(`reason=${JSON.stringify(reason)}`)
  if (!parts.length) return ''
  const stamp = input.at ? ` ${input.at.replace(/[^\d.-]/g, '')}` : ''
  return `<!-- ddd:mark${stamp} ${parts.join(' ')} -->`
}
export function appendMarkBlock(text, block) {
  if (!block) return text
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  return `${text.replace(/(\r?\n)+$/, '')}${eol}${eol}${block}${eol}`
}
export function createMarkTool(deps) {
  const now = deps.now ?? (() => new Date().toISOString().slice(0, 10))
  return defineTool({
    name: 'doc_mark',
    description: '修改文档或段落状态，可同时改 basis。sealed/void 必须给 reason，superseded 必须给 supersededBy。交接 authoritative 表示发布为当前入口，不表示工作结束；发布后仍可原地 edit。不检查正文格式、不写清单或快照。其他结构字段请用 edit。目标须先读，成功自改无需重读，外部变化须重读。',
    parameters: {
      id: { type: 'string', required: true, description: '目标文档 id。' },
      status: { type: 'string', enum: [...STATUSES], description: '文档状态。交接 authoritative 发布为接续入口。' },
      anchor: { type: 'string', description: '段落锚点，例如 #7。' },
      sectionStatus: { type: 'string', enum: [...STATUSES], description: '段落状态，需配 anchor。' },
      basis: { type: 'string', enum: [...BASES], description: '依据类型，不等同于发布状态。' },
      reason: { type: 'string', description: 'sealed/void 必填，说明原因。' },
      supersededBy: { type: 'array', items: { type: 'string' }, description: 'superseded 必填，取代者 id。' },
    },
    output: {
      schema: { type: 'object', properties: {
        id: { type: 'string', required: true }, changed: { type: 'array', required: true, items: { type: 'string' } },
        added: { type: 'array', required: true, items: { type: 'string' } }, removed: { type: 'array', required: true, items: { type: 'string' } },
        marked: { type: 'boolean', required: true }, indexed: { type: 'boolean', required: true },
        published: { type: 'boolean', required: true }, supersededOld: { type: 'array', required: true, items: { type: 'string' } },
        warning: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: `${value.warning ? '状态操作结果' : '已更新'} \`${value.id}\`：${[...value.changed, ...value.added].join('、') || '无字段变化'}。`
        + (value.published ? '\n已选为当前交接入口；可继续原地编辑。' : '')
        + (!value.indexed ? '\n写入后目录刷新未确认，请读取目标确认。' : '')
        + (value.warning ? `\n${value.warning}` : ''),
      }],
    },
    execute: async (args, exec) => {
      await deps.assertAllowed?.(exec)
      const unknown = unknownParamsOf(args)
      if (unknown.length) throw new Error(`doc_mark 不认这些参数：${unknown.join('、')}。仅支持 status / sections / basis；order / role / title / summary 请用 edit 改 frontmatter。`)
      const session = exec?.agent?.session
      const reg = typeof deps.registry === 'function' ? deps.registry(session) : deps.registry
      if (!reg) throw new Error('DDD 注册表还没就绪。')
      return withDocumentLock(reg, async () => {
        const id = typeof args?.id === 'string' ? args.id.trim() : ''
        if (!id) throw new Error('id 不能为空。')
        const entry = reg.entryById?.(id)
        if (!entry) throw new Error(`找不到 id 为 \`${id}\` 的受管文档。`)
        if (entry.meta?.role === 'evidence') throw new Error(`\`${id}\` 是 evidence（证据类文档），不允许改写；需要新证据请用 doc_new。`)
        const { status, basis, sectionStatus } = args
        const anchor = typeof args.anchor === 'string' ? args.anchor.trim() : undefined
        const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
        const supersededBy = Array.isArray(args.supersededBy) ? args.supersededBy.filter((item) => typeof item === 'string' && item) : []
        if (status === undefined && basis === undefined && anchor === undefined && sectionStatus === undefined) throw new Error('至少要给 status、basis，或 anchor + sectionStatus。')
        if (status !== undefined && !STATUSES.includes(status)) throw new Error(`status 不合法：${status}`)
        if (basis !== undefined && !BASES.includes(basis)) throw new Error(`basis 不合法：${basis}`)
        if (anchor !== undefined && sectionStatus === undefined) throw new Error('给了 anchor 就必须同时给 sectionStatus。')
        if (sectionStatus !== undefined && (!anchor || !STATUSES.includes(sectionStatus))) throw new Error('sectionStatus 需要合法状态和 anchor。')
        if (['sealed', 'void'].includes(status) && !reason) throw new Error(`把 \`${id}\` 改成 ${status} 必须给 reason。`)
        if (status === 'superseded' && !supersededBy.length) throw new Error('改成 superseded 必须给 supersededBy。')
        const record = deps.readRecordOf?.(session, id)
        const selfWritten = reg.isSelfWritten?.(id, session) === true
        if (!record) throw new Error(`改 \`${id}\` 的状态之前必须先读它：用 read 后重试。`)
        if (!selfWritten && reg.fingerprintOf?.(id) !== undefined && record.fingerprint !== reg.fingerprintOf(id)) throw new Error(`\`${id}\` 你读过的是旧版，请用 read 重读后重试。`)
        const original = entry.text
        if (typeof original !== 'string' || !original) throw new Error(`读不到 \`${id}\` 的正文。`)
        const fields = {}
        if (status !== undefined) {
          fields.status = status
          if (status === 'superseded') fields.supersededBy = supersededBy
          else if (entry.meta.supersededBy !== undefined) fields.supersededBy = null
        }
        if (basis !== undefined) fields.basis = basis
        if (anchor && sectionStatus) {
          const sections = (entry.meta.sections ?? []).filter((item) => item && typeof item === 'object').map((item) => ({ ...item }))
          const index = sections.findIndex((item) => item.anchor === anchor)
          const section = { anchor, status: sectionStatus, ...(reason ? { reason } : {}) }
          if (index < 0) sections.push(section)
          else sections[index] = { ...sections[index], ...section }
          fields.sections = sections
        }
        const edited = setFrontmatterFields(original, fields)
        if (!edited.ok) throw new Error(edited.message ?? 'frontmatter 改写失败。')
        const block = reason || ['sealed', 'void'].includes(status) ? markBlock({ status, anchor, sectionStatus, reason, at: now() }) : ''
        const next = appendMarkBlock(edited.text, block)
        const root = deps.projectRootOf?.(session)
        const policy = { ...sandboxPolicyOf(exec), ...(root ? { workspaceRoot: root } : {}) }
        let indexed, published = false, supersededOld = [], warning = ''
        if (entry.meta.role === 'handover' && status === 'authoritative') {
          const result = await publishHandover({ reg, fs: deps.fs, entry, text: next, root, policy, session, exec })
          ;({ indexed, published, supersededOld, warning } = result)
        } else {
          if (next !== original) {
            const observed = await readVersion(deps.fs, entry.path, root, exec?.signal)
            if (observed.text !== original) throw new Error(`\`${id}\` 磁盘已变化，请重读后再改状态。`)
            await replaceObserved(deps.fs, observed, next, policy, exec?.signal)
          }
          indexed = await refreshDocuments(reg, session, exec, [{ id, text: next }], [id])
        }
        return { id, changed: warning ? [] : edited.changed ?? [], added: warning ? [] : edited.added ?? [],
          removed: warning ? [] : edited.removed ?? [], marked: !warning && !!block, indexed, published, supersededOld, warning }
      })
    },
  })
}

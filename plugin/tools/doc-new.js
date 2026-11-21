/** Create managed documents. Navigation is derived; no index-body copies are written. */
import { defineTool } from './define-tool.js'
import { BASES, ROLES, STATUSES } from '../docs/schema.js'
import { publishHandover, refreshDocuments, withDocumentLock } from './document-write.js'

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export function deriveId(title) {
  return String(title ?? '').replace(/[\s_/\\·—–]+/g, '-').replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase()
}
export function isDerivedIdUsable(value) { return typeof value === 'string' && ID_RE.test(value) && /[a-z]/.test(value) }
export function nextOrder(entries) {
  return Math.max(0, ...(entries ?? []).map((entry) => entry?.meta?.order).filter(Number.isFinite)) + 10
}
export function nextHandoverOrder(entries) {
  const orders = (entries ?? []).filter((entry) => entry?.meta?.role === 'handover')
    .map((entry) => entry.meta.order).filter(Number.isFinite)
  return orders.length ? Math.min(...orders) - 10 : -10
}
export function sandboxPolicyOf(exec) {
  const header = exec?.agent?.session?.header
  const mode = header?.sandboxMode ?? header?.sandbox?.mode ?? exec?.sandboxMode
  return { mode: ['read-only', 'workspace-write', 'danger-full-access'].includes(mode) ? mode : 'workspace-write' }
}
function formatValue(value) {
  if (Array.isArray(value)) return JSON.stringify(value)
  if (typeof value === 'number') return String(value)
  const text = String(value)
  return /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)
    || /^(?:true|false|null|~|yes|no|on|off)$/i.test(text) || /[:#[\]{}",'\n\r\t]|^\s|\s$/.test(text)
    ? JSON.stringify(text) : text
}
export function renderDocText(meta, body) {
  const fields = ['id', 'title', 'role', 'order', 'status', 'summary', 'basis', 'scope', 'supersededBy', 'supersedes', 'verifiedDsh', 'verifiedBundle', 'verifiedCommit', 'tokens']
  const lines = ['---']
  for (const key of fields) {
    const value = meta[key]
    if (value === undefined || value === null || (Array.isArray(value) && !value.length)) continue
    lines.push(`${key}: ${formatValue(value)}`)
  }
  lines.push('---', '')
  const text = typeof body === 'string' && body.trim() ? body : `# ${meta.title}\n`
  return `${lines.join('\n')}\n${text.replace(/\s+$/, '')}\n`
}

export function createNewTool(deps) {
  return defineTool({
    name: 'doc_new',
    description: '新建 docs/ 下的受管文档，自动生成元数据并刷新实时目录。中文标题请显式给 id。默认 draft；交接传 status: authoritative 可一次发布为当前入口，发布不表示工作结束，之后可原地 edit。草稿不取代旧入口。不回写旧索引正文，无需检查或同步清单。',
    parameters: {
      role: { type: 'string', required: true, enum: [...ROLES], description: '文档角色。' },
      title: { type: 'string', required: true, description: '文档标题。' },
      summary: { type: 'string', required: true, description: '一句话摘要，建议不超过80字。' },
      id: { type: 'string', description: '永久 kebab-case 标识；中文标题请显式传入。' },
      order: { type: 'number', description: '排序值，默认普通文档最大+10，交接最小-10；发布时确保成为首位交接。' },
      status: { type: 'string', enum: [...STATUSES], description: '默认 draft；交接 authoritative 表示选为接续入口。' },
      basis: { type: 'string', enum: [...BASES], description: '依据类型，默认未验证；不影响发布资格。' },
      scope: { type: 'array', items: { type: 'string' }, description: 'partial 必须说明适用范围。' },
      body: { type: 'string', description: 'Markdown 正文。交接可写当前状态、后续动作或无、约束与验证情况，无固定标题要求。' },
    },
    output: {
      schema: { type: 'object', properties: {
        id: { type: 'string', required: true }, path: { type: 'string', required: true },
        role: { type: 'string', required: true }, order: { type: 'number', required: true },
        status: { type: 'string', required: true }, indexed: { type: 'boolean', required: true },
        recorded: { type: 'boolean', required: true }, published: { type: 'boolean', required: true },
        supersededOld: { type: 'array', required: true, items: { type: 'string' } },
        warning: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text:
        `已创建 \`${value.path}\`（${value.status}，order ${value.order}）。`
        + (value.published ? '\n已选为当前交接入口；之后可继续原地编辑。' : '')
        + (!value.indexed ? '\n文件已写入，但目录刷新未确认；请读取目标确认后再继续。' : '')
        + (value.warning ? `\n${value.warning}` : ''),
      }],
    },
    execute: async (args, exec) => {
      await deps.assertAllowed?.(exec)
      const session = exec?.agent?.session
      const reg = typeof deps.registry === 'function' ? deps.registry(session) : deps.registry
      if (!reg) throw new Error('DDD 注册表未就绪：请确认目标是已激活的 DDD 项目。')
      return withDocumentLock(reg, async () => {
        const role = args?.role
        if (!ROLES.includes(role)) throw new Error(`role 不合法：${String(role)}（允许：${ROLES.join(' / ')}）`)
        const title = typeof args?.title === 'string' ? args.title.trim() : ''
        const summary = typeof args?.summary === 'string' ? args.summary.trim() : ''
        if (!title) throw new Error('title 不能为空。')
        if (!summary) throw new Error('summary 不能为空。')
        const status = args?.status ?? 'draft'
        const basis = args?.basis ?? '未验证'
        if (!STATUSES.includes(status)) throw new Error(`status 不合法：${String(status)}`)
        if (!BASES.includes(basis)) throw new Error(`basis 不合法：${String(basis)}`)
        if (status === 'partial' && !(Array.isArray(args?.scope) && args.scope.length)) throw new Error('status 为 partial 时必须给 scope。')
        let id = typeof args?.id === 'string' ? args.id.trim() : ''
        if (!id) {
          id = deriveId(title)
          if (!isDerivedIdUsable(id)) throw new Error(`中文标题派生不出合法 id（${id || '空串'}）。请显式传 id，例如 id: "handover-m4"。`)
        }
        if (!ID_RE.test(id)) throw new Error(`id 不是 kebab-case：${id}`)
        if (reg.entries?.some((entry) => entry?.meta?.id === id)) throw new Error(`id \`${id}\` 已被占用；请 read 并 edit 现有文档，或换一个 id。`)
        const root = typeof deps.projectRoot === 'function' ? deps.projectRoot(session) : deps.layout?.projectRoot
        if (!root) throw new Error('找不到项目根，无法创建文档。')
        const path = `${deps.config.docsDir}/${id}.md`
        const absolute = `${root.replace(/[\\/]+$/, '')}/${path}`
        if (!deps.fs?.resolve || !deps.fs?.writeText) throw new Error('文件系统服务不可用。')
        const order = Number.isFinite(args?.order) ? args.order : role === 'handover' ? nextHandoverOrder(reg.entries) : nextOrder(reg.entries)
        // Stage direct publication as draft, preserving predecessors if publication fails.
        const text = renderDocText({ id, title, role, order, status: role === 'handover' && status === 'authoritative' ? 'draft' : status,
          summary, basis, scope: args?.scope }, args?.body)
        const target = await deps.fs.resolve(absolute, { cwd: root })
        const policy = { ...sandboxPolicyOf(exec), workspaceRoot: root }
        try { await deps.fs.writeText(target, text, { kind: 'createIfAbsent' }, exec?.signal, policy) }
        catch (error) { throw new Error(`创建 ${path} 失败，未确认写入：${error?.message ?? error}`) }
        let indexed = await refreshDocuments(reg, session, exec, [{ id, text }], [id])
        const fresh = reg.entryById?.(id) ?? reg.entries?.find((entry) => entry?.meta?.id === id)
        let published = false
        let supersededOld = []
        let warning = ''
        if (role === 'handover' && status === 'authoritative') {
          if (!fresh) warning = '交接草稿已写入，未发布：目录未收录。请读取该文件确认后，对同一 id 调用 doc_mark(status: authoritative)。'
          else if (fresh.text !== text) warning = '交接草稿已写入，但随后被外部修改，未自动发布。请读取当前内容，再对同一 id 调用 doc_mark(status: authoritative)。'
          else {
            try {
              const result = await publishHandover({ reg, fs: deps.fs, entry: fresh, text, root, policy, session, exec })
              ;({ published, supersededOld, warning, indexed } = result)
            } catch (error) { warning = `交接草稿已写入，未发布：${error?.message ?? error}。请重读后对同一 id 重试发布。` }
          }
        }
        const after = reg.entryById?.(id)
        return { id, path, role, order: after?.meta?.order ?? order,
          status: after?.meta?.status ?? (role === 'handover' && status === 'authoritative' && !published ? 'draft' : status),
          indexed, recorded: typeof reg.readSetFor === 'function' ? reg.readSetFor(session)?.has(id) === true : false,
          published, supersededOld, warning }
      })
    },
  })
}

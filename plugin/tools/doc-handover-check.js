/** Optional, read-only diagnostics; never a publication or completion gate. */
import { defineTool } from './define-tool.js'
import { checkHandover } from '../core/handover.js'
import { currentHandoverOf } from '../core/navigation.js'

/** Explicit ids never silently fall back to another handover. */
export function pickHandover(entries, id) {
  const list = Array.isArray(entries) ? entries : []
  if (typeof id === 'string' && id !== '') {
    const entry = list.find((item) => item?.meta?.id === id)
    if (entry === undefined) return { reason: `找不到 id 为 \`${id}\` 的文档。`, rule: 'HD-MISSING' }
    if (entry.meta.role !== 'handover') return { reason: `\`${id}\` 不是 role: handover 的文档。`, rule: 'HD-ROLE' }
    return { entry }
  }
  const current = currentHandoverOf(list)
  return current !== undefined
    ? { entry: current }
    : { reason: '当前没有已发布的交接入口；未诊断任何文档。可用 id 指定已有草稿，或用 body 诊断文本。', rule: 'HD-NO-CURRENT' }
}

const issueSchema = {
  type: 'object',
  properties: {
    rule: { type: 'string', required: true },
    message: { type: 'string', required: true },
  },
}

function resultOf(id, verdict) {
  return {
    ok: verdict.ok,
    id,
    errors: verdict.errors.map(({ rule, message }) => ({ rule, message })),
    warnings: verdict.warnings.map(({ rule, message }) => ({ rule, message })),
    // Kept for result-shape compatibility; these no longer express requirements.
    sections: [],
    stats: { sectionsFound: 0, sectionsTotal: 0, concreteActions: 0, acceptanceItems: 0 },
  }
}

export function createHandoverCheckTool(deps) {
  const { registry } = deps
  return defineTool({
    name: 'doc_handover_check',
    description: '可选的交接客观诊断：检查正文是否为空、指定文档是否存在且为 handover。'
      + '不检查固定段落、下一步、证据措辞或任务完成情况，不是交接前置。只读。'
      + 'body 优先，仅诊断给定文本；否则按 id 查文档，省略 id 时查看当前已发布交接。',
    parameters: {
      id: { type: 'string', description: '已有交接文档 id；省略时查看当前已发布交接，没有时如实返回未诊断。' },
      body: { type: 'string', description: '直接诊断正文；提供时忽略 id 和磁盘文档，不要求先创建文档。' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          errors: { type: 'array', required: true, items: issueSchema },
          warnings: { type: 'array', required: true, items: issueSchema },
          sections: {
            type: 'array', required: true,
            items: { type: 'object', properties: {
              index: { type: 'integer', required: true }, label: { type: 'string', required: true },
              found: { type: 'boolean', required: true }, title: { type: 'string', required: true },
            } },
          },
          stats: { type: 'object', required: true, properties: {
            sectionsFound: { type: 'integer', required: true }, sectionsTotal: { type: 'integer', required: true },
            concreteActions: { type: 'integer', required: true }, acceptanceItems: { type: 'integer', required: true },
          } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.errors.length + value.warnings.length === 0
          ? `交接诊断 \`${value.id}\`：正文非空；未检查内容真实性、完整性或任务完成情况。`
          : [`交接诊断 \`${value.id}\`：`, ...[...value.errors, ...value.warnings]
            .map((issue) => `- [${issue.rule}] ${issue.message}`)].join('\n'),
      }],
    },
    execute: async (args, exec) => {
      await deps.assertAllowed?.(exec)
      if (typeof args?.body === 'string') return resultOf('(文本)', checkHandover({ body: args.body }))
      const session = exec?.agent?.session
      const reg = typeof registry === 'function' ? registry(session) : registry
      if (reg === undefined || reg === null) throw new Error('DDD 注册表不可用，未诊断文档。')
      const picked = pickHandover(reg.entries, args?.id)
      if (picked.entry === undefined) {
        const issue = { rule: picked.rule, message: picked.reason }
        const noCurrent = picked.rule === 'HD-NO-CURRENT'
        return resultOf(typeof args?.id === 'string' && args.id !== '' ? args.id : '(当前交接)', {
          ok: false, errors: noCurrent ? [] : [issue], warnings: noCurrent ? [issue] : [],
        })
      }
      return resultOf(picked.entry.meta.id, checkHandover({ meta: picked.entry.meta, body: picked.entry.body ?? '' }))
    },
  })
}

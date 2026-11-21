/** Optional structural health diagnostics. Reads the registry snapshot only. */
import { defineTool } from './define-tool.js'
import { HEALTH_RULES, checkHealth } from '../core/health.js'

export function createHealthTool(deps) {
  const { registry } = deps
  return defineTool({
    name: 'doc_health',
    description: '可选的文档结构诊断：检查取代关系、入口引用和显式环境锚点。'
      + '返回发现与未检查项，不判断文档是否真实或任务是否完成，不是施工前置。只读，不读取或更新标绿快照。',
    parameters: {
      scope: { type: 'string', enum: ['all', 'errors'], description: 'all（默认）返回全部发现；errors 仅返回 error。现有结构规则均为 warn。' },
    },
    output: {
      schema: {
        type: 'object', properties: {
          ok: { type: 'boolean', required: true },
          issues: { type: 'array', required: true, items: { type: 'object', properties: {
            rule: { type: 'string', required: true },
            level: { type: 'string', required: true, enum: ['error', 'warn'] },
            docId: { type: 'string', required: true },
            message: { type: 'string', required: true },
          } } },
          skipped: { type: 'array', required: true, items: { type: 'string' }, description: '因当前环境值未知而未检查的显式锚点。' },
          stats: { type: 'object', required: true, properties: {
            docs: { type: 'integer', required: true }, required: { type: 'integer', required: true },
            requiredIds: { type: 'array', required: true, items: { type: 'string' }, description: '注册表参考目录 id，保持既有返回字段名。' },
            errors: { type: 'integer', required: true }, warnings: { type: 'integer', required: true },
          } },
          rules: { type: 'array', required: true, items: { type: 'object', properties: {
            rule: { type: 'string', required: true }, title: { type: 'string', required: true }, hits: { type: 'integer', required: true },
          } } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: [
        value.issues.length === 0
          ? `文档结构诊断：未发现所检查规则的问题（${value.stats.docs} 份受管文档）。`
          : `文档结构诊断：${value.issues.length} 条发现，不阻塞施工。`,
        ...value.issues.map((issue) => `- [${issue.rule}] \`${issue.docId}\`：${issue.message}`),
        ...(value.skipped.length === 0 ? [] : [`未检查的环境锚点：${value.skipped.join('、')}`]),
      ].join('\n') }],
    },
    execute: async (args, exec) => {
      await deps.assertAllowed?.(exec)
      const session = exec?.agent?.session
      const reg = typeof registry === 'function' ? registry(session) : registry
      if (reg === undefined || reg === null) throw new Error('DDD 注册表不可用，未诊断文档。')
      const required = Array.isArray(reg.index?.required) ? reg.index.required : []
      const result = checkHealth({
        entries: reg.entries ?? [], required, anchors: deps.anchors ?? {},
      })
      const issues = args?.scope === 'errors' ? result.issues.filter((item) => item.level === 'error') : result.issues
      return {
        ok: result.ok,
        issues: issues.map(({ rule, level, docId, message }) => ({ rule, level, docId, message })),
        skipped: [...result.skipped],
        stats: {
          docs: result.stats.docs, required: result.stats.required,
          requiredIds: required.map((entry) => entry?.meta?.id).filter((id) => typeof id === 'string' && id !== ''),
          errors: issues.filter((item) => item.level === 'error').length,
          warnings: issues.filter((item) => item.level === 'warn').length,
        },
        rules: HEALTH_RULES.map((spec) => ({ rule: spec.rule, title: spec.title, hits: result.stats.byRule[spec.rule] ?? 0 })),
      }
    },
  })
}

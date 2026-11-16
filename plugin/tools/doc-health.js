/**
 * `doc_health` —— 文档健康度自检（**只读**，M1-D）。
 *
 * 为什么它必须是工具（SPEC §2.2 第 2 条）：
 * 「用普通命令实现」在这个架构里是错的。它要读全部受管文档、跑 V1–V11 校验、
 * 跨文档比对 supersedes 图 —— 这些能力**已经在注册表里了**。
 * 让模型用 `pwsh` 去实现，等于把结构化数据降级成文本解析，
 * 而且**必然与插件内部的判定不一致**（两份真源）。
 */

import { defineTool } from './define-tool.js'
import { HEALTH_RULES, checkHealth } from '../core/health.js'
import { computeBudget } from '../core/budget.js'

const DESCRIPTION = [
  '自检项目里的文档健康度：跑 5 项检查，返回 warn 清单与统计。',
  'H-1 supersededBy 未反填 / H-2 superseded 链断或成环 / H-3 不可达的权威文档',
  ' / H-4 verified 锚点与当前环境不符 / H-5 basis 未验证却标成 authoritative。',
  '全部是 warn，不阻塞施工；只读，不改任何文件。修完再用它复查。',
].join('')

/**
 * 建工具。
 *
 * @param {object} deps
 * @param {object} deps.config
 * @param {(session: object|undefined) => object|undefined} deps.registry 同步取注册表
 * @param {object} [deps.anchors] 环境锚点（V9 / H-4 用）
 * @param {(session: object|undefined) => string|undefined} [deps.projectRootOf] 取项目根（标绿快照对账用）
 * @param {object} [deps.fs] 宿主的 `ctx.fs`（标绿快照对账用；没有就跳过对账）
 * @param {object} [deps.logger]
 * @returns {object} 原始 ToolDefinition
 */
export function createHealthTool(deps) {
  const { config, registry, logger } = deps

  /**
   * M2.7：已经报告过的 H-6 漂移（按会话隔离，纯内存）。
   *
   * 键 = `文档id::引用id@标绿时指纹`。语义与理由见调用点那段长注释：
   * **同一份快照只报一次**，但模型重新标绿后（快照变了）会**重新报**。
   *
   * 为什么按会话隔离：`doc_health` 是全局注册的工具，多个会话共用同一个
   * 模块实例；不隔离会让 A 会话报过的漂移在 B 会话里被静默吞掉。
   *
   * @type {WeakMap<object, Set<string>>}
   */
  const reportedDriftBySession = new WeakMap()
  /** 拿不到 session 时的兜底（单会话脚本 / 冒烟）。 */
  const reportedDriftShared = new Set()

  /** 取（或建）某个会话的"已报告漂移"集合。 */
  function reportedDriftFor(session) {
    if (session === null || typeof session !== 'object') return reportedDriftShared
    let set = reportedDriftBySession.get(session)
    if (set === undefined) {
      set = new Set()
      reportedDriftBySession.set(session, set)
    }
    return set
  }

  return defineTool({
    name: 'doc_health',
    description: DESCRIPTION,
    parameters: {
      scope: {
        type: 'string',
        enum: ['all', 'errors'],
        description: 'all（默认）返回全部检查项；errors 只看 error 级问题（当前 5 项都是 warn，所以通常是空）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          issues: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                rule: { type: 'string', required: true },
                level: { type: 'string', required: true, enum: ['error', 'warn'] },
                docId: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
          },
          skipped: {
            type: 'array',
            required: true,
            description: '因为"当前环境值未知"而没能检查的锚点。必须如实展示，不能静默跳过。',
            items: { type: 'string' },
          },
          stats: {
            type: 'object',
            required: true,
            properties: {
              docs: { type: 'integer', required: true },
              required: { type: 'integer', required: true },
              // ---- 2026-11-16 M2.9（§7 第 2 项）----
              //
              // ⚠️ **必须在 schema 里声明**：M2.6 踩过这个坑（`session-f36fd404`）——
              // 返回值里多一个 schema 没声明的键，宿主直接判 `additionalProperties: false`
              // **拒绝整个工具调用**，那一轮从 8 657 字符打回 25 038。
              requiredIds: {
                type: 'array',
                required: true,
                items: { type: 'string' },
                description: '必读清单里的文档 id（按 order 升序）。原来只给数量，模型拿到"2 份必读"没法据此做任何事。',
              },
              errors: { type: 'integer', required: true },
              warnings: { type: 'integer', required: true },
            },
          },
          rules: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                rule: { type: 'string', required: true },
                title: { type: 'string', required: true },
                hits: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        // 「跳过的检查」必须如实说出来 —— 静默跳过正是 H-4 被判"死分支"的原因。
        const skippedLine = value.skipped.length > 0
          ? `\n⚠️ 有 ${value.skipped.length} 项锚点没检查（当前环境值未知）：${value.skipped.join('、')}`
          : ''
        // ---- 2026-11-16 M2.9：**「N 份必读」要列 id**（用户拍板 §7 第 2 项「顺手做」）----
        //
        // 原来只说「4 份受管文档，2 份必读」。那是个**只有数、没有名字**的回执：
        // 模型读到"2 份必读"没法据此做任何事 —— 它不知道是哪两份、
        // 也不知道自己读的算不算，只能再去 `read` 索引或重读一遍。
        //
        // 这不是新信息：`reg.index.required` 本来就拿得到（`checkHealth` 的入参里就有）。
        // 原来是"算了数就把名字丢了"，属于白丢的上下文。
        const requiredIds = Array.isArray(value.stats.requiredIds) ? value.stats.requiredIds : []
        const summaryLine = requiredIds.length > 0
          ? `${value.stats.docs} 份受管文档，${value.stats.required} 份必读：${requiredIds.map((id) => `\`${id}\``).join('、')}`
          : `${value.stats.docs} 份受管文档，${value.stats.required} 份必读`
        if (value.issues.length === 0) {
          return [{
            type: 'text',
            text: `文档健康度：5 项检查全过（${summaryLine}）。${skippedLine}`,
          }]
        }
        const lines = value.issues.map((item) => `- [${item.rule}] \`${item.docId}\`：${item.message}`)
        return [{
          type: 'text',
          text: [
            `文档健康度：${value.stats.warnings} 条 warn（${value.stats.docs} 份受管文档）。`,
            '这些都是 warn，不阻塞施工，但每一条都是"文档在骗人"的迹象：',
            ...lines,
          ].join('\n') + skippedLine,
        }]
      },
    },
    execute: async (args, exec) => {
      // S2 执行期兜底：子代理即使能看到工具，也不能真的用它（见 tools/when.js 的说明）。
      await deps.assertAllowed?.(exec)

      const session = exec?.agent?.session
      const reg = typeof registry === 'function' ? registry(session) : registry
      if (reg === undefined || reg === null) {
        throw new Error('DDD 注册表还没就绪：这个会话不是 DDD 项目，或扫描失败了。')
      }

      const result = checkHealth({
        entries: reg.entries ?? [],
        required: reg.index?.required ?? [],
        anchors: deps.anchors ?? {},
        fileNameOf: (entry) => String(entry?.path ?? '').split(/[\\/]/).pop() ?? '',
      })

      const onlyErrors = args?.scope === 'errors'
      const issues = onlyErrors ? result.issues.filter((item) => item.level === 'error') : result.issues

      // ---- 2026-11-14 M2.6：**标绿快照对账**（用户拍板方案 B）----
      //
      // 标绿时 `doc_mark` 把其它文档的指纹记进 `_artifacts/ddd-mark-snapshots.json`。
      // 这里读回来比对：**标绿之后，它引用的文档改过没有？**
      //
      // 为什么放在 `doc_health`（而不是 `doc_handover_check`）：
      //   - `doc_health` 是"随便什么时候都能跑"的体检工具，标绿后跑一次最自然；
      //   - 交接只是 `authoritative` 的一种，别的文档标绿后也可能引用过时内容。
      //
      // ⚠️ 这条**只报 warn**，不阻塞。用户确认："交接本来就处于会话末端，
      //    此时噪声不会影响工程质量。"
      //
      // ⚠️ 完全静默失败：读不到快照文件（从来没标绿过）就是没有漂移，不是错误。
      const driftIssues = []
      if (!onlyErrors) {
        const reportedDrift = reportedDriftFor(session)
        try {
          const root = typeof deps.projectRootOf === 'function' ? deps.projectRootOf(session) : undefined
          const fsApi = deps.fs
          if (typeof root === 'string' && root !== ''
            && typeof fsApi?.resolve === 'function' && typeof fsApi?.readText === 'function') {
            const { MARK_SNAPSHOT_FILE, driftedRefsOf, driftMessageOf } = await import('../core/markSnapshot.js')
            const snapshotPath = `${root}/_artifacts/${MARK_SNAPSHOT_FILE}`.replaceAll('\\', '/')
            const target = await fsApi.resolve(snapshotPath, { cwd: root })
            const text = await fsApi.readText(target)
            if (typeof text === 'string' && text !== '') {
              let table = JSON.parse(text)
              const entries = Array.isArray(reg.entries) ? reg.entries : []
              const fingerprintOfId = (docId) => {
                const hit = entries.find((each) => each?.meta?.id === docId)
                // 只对**仍受管**的文档对账；被归档/删除的返回 undefined（不算漂移）。
                if (hit === undefined || hit.unmanaged === true) return undefined
                return String(hit.fingerprint ?? '')
              }
              for (const docId of Object.keys(table ?? {})) {
                const drifted = driftedRefsOf(table, docId, fingerprintOfId)
                if (drifted.length === 0) continue
                // ---- 2026-11-15 M2.8（用户拍板 Q1 = A）：**报完就自动重取快照** ----
                //
                // 用户原话：
                // > 不该认定 AI 能判断出自己的任务跑完了没，很多时候 AI 自己觉得跑完了，
                // > 去做最后一步，然后又发现别的东西要做。
                //
                // 实测：8 轮里 **3 轮（37.5%）在标绿之后继续改**，第 19 轮标绿后又跑 13 步。
                // 所以"标绿 = 封口"这个前提**在 37.5% 的轮次里是错的**。
                //
                // M2.7 用"同一份快照只报一次"缓解过，但那只是**压下症状**：
                // 第二次及以后的漂移**完全不报**，模型从此不知道引用还准不准。
                //
                // ⇒ Q1 的语义：**标绿是"取快照"，不是"封口"。**
                //   · 报出漂移（和以前一样，说清是哪几份、从哪个版本到哪个版本）；
                //   · **然后把这条快照重写成"现在"的版本** ——
                //     因为模型已经被告知过了，之后的改动是**新一轮**的事实，
                //     不该继续拿旧基线去比（那会导致"越改越报"）。
                //
                // 这样 H-6 从"永远满足不了的警告"变成"**每次基线漂移报一次**"，
                // 而模型不需要预判"我改完了没有"——它只需要看这一次的提示。
                const key = `${docId}::${drifted
                  .map((item) => `${item.id}@${item.was}`)
                  .sort()
                  .join(',')}`
                if (reportedDrift.has(key)) continue
                reportedDrift.add(key)
                // ---- 2026-11-16 M2.9：**顺带指出"哪句可能过期了"**（第 35 轮反馈）----
                //
                // 现场（`session-0a4d5b43` seq 153）：H-6 报了
                //   「`instruction-2`：标绿时 4ecf18，现在 1a4866」
                // 而 `handover-1` §5 里那句「`glob` 实跑命中 **4/4 命中**」
                // 正因为 `instruction-2` 被归档而**当场变成假话**。
                //
                // 模型看到的是两个指纹，无法把"它改过"和"我那句 4/4"联系起来 ——
                // 于是只能整份重读交接去人肉找，或者干脆无视（H-6 已经降级成信息）。
                //
                // ⇒ 从**被标绿那份文档的正文**里挑出「含计数的行」列出来。
                //   · 只挑含数字的（多数引用不会因为改个标点就假，全列 = 噪音）；
                //   · 只报**候选**，不判对错（插件不知道那个数字是否真的过期）；
                //   · 最多 5 条（再多没人看）。
                //
                // ⚠️ 这不升级 H-6 的级别（仍是 warn，用户拍板决策 #4），
                //    只是让同一条 warn **信息量更足**。
                let countingHint = ''
                try {
                  const selfEntry = entries.find((each) => each?.meta?.id === docId)
                  if (typeof selfEntry?.text === 'string') {
                    const { countingLinesOf } = await import('../core/markSnapshot.js')
                    const candidates = countingLinesOf(selfEntry.text)
                    if (candidates.length > 0) {
                      countingHint = `\n**它正文里这些行含数字/计数**（最可能过期的地方）：\n`
                        + candidates.map((line) => `  - ${line}`).join('\n')
                        + '\n核对一下就行 —— 这些是**候选**，不是判决。'
                    }
                  }
                } catch {
                  // 拿不到正文就算了：H-6 的主体信息仍然有效。
                }
                driftIssues.push({
                  rule: 'H-6',
                  level: 'warn',
                  docId,
                  message: driftMessageOf(docId, drifted).replace(/^⚠️ /, '') + countingHint,
                })
                // ★ 重取基线：把该文档快照里的 refs 更新成**当前**指纹。
                //
                // ⚠️ 只在**真的要报**的时候做（被 `reportedDrift` 挡掉的不重取）——
                //    否则同一份快照会被反复刷新，永远报不出来。
                // ⚠️ 写文件失败只 warn：快照是辅助信息，不能把健康度检查搞挂。
                if (typeof fsApi?.writeText === 'function') {
                  try {
                    const { snapshotOf, mergeSnapshot, MARK_SNAPSHOT_FILE: FILE } = await import('../core/markSnapshot.js')
                    const fresh = snapshotOf({
                      id: docId,
                      status: table[docId]?.status ?? 'authoritative',
                      at: Date.now(),
                      refs: entries
                        .filter((each) => each !== null && typeof each === 'object'
                          && each.unmanaged !== true
                          && typeof each.meta?.id === 'string' && each.meta.id !== ''
                          && each.meta.id !== docId)
                        .map((each) => ({ id: each.meta.id, fingerprint: String(each.fingerprint ?? '') })),
                    })
                    table = mergeSnapshot(table, fresh)
                    const writePath = `${root}/_artifacts/${FILE}`.replaceAll('\\', '/')
                    const writeTarget = await fsApi.resolve(writePath, { cwd: root })
                    await fsApi.writeText(
                      writeTarget,
                      `${JSON.stringify(table, null, 2)}\n`,
                      undefined,
                      exec?.signal,
                      { mode: 'workspace-write', workspaceRoot: root },
                    )
                  } catch {
                    // 静默：重取基线失败只意味着"下次还会再报一次"，不影响判据正确性。
                  }
                }
              }
            }
          }
        } catch {
          // 静默失败：快照是辅助信息，不能让它把健康度检查搞挂。
        }
      }

      const allIssues = [...issues, ...driftIssues]

      // 预算也一起报：模型拿到健康度后最常问的下一个问题就是"要读多少"。
      const budget = computeBudget(reg.index?.required ?? [], { limit: config.coldStartBudgetTokens })
      logger?.debug?.(`[ddd] doc_health：${allIssues.length} 条，${budget.tokens} tokens`)

      return {
        ok: result.ok,
        issues: allIssues.map((item) => ({
          rule: item.rule,
          level: item.level,
          docId: item.docId,
          message: item.message,
        })),
        skipped: Array.isArray(result.skipped) ? [...result.skipped] : [],
        stats: {
          docs: result.stats.docs,
          required: result.stats.required,
          // M2.9：必读清单的 id（与上面的 `required` 同一个数组，只是不再把名字丢掉）。
          requiredIds: (Array.isArray(reg.index?.required) ? reg.index.required : [])
            .map((entry) => entry?.meta?.id)
            .filter((id) => typeof id === 'string' && id !== ''),
          // ---- 2026-11-15 M2.7（#2）：**计数必须从 `allIssues` 算，不能用 `result.stats`** ----
          //
          // 缺陷（`session-535d7bab` seq 209 实测）：标题说「0 条 warn」，
          // 正文却列了一条 `[H-6]`。原因是：
          //
          //   · `result.stats.warnings` 只统计 `checkHealth` 的 5 项（H-1~H-5）；
          //   · H-6 是这里**后追加**的 `driftIssues`，从来没被算进去。
          //
          // 后果不只是难看：AI 会以为"健康度是干净的"，从而**跳过处理**。
          // 那一轮的 AI 自述原文：
          //
          //   > it says "0 条 warn" in header yet lists one.
          //   > Let me check whether it's benign.
          //
          // 它注意到了矛盾，然后**自己判断成良性跳过了**。那一轮是运气好（确实良性），
          // 换一份真引用了 read-order 的交接就会漏掉。
          //
          // ⇒ 正解：从**合并后**的 `allIssues` 直接数，两处口径永远一致。
          errors: allIssues.filter((item) => item.level === 'error').length,
          warnings: allIssues.filter((item) => item.level === 'warn').length,
        },
        rules: HEALTH_RULES.map((spec) => ({
          rule: spec.rule,
          title: spec.title,
          hits: result.stats.byRule?.[spec.rule] ?? 0,
        })),
      }
    },
  })
}

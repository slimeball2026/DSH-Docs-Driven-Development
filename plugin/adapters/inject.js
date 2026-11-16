/**
 * 每轮索引块注入（SPEC §6.4）。`ctx.systemPrompt.context()`。
 *
 * **为什么是 `context()` 而不是 `section()`**（与教练模式同样的判断）：
 * 1. 运行时上下文按**每次模型请求重新装配**，语义是"本快照取代上一份快照"；
 * 2. 它不进入历史消息，也不改系统提示词前缀，对 KV 缓存最友好；
 * 3. `text` 回调拿到的 `AssembleContext` 里有 `agent`（`assembleContextFor` 保证），
 *    所以能按会话渲染。
 *
 * **两个必须做对的地方**（都是实测出来的）：
 *
 * (1) `text` 回调**必须同步**。`dsh-agent-loop` 里 `renderContextSections()` 直接
 *     `entry.text(context)` 取值，不 await。所以这里只读注册表内存，绝不读盘。
 *
 * (2) 必须 `interpolate: false`。`dsh-system-prompt` 的 `renderPrompt` 会对
 *     `{{...}}` 做变量插值，**未知引用直接抛错**（"格式错误的提示词比明确失败更糟"）。
 *     我们的索引块要渲染用户文档的 `title` / `summary`——
 *     `summary: 用 {{model}} 生成` 这种完全可能存在。
 *     不关插值 = 某份文档让整个会话每一轮都硬失败。
 */

import { projectLineOf, renderIndexBlock, sliceLineOf } from '../core/render.js'
import { budgetHintIdsOf, computeBudget, renderBudgetLine } from '../core/budget.js'
import { isSubagentSession, shouldActivate } from '../core/scope.js'

/** 上下文注册名。 */
export const CONTEXT_NAME = 'ddd:index'

/**
 * 排序位置。
 *
 * `CONTEXT_ORDERS` 里第一方占用的顺序是：
 *   100 working-directory / 110 sandbox / 115 approval / 120 subagent-delegation
 *   / 125 team / 200 harness-source / 210 web-surface
 * 我们排在所有第一方条目**之后**（220），理由：
 * 索引块是"项目级规则"，应当排在环境事实之后——模型先知道自己在哪，
 * 再知道这个项目要求先读什么。
 */
export const CONTEXT_ORDER = 220

/**
 * 注册索引块上下文。
 *
 * @param {object} ctx 插件上下文
 * @param {object} deps
 * @param {object} deps.config
 * @param {() => object} deps.registry 取注册表（同步）
 * @param {() => object} deps.probe 取激活探测结果
 * @param {() => boolean} deps.ready 是否已扫过一遍
 * @returns {Function} disposer
 */
export function registerIndexBlock(ctx, deps) {
  const { config, registry, probe, ready } = deps

  return ctx.effect(() => ctx.systemPrompt.context({
    name: CONTEXT_NAME,
    order: CONTEXT_ORDER,
    // 见文件头 (2)：不关插值，文档里的 `{{` 会让整轮硬失败。
    interpolate: false,
    text: (assemble) => {
      // ---- 入口第一句：**要不要干活**。
      const session = assemble?.agent?.session
      const info = typeof probe === 'function' ? probe(session) : {}
      const activated = shouldActivate({
        hasMarker: info.hasMarker === true,
        hasProjectRoot: info.projectRoot !== undefined,
        isSubagent: isSubagentSession(session),
        requireMarker: config.requireMarker,
        excludeSubagents: config.excludeSubagents,
      })
      if (!activated) return ''

      // 还没扫过 / 扫描失败 → 空串（静默降级，绝不报错）。
      if (typeof ready === 'function' && ready(session) !== true) return ''

      const reg = typeof registry === 'function' ? registry(session) : registry
      if (reg === undefined || reg === null) return ''

      try {
        // **同步**读内存，不读盘。
        //
        // 【预算】行（M1-E）在这里算：它只依赖「必读集合 + 各文档 tokens」，
        // 不依赖已读集合、不含时间/轮次 —— 所以它**只在必读清单或某份文档长度变了时才变**，
        // 不会让索引块每轮都 append（M0-5 的红线）。
        const index = reg.index
        const budget = computeBudget(index?.required ?? [], {
          limit: config.coldStartBudgetTokens,
        })
        // M2-G / D-9：超限时给出**具体的**「先读哪几份」。
        // `budgetHintIdsOf` 只在超限时才被用来拼后缀；不超限时
        // `renderBudgetLine` 直接原样返回，**一个字符都不变**（判据 3）。
        const budgetLine = renderBudgetLine(budget, {
          hintIds: budget.over === true
            ? budgetHintIdsOf(index?.required ?? [], config.uiBudgetHintCount)
            : [],
          hintCount: config.uiBudgetHintCount,
        })

        return renderIndexBlock({
          index,
          readSet: typeof reg.readSetFor === 'function' ? reg.readSetFor(session) : reg.readSet,
          currentFingerprint: (id) => reg.fingerprintOf(id),
          maxChars: config.maxIndexBlockChars,
          activated: true,
          budgetLine,
          // M1.5 / N8：这个项目是什么。取不到时是空串，renderIndexBlock 会**整行不显示**。
          projectLine: projectLineOf(reg),
          // M1.5 / D5（选项 B）：当前切片名。同样**拿不到就整行不显示**。
          sliceLine: sliceLineOf(reg),
          // M1.5 / N4：【文档异常】要显示**相对项目根**的路径，不能用绝对路径。
          projectRoot: info.projectRoot,
        })
      } catch {
        // 渲染失败返回空串：索引块坏掉不该让会话挂掉。
        return ''
      }
    },
  }), 'ddd.systemPrompt.context()')
}

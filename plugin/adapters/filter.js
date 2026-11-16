/**
 * 坟场过滤（SPEC §8.2）。`tools/post-execute` 水fall。
 *
 * **为什么 guard 不够**：`guard` 按参数拦，它拦不住**枚举**——
 * `glob docs/**\/*.md` 的参数里没有坟场路径，**但结果里有**。
 * 所以两个挂钩点缺一不可（Q4 = A）。
 *
 * **为什么改 `content` 而不是 `value`**（实测 `dsh-tools` 的 post-execute）：
 *   - accept 决策可以给 `{ content }` 或 `{ value }`，**不能两个都给**
 *     （`throw new TypeError('tools/post-execute accept decision cannot replace both value and content')`）；
 *   - 失败结果不能换 `value`；
 *   - 模型的文本来自 `content`，所以换 `content` 就够了。
 *
 * 已知限制：`value` 里的坟场路径仍在，PTC 的 `run_code` 理论上能读到（写进 README）。
 */

import { isSubagentSession, shouldActivate } from '../core/scope.js'

/** 会产生“路径列表”的工具。 */
const ENUM_TOOLS = new Set(['glob', 'grep'])

/** 全部被剔除时的占位文案（SPEC §8.2：返回"没有匹配的文件"而不是空数组）。 */
export const EMPTY_TEXT = '（没有匹配的文件）'
export const EMPTY_MATCH_TEXT = '（没有匹配的内容）'

/**
 * 从结果内容里就地判断：是不是 glob 的 `value.paths` 形态。
 * @param {object} value
 * @returns {boolean}
 */
function isGlobValue(value) {
  return value !== null && typeof value === 'object'
    && Array.isArray(value.paths)
    && value.paths.every((item) => typeof item === 'string')
}

/** greps 的 value.matches 形态。 */
function isGrepValue(value) {
  return value !== null && typeof value === 'object'
    && Array.isArray(value.matches)
    && value.matches.every((item) => item !== null && typeof item === 'object'
      && typeof item.path === 'string')
}

/**
 * 从 glob 的结果里剔除坟场路径。
 *
 * @param {object} input
 * @param {object} input.value glob 的 value `{root, paths}`
 * @param {(path: string) => boolean} input.isGraveyard
 * @returns {{kept: string[], removed: number}}
 */
export function filterGlobPaths(input) {
  const paths = Array.isArray(input?.value?.paths) ? input.value.paths : []
  const kept = []
  for (const path of paths) {
    if (input.isGraveyard(path) === true) continue
    kept.push(path)
  }
  return { kept, removed: paths.length - kept.length }
}

/**
 * 从 grep 的结果里剔除坟场匹配。
 * @param {object} input
 * @param {object} input.value grep 的 value `{matches}`
 * @param {(path: string) => boolean} input.isGraveyard
 * @returns {{kept: object[], removed: number}}
 */
export function filterGrepMatches(input) {
  const matches = Array.isArray(input?.value?.matches) ? input.value.matches : []
  const kept = matches.filter((item) => input.isGraveyard(item.path) !== true)
  return { kept, removed: matches.length - kept.length }
}

/**
 * 组装 post-execute 处理器。
 *
 * @param {object} deps
 * @param {object} deps.config
 * @param {() => object} deps.probe
 * @param {(path: string) => string} deps.classify
 * @param {(path: string, session: object) => string} deps.resolvePath
 * @param {object} [deps.logger]
 * @returns {(exec: object, result: object, next: Function) => Promise<object>}
 */
export function createFilter(deps) {
  const { config, probe, classify, resolvePath, logger } = deps

  return async function dddFilter(exec, result, next) {
    // `next()` 必须调用 —— 这是 waterfall，不调用会吞掉后续监听器。
    const decision = typeof next === 'function' ? await next() : { kind: 'accept' }

    // ---- 入口第一句：**要不要干活**。
    const session = exec?.agent?.session
    const info = typeof probe === 'function' ? probe(session) : {}
    const activated = shouldActivate({
      hasMarker: info.hasMarker === true,
      hasProjectRoot: info.projectRoot !== undefined,
      isSubagent: isSubagentSession(session),
      requireMarker: config.requireMarker,
      excludeSubagents: config.excludeSubagents,
    })
    if (!activated) return decision

    if (config.graveyardFilterEnabled === false) return decision

    const name = exec?.name
    if (typeof name !== 'string' || !ENUM_TOOLS.has(name)) return decision

    // 失败结果不动。
    if (result?.isError === true) return decision
    // 已经被别的监听器改过内容/值，就不插手（避免覆盖别人的决策）。
    if (decision?.kind !== 'accept' || decision.content !== undefined || decision.value !== undefined) {
      return decision
    }

    const value = result?.value
    const isGrave = (path) => {
      try {
        return classify(path, session) === 'graveyard'
      } catch {
        return false
      }
    }

    try {
      if (isGlobValue(value)) {
        const { kept, removed } = filterGlobPaths({ value, isGraveyard: isGrave })
        if (removed === 0) return decision
        const text = kept.length === 0 ? EMPTY_TEXT : kept.join('\n')
        logger?.debug?.(`[ddd] 坟场过滤：从 glob 结果剔除 ${removed} 条`)
        return { ...decision, content: [{ type: 'text', text }] }
      }

      if (isGrepValue(value)) {
        const { kept, removed } = filterGrepMatches({ value, isGraveyard: isGrave })
        if (removed === 0) return decision
        const text = kept.length === 0
          ? EMPTY_MATCH_TEXT
          : groupGrepText(kept)
        logger?.debug?.(`[ddd] 坟场过滤：从 grep 结果剔除 ${removed} 条`)
        return { ...decision, content: [{ type: 'text', text }] }
      }
    } catch (error) {
      // 过滤失败只是漏一次门禁（SPEC §13 已承认门禁不是全覆盖），不能阻断施工。
      logger?.warn?.(`[ddd] 坟场过滤失败，保留原结果：${error?.message ?? error}`)
    }

    return decision
  }
}

/**
 * 按 grep 原始格式（按文件分组）重新渲染。
 *
 * 宿主 `grep` 的模型可见文本是"每个路径下分组展示 `Line N: <preview>`"，
 * 这里保持同一形状，避免模型看到两种格式。
 *
 * @param {Array<{path: string, lineNumber: number, line: string}>} matches
 * @returns {string}
 */
export function groupGrepText(matches) {
  const groups = new Map()
  for (const match of matches) {
    if (!groups.has(match.path)) groups.set(match.path, [])
    groups.get(match.path).push(match)
  }
  const out = []
  for (const [path, items] of groups) {
    out.push(path)
    for (const item of items) out.push(`  Line ${item.lineNumber}: ${item.line}`)
  }
  return out.join('\n')
}

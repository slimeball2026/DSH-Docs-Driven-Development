/**
 * 项目探测（SPEC §4.2）。
 *
 * **这个模块存在的唯一理由**：`systemPrompt.context()` 的 `text` 回调**必须同步**，
 * 而探测要读盘（异步）。所以必须把"异步探测"与"同步查询"拆开：
 *
 *   - `ensure(cwd)`  异步，真正读盘，结果写进缓存；
 *   - `peek(cwd)`   同步，只读缓存，**绝不读盘**。
 *
 * 但"第一轮就要有索引"与"回调必须同步"天然冲突。解法不是等：
 * **启动时就把 `process.cwd()` 与所有已知 cwd 预先探好**，
 * 并且在 `agent/pre-step`（异步、每个 step 都跑）里刷新当前会话的 cwd。
 * 这样 `text` 回调永远是读缓存，而缓存总是被前一步填好。
 *
 * 另外：探测**从会话 cwd 起步**，不是 `process.cwd()` ——
 * 否则会在完全无关的目录树里向上扫，既慢又可能误命中。
 */

import { dirname, join } from 'node:path'

import { probeMarker } from '../docs/marker.js'

/** 缓存有效期（同一 cwd 在这段时间内不重复读盘）。 */
export const PROBE_TTL_MS = 2000

/**
 * 建一个探测器。
 *
 * @param {object} deps
 * @param {object} deps.config resolveConfig 的产物
 * @param {object} deps.fsAdapter `{ listDir, readText, readHead }`
 * @param {(root: string) => object} deps.layoutOf 由项目根算布局
 * @param {object} [deps.logger]
 * @returns {object}
 */
export function createProber(deps) {
  const { config, fsAdapter, layoutOf, logger } = deps

  /**
   * @type {Map<string, {at: number, hasMarker: boolean, projectRoot?: string, via?: string}>}
   */
  const cache = new Map()
  /** 正在进行的探测（同一 cwd 不并发扫两遍）。 @type {Map<string, Promise<object>>} */
  const inflight = new Map()

  /** 取父目录；到根返回 undefined。 */
  function parentOf(path) {
    const parent = dirname(path)
    return parent === path ? undefined : parent
  }

  /**
   * 探测某个候选根是否带标记。
   * @param {string} root
   * @returns {Promise<boolean>}
   */
  async function probeOne(root) {
    const hit = await probeMarker({
      projectRoot: root,
      layout: layoutOf(root),
      listDir: fsAdapter.listDir,
      readHead: fsAdapter.readHead,
      joinPath: join,
    })
    return hit.hit === true
  }
  /**
   * 真正的探测逻辑。
   * @param {string} cwd
   * @returns {Promise<{hasMarker: boolean, projectRoot?: string, via?: string}>}
   */
  async function detect(cwd) {
    // ---- 1. 显式配置优先（SPEC §4.2 规则 1）
    if (config.projectRoot !== '') {
      const root = /^[A-Za-z]:[\\/]/.test(config.projectRoot) || config.projectRoot.startsWith('/')
        ? config.projectRoot
        : join(cwd, config.projectRoot)
      const hit = await probeOne(root)
      return hit ? { hasMarker: true, projectRoot: root, via: 'config' } : { hasMarker: false, projectRoot: root }
    }

    // ---- 2. 从会话 cwd 向上找**带激活标记的最近目录**（规则 2）
    let current = cwd
    let depth = 0
    while (current !== undefined && depth <= config.markerProbeDepth) {
      // 逐级探；一旦这一级命中就停（最近者胜）。
      if (await probeOne(current)) {
        return { hasMarker: true, projectRoot: current, via: 'marker' }
      }
      current = parentOf(current)
      depth += 1
    }

    // ---- 3. 探不到 → 静默降级（规则 3）
    // requireMarker=false 是调试开关：退化为"cwd 就是项目根"，仅用于本地验证。
    if (config.requireMarker === false) {
      return { hasMarker: false, projectRoot: cwd, via: 'require-marker-off' }
    }
    return { hasMarker: false }
  }

  /**
   * 确保某个 cwd 的探测结果已就绪（异步）。并发调用合并成一次。
   * @param {string} cwd
   * @returns {Promise<object>}
   */
  async function ensure(cwd) {
    if (typeof cwd !== 'string' || cwd === '') return { hasMarker: false }
    const cached = cache.get(cwd)
    if (cached !== undefined && Date.now() - cached.at < PROBE_TTL_MS) return cached

    const running = inflight.get(cwd)
    if (running !== undefined) return running

    const task = (async () => {
      try {
        const result = await detect(cwd)
        const record = { at: Date.now(), ...result }
        cache.set(cwd, record)
        return record
      } catch (error) {
        logger?.warn?.(`[ddd] 项目探测失败（${cwd}）：${error?.message ?? error}`)
        const record = { at: Date.now(), hasMarker: false }
        cache.set(cwd, record)
        return record
      } finally {
        inflight.delete(cwd)
      }
    })()

    inflight.set(cwd, task)
    return task
  }

  /**
   * 同步查询（**绝不读盘**）。缓存缺失时返回"未激活"。
   * @param {string} cwd
   * @returns {{hasMarker: boolean, projectRoot?: string, via?: string}}
   */
  function peek(cwd) {
    const cached = typeof cwd === 'string' ? cache.get(cwd) : undefined
    if (cached === undefined) return { hasMarker: false }
    return {
      hasMarker: cached.hasMarker,
      projectRoot: cached.projectRoot,
      via: cached.via,
    }
  }

  /** 清缓存（配置变化 / 释放时用）。 */
  function clear() {
    cache.clear()
    inflight.clear()
  }

  /**
   * 让**一个**目录的探测结果失效，下一次 `ensure` 会重新读盘。
   *
   * ---- 为什么需要这个（2026-11-13 用户实测）----
   *
   * `ensure()` 有 `PROBE_TTL_MS` 缓存。用户在面板里点"刷新"时，
   * 如果只是重拉列表而**不清这个目录的探测缓存**，那么
   * 「我刚在目录里建了 `docs/`」这件事**永远不会被发现**——
   * 面板会一直说"这不是 DDD 项目"，直到 TTL 过期或重启宿主。
   *
   * 症状特别像 bug：点了刷新没反应，但换一个目录（`pickDirectory`）反而好了
   * —— 因为换了 cwd 就绕过了那个坏缓存。
   *
   * @param {string} cwd
   */
  function forget(cwd) {
    if (typeof cwd !== 'string' || cwd === '') return
    cache.delete(cwd)
    // 归一化后的键也删一次（探测里可能会用 realpath）。
    for (const key of [...cache.keys()]) {
      if (key === cwd) cache.delete(key)
    }
  }

  /** 已知的项目根（供注册表预热）。 */
  function knownRoots() {
    const roots = new Set()
    for (const record of cache.values()) {
      if (record.projectRoot !== undefined) roots.add(record.projectRoot)
    }
    return [...roots]
  }

  return { ensure, peek, clear, forget, knownRoots }
}

/**
 * `AGENTS.md` 的节流写入（SPEC §6.5）。
 *
 * **只在成员或状态变化时重写**，不是每次请求。触发：
 *   - 插件激活后首次扫描完成
 *   - 有文档新增 / 删除 / status 变化
 *   - 用户在 UI 上手动"刷新索引"（M2）
 *
 * **为什么越少改越好**：`dsh-agent-instructions` 的注入是"持久 user 消息 +
 * digest 变化才追加替换"——每改一次 `AGENTS.md`，会话里就多一条历史消息，
 * 旧的在压缩前一直留着。所以这里做两重节流：
 *   1. **内容相同就不写**（`sameBlock` 比较）；
 *   2. 距上次写入 < `agentsMdMinWriteMs` 时**合并**（排队到窗口结束后写一次）。
 *
 * **为什么用 `ctx.fs` 而不是 `node:fs`**：
 * 走同一套文件后端，沙箱/远端部署下行为一致；`node:fs` 会绕过它们。
 */

import { mergeAgentsMd, renderAgentsMd, sameBlock } from '../core/agentsMd.js'
import { isSubagentSession, shouldActivate } from '../core/scope.js'

/**
 * 组装写者。
 *
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} deps.fs `ctx.fs`
 * @param {() => object} deps.registry
 * @param {() => object} deps.probe
 * @param {() => boolean} deps.ready
 * @param {object} deps.layout
 * @param {object} [deps.logger]
 * @param {() => number} [deps.now] 时间源（注入以便测试；默认 Date.now）
 * @returns {{sync: Function, dispose: Function, flushNow: Function}}
 */
export function createAgentsMdWriter(deps) {
  const { config, fs, registry, probe, ready, layout, logger } = deps
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()

  let lastWriteAt = 0
  let lastBlock = ''
  let pending = null
  let disposed = false

  /** 读现有 AGENTS.md（不存在返回 ''）。 */
  async function readExisting() {
    try {
      const target = await fs.resolve(layout.agentsMdAbs)
      const info = await fs.stat(target)
      if (info === undefined) return ''
      if (info.type !== 'file') return ''
      return await fs.readText(target)
    } catch {
      return ''
    }
  }

  /**
   * 真正写一次。
   *
   * ⚠️ **必须整体包 try/catch**：`ctx.fs` 是 `dsh-fs-sandbox` 后端，
   * 写操作受沙箱围栏限制（工作区外的路径会被拒），而本插件的调用方
   * （`ensureRegistry`）在 `await sync()` 上——一旦这里抛出，
   * **整个项目的注册表初始化就失败**，索引与门禁会一起不生效。
   *
   * 写 `AGENTS.md` 只是"慢变量索引"这一个附加价值，
   * 它失败绝不能连累门禁。宁可少一份索引，不可让门禁消失。
   */
  async function writeOnce(block) {
    if (disposed) return
    try {
      const existing = await readExisting()
      const merged = mergeAgentsMd(existing, block)
      if (existing === merged) return
      const target = await fs.resolve(layout.agentsMdAbs)
      await fs.writeText(target, merged)
      lastWriteAt = now()
      lastBlock = block
      logger?.debug?.('[ddd] 已更新 AGENTS.md 的索引块')
    } catch (error) {
      // 沙箱拒绝 / 只读 / 权限问题：记一条 warn 就够，不影响任何别的功能。
      logger?.warn?.(`[ddd] 写 AGENTS.md 失败（不影响门禁与索引块）：${error?.message ?? error}`)
    }
  }

  /**
   * 按当前索引同步一次（带节流）。
   * @returns {Promise<void>}
   */
  async function sync() {
    // ---- 入口第一句：**要不要干活**。
    const info = typeof probe === 'function' ? probe() : {}
    const activated = shouldActivate({
      hasMarker: info.hasMarker === true,
      hasProjectRoot: info.projectRoot !== undefined,
      isSubagent: false, // 写文件不看会话，但激活判定要看项目
      requireMarker: config.requireMarker,
      excludeSubagents: config.excludeSubagents,
    })
    if (!activated) return
    if (typeof ready === 'function' && ready() !== true) return
    if (typeof fs?.writeText !== 'function') return

    const reg = typeof registry === 'function' ? registry() : registry
    if (reg === undefined || reg === null) return

    const block = renderAgentsMd(reg.index, { terms: deps.terms })
    if (sameBlock(block, lastBlock)) return // 内容没变，绝不写

    const elapsed = now() - lastWriteAt
    const window = config.agentsMdMinWriteMs
    if (window > 0 && elapsed < window) {
      // 窗口内：排队，窗口结束后合并写一次。
      pending = block
      if (pendingTimer === null) {
        pendingTimer = setTimeout(() => {
          pendingTimer = null
          const queued = pending
          pending = null
          if (queued !== null) void writeOnce(queued)
        }, window - elapsed)
        // 定时器不该拖住进程退出。
        if (typeof pendingTimer?.unref === 'function') pendingTimer.unref()
      }
      return
    }

    await writeOnce(block)
  }

  /** @type {ReturnType<typeof setTimeout> | null} */
  let pendingTimer = null

  /** 立即写（测试与"刷新索引"用，绕过节流）。 */
  async function flushNow() {
    const reg = typeof registry === 'function' ? registry() : registry
    if (reg === undefined || reg === null) return
    await writeOnce(renderAgentsMd(reg.index, { terms: deps.terms }))
  }

  /** 停止排队中的写入。 */
  function dispose() {
    disposed = true
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer)
      pendingTimer = null
    }
    pending = null
  }

  return { sync, flushNow, dispose }
}

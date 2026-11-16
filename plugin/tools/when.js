/**
 * 工具的条件注册（M1-Q8）—— **M1 最危险的一处**（M1-L8）。
 *
 * ---- 为什么必须条件注册 ----
 * 本插件是**全局挂载**（S1）：`ctx.tools.register()` 注册的工具会出现在
 * **所有人的所有会话**里。M1 加了 4 个工具 = 4 份 schema = 每轮固定 token 开销。
 * 所以只在「探测到 DDD 项目根 + 非子代理」时才让它们可见。
 *
 * ---- 为什么这个文件必须这么小心 ----
 * `dsh-tools` 的行为（反编译 `lib/index.js` 的 `resolve()` 确认）：
 *
 * ```js
 * for (const [name, definition] of view.visible) {
 *   try { enabled = registration?.when === void 0 || await registration.when(context) }
 *   catch (cause) { throw new ToolActivationError(name, cause) }   // ← 抛错的后果
 *   if (enabled) admitted.set(name, definition)
 * }
 * ```
 *
 * 而 `ToolActivationError` 的 code 是 **`TOOL_ACTIVATION_FAILED`**，
 * 它会**中止整步准备**（`agent-loop` 的 `preStep` 里 `tools.resolve` 在 try 内，
 * 抛出去就是这一步起不来）。**不是"这个工具不可用"，是整个会话卡死。**
 *
 * 所以本模块的每一条都遵守三条纪律：
 *   1. **绝不抛**：每个条件整体包 try/catch，异常一律 `return false`；
 *   2. **绝不读盘**：只读 `probe.peek()` 的同步缓存（那是 pre-step 已经填好的）；
 *   3. **绝不改状态**：条件可能被调用多次（每个 step 一次），不能有副作用。
 *
 * > `when` 本身是 **await 的**（宿主 `await registration.when(context)`），
 * > 但它仍然不该做异步 IO：`resolve()` 是**串行**遍历全部工具的，
 * > 一个慢条件会拖慢每一步的全部工具。
 */

import { activationReason, isSubagentSession, shouldActivate } from '../core/scope.js'

/**
 * **执行期的 S2 兜底**：工具被执行时再判一次「这个会话该不该用 DDD 工具」。
 *
 * ---- 为什么需要第二道防线（M1-14 的实机教训）----
 * `when` 条件注册是**第一道**防线：它让工具从模型的工具清单里消失。
 * 但实机验收发现：**子代理会话仍然能看到并成功执行 4 个工具**。
 *
 * 已排除的解释：
 *   - `isSubagentSession()` 逻辑正确（离线用真实 header 形态验证 → true）；
 *   - 宿主确实给子会话写了 `origin: "subagent"`（反编译 `dsh-subagent` 确认）；
 *   - `when` 确实被调用过，且诊断日志里出现过 `isSub: true` 的记录。
 *
 * 也就是说：**「工具不可见」这条防线在子代理路径上不可靠**，
 * 而 M1-14 的判据是「4 个工具都不可见」。既然看不见这一点靠不住，
 * 就补一道**执行期**的 `if` —— 这与 M0 的 `guard` 是同一条思路：
 * 当「不注册」不是一个可选项时，就在回调内部判。
 *
 * ⚠️ **它不是替代品，是兜底**：正常路径下工具本来就不可见，
 * 走到这里说明第一道防线漏了；此时**拒绝执行**比"让它悄悄成功"安全得多
 * （子代理改 docs/ 会污染父会话的文档状态）。
 *
 * @param {object} deps
 * @param {object} deps.config
 * @param {(session: object|undefined) => {hasMarker: boolean, projectRoot?: string}} deps.probe
 * @param {(session: object|undefined) => object|undefined} deps.registry
 * @returns {(exec: object) => void} 不通过就 throw（工具错误，模型可见且不会结束回合）
 */
export function assertToolAllowed(deps) {
  const { config, probe, registry, ensureProbe } = deps

  return function assertAllowed(exec) {
    const session = exec?.agent?.session
    if (session === null || typeof session !== 'object') {
      throw new Error('DDD 工具不可用：拿不到会话上下文。')
    }

    const info = typeof probe === 'function' ? probe(session) : {}
    const reason = activationReasonSafe({
      hasMarker: info?.hasMarker === true,
      hasProjectRoot: info?.projectRoot !== undefined,
      isSubagent: isSubagentSession(session),
      requireMarker: config.requireMarker,
      excludeSubagents: config.excludeSubagents,
    })

    if (reason === 'subagent') {
      // 子代理被明确排除（S2）。文案要说明"这是刻意的"，否则模型会去猜是不是坏了。
      throw new Error(
        'DDD 工具在子代理会话里不可用（S2：子代理不参与文档施工）。'
          + '如果你需要改文档，请把结论交回父会话，由父会话来改。',
      )
    }
    if (reason !== 'active') {
      throw new Error(denyMessageOf(reason))
    }

    const reg = typeof registry === 'function' ? registry(session) : registry
    if (reg === undefined || reg === null || reg.state !== 'ready') {
      throw new Error('DDD 注册表还没就绪：这个会话不是 DDD 项目，或扫描失败了。')
    }
  }
}

/**
 * 判定 + **必要时现探一次**（M2.5，异步版）。
 *
 * ---- 为什么需要它（2026-11-14 实测，会话 `3ce8bc82`）----
 *
 * 现象：用户在**一个全新的空目录**里说「用 ddd 建一份 spec」，
 * `doc_new` 报 `no-project-root`。AI 按提示去问用户「这个目录对吗」，
 * 用户答「就是这个目录，继续」，它再试 —— **还是同一个错**。
 *
 * 根因：`index.js` 的 `probeOf()` 走的是 `prober.peek()`，而 `peek` 的语义是
 * **只读缓存、绝不读盘**。一个从没被任何会话打开过的目录，缓存里什么都没有，
 * 于是 `projectRoot` 是 `undefined` → 被判成 `no-project-root`。
 *
 * 但真实情况是：**目录拿得到，它只是还没被探测过**。正确的原因码应该是
 * `no-marker`（"还不是 DDD 工作区"），而那条提示恰好告诉用户怎么初始化。
 *
 * ⚠️ **这个坑 `index.js` 的 `locate()` 早就修过**（那条是 HTTP 路由用的），
 * 注释原文：「这里必须用 `ensure` 而不是 `peek`……一个从没被任何会话打开过的目录，
 * 缓存里什么都没有」。**工具这条路漏了同一个修法。**
 *
 * ---- 为什么是异步 ----
 *
 * `ensure` 要读盘（找 `AGENTS.md`），不能放进同步的 `peek` 里。
 * 好在四个工具的 `execute` 本来就是 `async` —— 把判定也改成 await 是免费的。
 *
 * @param {object} deps
 * @param {object} deps.config
 * @param {(session: object|undefined) => {hasMarker: boolean, projectRoot?: string}} deps.probe 同步读缓存
 * @param {(session: object|undefined) => object|undefined} deps.registry
 * @param {(session: object|undefined) => Promise<object>} [deps.ensureProbe] 现探一次（读盘）
 * @returns {(exec: object) => Promise<void>} 不通过就 throw
 */
export function assertToolAllowedAsync(deps) {
  const { config, probe, registry, ensureProbe } = deps
  const syncCheck = assertToolAllowed({ config, probe, registry })

  return async function assertAllowedAsync(exec) {
    const session = exec?.agent?.session

    // 先走同步判定（绝大多数情况下缓存已有，零成本）。
    try {
      syncCheck(exec)
      return
    } catch (error) {
      // 只有"探不到项目根"这一种失败**值得**现探一次 ——
      // 其余（子代理 / 没标记 / 已禁用）现探也改变不了结论。
      const message = String(error?.message ?? '')
      if (!message.includes('no-project-root')) throw error
      if (typeof ensureProbe !== 'function') throw error
    }

    // 现探一次，然后**重新判定**（用新缓存）。
    try {
      await ensureProbe(session)
    } catch { /* 探测失败：按原样再判一次，让它给出原来的错 */ }

    syncCheck(exec)
  }
}

/** `activationReason` 的安全包装（它本身不抛，但探测可能抛）。 */
function activationReasonSafe(input) {
  try {
    return activationReason(input)
  } catch {
    return 'unknown'
  }
}

/**
 * 未激活时到底该做什么 —— **按原因给具体出路**（M2.5 · 摩擦台账补充）。
 *
 * ---- 为什么必须分开说（2026-11-14 实测，会话 `25c3ac49`）----
 *
 * 旧文案是一句打包的话：
 *
 * > 「DDD 工具在这个会话里不可用（no-project-root）：这里不是 DDD 项目，或激活标记没探测到。」
 *
 * 实测后果：AI 拿到这句之后**没有去找用户**，而是花了 **20+ 次工具调用**去逆向插件：
 *
 *   搜 app.asar → 读 `D:\deepseek-harness` → 读 `.dsh\profiles\desktop`
 *   → `read DDD插件施工\ddd-bundle\server\init-workspace.ts`
 *   → 最后**手写** `docs/read-order.md`（绕过了 `doc_new`）
 *
 * 也就是说：**一句含糊的报错，把 AI 推向了"读插件源码"这条最贵的路。**
 *
 * 而那件事本来只需要一句话：「这个目录还不是 DDD 工作区，先加激活标记」。
 *
 * ---- 三种原因给三种出路 ----
 *
 * | 原因 | 真实含义 | 该做什么 |
 * |---|---|---|
 * | `no-project-root` | **这个目录不是 DDD 工作区**（探不到标记） | **自己写** `AGENTS.md` 的 `<!-- ddd:index -->`，或 `docs/` 下一份合法 frontmatter |
 * | `no-marker` | 同上，只是探到了目录 | 同上 |
 * | `disabled` | 配置里关了 | 找用户 |
 *
 * ⚠️ 出路**不能**写成「按 README 做」—— 全新目录里根本没有 README（M2.6 实测 5 个会话全卡死）。
 * ⚠️ 出路是**请用户点界面按钮**，不是让 AI 自己去建标记文件 ——
 * 「这个目录要不要变成 DDD 工作区」是用户的选择，不该由 AI 在报错里被推着替他决定。
 * ⚠️ 三种都**不要**让 AI 去读插件源码 —— 那是实现细节，不是任务。
 * ⚠️ 也**不要**让 AI 去"确认工作目录" —— 实测证明那是个假问题（会话 `47533924`）。
 *
 * @param {string} reason `SCOPE_REASONS` 之一
 * @returns {string} 模型可见的错误文案
 */
export function denyMessageOf(reason) {
  const head = `DDD 工具在这个会话里不可用（${reason}）。`

  if (reason === 'no-project-root') {
    // ---- 2026-11-14 M2.5 收尾：改掉误导性的归因 ----
    //
    // ⚠️ 这段文案原来写的是「拿不到当前会话的工作目录，所以不知道要管哪个项目」，
    // 并且让 AI「先向用户确认工作目录」。
    //
    // **那个归因是错的。** 实测（会话 `47533924`，目录 `DDD新建测试2`）：
    // 会话的 cwd 明明是好的（`session.cwd` 有值），AI 也确实去问了用户、
    // 用户也确认了「就是这个目录」—— 但再试**还是同一个错**。
    //
    // 真正的原因在 `adapters/probe.js` 的 `detect()` 第 3 步：
    //
    //   // ---- 3. 探不到 → 静默降级（规则 3）
    //   return { hasMarker: false }        ← **没有 projectRoot**
    //
    // 也就是说：**探不到激活标记时 `projectRoot` 按设计就是 undefined**，
    // 于是 `core/scope.js` 的 `hasProjectRoot === false` 永远先命中，
    // `NO_MARKER` 那个分支几乎走不到。
    //
    // 所以 `no-project-root` 在这个场景下的真实含义是
    // **「这个目录不是一个 DDD 工作区」**，而不是「拿不到目录」。
    //
    // 为什么只改文字、不改机制（用户 2026-11-14 拍板）：
    //   - 改 `detect()` 让它返回 projectRoot 会破坏「探不到就 no-op」这条铁律；
    //   - 改 `scope.js` 的原因码优先级要动冻结判据附近；
    //   - 而收益只是"一句话更准确"。
    //   ⇒ 让报错**别再把人往错误方向引**就够了，真正的使用说明写在 README 里。
    //
    // ---- 2026-11-14 M2.6：出路必须**可执行且不越权** ----
    //
    // M2.5 版写的是「按 README 里『如何把目录变成 DDD 工作区』做」——
    // 但**全新目录里没有 README**，这等于把死循环换了个方向。
    //
    // M2.6 第一版我把它改成「AI 自己写 AGENTS.md」——**用户当场否掉了，理由是这条**：
    // 「这个目录要不要变成 DDD 工作区」是**用户的选择**，不该由 AI 在报错里被推着替他决定；
    // 而且手写标记只能让插件"激活"，不是一份正常的工作区（没有 docs/、没有入口索引）。
    // 记录在此，别再改回去。
    //
    // 正确的出路：**请用户点界面上那个按钮**。它有名字、有位置、用户一看就能做，
    // 且「初始化」这个动作本来就只有人能做（`server/init-workspace.ts` 走的是面板那条路）。
    //
    // ⚠️ 注意与"确认工作目录"的区别 —— 那是**问用户一个他答了也没用的问题**（死循环的成因）；
    // 这里是**请用户做一个他做了就生效的动作**。两者不是一回事。
    return head
      + '原因：这个目录还不是 DDD 工作区（没探测到激活标记）。\n'
      + '**这不是路径问题**：会话的工作目录是对的，缺的是「这是个 DDD 项目」的标记。\n'
      + '**该做什么**：请用户在这个面板里点一下「初始化为 DDD 工作区」按钮 —— '
      + '它会建 `docs/` 并写一份合规的入口索引，点完就能用。\n'
      + '（按钮位置：DDD 面板顶部的「项目根」一行，`⟳` 右边。'
      + '要初始化的目录不在下拉里，先点「浏览…」选它。）\n'
      + '**不要**自己写 `AGENTS.md` 或 `docs/` 去凑标记 —— 要不要让这个目录变成 DDD 工作区，由用户决定。\n'
      + '**不要**去确认/更改会话的工作目录（那是对的），也**不要**读 DDD 插件的源码 —— 那都不是问题所在。'
  }
  if (reason === 'no-marker') {
    // 与 `no-project-root` 同一件事，只是**探到了目录、没探到标记**。出路同样指向用户那一下点击。
    return head
      + '原因：这个目录还不是 DDD 工作区 —— 目录找到了，但没探到激活标记。\n'
      + '**该做什么**：请用户在这个面板里点「初始化为 DDD 工作区」按钮'
      + '（「项目根」一行，`⟳` 右边；目录不在下拉里就先点「浏览…」）。\n'
      + '**不要**自己写 `AGENTS.md` 或 `docs/` 去凑标记 —— 那是用户的选择。\n'
      + '不要为了搞清楚原因去读 DDD 插件的源码 —— 那不是你的任务。'
  }
  if (reason === 'disabled') {
    return head
      + '原因：DDD 插件在当前配置里被显式关掉了（调试开关）。\n'
      + '**该做什么**：告诉用户插件未启用，不要尝试绕过。'
  }
  return head
    + '原因：未知（探测过程抛错了）。\n'
    + '**该做什么**：把这个原因码告诉用户，不要自己改文档或读插件源码。'
}

/**
 * 建一个「当前会话该不该看到 M1 工具」的判定器。
 *
 * 判定链与全插件其它入口**完全一致**（`core/scope.js` 的 `shouldActivate`），
 * 只是额外要求「注册表已就绪」—— 注册表没扫成功时工具不该出现
 * （它们全都依赖注册表里的元数据，出现了也只会报错）。
 *
 * @param {object} deps
 * @param {object} deps.config
 * @param {(session: object|undefined) => {hasMarker: boolean, projectRoot?: string}} deps.probe
 *        同步探测（**只读缓存，绝不读盘**）
 * @param {(session: object|undefined) => object|undefined} deps.registry
 *        同步取注册表
 * @param {object} [deps.logger]
 * @returns {(context: object) => boolean} 宿主 `when` 回调（**永不抛**）
 */
export function createToolGate(deps) {
  const { config, probe, registry, logger } = deps

  return function whenToolsVisible(context) {
    try {
      // `when` 收到 `{ agent, modelSelection, signal }`；会话从 agent 上取。
      const agent = context?.agent
      const session = agent?.session

      // ⚠️ **拿不到 session 一律不可见**（fail-closed）。
      //
      // 这是自查时补的：`shouldActivate` 的默认是 `hasProjectRoot !== false` 时放行，
      // 所以 `session === undefined` 会被判成"激活"。对**门禁**来说那是保守的（放行=不拦），
      // 但对**工具可见性**来说方向相反：拿不到会话就暴露 4 份 schema 给一个未知会话。
      // 两者的正确默认值不同，所以这里显式挡一道。
      if (session === null || typeof session !== 'object') return false

      const info = typeof probe === 'function' ? probe(session) : {}
      const activated = shouldActivate({
        hasMarker: info?.hasMarker === true,
        hasProjectRoot: info?.projectRoot !== undefined,
        isSubagent: isSubagentSession(session),
        requireMarker: config.requireMarker,
        excludeSubagents: config.excludeSubagents,
      })
      if (!activated) return false

      const reg = typeof registry === 'function' ? registry(session) : registry
      if (reg === undefined || reg === null) return false
      // 扫描失败 / 还没扫过 → 工具不出现：它们全都依赖注册表里的元数据。
      if (reg.state !== 'ready') return false

      return true
    } catch (error) {
      // ⚠️ **这一行是 M1-L8 的全部**：条件抛错 = TOOL_ACTIVATION_FAILED = 会话卡死。
      // 任何意外都只能变成「工具不可见」，绝不能冒泡。
      // 这里**只 debug 不 warn**：条件每步都求值，warn 会把日志刷满。
      logger?.debug?.(`[ddd] 工具可见性判定异常（按不可见处理）：${error?.message ?? error}`)
      return false
    }
  }
}

/**
 * 把一个 `when` 回调包成"无论如何都不抛"的版本。
 *
 * 为什么还要包一层（`createToolGate` 内部已经有 try/catch）：
 * 注册时的调用方可能是**我们自己**（冒烟脚本、单测），
 * 也可能将来有人在 `createToolGate` 外面再接一段逻辑。
 * 包一层之后，**任何**传给宿主的 `when` 都天然满足"永不抛"这条硬约束。
 *
 * @param {(context: object) => unknown} when
 * @param {object} [logger]
 * @returns {(context: object) => boolean}
 */
export function safeWhen(when, logger) {
  return function safeWhenCall(context) {
    try {
      const verdict = typeof when === 'function' ? when(context) : false
      return verdict === true
    } catch (error) {
      logger?.debug?.(`[ddd] when 条件抛错（按不可见处理）：${error?.message ?? error}`)
      return false
    }
  }
}

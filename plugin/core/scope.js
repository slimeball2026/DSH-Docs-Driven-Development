/**
 * 激活判定 —— **S1 / S2 的总闸门**（SPEC §4.3 / §4.4 / §10.1）。
 *
 * 这是整个插件最重要的几行代码，因为：
 *
 * > **装载是全局的，生效是项目级的。**
 *
 * 全局挂载让 `guard` 作用于**所有会话**。如果只凭「有 docs/ 目录」就启用，
 * 一个普通代码仓库里刚好有个 `docs/`（没有 frontmatter），模型去改它就会被拦——
 * **不可接受的误伤**（M0-12 专门盯这个）。
 *
 * 同理，子代理被门禁拦住是**硬故障**而不是体验问题：它没法干活。
 *
 * 写成纯函数是因为它必须先于任何 adapter 被单测钉死——
 * 这个东西写错了，M0-12（普通仓库被误伤）和 M0-13（子代理被拦）会一起失败，
 * 而且是在你以为是 frontmatter 或 guard 问题的时候。
 *
 * **本文件属 `core/`：零 IO、零时间、零随机、不 import 任何内置模块。**
 */

/** 判定结果的原因码，便于日志与单测断言。 */
export const SCOPE_REASONS = Object.freeze({
  /** 已激活。 */
  ACTIVE: 'active',
  /** 子代理会话 —— S2 排除。 */
  SUBAGENT: 'subagent',
  /** 没有激活标记 —— S1 防误伤。 */
  NO_MARKER: 'no-marker',
  /** 探测不到项目根。 */
  NO_PROJECT_ROOT: 'no-project-root',
  /** 配置显式关闭了本插件（调试用）。 */
  DISABLED: 'disabled',
})

/**
 * 判断本插件是否应在当前会话/项目里干活。
 *
 * 规则（顺序重要，先命中者胜）：
 *   1. `isSubagent` → false（S2，**即使有标记也不生效**）
 *   2. `hasMarker`  → false 时看 `requireMarker`（S1）
 *   3. 否则        → true
 *
 * @param {object} input
 * @param {boolean} input.hasMarker 是否探测到激活标记（T1 或 T2）。
 * @param {boolean} input.isSubagent 是否子代理会话。
 * @param {boolean} [input.requireMarker] S1 配套开关，默认 true。
 * @param {boolean} [input.excludeSubagents] S2 配套开关，默认 true。
 * @param {boolean} [input.enabled] 总开关（调试用），默认 true。
 * @param {boolean} [input.hasProjectRoot] 是否探测到项目根，默认 true。
 * @returns {boolean}
 */
export function shouldActivate(input) {
  return activationReason(input) === SCOPE_REASONS.ACTIVE
}

/**
 * 同 `shouldActivate`，但返回原因码（给日志与单测用）。
 *
 * @param {object} input 同 shouldActivate
 * @returns {string} SCOPE_REASONS 之一
 */
export function activationReason(input) {
  const opts = input !== null && typeof input === 'object' ? input : {}

  if (opts.enabled === false) return SCOPE_REASONS.DISABLED

  // S2 优先：子代理即使带着标记也不加载。
  // 判据是 session.header.origin === 'subagent'（[实测] dsh-session 的
  // validateSessionHeader 只允许这一个值），由适配层算好传进来。
  if (opts.isSubagent === true && opts.excludeSubagents !== false) {
    return SCOPE_REASONS.SUBAGENT
  }

  if (opts.hasProjectRoot === false) return SCOPE_REASONS.NO_PROJECT_ROOT

  // S1：没有激活标记就整个 no-op（除非调试时显式关掉 requireMarker）。
  if (opts.hasMarker !== true && opts.requireMarker !== false) {
    return SCOPE_REASONS.NO_MARKER
  }

  return SCOPE_REASONS.ACTIVE
}

/**
 * 写类工具名单（M1.5 / **N9**：子代理写 `docs/` 要拦的那一类）。
 *
 * 与 `core/gate.js` 的 `READ_TOOLS` 互补：
 * `READ_TOOLS` 是"永不拦"，这里是"**要拦的**"。
 * `apply_patch` 也算写（它可能改多份文件），虽然 `pathArgOf` 抽不出单一路径——
 * 那种情况下我们**不猜**（见 `decideSubagentWrite` 的注释）。
 */
export const WRITE_TOOLS = Object.freeze(['write', 'edit', 'str_replace_editor', 'apply_patch'])

/**
 * 子代理写 `docs/` 的裁决（M1.5 / **N9**，`P14` 授权）。
 *
 * ---- 为什么需要这条（这是 M1 评审里唯一的**架构级**缺陷）----
 *
 * S2 原本是「整个插件对子代理 no-op」。实测后果：
 *
 * ```
 * 1. 主 agent 派子代理去改 docs/
 * 2. 子代理没读过任何必读文档（它连索引块都没有）
 * 3. write 成功 —— 门禁对子代理 no-op（guard.js）
 * 4. 不记 readSet、不记 write、不 rescan（observe.js 同样 S2 no-op）
 * 5. 主 agent 的索引块显示「0/6 未读」—— 一切如常
 * ```
 *
 * 于是**核心不变量「改文档的人必须是读过文档的人」在子代理路径上完全不成立**，
 * 而且**不留任何痕迹**。它比 M1-14（工具可见但执行被拒）严重，因为
 * M1-14 有兜底、有回执、一调用就暴露；这条是**完全静默**的。
 *
 * ---- 为什么判决是「拦」而不是「让子代理也加载」----
 *
 * 用户拍板（`P14`）的原话：「子代理只干活（只写代码这类工程活），文档交给主 agent 去改」。
 * 这条把不变量的边界画对了：**「读过」是会话级的事实，不能通过派生子代理来继承。**
 *
 * 而且它**恰好绕开了 S2 的理由 #3**（"门禁会拦住子代理的正常写入，让它没法干活"）：
 * 如果子代理本来就不该干文档活，那"改文档被拒"就**不是硬故障，是设计意图**——
 * 它会把子代理**逼回正确的分工**。
 *
 * ---- 为什么不动 probe（**这一条推翻了交接文档的假设**）----
 *
 * 交接 §3.9.3 写「子代理的 probe 是 no-op，所以判不出 docs/」，并据此建议
 * 「让子代理也 probe，代价是付一次探测成本」。
 *
 * **实测（`_m15/probe-n9-facts.mjs`）表明这不成立**：
 *   - `adapters/probe.js` 的 `peek(cwd)` **只看 cwd、完全不看 session**；
 *   - `index.js` 的 `prepareSession` **没有** isSubagent 判断，子代理照常探测；
 *   - 子代理 `header.cwd` 也在，所以 `cwdOf` 一样拿得到。
 *
 * 实测输出：子代理会话与普通会话对**同一个 cwd** 的 `peek()` 结果**逐字相同**
 * （都是 `{hasMarker:true, projectRoot:...}`）。
 *
 * 所以：**S2 的唯一落点是 `shouldActivate()`，不是 probe。**
 * 修法因此简单得多——判据本来就拿得到项目根，**不需要额外探测、不增加成本**。
 *
 * @param {object} input
 * @param {string} [input.toolName] 工具名
 * @param {string} [input.path] 已解析成绝对路径的目标（抽不出时为 undefined）
 * @param {string} [input.kind] `classify(path)` 的结果（doc / graveyard / deliverable / ...）
 * @param {boolean} [input.isSubagent]
 * @param {boolean} [input.excludeSubagents] **现有**配置项：true 表示 S2 生效
 * @returns {string | undefined} 拒绝文案；undefined = 放行
 */
export function decideSubagentWrite(input) {
  const opts = input !== null && typeof input === 'object' ? input : {}

  // 不是子代理 → 这条规则不适用（主 agent 的一切行为**完全不变**）。
  if (opts.isSubagent !== true) return undefined
  // `excludeSubagents === false` 是那些"要单独评估"的项目/调试场景：
  // 维持 M1 的旧行为（完全放行）。**必须显式配成 false 才放开**，默认是拦。
  if (opts.excludeSubagents === false) return undefined
  if (typeof opts.toolName !== 'string' || !WRITE_TOOLS.includes(opts.toolName)) return undefined

  // 判据是 `classify()` 的结果而不是字符串匹配 `/docs/`：
  // 后者会误伤 `src/docs/`，而误伤正是这个项目反复批评的形态。
  //
  // ⚠️ 坟场**不算** `doc`（`classify` 会返回 `graveyard`，而且坟场本来就一律拒绝，
  // 由 `decideGate` 里更早的那一条管）。这里只管普通的 `docs/`。
  if (opts.kind !== 'doc') return undefined

  return 'docs/ 下的文档只能由主 agent 改（S2：子代理不参与文档施工）。\n'
    + '你改的是文档，不是代码。请把「要改什么、为什么改」交回父会话，由父会话读过之后落盘。'
}

/**
 * 从会话对象判断它是不是子代理会话。
 *
 * **纯函数**：只读 `session.header`，不做任何 IO。
 *
 * 判据来自实测的 DSH 源码：
 * - `dsh-session` 的 `validateSessionHeader` 硬编码
 *   `if (record.origin !== void 0 && record.origin !== "subagent") throw`，
 *   所以 `origin` 只可能是 `undefined` 或 `'subagent'`。
 * - `dsh-subagent/lib/types/child-agent.js` 在创建子会话时写 `origin: 'subagent'`。
 * - 子代理还会带 `delegationDepth`（durable，跨恢复保留）。
 *
 * **不做「有 parentSession 就当子代理」的保守降级**：
 * `dsh-session` README 明说「历史普通 fork 可能仍在此字段保留来源」，
 * 那样会把普通 fork 会话误判成子代理，让用户失去门禁保护。
 * SPEC §4.4 的「待复核」到此关闭。
 *
 * @param {object} session 会话对象（可能缺 header）。
 * @returns {boolean}
 */
export function isSubagentSession(session) {
  const header = session?.header
  if (header === null || typeof header !== 'object') return false
  if (header.origin === 'subagent') return true
  // 兜底：origin 缺失但 delegationDepth > 0（子代理路径写入的 durable 字段）。
  if (header.origin === undefined
    && typeof header.delegationDepth === 'number'
    && header.delegationDepth > 0) {
    return true
  }
  return false
}

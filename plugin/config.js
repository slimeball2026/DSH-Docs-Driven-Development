/**
 * 插件配置的默认值与归一化。
 *
 * **本文件不导出 `Config` schema**，也不 import `@deepseek-ai/schemastery`——
 * profile 里装的 bundle 解析不到 dsh 自己的包（实测 `ERR_MODULE_NOT_FOUND`）,
 * 导出 `Config` 会让整行加载失败。
 *
 * 代价：`cordis.patch.yml` 里这一行的 `config` 不会被 schema 校验，
 * Plugin Manager 里也就没有字段表单。所以 `resolveConfig` 必须自己兜住
 * 缺字段、类型不对、负数、非有限数等所有情况。
 *
 * 归一化规则（SPEC §11，全部静默回落默认值，**绝不抛**）：
 * - 非字符串 → 默认
 * - 负数 / 非有限数 → 默认
 * - 布尔非 `true`/`false` → 默认
 */

/** 配置默认值（SPEC §11 的表格，逐项对应）。 */
export const CONFIG_DEFAULTS = Object.freeze({
  /** 空 = 自动探测（§4.2）。非空时相对工作区解析。 */
  projectRoot: '',
  docsDir: 'docs',
  graveyardDir: 'docs/_graveyard',
  deliverablesDir: 'deliverables',
  artifactsDir: '_artifacts',
  agentsMdName: 'AGENTS.md',
  maxIndexBlockChars: 1200,
  maxWatchedDocs: 100,
  agentsMdMinWriteMs: 5000,
  gateEnabled: true,
  graveyardFilterEnabled: true,
  /** S1 配套：必须有激活标记才生效。设 false = 只凭 docs/ 目录就激活（危险，仅调试）。 */
  requireMarker: true,
  /** S2 配套：子代理会话不加载。设 false 会让子代理也被门禁拦住（不建议）。 */
  excludeSubagents: true,
  /** 向上探测项目根的层数上限，防止在深目录里一路扫到盘根。 */
  markerProbeDepth: 8,

  // ---------------------------------------------------------------- M1 新增

  /**
   * 冷启动预算上限（token，M1-E）。
   * 索引块的【预算】行超过这个数就带 ⚠️。**它只影响渲染，不拦任何操作。**
   */
  coldStartBudgetTokens: 30000,

  // ---------------------------------------------------------------- M2 新增

  /**
   * 关掉就**不注册 host 的 HTTP 路由**（调试用）。
   *
   * ⚠️ **它关不掉 client bundle** —— 这是实测出来的边界，不要写错注释：
   * `dsh.client` 是**宿主在 Loader 层读 `package.json`** 决定的，
   * 插件自己的 `config` 到不了那一层。所以：
   *
   * | 想要 | 怎么做 |
   * |---|---|
   * | 让看板拿不到数据（但面板还在） | `uiEnabled: false` |
   * | 让面板彻底不出现 | 从 `package.json` 里删掉 `dsh.client`，或停用整个 bundle |
   *
   * 我第一版把这行注释写成"关掉就不注册 client bundle"——**那是错的**，
   * 而且错得很隐蔽：改成 false 之后面板照样出现、只是永远显示"没有数据"，
   * 很容易被误诊为"client bundle 有问题"。
   */
  uiEnabled: true,
  /** 0 = 不轮询，只在用户操作时刷新；> 0 = 轮询间隔（毫秒）。 */
  uiRefreshMs: 0,
  /**
   * M2-G 推荐的「先读」份数上限（SPEC §9 与 §6.7 判据 4）。
   *
   * ⚠️ 这个值会被 `core/budget.js` 的 `MAX_BUDGET_HINTS`（5）**再夹一次**：
   * 配成 99 不会真的列 99 个 id —— 那会把索引块撑爆，又变成长清单。
   */
  uiBudgetHintCount: 3,
})

/** 正整数（>=1）；非法回落默认值。 */
function naturalOf(value, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

/** 非负整数（>=0）；非法回落默认值。`agentsMdMinWriteMs` 允许 0（= 不节流）。 */
function nonNegativeOf(value, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(number) && number >= 0 ? number : fallback
}

/** 非空字符串；空白串视为未设置，回落默认值。 */
function textOf(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length === 0 ? fallback : trimmed
}

/** 布尔：只有显式的 true / false 才算数，其余一律回落默认值。 */
function booleanOf(value, fallback) {
  return value === true || value === false ? value : fallback
}

/**
 * 把用户写的配置补成完整、类型正确的对象。
 * @param {unknown} config `cordis.patch.yml` 里该行的 `config`（可能整个缺失）。
 * @returns {Readonly<typeof CONFIG_DEFAULTS>} 完整配置。
 */
export function resolveConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const d = CONFIG_DEFAULTS

  return Object.freeze({
    projectRoot: typeof raw.projectRoot === 'string' ? raw.projectRoot.trim() : d.projectRoot,
    docsDir: textOf(raw.docsDir, d.docsDir),
    graveyardDir: textOf(raw.graveyardDir, d.graveyardDir),
    deliverablesDir: textOf(raw.deliverablesDir, d.deliverablesDir),
    artifactsDir: textOf(raw.artifactsDir, d.artifactsDir),
    agentsMdName: textOf(raw.agentsMdName, d.agentsMdName),
    maxIndexBlockChars: naturalOf(raw.maxIndexBlockChars, d.maxIndexBlockChars),
    maxWatchedDocs: naturalOf(raw.maxWatchedDocs, d.maxWatchedDocs),
    agentsMdMinWriteMs: nonNegativeOf(raw.agentsMdMinWriteMs, d.agentsMdMinWriteMs),
    gateEnabled: booleanOf(raw.gateEnabled, d.gateEnabled),
    graveyardFilterEnabled: booleanOf(raw.graveyardFilterEnabled, d.graveyardFilterEnabled),
    requireMarker: booleanOf(raw.requireMarker, d.requireMarker),
    excludeSubagents: booleanOf(raw.excludeSubagents, d.excludeSubagents),
    markerProbeDepth: naturalOf(raw.markerProbeDepth, d.markerProbeDepth),
    coldStartBudgetTokens: naturalOf(raw.coldStartBudgetTokens, d.coldStartBudgetTokens),

    // ---- M2 新增
    uiEnabled: booleanOf(raw.uiEnabled, d.uiEnabled),
    /** 0 是**合法值**（不轮询），所以用 nonNegativeOf；`naturalOf` 会把 0 当非法。 */
    uiRefreshMs: nonNegativeOf(raw.uiRefreshMs, d.uiRefreshMs),
    uiBudgetHintCount: naturalOf(raw.uiBudgetHintCount, d.uiBudgetHintCount),
  })
}

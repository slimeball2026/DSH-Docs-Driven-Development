/**
 * 冷启动预算（M1-E，SPEC-M1 §7.1）。
 *
 * **纯函数，零 IO / 零时间 / 零随机 / 不 import 任何内置模块。**
 *
 * ---- 它回答什么问题 ----
 * 「这个项目的必读清单，要花多少 token 才能读完？」
 *
 * 用户原始设想里有「文档置信度」和「阅读顺序」，但真正决定**新会话能不能开工**的
 * 是第三个数：**必读清单的总成本**。太大 → 新会话读不完就被截断 → 交接等于没交接。
 *
 * ---- 三条硬约束（都来自 SPEC §7.1，都有理由）----
 * 1. **不写回 frontmatter。** 写回会让每次读都改文件 → 指纹变 → 门禁要求重读 →
 *    索引块文本变 → 又违反 M0-5（索引不随轮次累积）。这是**连锁失效**，不是洁癖。
 * 2. **显式 `tokens` 优先，没有才估算。** 作者自己量过就信作者的。
 * 3. **估算公式 `Math.ceil(正文字符数 × 0.75)`。** 中文按 1 字 ≈ 0.75 token 保守取整。
 *    这是**下界估计**（实际 tokenizer 对中文常常更贵），所以超预算的警告是"至少这么多"。
 */

/** 默认预算上限（token）。 */
export const DEFAULT_BUDGET_TOKENS = 30000

/** 每字符折算的 token 数（中文保守估计）。 */
export const TOKENS_PER_CHAR = 0.75

/**
 * 估算一段正文的 token 数。
 *
 * 用 `[...text].length` 而不是 `text.length`：后者数的是 UTF-16 code unit，
 * emoji 与部分 CJK 扩展字符会算成 2 —— 那会让预算虚高一倍。
 *
 * @param {string} body
 * @returns {number} 非负整数
 */
export function estimateTokens(body) {
  if (typeof body !== 'string' || body === '') return 0
  return Math.ceil([...body].length * TOKENS_PER_CHAR)
}

/**
 * 取一份文档的 token 数：显式 `tokens` 优先，否则按正文估算。
 *
 * @param {object} entry 注册表条目 `{ meta, body?, text? }`
 * @returns {{tokens: number, source: 'declared'|'estimated'|'none'}}
 */
export function tokensOfDoc(entry) {
  const meta = entry?.meta ?? {}
  const declared = meta.tokens
  if (typeof declared === 'number' && Number.isFinite(declared) && declared >= 0) {
    return { tokens: Math.ceil(declared), source: 'declared' }
  }
  // 正文优先用 `body`（frontmatter 之后的部分），没有就用全文（略高估，方向安全）。
  const text = typeof entry?.body === 'string' ? entry.body : entry?.text
  if (typeof text !== 'string') return { tokens: 0, source: 'none' }
  return { tokens: estimateTokens(text), source: 'estimated' }
}

/**
 * 汇总必读清单的预算。
 *
 * @param {Array<object>} required 必读清单（`buildIndex()` 的 required）
 * @param {object} [options]
 * @param {number} [options.limit] 上限（默认 30000）
 * @returns {{count: number, tokens: number, limit: number, over: boolean,
 *            overBy: number, declared: number, estimated: number, perDoc: Array<object>}}
 */
export function computeBudget(required, options = {}) {
  const list = Array.isArray(required) ? required : []
  const limit = typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
    ? Math.floor(options.limit)
    : DEFAULT_BUDGET_TOKENS

  let tokens = 0
  let declared = 0
  let estimated = 0
  const perDoc = []

  for (const entry of list) {
    const verdict = tokensOfDoc(entry)
    tokens += verdict.tokens
    if (verdict.source === 'declared') declared += 1
    else if (verdict.source === 'estimated') estimated += 1
    perDoc.push({
      id: typeof entry?.meta?.id === 'string' ? entry.meta.id : '(无 id)',
      tokens: verdict.tokens,
      source: verdict.source,
    })
  }

  // 排序：token 多的在前（用户想知道"谁最贵"），同 token 按 id 稳定排序。
  perDoc.sort((a, b) => (b.tokens - a.tokens) || a.id.localeCompare(b.id))

  return {
    count: list.length,
    tokens,
    limit,
    over: tokens > limit,
    overBy: tokens > limit ? tokens - limit : 0,
    declared,
    estimated,
    perDoc,
  }
}

/**
 * 把 token 数渲染成 `28.4k` 这种形态（与索引块一行放得下）。
 *
 * 整数千（30000 → `30k`）**不写小数**：`30.0k` 读起来像精度噪音，
 * 而上限通常就是个整数。非整数千才保留一位小数。
 *
 * @param {number} tokens
 * @returns {string}
 */
export function formatTokens(tokens) {
  const value = typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0 ? tokens : 0
  if (value < 1000) return String(Math.round(value))
  const thousands = value / 1000
  return Number.isInteger(thousands) ? `${thousands}k` : `${thousands.toFixed(1)}k`
}

/**
 * 渲染索引块里的【预算】行（M1-E）。
 *
 * 形态：`【预算】必读 7 份 ≈ 51.9k tokens（上限 30k）⚠️ 超出上限`
 *
 * **这一行只由「必读集合 + 各文档 tokens」决定**，不含任何快变量
 * （不含"已读几份"、不含时间、不含轮次）—— 这是 M0-5 的红线（SPEC §7.1 的警告）。
 *
 * 没有任何必读文档时返回空串：那种项目不需要预算行，多一行就是噪音。
 *
 * ---- M2-G / D-9：超限时给出路 ----
 *
 * 超限时在行尾追加 ` —— 建议先读 \`a\`、\`b\` 两份`。
 * **不超限时这一行一个字符都不变**（SPEC §6.7 判据 3）——
 * 所以下面的实现是**严格追加**：`hint` 为空串时返回值与 M1 逐字节相同。
 *
 * 推荐份数由 `opts.hintCount` 控制（配置 `uiBudgetHintCount`，默认 3）。
 * 判据 4 要求它有上限，**不许变成长清单** —— 所以这里还会夹一个硬上限。
 *
 * @param {object} budget `computeBudget()` 的结果
 * @param {object} [opts]
 * @param {string[]} [opts.hintIds] 建议先读的 id（已按优先级排好；空数组 = 不追加）
 * @returns {string}
 */
export function renderBudgetLine(budget, opts = {}) {
  const data = budget !== null && typeof budget === 'object' ? budget : {}
  const count = typeof data.count === 'number' ? data.count : 0
  if (count === 0) return ''

  const tokens = formatTokens(data.tokens)
  const limit = formatTokens(data.limit)
  // 后缀**不带前导空格**：中文全角括号已经给了视觉间隔，再加空格会让这一行看起来像两段。
  const over = data.over === true ? ' ⚠️ 超出上限'.trimStart() : ''
  const base = `【预算】必读 ${count} 份 ≈ ${tokens} tokens（上限 ${limit}）${over}`

  // ⚠️ **只在超限时追加**（判据 3：不超限时一个字符都不许变）。
  // 判据 1 还要求"给出具体的 id 列表，不是空话" —— 所以 hintIds 为空时
  // 宁可不追加，也不写「建议读关键文档」那种废话。
  if (data.over !== true) return base

  const rawCount = typeof opts?.hintCount === 'number' && Number.isFinite(opts.hintCount)
    ? Math.floor(opts.hintCount)
    : 3
  const hintCount = Math.max(1, Math.min(MAX_BUDGET_HINTS, rawCount))
  const hintIds = Array.isArray(opts?.hintIds)
    ? opts.hintIds.filter((id) => typeof id === 'string' && id !== '').slice(0, hintCount)
    : []
  if (hintIds.length === 0) return base

  const list = hintIds.map((id) => `\`${id}\``).join('、')
  // ⚠️ 量词**必须跟着份数走**。
  // 我第一版写的是 `hintIds.length === 1 ? '这一份' : '两份'` ——
  // 于是配 3 份时输出「…、`coach-prompt-spec` 两份」，列了三个却写两份。
  // 那是"数据对、文案错"，比没有文案更难发现（用户会以为只该读两份）。
  const measure = hintIds.length === 1 ? '这一份' : `${hintIds.length} 份`
  return `${base} —— 建议先读 ${list} ${measure}`
}

/**
 * 推荐份数的**硬上限**（判据 4）。
 *
 * 配置 `uiBudgetHintCount` 可以被写成 99，但这一行是**索引块**里的一行，
 * 列 99 个 id 等于把索引块撑爆，而且又变成长清单 —— 那正是 D-9 要解决的问题本身。
 * 所以配置只在一个区间内有效：1–5。
 */
export const MAX_BUDGET_HINTS = 5

/**
 * 算出「超限时建议先读哪几份」（M2-G / D-9 的判据 2）。
 *
 * ---- 优先级规则（**固定且可测**，SPEC §6.7 判据 2）----
 *
 * 1. `role: handover` 与 `role: index` 优先 —— 它们是「新会话能不能知道自己在改什么」的
 *    唯一入口（`【项目】` 与 `【施工】` 两支都从这两类文档取）；
 * 2. 同类内按 `order` 升序；`order` 相同按 `id` 字典序（保证渲染稳定，不影响 KV 缓存）；
 * 3. 其余角色按 `order` 升序。
 *
 * ---- 三条明确的**不做** ----
 *
 * - **不看「已读/未读」**：那是状态，状态会变，变了就会改索引块（M0-5 红线）。
 *   SPEC §6.7 的警告原文：「不要把"已读/未读"塞进优先级」。
 * - **不看 tokens 大小**：那会让同一份文档在不同项目里优先级不同，规则就不可测了。
 * - **不猜**：`meta.role` 不是字符串的条目原样排到最后，不试着从 summary 推断。
 *
 * @param {Array<object>} required 必读清单（`buildIndex(entries).required`）
 * @param {number} [hintCount] 最多几份（默认 3，硬上限 `MAX_BUDGET_HINTS`）
 * @returns {string[]} 建议先读的 id 列表（可能为空）
 */
export function budgetHintIdsOf(required, hintCount = 3) {
  const list = Array.isArray(required) ? required : []
  const count = Math.max(1, Math.min(MAX_BUDGET_HINTS,
    typeof hintCount === 'number' && Number.isFinite(hintCount) ? Math.floor(hintCount) : 3))

  /** 优先档：handover=0, index=1, 其它=2。 */
  const tierOf = (entry) => {
    const role = entry?.meta?.role
    if (role === 'handover') return 0
    if (role === 'index') return 1
    return 2
  }

  const shaped = list
    .filter((entry) => typeof entry?.meta?.id === 'string' && entry.meta.id !== '')
    .map((entry) => ({
      id: entry.meta.id,
      tier: tierOf(entry),
      order: typeof entry?.meta?.order === 'number' && Number.isFinite(entry.meta.order)
        ? entry.meta.order
        : Number.MAX_SAFE_INTEGER,
    }))

  shaped.sort((a, b) => (
    a.tier - b.tier
    || a.order - b.order
    || a.id.localeCompare(b.id)
  ))

  return shaped.slice(0, count).map((item) => item.id)
}



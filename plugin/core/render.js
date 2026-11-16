/**
 * 快变量索引块渲染（SPEC §6.4）。
 *
 * **这是 R3 的命门，也是整个 M0 最容易在实机上翻车的地方。**
 *
 * 硬约束（我实测 DSH 源码 + 264 个真实会话日志得出的）：
 *
 * `systemPrompt.context()` 的内容由 `dsh-agent-loop` 的 `RuntimeContextProjection.project()`
 * 提交——**文本一变就 append 一条新 user/message，旧的不删、不 replace**
 * （`agent-loop` 里唯一的 `surfaceOp: {op:'replace'}` 属于系统提示词，不属于 runtime-context）。
 *
 * 实测证据：5 个静态 section 撑 98 步只出 1.8 条；而教练模式的 `coach:state`
 * 因为每步都在变（进度、失败次数、证据），69 步出了 **31 条**。
 *
 * 所以本模块的红线是：**渲染文本只能由"文档集合与文档状态"决定**，绝不能包含：
 * - 时间戳、轮次号、步号、seq
 * - 每次 read 都会变的"读取时间 / 读到第几行"
 * - 任何"本次已读第 N 份"这类计数
 *
 * 允许变的只有：哪些文档已读（每个 id 至多变一次）、指纹（内容变才变）、
 * 必读清单成员（增删才变）。这些都在「1 + |必读清单|」的量级内。
 */

/** 索引块的字符预算默认值（SPEC §6.4）。 */
export const DEFAULT_MAX_CHARS = 1200

/** 每个分节的行前缀。 */
const TAG = Object.freeze({
  index: '【文档驱动】',
  read: '【已读】',
  unread: '【未读】',
  forbid: '【禁止执行】',
  anomaly: '【文档异常】',
  // M1 新增：冷启动预算（M1-E）。
  budget: '【预算】',
  // 门禁状态行（M1 起与【已读】分开，见 renderIndexBlock 里 R1 的说明）。
  gate: '【门禁】',
  // M1.5 / N8：这个项目是什么。
  project: '【项目】',
  // M1.5 / D5：这个切片叫什么。
  work: '【施工】',
  // M2.6：**这几件事怎么做**（归档 / 交付 / 阅读顺序）。
  //
  // ---- 为什么必须加这一段（2026-11-14 用户全流程演练，会话 `524e5041`）----
  //
  // 用户的原话是「很多的问题，大概都表现为 **AI 不知道自己该怎么做**」。
  // 实测数据：**13 个回合里有 3 个（turn 3/6/10）在翻插件源码**，
  // 共 **25 次**工具调用打向 `app.asar` / `profiles\desktop\node_modules`，
  // 其中 **2 个回合被用户直接中止**。
  //
  // 三次都是同一件事：用户说「把旧交接归档」「把 spec 交付」「改阅读顺序」，
  // AI 不知道这三个动作在 DDD 里**具体等于什么操作**，于是去逆向插件。
  //
  // 而这三条机制**早就存在**，只是**从没写进模型能看见的地方**：
  //   - 归档 = `doc_mark` 标 `void`（`tools/doc-mark.js` 强制 reason）；
  //   - 交付 = 把文件放进 `deliverables/`（`server/deliverables.ts`），
  //     或调用宿主的 `present` 工具声明它；
  //   - 阅读顺序 = frontmatter 的 `order` 值（`core/index.js` 的 `byOrderThenId` 升序）。
  //
  // ⚠️ **为什么不能写进 `AGENTS.md`**：那是慢变量文件，写进去一变更就多一条历史消息
  // （M0-5 红线）。而 `context()` 通道每轮重算、不进历史 —— 所以放这里。
  // ⚠️ **必须是静态文案**：不含时间戳/轮次/百分比，不破 M0-5 红线。
  // ⚠️ 它是 `pinned` 的：被裁掉就等于没做（与【项目】行同理）。
  howto: '【怎么做】',
})

/** 取指纹前 6 位（SPEC §6.4 规则 3：让模型能发现"我读的是旧版"）。 */
export function shortVersion(fingerprint) {
  return typeof fingerprint === 'string' && fingerprint.length >= 6 ? fingerprint.slice(0, 6) : '??????'
}

/**
 * 渲染状态标记：status 的 emoji（与 SPEC §5.3 一致）。
 * @param {string} status
 * @returns {string}
 */
export function statusMark(status) {
  switch (status) {
    case 'authoritative': return '🟢'
    case 'partial': return '🟡'
    case 'superseded': return '⚪'
    case 'sealed': return '🔴'
    case 'void': return '⚫'
    case 'draft': return '🔵'
    default: return '❔'
  }
}

/**
 * 渲染一行文档条目：`id · summary · 🟢 ✅ · v3`。
 * @param {object} entry
 * @param {{showStatus?: boolean, showVersion?: boolean}} [opts]
 * @returns {string}
 */
function entryLine(entry, opts = {}) {
  const meta = entry?.meta ?? {}
  const id = typeof meta.id === 'string' && meta.id !== '' ? meta.id : '(无 id)'
  const parts = [`\`${id}\``]
  if (typeof meta.summary === 'string' && meta.summary !== '') parts.push(meta.summary)
  if (opts.showStatus !== false) parts.push(statusMark(meta.status))
  if (opts.showVersion === true && typeof entry.fingerprint === 'string') {
    parts.push(`v${shortVersion(entry.fingerprint)}`)
  }
  return `- ${parts.join(' · ')}`
}

/**
 * 把绝对路径折成相对项目根的路径（M1.5 / N4）。
 *
 * 与 `core/index.js` 里 `relativeTo` 的逻辑**同构**，但两处各自维护：
 * `index.js` 那个是给 `anomalyLine()`（外部调用方用）的，
 * 这个是给 `renderIndexBlock()` 的。合并会把两个不同用途的函数耦死，
 * 而它们的输入契约并不一样（前者可被测试直接调用，后者只在渲染里用）。
 *
 * **纯字符串运算、不做 IO**（`core/` 禁止内置模块）。
 *
 * @param {string} absPath
 * @param {string} [projectRoot]
 * @returns {string | undefined}
 */
function relativeToRoot(absPath, projectRoot) {
  if (typeof absPath !== 'string' || absPath === '') return undefined
  if (typeof projectRoot !== 'string' || projectRoot === '') return undefined
  const normalize = (value) => value.replaceAll('\\', '/').replace(/\/+$/, '')
  const root = normalize(projectRoot)
  const path = normalize(absPath)
  if (path.toLowerCase() === root.toLowerCase()) return undefined
  if (!path.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return undefined
  return path.slice(root.length + 1)
}

/**
 * 由注册表算出 `【项目】` 行的内容（M1.5 / N8）。
 *
 * 取法（`P13` 拍板）：
 *   1. `role: index` 文档的 `summary` —— 它天然是"入口索引"，最接近"项目简介"；
 *   2. 拿不到就退到第一份 `role: spec`；
 *   3. **再拿不到就返回空串**（整行不显示）。
 *
 * ⚠️ **不写占位**（「（未知项目）」/「（未设置）」）：那会变成永久噪声，
 * 每一轮都注入一次，而它一个字的信息量都没有。
 *
 * ⚠️ 这一行是**慢变量**（项目描述不每轮变），但走的是 `context()` 通道，
 * 不是 `AGENTS.md` —— 合规（R3 红线：`AGENTS.md` 里一变更就多一条历史消息）。
 *
 * @param {object} registry 注册表
 * @param {number} [maxChars] 截断长度（防止某个 summary 写成一整段把索引块吃掉）
 * @returns {string} 空串 = 不显示
 */
export function projectLineOf(registry, maxChars = 120) {
  const entries = Array.isArray(registry?.entries) ? registry.entries : []

  const pickOf = (role) => entries.find((entry) => (
    entry?.meta?.role === role
    && typeof entry?.meta?.summary === 'string'
    && entry.meta.summary.trim() !== ''
    // 坏的文档不能当"项目简介"的依据（它有 error，说明字段本身不可信）。
    && entry?.hasError !== true
  ))

  const picked = pickOf('index') ?? pickOf('spec')
  if (picked === undefined) return ''

  const summary = String(picked.meta.summary).trim().replace(/\s+/g, ' ')
  if (summary === '') return ''
  return summary.length > maxChars ? `${summary.slice(0, maxChars)}…` : summary
}

/**
 * 由注册表算出 `【施工】` 行的内容（M1.5 / **D5**，用户 2026-11-12 拍板**选项 B**）。
 *
 * ---- 为什么只有「切片名」，没有「阶段 / 下一步」----
 *
 * 交接 §3.6 的 D5 原设想是三行：`当前切片 / 当前阶段 / 下一步`。**我们只做第一项**，
 * 理由是**技术硬约束**，不是偷懒：
 *
 * 索引块走 `context()` 通道 —— **内容一变，宿主就 append 一条新的历史消息，旧的不删。**
 * 实测（`core/render.js` 文件头）：
 * > 5 个静态 section 撑 98 步只出 **1.8 条**；
 * > 而教练模式那个每步都在变的 state，69 步出了 **31 条**。
 *
 * 而「**阶段**」和「**下一步**」天然**每完成一步就变**。做了它等于每走一步就往历史里
 * 塞一份完整索引块 —— 这就是 **M0-5 红线**（索引块不许含快变量）。
 *
 * 而「切片名」（`M1.5` / `M2` …）是**慢变量**：几天/几十步才换一次。**合规。**
 *
 * ---- 内容从哪来（**不新造 schema 主路径**）----
 *
 * 取法（从宽到严，任一命中即可）：
 *   1. `role: index` 文档的**可选字段 `slice`**（显式写法，最可靠）；
 *   2. 退到 `role: index` 文档的 **`scope[0]`**（`scope` 是已有字段，`status: partial` 时必填）；
 *   3. 都没有 → **空串（整行不显示）**。
 *
 * ⚠️ **不做**的两件事：
 *   - **不解析 `summary` 里猜切片名**（那需要正则猜中文，必然误报）；
 *   - **不写占位**（「（未知切片）」是永久噪声，理由同 `【项目】` 行）。
 *
 * ⚠️ **不改 `docs/schema.js` 的必填字段**：`slice` 是**可选**的。
 * 加必填会让所有现存文档立刻变 error —— 那是方案 A 的代价（`P13` 已否决过同类做法）。
 *
 * @param {object} registry 注册表
 * @param {number} [maxChars] 截断长度
 * @returns {string} 空串 = 不显示
 */
export function sliceLineOf(registry, maxChars = 40) {
  const entries = Array.isArray(registry?.entries) ? registry.entries : []

  // 只在**没坏**的 `role: index` 文档里找（坏文档的字段不可信）。
  const indexDocs = entries.filter((entry) => (
    entry?.meta?.role === 'index' && entry?.hasError !== true
  ))

  const clean = (value) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '')

  // 1) 显式的 `slice` 字段
  for (const doc of indexDocs) {
    const slice = clean(doc.meta?.slice)
    if (slice !== '') return slice.length > maxChars ? `${slice.slice(0, maxChars)}…` : slice
  }

  // 2) 退到 `scope[0]`（已有字段，不新造）
  for (const doc of indexDocs) {
    const scope = doc.meta?.scope
    if (!Array.isArray(scope) || scope.length === 0) continue
    const slice = clean(scope[0])
    if (slice !== '') return slice.length > maxChars ? `${slice.slice(0, maxChars)}…` : slice
  }

  // 3) 都没有 → 不显示
  return ''
}

/**
 * 渲染索引块。
 *
 * @param {object} state
 * @param {object} state.index `buildIndex()` 的结果 `{required, forbidden, anomalies}`
 * @param {Map<string, {fingerprint: string}>} state.readSet 本会话已读
 * @param {(id: string) => string} [state.currentFingerprint]
 * @param {number} [state.maxChars] 字符预算
 * @param {boolean} [state.activated] 是否已激活（未激活直接返回空串）
 * @returns {string} 索引块文本；未激活或没有任何内容时返回 `''`
 */
export function renderIndexBlock(state) {
  const opts = state !== null && typeof state === 'object' ? state : {}

  // §6.4 规则 4：没有探测到项目根 / 未激活 → 返回空字符串。
  if (opts.activated === false) return ''

  const index = opts.index ?? {}
  const required = Array.isArray(index.required) ? index.required : []
  const forbidden = Array.isArray(index.forbidden) ? index.forbidden : []
  const anomalies = Array.isArray(index.anomalies) ? index.anomalies : []

  // 三份清单都空 → 什么都不注入（不占 token）。
  //
  // ⚠️ **M1.5 / D5 起这里多了一个前提**：如果调用方给了 `sliceLine`，
  // 即使三份清单全空也要渲染 —— 否则「有切片名但项目还没有受管文档」这种状态
  // 会**静默吞掉【施工】行**（新项目刚建、docs/ 还空的时候正是这个状态）。
  //
  // 本插件的 M0-9 验收要求「空工作区 → 索引块为空且不抛」。
  // 那条判据**针对的是"什么都没有"**（未激活 / 没有项目根），
  // 而这里是"已激活、有项目、只是清单空" —— 两者不同，所以不冲突。
  const hasSlice = typeof opts.sliceLine === 'string' && opts.sliceLine.trim() !== ''
  if (required.length === 0 && forbidden.length === 0 && anomalies.length === 0 && hasSlice !== true) {
    return ''
  }

  const readSet = opts.readSet ?? new Map()
  const lookupRead = (id) => (typeof readSet.get === 'function' ? readSet.get(id) : readSet[id])
  const currentFingerprint = opts.currentFingerprint

  const readLines = []
  const unreadLines = []
  let readCount = 0

  for (const entry of required) {
    const id = entry?.meta?.id
    if (typeof id !== 'string' || id === '') continue
    const record = lookupRead(id)
    const current = typeof currentFingerprint === 'function'
      ? currentFingerprint(id)
      : entry.fingerprint
    const fresh = record !== undefined && record !== null && record.fingerprint === current
    if (fresh) {
      readCount += 1
      readLines.push(entryLine({ ...entry, fingerprint: current }, { showVersion: true }))
    } else {
      unreadLines.push(entryLine(entry, { showVersion: false }))
    }
  }

  const total = required.length
  const ratio = total > 0 ? `${Math.min(readCount, total)}/${total}` : '0/0'

  const sections = []

  // 门禁状态（**永不裁**，SPEC §6.4 的裁剪表）。
  //
  // ⚠️ **M0 评审的 R1 在这里修掉**：修之前 gate 段与 read 段都以 `【已读】` 开头，
  // 索引块里「【已读】1/7」出现两次 —— 模型读起来是冗余噪声，还多吃掉约 20 字符。
  // 现在 gate 段改用 `【门禁】`，`【已读】` 只属于 read 段。
  // `test/render.test.js` 有一条反向断言钉住「【已读】只出现一次」。
  //
  // ---- 2026-11-14 M2.5：补一句「改完会作废已读」（摩擦台账 F1）----
  //
  // 摩擦台账里最贵的一条：**AI 改完文档就发现自己的已读失效了**，而且每次都要
  // 撞一次才想起来。5 个会话里出现 10 次（7 次 edit + 3 次 doc_mark）。
  //
  // 那是铁律 7 的**必然代价**（`gate.read` 必须实时），不能改行为 —— 只能**预告**。
  //
  // ⚠️ 这句话是**静态文案**：不含时间戳/轮次/百分比，所以不破 M0-5 红线
  // （索引块里放快变量会让宿主每轮 append 一条新历史消息）。
  // ⚠️ 措辞必须同时覆盖 `edit`/`write` 与 `doc_mark` —— 三者的门禁是同一条。
  //
  // ---- 2026-11-15 M2.7：把「只读片段不算读过」并进这一句 ----
  //
  // 为什么不能新加一行：【门禁】+【预算】+【怎么做】三行已经用掉 pinned 预算的
  // 92%（实测 166/180，只剩 14 字符），`renderM1.test.js` 有硬判据卡着。
  // 所以只能**等长替换**——下面这句正好 26 字符，与原来的
  // 「改过的文档会立刻变回未读（指纹变了），再改之前要重读」**逐字等长**。
  //
  // 为什么必须说（`session-25dad0e8` 实测）：那一轮交接里模型做了一次
  // `read(limit=12)`，紧接着 edit 被拒，它**再读一次窗口**（limit=10）又被拒，
  // 才改成完整读。统计那一轮 turn 3：
  //   - 完整读 → 写：8 次里成功 7 次
  //   - 窗口读 → 写：**5 次里成功 0 次**
  // 即「窗口读换不来写权限」是**每条必踩一次**的坑，而注入里从没说过。
  // 这正是架构分析 §5 的第 ① 层（注入）——报事实，不是加判据。
  const gateLine = unreadLines.length > 0
    ? `${TAG.gate}${ratio} ｜ 未读完必读清单，改 docs/ 会被拒绝`
      + ' ｜ 改过的文档立刻变回未读；只读片段不算读过，要整份重读'
    : `${TAG.gate}${ratio} ｜ 必读已读完，可以动 docs/`
      + ' ｜ 改过的文档立刻变回未读；只读片段不算读过，要整份重读'

  sections.push({ key: 'gate', text: gateLine, pinned: true })

  // 【项目】行（M1.5 / **N8**）。**pinned：永不裁**，理由同【预算】。
  //
  // 为什么要有它：交接模板的七段里**没有任何一段**回答「这个项目是干什么的」
  // （`core/handover.js` 的 `SECTIONS`：§1 意图讲的是**本轮**意图）。于是
  // 一份"七段写全了"的交接**依然可能让下一个会话不知道自己在改什么**——
  // 它已经被漏了**三次**（三个不同作者，其中一次还写「我不该重犯」）。
  // 结论：靠"交接模板写全七段"挡不住，必须**从系统层保证**。
  //
  // 三条硬约束（`P13` 拍板）：
  //   1. 走 `context()` 通道 —— 索引块**就是** `context()`，所以合规；
  //      **绝不能进 `AGENTS.md`**（那里是慢变量，一变更就多一条历史消息，M0-5 红线）。
  //   2. `pinned: true` —— 它是"新会话知不知道自己在改什么"的唯一保证，被裁掉就等于没做。
  //   3. **拿不到就整行不显示** —— 不写「（未知项目）」这类占位，那会变成永久噪声。
  const projectLine = typeof opts.projectLine === 'string' ? opts.projectLine.trim() : ''
  if (projectLine !== '') {
    sections.push({ key: 'project', text: `${TAG.project}${projectLine}`, pinned: true })
  }

  // 【施工】行（M1.5 / **D5**，用户拍板**选项 B：只显示切片名**）。**pinned：永不裁**。
  //
  // 为什么它只答"在哪个切片"、不答"阶段/下一步"：见 `sliceLineOf()` 的注释 ——
  // 「阶段/下一步」是**快变量**，做进索引块会重造 M0-5 那个坑（每步 append 一条历史消息）。
  //
  // 拿不到就**整行不显示**，不写占位（理由同 `【项目】` 行）。
  //
  // ⚠️ 它排在 `【预算】` **之前**：三行 pinned（门禁 / 项目 / 施工）连在一起，
  // 让"我在哪、在改什么、预算够不够"这三条**结构化的环境事实**一眼可见，
  // 后面才是可裁的清单。
  const sliceLine = typeof opts.sliceLine === 'string' ? opts.sliceLine.trim() : ''
  if (sliceLine !== '') {
    sections.push({ key: 'work', text: `${TAG.work}${sliceLine}`, pinned: true })
  }

  // 【预算】行（M1-E）。**pinned：永不裁**。
  // 理由：它是 M1-1 的判据本身；被裁掉的话，在长索引项目上这条验收直接判不了。
  // 它只由「必读集合 + 各文档 tokens」决定，不含快变量（M0-5 红线）。
  const budgetLine = typeof opts.budgetLine === 'string' ? opts.budgetLine : ''
  if (budgetLine !== '') sections.push({ key: 'budget', text: budgetLine, pinned: true })

  // 【怎么做】行（M2.6）。**pinned：永不裁**。
  //
  // ---- 为什么必须加（2026-11-14 用户全流程演练，会话 `524e5041`）----
  //
  // 用户原话：「很多的问题，大概都表现为 **AI 不知道自己该怎么做**」。
  // 实测：13 个回合里 3 个（turn 3/6/10）在翻插件源码，共 **25 次**工具调用打向
  // `app.asar` / `profiles\desktop\node_modules`，其中 **2 个回合被用户直接中止**。
  // 三次都是同一件事：用户说「归档」「交付」「改阅读顺序」，AI 不知道在 DDD 里
  // **这三个词各等于什么操作**，于是去逆向插件。
  //
  // 三条机制**早就存在**，只是从没写进模型能看见的地方：
  //   归档 = `doc_mark` 标 `void`（`tools/doc-mark.js` 强制 reason）
  //   交付 = 放进 `deliverables/`（`server/deliverables.ts`）
  //   阅读顺序 = frontmatter 的 `order`（`core/index.js` 的 `byOrderThenId` 升序）
  //
  // ---- 为什么写得这么短（这是被测试逼出来的，不是偷懒）----
  //
  // 第一版写成完整句子（约 100 字符），立刻把两条**既有判据**撞红：
  //   - `render.test.js`「maxChars 可配置」：`maxChars: 200` 时装不下（实测 233）
  //   - `renderM1.test.js`「预算行永不裁」：同上
  //
  // 那两条判据守的是「pinned 段总长必须是常量级，任何预算下都装得下」。
  // 它是对的，我第一版错在把索引块当成了文档 —— 这里每一轮都要付 token。
  //
  // ⇒ 压到只留**动作名 → 落点**，参数细节交给工具自己的 `description`。
  //   目标：整行 ≤ 60 字符，让 pinned 三行总长仍能装进 200。
  //
  // ⚠️ 不能写进 `AGENTS.md`：那是慢变量文件，一变更就多一条历史消息（M0-5 红线）。
  // ⚠️ 必须是静态文案：不含时间戳/轮次/百分比。
  sections.push({
    key: 'howto',
    text: `${TAG.howto}归档→doc_mark 标 void；交付→放 deliverables/；`
      + '阅读顺序→改各文档 order 且改入口索引正文。别读插件源码。',
    pinned: true,
  })

  // read 段**不再带** `【已读】${ratio}` 前缀（R1），只有条目。
  if (readLines.length > 0) sections.push({ key: 'read', text: `${TAG.read}\n${readLines.join('\n')}` })
  if (unreadLines.length > 0) sections.push({ key: 'unread', text: `${TAG.unread}\n${unreadLines.join('\n')}` })
  if (forbidden.length > 0) {
    const lines = forbidden.map((entry) => entryLine(entry, { showVersion: false }))
    sections.push({ key: 'forbid', text: `${TAG.forbid}\n${lines.join('\n')}` })
  }
  if (anomalies.length > 0) {
    const lines = anomalies.slice(0, 5).map((entry) => {
      // M1.5 / N4：**绝不在这里用绝对路径**。
      // 修之前这里写的是 `entry?.path ?? '(未知文档)'`，于是索引块里出现
      // `C:\Users\...\docs\spec-anchored.md`（~90 字符），而 anomaly 段
      // 恰好是 `fitBudget` **最先裁**的那一段 —— 路径越长，越可能把
      // "文档写坏了"这个最该看到的信号整段挤掉。
      //
      // 现在：有 id 用 id；没有 id 用项目根的相对路径（`docs/x.md`）；
      // 连相对路径都算不出来才退回 `(未知文档)` —— **不猜、不截断**。
      const id = entry?.meta?.id
      const name = typeof id === 'string' && id !== ''
        ? id
        : (relativeToRoot(entry?.path, opts.projectRoot) ?? '(未知文档)')
      const first = (Array.isArray(entry?.issues) ? entry.issues : []).find((item) => item?.level === 'error')
      return `- \`${name}\`：${first?.message ?? '元数据不合法'}`
    })
    sections.push({ key: 'anomaly', text: `${TAG.anomaly}\n${lines.join('\n')}` })
  }

  const budget = typeof opts.maxChars === 'number' && opts.maxChars > 0
    ? Math.floor(opts.maxChars)
    : DEFAULT_MAX_CHARS

  return fitBudget(sections, budget)
}

/**
 * 按 SPEC §6.4 的**固定顺序**裁剪到预算内。
 *
 * 裁剪顺序（不能改）：
 *   1. 文档异常 → 只留条数
 *   2. 已读 → 只留 `3/5`
 *   3. 未读 → 只留条数
 *   **永不裁**（`pinned: true`）：门禁状态、**预算行（M1-E）**、切片/阶段。
 *
 * ⚠️ `pinned` 是 M1 加的真语义：修之前这个字段**只被写着、从来没被读过** ——
 * 门禁段之所以"永不裁"，纯粹是因为它排在裁剪顺序之外。加【预算】行时如果
 * 只按位置信任它，`fitBudget` 会在裁剪时把它当作可裁对象（它有 key 但不在
 * 三步裁剪表里，于是**留在最后不裁**——这碰巧是对的，但靠的是"没写代码"）。
 * 现在显式实现：pinned 的段在最后一步**整体保留**，且不计入可裁范围。
 *
 * @param {Array<{key: string, text: string, pinned?: boolean}>} sections
 * @param {number} budget
 * @returns {string}
 */
export function fitBudget(sections, budget) {
  const parts = sections.map((section) => ({ ...section }))
  const join = () => parts.map((section) => section.text).filter((text) => text !== '').join('\n')

  let text = join()
  if (text.length <= budget) return text

  // 0. **`pinned` 段先钉住**（M1.5 / N8 时显式化）。
  //
  // 修之前 `pinned` 只是"碰巧没被裁"：它不在下面三步的裁剪表里，于是留在最后。
  // 那是靠"没写代码"实现的 —— 加【项目】行时如果只按位置信任它，
  // 任何一次重构（比如有人给"裁剪表"加一条通配）都能静默把它裁掉，
  // 而【项目】行被裁掉就等于 N8 没做。
  //
  // 现在改成"**显式**"：可裁段只从 `pinned !== true` 的段里选，
  // 且每轮裁剪都重算，绝不碰 pinned 段。
  // 若连同 pinned 都装不下，也**绝不动它们** —— 它们的总长度是常量级
  // （门禁 1 行 + 预算 1 行 + 项目 1 行），不会把索引块撑爆；
  // 而"新会话不知道自己该先读什么 / 在改什么"是不可接受的降级。
  const isCroppable = (section) => section.pinned !== true

  // 1. 文档异常 → 只留条数
  const anomaly = parts.find((section) => section.key === 'anomaly' && isCroppable(section))
  if (anomaly !== undefined) {
    const count = anomaly.text.split('\n').length - 1
    anomaly.text = `${TAG.anomaly}${count} 份（清单见 AGENTS.md）`
    text = join()
    if (text.length <= budget) return text
  }

  // 2. 已读 → 只留 `3/5`（比率从门禁段取；R1 之后门禁段用【门禁】前缀）
  const read = parts.find((section) => section.key === 'read' && isCroppable(section))
  if (read !== undefined) {
    const ratio = /(\d+\/\d+)/.exec(sections.find((section) => section.key === 'gate')?.text ?? '')?.[1] ?? ''
    read.text = ratio === '' ? '' : `${TAG.read}${ratio}`
    text = join()
    if (text.length <= budget) return text
  }

  // 3. 未读 → 只留条数
  const unread = parts.find((section) => section.key === 'unread' && isCroppable(section))
  if (unread !== undefined) {
    const count = unread.text.split('\n').length - 1
    unread.text = `${TAG.unread}${count} 份（见 AGENTS.md 的必读清单）`
    text = join()
    if (text.length <= budget) return text
  }

  // 4. 禁止清单 → 只留条数（SPEC 没单列，但它排在异常/已读/未读之后，属"最后兜底"）
  const forbid = parts.find((section) => section.key === 'forbid' && isCroppable(section))
  if (forbid !== undefined) {
    const count = forbid.text.split('\n').length - 1
    forbid.text = `${TAG.forbid}${count} 份（见 AGENTS.md）`
    text = join()
  }

  return text
}

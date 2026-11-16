/**
 * 交接文档的解析与校验（H1–H7，SPEC-M1 §4.2 / §4.3）。
 *
 * **纯函数，零 IO / 零时间 / 零随机 / 不 import 任何内置模块。**
 *
 * ---- 这个模块存在的理由 ----
 * M1 的目标是「让交接从『写一份文档』变成『一份能通过校验的产物』」。
 * 但**校验最容易被写成「看起来严格但永远通过」**（交接 §9 的警告）：
 * 「七段标题都在吗」这种检查，任何一份格式正确的空壳都能过。
 *
 * 所以 H1–H7 里真正有语义的只有两条，它们也是本模块的重点：
 *   - **H3**：§3「下一刀」必须含**具体路径 / 工具名 / 命令**；
 *   - **H4**：§5「验收」每一条都要带**证据形式**（seq / 会话 id / 哈希 / 测试输出）。
 *
 * 这两条都有对应的反例测试，且反例来自真实交接文档的写法，不是编出来的。
 *
 * ---- 两条我按现场证据放宽的判据（已写进 README 的订正清单）----
 * 1. **标题接受 `##` 与 `###`，且不强制顺序。**
 *    dogfood 里唯一那份 `authoritative` 交接（`handover-to-tier26`）把「验收 / 刻意没做 /
 *    仍未决」写在 `###` 级，且「验收」出现在 §4.5 的位置。按 SPEC 字面（二级标题 + 按顺序）
 *    它 7 段要挂 3 段 —— 那样 M1-8 的失败原因就变成"标题层级"，而不是"内容"。
 * 2. **§3 的「具体」有三种形态**（路径 / 工具名 / 反引号命令）。
 *    第三种是 SPEC 作者预演时补的：`node --test --test-isolation=none` 这种
 *    合法且非常具体的下一步，只按前两种会被误拒。样例见 `_ref/check-h3.mjs`。
 */

// ---------------------------------------------------------------- 段落定义

/**
 * 七段的定义。
 *
 * `keywords` 是**二级或三级标题**里要出现的关键词（任一命中即算这一段）。
 * 关键词刻意选得宽：真正的把关在 H2/H3/H4 的**内容**判据上，不在标题措辞上。
 */
export const SECTIONS = Object.freeze([
  {
    index: 1,
    key: 'intent',
    label: '我的意图',
    keywords: ['意图', '为什么'],
    // §1 排第一是刻意的（架构评审 B2 的原话）：现状可以从代码和日志重建，**意图不能**。
    requirement: '必须有一段非空的说明（不是「无」）',
  },
  {
    index: 2,
    key: 'status',
    label: '现在到哪了',
    keywords: ['现在到哪了', '现状', '到哪了'],
    requirement: '至少 1 个表格行或列表项',
  },
  {
    index: 3,
    key: 'next',
    label: '下一刀',
    keywords: ['下一刀', '下一步', '接下来', '接下来做什么', '你接下来做什么'],
    requirement: '至少 1 条含具体路径 / 工具名 / 命令（M1-Q9）',
  },
  {
    index: 4,
    key: 'pitfalls',
    label: '坑',
    keywords: ['坑', '不要重犯'],
    requirement: '至少 1 个表格行',
  },
  {
    index: 5,
    key: 'acceptance',
    label: '验收',
    keywords: ['验收'],
    requirement: '每条都要有证据形式（seq / 会话 id / 哈希 / 测试输出）',
  },
  {
    index: 6,
    key: 'nonGoals',
    label: '刻意没做',
    keywords: ['刻意没做', '负向范围', '没做的事'],
    requirement: '至少 1 个列表项',
  },
  {
    index: 7,
    key: 'open',
    label: '仍未决',
    // M1.5 / **N7**：加上「已拍板」这一类。
    //
    // 为什么必须加：交接的 §7 **语义会随阶段变化** —— 刚交接时"未决"，
    // 用户拍板后"已决"。而 H1 原来只认「仍未决 / 需要拍板 / 未决」，
    // 于是**"拍板完成"这个正确状态反而被判不合格**。
    //
    // 实测（评审者写这份交接时撞上的）：
    //   `## 7. 已拍板（2026-11-12，用户确认，冻结，不要重开）`
    //   → `H1 缺少 1 个必填段落：§7 仍未决`
    // 他当时的处理是把标题写成「仍未决 → 已拍板」保住关键词，并注明"这是绕过，不是设计"。
    //
    // 这与 H3/H4 是同一个病：**判据只认字面，不认语义**。区别是 H3/H4「太宽松」，
    // N7「太死板」—— 正确的状态过不了。
    //
    // 关键词变多后更容易误命中？H1 有"一个标题只能担任一段"的防重规则
    // （见 `parseHandoverSections` 的 `used` 集合），风险很小。
    keywords: ['仍未决', '需要拍板', '未决', '已拍板', '决策台账', '拍板完毕', '已裁定'],
    requirement: '可为空，但必须显式写「无」',
  },
])

/** §7 允许显式写「无」的几种说法（区分「忘了写」与「确实没有」）。 */
const NONE_RE = /(^|\n)\s*[-*>]?\s*(无|没有|暂无|none|无。|没有。)\s*$/im

/** 标题行：`## x` / `### x`（H1 的判据）。 */
const HEADING_RE = /^\s{0,3}(#{2,3})\s+(.*)$/

/**
 * `verifiedAt` / 交接创建时间认的日期形态（M1.5 / **D4** / H8）。
 *
 * 与 `docs/schema.js` 的 `DATE_RE` **同构**，但两处各自维护：
 * `core/` 不许 import `docs/`（分层约束），而这条正则小到不值得抽共享模块。
 * **两边改一处忘另一处**是这类代码的经典事故 —— 所以我在这里写一句：
 * **改这里的正则时，同步改 `docs/schema.js` 的 `DATE_RE`。**
 */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

/** 工具名白名单（与 SPEC-M1 §4.3 一致）。 */
export const TOOL_NAMES = Object.freeze([
  'write', 'edit', 'read', 'pwsh', 'bash', 'glob', 'grep', 'present',
  'doc_new', 'doc_mark', 'doc_health', 'doc_handover_check',
])

/**
 * 形态 1：路径。
 *
 * ⚠️ **这条被 A4 独立评审打回过两次，每次都是"有约束的一半修了，没约束的一半还在"。**
 *
 * 第一版 `/[\\/]|\.\w{1,5}\b/` —— 版本号 `M1.2` 命中后半段（A1 反例 1 抓的）。
 * 第二版修了后半段，但**前半段 `[\\/]` 毫无约束**：
 * `和/或这件事先放一放`、`按既定的 A/B 方案继续` 全是 `true`（A4 抓的）。
 *
 * 现在的形态：**路径必须有"路径的形状"**，不能只是含一个斜杠。
 *   - 形如 `a/b`、`a\b` 的**多段标识符**（每段非空、不含空白）；
 *   - 或形如 `name.ext` 的文件名（扩展名在白名单里，且前缀不是单个字母/数字）。
 *
 * 刻意**不接受**：「和/或」「A/B 方案」这类**自然语言里的斜杠**。
 * 宁可漏判（要求作者写清路径），也不让自然语言冒充"具体"。
 */
const PATH_RE = new RegExp([
  // 多段路径：`core/render.js`、`ddd-bundle\\test\\`、`docs/00-read-order.md`
  //
  // ⚠️ 要求**至少一段里含 `.` 或 `-` 或长度 ≥3**：
  // 否则 `A/B 方案`、`和/或` 这种自然语言里的斜杠会被当成路径（A4 抓到的第二处漏）。
  String.raw`(?:[A-Za-z0-9_.-]*[A-Za-z0-9_-]{2,}[A-Za-z0-9_.-]*[\\/]){1,}[A-Za-z0-9_.-]*[A-Za-z0-9_-]`,
  // 单段文件名（扩展名白名单）
  String.raw`\b[A-Za-z][\w-]{1,}\.(?:js|mjs|cjs|ts|json|md|yml|yaml|txt|ps1|sh|py)\b`,
].join('|'), 'i')

/**
 * 形态 2：工具名。
 *
 * ⚠️ **A4 独立评审抓到的平凡绕过**：裸词 `read` 出现在
 * 「推进 `read` 那件事」里就算具体 —— 但它没说读什么、读完之后做什么。
 *
 * 现在的形态：工具名必须**带反引号**（`` `read` ``、`` `doc_mark` ``），
 * 或者前面紧接一个**动作动词**（用/跑/调/执行 + 工具名）。
 *
 * 为什么这样够：交接文档里引用工具时，**带反引号是通行写法**（本项目所有文档都这样）。
 * 裸词命中"推进 read 那件事"这类自然语言，会让 H3 退化成"出现了这几个字母"。
 */
const TOOL_NAME_PATTERN = TOOL_NAMES.join('|')

/** 带反引号的工具名。 */
const TOOL_BACKTICK_RE = new RegExp('`\\s*(?:' + TOOL_NAME_PATTERN + ')\\s*`')

/** 动作动词 + 工具名（`用 doc_new`、`跑 node --test` 里的工具名部分）。 */
const TOOL_VERB_RE = new RegExp(
  '(?:用|跑|调|执行|调用|改用|使用)\\s*(?:' + TOOL_NAME_PATTERN + ')\\b',
)

/** 形态 3：反引号包住且含空白（命令，如 `` `node --test --test-isolation=none` ``）。 */
const CMD_RE = /`[^`]*\s[^`]*`/

/**
 * H4 的「证据形式」。
 *
 * ⚠️ **这条被 A4 独立评审打回过两次。**
 *
 * 第一版有一条 `file` 形态，让「`- M1-3 的改动在 core/handover.js`」通过（A1 反例 2）。
 * 第二版删掉 `file`，但剩下四种**全是极度宽松的子串匹配**（A4 抓的）：
 *
 * ```
 * ok=true  "- 我没跑过，测试也没做"        ← 「测试」二字
 * ok=true  "- 这一条 1/2 的概率能过"      ← `\d+/\d+`
 * ok=true  "- 见 seq 那一节（没给数字）"   ← 裸词 `seq`
 * ok=true  "- 大概是 deadbeef 之类的吧"    ← 7 位 hex
 * ```
 *
 * 报告把 H4 当「两条真正有语义的判据」之一，但它的实际语义曾是
 * 「提到了测试/seq/哈希这类词」，**不是「验证发生过」** —— 与文件头的自述直接矛盾。
 *
 * 现在的形态：每一种都要求**带结构**，不接受裸词。
 *   - `seq` 必须跟数字：`seq=2468` / `seq: 2468` / `#2468 步`；
 *   - 会话 id 必须是 `session-` + 至少 6 位十六进制（那是宿主真实格式）；
 *   - 哈希必须带上下文：`v8c6246` / `指纹 8c6246` / `sha256:…`；
 *   - 测试必须是有形状的结果：`413/413`、`ALL GOOD`、`node --test`、`12 passed`。
 */
export const EVIDENCE_PATTERNS = Object.freeze([
  {
    key: 'seq',
    // 必须带数字。裸词 `seq` 不算（「见 seq 那一节」曾经就能过）。
    re: /\bseq\s*[=:]\s*\d+|#\d+\s*步|事件序号\s*[=:：]\s*\d+/i,
    label: '事件 seq（带编号）',
  },
  {
    key: 'session',
    // 宿主真实格式：`session-` + UUID 或至少 6 位 hex。
    re: /\bsession-[0-9a-f]{6,}(?:-[0-9a-f]{2,})*|会话\s*id\s*[=:：]\s*\S+/i,
    label: '会话 id',
  },
  {
    key: 'hash',
    // 必须带上下文（`v` 前缀 / 「指纹」/ 算法名），不接受裸 hex。
    //
    // ---- 2026-11-14 演练复盘 D1：`=` 之后的反引号曾经挡住这里 ----
    //
    // 实机（`session-10f26ffe` 的 seq=144）：
    // ```
    // 写：- **边界**：`input.log` 的 sha256 = `B8E89AC6…354C`   ← hex 包在反引号里
    // 报：[H4] §5 验收：有 1/3 条没有证据形式。第一条缺证据的是：- **边界**：…
    // ```
    // 而这条写法**完全正确**：反引号是 Markdown 里"这是个值"的标准写法。
    //
    // 根因：`[=:：]\s*[0-9a-f]{8,}` 的 `\s*` 只吃空白，吃不到反引号。
    //
    // 更糟的是**判据之间不自洽**：同一份交接里
    // `会话 id：` + 反引号 + id  **能过**（session 判据用 `\S+`，吃反引号），
    // 而哈希用 `[0-9a-f]{8,}`（吃不到）—— 同一种写法两个答案。
    //
    // 修法：`=` 与 hex 之间允许 Markdown 的包裹符（反引号 / 星号 / 下划线）。
    // ⚠️ **不放开"不必是 hex"**：仍然要求 8 位以上十六进制，
    // 所以 `sha256 = 见文件` 这类仍然 MISS（反例见 test/h4-chinese-evidence.test.js）。
    //
    // ---- 2026-11-14 M2.6 第二次撞同一类问题：**分隔符本身太窄** ----
    //
    // 实机（`session-138d9491` turn 6，用户报"交接一直卡住"）：
    // ```
    // 写：- `docs/test-spec.md` 存在且正文仅一个 `1`：文件 169 字节，SHA256 `0445F64…`
    // 报：[H4] §5 验收：有 5/5 条没有证据形式。    ← 5 条全挂
    // ```
    // 这条写法**完全正确**（算法名 + 反引号包住的 hex），根因是：
    //   `(?:sha256|md5|sha1)\s*[=:：]\s*...`  —— **要求必须有 `=` 或 `:`**。
    // 而 `SHA256 \`0445F64…\`` 是「算法名 + 空格 + 值」，没有冒号 —— 于是 5/5 全 MISS。
    //
    // ⚠️ 这与上面 D1 是**同一类**错误（把"某种正确写法"写成了唯一写法），
    //    只是这次卡的是分隔符。**报错文案里给的示例 `sha256: a1b2c3d4` 本身能过，
    //    所以 AI 会照抄它、然后以为是自己写错了，反复重写** —— 这正是"卡住没进展"的成因。
    //
    // 修法：分隔符改成 `[=:：]?`（可选），并允许中间有空格 / 包裹符。
    // 仍然要求「算法名 + 至少 8 位十六进制」同时出现 —— 不会退化成裸 hex 匹配。
    re: /\bv[0-9a-f]{6,}\b|指纹\s*[=:：]?\s*[`*_]*\s*[0-9a-f]{6,}|(?:sha256|md5|sha1)\s*[=:：]?\s*[`*_]*\s*[0-9a-f]{8,}/i,
    label: '哈希/指纹（带上下文）',
  },
  {
    key: 'test',
    // 必须是有形状的测试结果，不接受「测试」二字。
    //
    // ⚠️ **末尾不许加 `\b`**（SPEC-M2 §9.5 的缺陷）。
    // `\b` 只在 `\w`（`[A-Za-z0-9_]`）与非 `\w` 之间成立，而「通」「过」「全」「绿」
    // **都不是 `\w`** —— 于是 `3/3 通过`、`12/12 全绿` 全部 MISS。
    // 这个项目的文档全是中文，结果就是「判据要求写中文证据，判据自己认不出中文证据」，
    // 演练里施工者为凑一份能过的交接连建 4 份（`session-c03fc8c8-…` 的 seq=228–248）。
    // 回归网在 `test/h4-chinese-evidence.test.js`（含"不许放宽"的反例）。
    // ---- 2026-11-14 M2.6：**报错文案自己举的示例过不了**（第三次同类问题）----
    //
    // 报错里写着「可用的写法示例：… `722/722 全绿`、`3/3 通过`、`tests 691 / pass 691`」。
    // 实测这三种里 **`tests 691 / pass 691` 过不了**。
    //
    // 根因：`\b\d+\s*\/\s*\d+\s*(?:全绿|通过|passed?|tests?)` 要求**斜杠比值后面
    // 紧跟中文/英文结果词**；`tests 691 / pass 691` 是「tests 在前、pass 在后」，
    // 中间还夹着 `/`，形状完全不同。
    //
    // ⚠️ 这已经是同一条判据的第三次"示例与实现不一致"：
    //    ① 中文结果词被 `\b` 挡住（`3/3 通过`）；
    //    ② 哈希的 `=` 后吃不到反引号；
    //    ③ 现在：示例里的 `tests N / pass N` 过不了。
    //    **判据必须至少认得自己文案里举的每一个例子** —— 这是本轮新增的回归判据
    //    （`test/h4-chinese-evidence.test.js` 里那条"文案与实现不许漂"）。
    //
    // ---- 我第一版改过头了，被既有判据拦下 ----
    //
    // 我先加的是一条"裸比值 `(\d+) / \1` 也算证据"（为了救 `1041 / 1041`）。
    // 但既有测试「只有分数没有结果词也不算证据」断言 `3/3`、`共 12/12 条`、
    // `跑了 3/3 次` **都不算** —— 那条是对的：`3/3` 可能只是"3 次里 3 次"，
    // 没有结果词就没有"通过"的语义，退化成"有数字就行"正是 H4 被打回过的老毛病。
    //
    // ⇒ 所以**不加裸比值**，只补 `tests N / pass N` 这种**自带结果词**的形态。
    //    `1041 / 1041` 这种写法不被认可 —— 那是**文案的问题**，不是判据的问题：
    //    文案里本来就没举它，我会把文案改成举 `单测 1041/1041 全绿`。
    // ---- 2026-11-14 M2.6：**「命中」与「通过」语义相同，判据却只认后者** ----
    //
    // 实测（`session-3ef1b3b2`，用户让 AI 自己总结困难）：
    //
    //   AI 写：`Select-String` 按 id 匹配，输出 `read-order 引用 id 数: 3/3 命中`
    //   判据：**MISS**
    //   AI 改成：`3/3 通过`
    //   判据：**过**
    //
    // AI 的原话：「真正难的地方在于：失败返回只告诉我"第一条缺证据的是哪条"，
    // 不告诉我为什么它不合格。我只能改写法再试，这本质上是在**猜一个评分标准的正则表达式**，
    // 而不是在提升文档质量。」
    //
    // ⇒ 「命中」和「通过」是同义词，只认一个是**偶然**（写正则时没想到），不是设计。
    //   补上「命中」。**但仍然不接受「文件数: 4」这类"N: 数字"** ——
    //   那没有"结果"语义，放宽到它会退化成"有数字就行"（H4 被打回过两次）。
    //
    // ---- 2026-11-15 M2.8（用户拍板「继续修，这会造成返工」）：**比值与结果词之间不许夹字** ----
    //
    // 实测（第 24 轮 `session-5b5f5c68`，seq 118 → 132，**多花 3 步**）：
    // ```
    // 写：本份交接的七段结构由 doc_handover_check 复检：7/7 段命中（H1–H7 无 error）。
    // 报：[H4] §5 验收：有 1/3 条没有证据形式。
    // 改：7/7 通过        ← 才过
    // ```
    // `7/7 段命中` 里 `7/7` 后面紧接的是「段」不是「命中」，所以 MISS。
    //
    // ---- 2026-11-15 M2.8 第二次修：**「全过」「核对通过」也不算** ----
    //
    // 第 25 轮（`session-18b07bcb` seq 107 → 143）**又一次 4/4 条全挂**，多花 4 步。
    // 它写的两种真话都不被认：
    //   · 「输出『文档健康度：5 项检查全过（3 份受管文档，1 份必读）』——**5/5 全过**」
    //     → 「全过」不在结果词表里；
    //   · 「frontmatter `id: spec-1` / `role: spec` / `order: 10`，**核对通过**」
    //     → 「核对通过」也没有 `N/N` 前缀。
    //
    // AI 自己的反馈（seq 178 第 1 条）说得很准：
    // > 第一版我写的是「核对通过」，被判 4/4 条全不合格……改写成 `4/4 通过` 之后立刻过了。
    // > **校验器验证的是句子形状，而不是验证本身。**
    //
    // ⚠️ 这是同一类错误的**第五次**：
    //    ① 中文结果词被 `\b` 挡住；② 哈希的 `=` 吃不到反引号；
    //    ③ 示例里的 `tests N / pass N` 过不了；④ 比值与结果词之间夹量词；
    //    ⑤ 现在：「全过」「核对通过」不在词表里。
    //    共同点还是**把"某种正确写法"写成了唯一写法**。
    //
    // 修法：结果词补 `全过|核过|核对通过|verified|ok`；
    // 同时允许**没有 `N/N` 前缀**的「…通过 / …核对通过」出现在**含具体值**的行里
    // （下面 `hasEvidence` 的第二道判据负责这件事，见 `EVIDENCE_PATTERNS` 之后的注释）。
    //
    // ⚠️ 仍然不接受「看起来没问题」「测试也没做」—— 那些没有任何可核对的值。
    re: /\b\d+\s*\/\s*\d+\s*(?:[^\d\s]{0,2}\s*)?(?:全绿|通过|命中|全过|passed?|tests?)|ALL\s+GOOD|ALL\s+PASS|node\s+--test|\b\d+\s+passed\b|单测\s*\d+\s*\/\s*\d+|\btests?\s*\d+\s*\/\s*pass(?:ed)?\s*\d+|\bpass(?:ed)?\s*[:=]?\s*\d+|核对\s*通过|verified\s*[:=]?\s*(?:ok|true)/i,
    label: '测试输出（带结果形状）',
  },
])

// ---------------------------------------------------------------- 文本工具

/**
 * 把正文按行拆开（保留空行：空行是"段落边界"的信息）。
 * @param {string} text
 * @returns {string[]}
 */
function linesOf(text) {
  return String(text ?? '').split(/\r?\n/)
}

/** 是不是表格行（`| a | b |`）。分隔行 `|---|---|` 也算，但下面会单独排除。 */
function isTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(line)
}

/** 是不是表格的分隔行（`|---|---|`）。它不算"内容"。 */
function isTableSeparator(line) {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-')
}

/** 是不是列表项（`- x` / `1. x` / `* x`）。 */
function isListItem(line) {
  return /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line)
}

/**
 * 去掉"没有信息量的行"：空行、纯分隔线、HTML 注释。
 * @param {string} line
 * @returns {boolean} true = 这一行算有内容
 */
function isMeaningfulLine(line) {
  const text = line.trim()
  if (text === '') return false
  if (/^[-=_*]{3,}$/.test(text)) return false
  if (/^<!--.*-->$/.test(text)) return false
  if (/^<\/?[A-Za-z][^>]*>$/.test(text)) return false
  return true
}

// ---------------------------------------------------------------- 切段

/**
 * 把正文切成「段」：每个二级/三级标题开一段。
 *
 * **只按 `##` / `###` 切**：`####` 及更深属于段内子标题，不另起一段。
 *
 * **段的内容包含它的子段落**（Markdown 的真实语义）：`## 1. 我的意图` 的正文，
 * 一直延伸到下一个**同级或更高级**标题为止 —— 中间的 `### 1.1` 是它的子节，不是它的终点。
 *
 * > 这一条是**在 dogfood 的真实交接上发现的**：`handover-to-tier26` 的 §1/§2/§3
 * > 正文全部写在 `###` 子节里，`##` 标题下只有一行空行。按"下一个标题就结束"切，
 * > 这三段会全被判成"空的"——而错误信息还会一本正经地说「这一段是空的」。
 *
 * @param {string} body 文档正文（不含 frontmatter）
 * @returns {Array<{level: number, title: string, text: string, line: number}>}
 */
export function splitSections(body) {
  const lines = linesOf(body)
  /** @type {Array<{level: number, title: string, line: number}>} */
  const heads = []

  for (let index = 0; index < lines.length; index += 1) {
    const match = HEADING_RE.exec(lines[index])
    if (match === null) continue
    heads.push({ level: match[1].length, title: match[2].trim(), line: index })
  }

  return heads.map((head, position) => {
    // 终点 = 后面第一个**同级或更高级**的标题；没有就是文档末尾。
    let end = lines.length
    for (let index = position + 1; index < heads.length; index += 1) {
      if (heads[index].level <= head.level) { end = heads[index].line; break }
    }
    const bodyLines = lines.slice(head.line + 1, end)
    // 去掉末尾的空行：它们是段与段之间的分隔，不是内容。
    while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === '') bodyLines.pop()
    return {
      level: head.level,
      title: head.title,
      text: bodyLines.join('\n'),
      line: head.line,
    }
  })
}

/**
 * 把七段匹配到实际标题上。
 *
 * 规则：
 *   - 关键词命中标题即可（**不区分顺序**，见文件头订正 1）；
 *   - **一个标题只能担任一段**（第一轮按 §1→§7 的顺序分配，先到先得）。
 *     这一条是 A1 审查的反例 3 逼出来的：`## 3. 现状与下一步` 同时含
 *     「现状」和「下一步」，于是同一段文本被 §2 与 §3 **复用两次**，
 *     H1 报「7/7 段齐全」—— 而全文只有 6 个标题，根本没有真正的「下一刀」。
 *     **同一段文字不能既当"现状"又当"下一步"。**
 *   - 段落内容包含其子段落（见 `splitSections`）。
 *
 * @param {string} body
 * @returns {Record<string, {found: boolean, title?: string, level?: number, text?: string, line?: number}>}
 */
export function parseHandoverSections(body) {
  const sections = splitSections(body)
  const used = new Set()
  /** @type {Record<string, object>} */
  const result = {}

  for (const spec of SECTIONS) {
    let hit
    for (let index = 0; index < sections.length; index += 1) {
      if (used.has(index)) continue
      if (!spec.keywords.some((keyword) => sections[index].title.includes(keyword))) continue
      hit = index
      break
    }
    if (hit === undefined) {
      result[spec.key] = { found: false }
      continue
    }
    used.add(hit)
    const section = sections[hit]
    result[spec.key] = { found: true, title: section.title, level: section.level, text: section.text, line: section.line }
  }

  return result
}

// ---------------------------------------------------------------- 各段判据

/**
 * §1 / §2 / §4 / §6 的「非空」判据（H2）。
 *
 * 「非空」不等于「有字」：`§1 我的意图` 下面写一个「无」也是空话。
 * 所以这里要求**至少一行有意义的内容**，且不能只是「无 / TBD / 待补」。
 *
 * `enumerable` = 这一段必须能**逐条枚举**（表格行或列表项）。
 * 用它而不是硬要求表格，是因为 §4「坑」在真实交接里常写成编号列表
 * （dogfood 的 `handover-to-tier26` §5 就是 1./2./3. 的列表），
 * 那是完全合格的写法——**要求表格会把合格的文档判挂**，属于误伤。
 * 纯散文仍然会被拒（那才是「不可枚举」的真问题）。
 *
 * @param {string} text
 * @param {{enumerable?: boolean}} [opts]
 * @returns {{ok: boolean, why?: string}}
 */
export function hasSubstance(text, opts = {}) {
  const lines = linesOf(text).filter(isMeaningfulLine)
  if (lines.length === 0) return { ok: false, why: '这一段是空的' }

  // 只有一句"无 / TBD"不算有内容（§7 例外，见 checkHandover）。
  const joined = lines.join('\n').trim()
  if (/^(无|没有|暂无|tbd|todo|待补|略)[。.!！]?$/i.test(joined)) {
    return { ok: false, why: '这一段只写了「无 / 待补」，等于没写' }
  }

  if (opts.enumerable === true) {
    const rows = lines.filter((line) => (isTableRow(line) && !isTableSeparator(line)) || isListItem(line))
    if (rows.length === 0) return { ok: false, why: '这一段既没有表格行也没有列表项，无法逐条核对' }
  }

  return { ok: true }
}

/**
 * §3 的一条「下一步」是否足够具体（H3 / M1-Q9）。
 *
 * 满足**任一**即可：含路径、含工具名、含反引号命令。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isConcreteAction(text) {
  if (typeof text !== 'string' || text.trim() === '') return false
  return PATH_RE.test(text) || TOOL_BACKTICK_RE.test(text) || TOOL_VERB_RE.test(text) || CMD_RE.test(text)
}

/**
 * §3 是否至少有 1 条具体的下一步（H3）。
 *
 * 判的是**整段**而不是逐行：真实交接里「下一步」常常写成
 * 「改 `core/render.js` 的 fitBudget，然后跑 `node --test`」这样一句带多个形态。
 *
 * @param {string} text
 * @returns {{ok: boolean, concrete: string[], vague: string[]}}
 */
export function checkNextActions(text) {
  const lines = linesOf(text).filter(isMeaningfulLine)
  const concrete = []
  const vague = []
  for (const line of lines) {
    if (isConcreteAction(line)) concrete.push(line)
    else vague.push(line)
  }
  return { ok: concrete.length > 0, concrete, vague }
}

/**
 * 一行「验收」是否带证据形式（H4）。
 *
 * @param {string} line
 * @returns {{ok: boolean, hits: string[]}}
 */
export function hasEvidence(line) {
  const text = String(line ?? '')

  // ---- 2026-11-15 M2.8（第 29 轮 `session-dd0e36b5` 反馈）：**比值必须合理** ----
  //
  // 缺陷现场：AI 在 §5 写了一条**它自己都不认为是证据**的话：
  //
  //   `0/0 通过` 级别的无缺项结论（见落盘后复检）
  //
  // 而 `doc_handover_check` **判它合格**（7/7 通过，一条 warn 都没有）。
  // AI 自己发现了这件事并如实报告：
  //
  // > 值得警惕的一点：第一次 `doc_handover_check` 就返回了 **7/7 通过**，
  // > 把我那条假证据也放过了（H4 已降为 warn）。
  // > **校验通过 ≠ 内容为真**，这次是我自己发现并修的。
  //
  // 实测（`_m28/ev29.mjs`）确认这条判据的三个漏洞：
  //   `0/0 通过`  → HIT   ← 零项被验证，却是"合格证据"
  //   `1/0 通过`  → HIT   ← 分子大于分母，数学上不可能
  //   `999/1 通过` → HIT  ← 同上
  //
  // 这不只是"形状不严"，是**判据在奖励一句明显为假的话**。
  // `0/0` 的含义恰恰是"我一项都没验" —— 它是 H4 想抓的那种情况的**极端形态**。
  //
  // ⇒ 修法：在原有形状判据之外，**再查一遍比值是否成立**：
  //    · 分母必须 > 0（`0/0` = 什么都没验，不能当证据）；
  //    · 分子必须 ≤ 分母（`3/2 通过` 不可能）。
  //
  // ⚠️ 只管 `N/M` 这一种形态；其它三类（seq / session / 哈希）没有这个问题。
  // ⚠️ 只**否定**这里的比值，不因此让整行必挂 —— 若该行还有 `seq=` 或哈希，
  //    它仍然是合格证据（下面仍是 `hits.length > 0`）。
  const badRatio = /(\d+)\s*\/\s*(\d+)/.exec(text)
  const ratioInvalid = badRatio !== null && (() => {
    const num = Number(badRatio[1])
    const den = Number(badRatio[2])
    return den === 0 || num > den
  })()

  const hits = EVIDENCE_PATTERNS
    .filter((pattern) => {
      // 比值不合理时，只否定「靠这个比值成立」的那一条（`test`），
      // 其它三条（seq / session / hash）与该比值无关，照常判。
      if (ratioInvalid && pattern.key === 'test') {
        // 例外：该行还有 `tests N / pass N` / `单测 N/M` 这类**自带分母语义**的形态？
        // 不例外 —— 那些形态也依赖同一组数字，照样要合理。
        return false
      }
      return pattern.re.test(text)
    })
    .map((pattern) => pattern.key)

  return { ok: hits.length > 0, hits, ratioInvalid }
}

/**
 * §5 的每一条验收是否都带证据形式（H4）。
 *
 * 「每一条」= 列表项与表格**数据行**（那是验收条目的两种写法）。
 * 三类行**不参与判定**：
 *   - 段落式的说明文字（否则「本切片验收如下：」这句导语会把整段判挂）；
 *   - 表格的**表头行**与分隔行（表头是列名，不是一条验收——第一版把它算进去了，
 *     结果「| # | 判据 | 证据 |」这条被当成"缺证据的验收"，是误报）；
 *   - **代码块内部的行**（见下）。
 *
 * ---- 2026-11-16 M2.8（用户拍板决策 #8）：**代码块内的行不算验收条目** ----
 *
 * 缺陷（长期存在，一直被当成"使用限制"写进技能）：
 *
 * ```
 * §5 写：
 *   - 建文档：`2/2 通过`。
 *
 *   ```bash
 *   - 这不是验收条目，是命令示例
 *   ```
 *
 * 判据：total = 2（把代码块里那条也数进去了）→ 那条没证据 → **H4 报不合格**
 * ```
 *
 * 实测（`_m28/codeblock.mjs`）：
 *   · 代码块里 2 条列表项 → `total` 从 2 变成 **4**，`missing` 里塞进那 2 条命令示例；
 *   · 代码块里一张表格 → `total` 从 1 变成 **2**，`missing` = `["| x | y |"]`。
 *
 * **方向反了**：技能一直在教"§5 别放代码块，用行内反引号"——
 * 那是让用户迁就实现。Markdown 里代码块**就是**"这段不是内容"的语法，
 * 解析器必须尊重它。
 *
 * ---- 为什么只改这里，不改 `isListItem` / `isTableRow` ----
 *
 * 那两个函数还被**另一个判据**用（`checkSectionContent` 第 505 行的
 * 「这一段有没有可枚举的行」）。在那个语境里，代码块里的列表**也算内容**
 * （一份交接的 §3 用代码块列出步骤是完全合法的）。
 * ⇒ 代码块感知**只属于 H4 的语义**，不能塞进公共工具函数。
 *
 * ---- 2026-11-16 M2.9：**折行的验收条目不能再被判废**（用户拍板「算」）----
 *
 * 缺陷现场（第 32 轮 `session-1fe6505f` seq 166，AI 自己实测出来的）：
 *
 * ```
 * §5 写：
 *   1. 两份文档正文只有一个字符，已整份 `read` 复核，
 *      结果 —— **2/2 通过**。
 * ```
 *
 * 判据报：「有 1/1 条没有证据形式。**不合格的条目**：1. 两份文档正文只有一个字符…」
 *
 * **为什么**：上一版把「一条验收」等同于「一个物理行」。于是
 *
 *   第 1 行 `1. 两份文档正文只有一个字符，已整份 read 复核，` → `items[0]`，无证据 → 判挂
 *   第 2 行 `   结果 —— 2/2 通过。`                        → 不是列表项，**直接丢掉**
 *
 * 而中文写作里长条目折行**极其自然**（AI 那一轮就是这么写的），一折行证据就落到
 * 第二行。**判据把"物理行"当成了"逻辑条目"** —— 这和 H9 认句式、H4 认词表是同一类错：
 * 拿排版当成内容。
 *
 * ---- 修法：软换行合并到它所属的列表项 ----
 *
 * 一条验收条目 = **一个列表项**（`1. ` / `- ` / `* ` 开头），它之后**紧跟的**
 * 非空、非列表项、非表格行、非标题行都属于它。三条边界：
 *
 *   · **空行结束续接** —— 空行之后是另一段话，不是同一条验收；
 *   · **表格行各算一条** —— 表格没有软换行语义（单元格就是换行边界）；
 *   · **代码块围栏 / 标题行结束续接** —— 它们不属于上一条验收。
 *
 * ⚠️ 必须**按原始行**迭代（不能用 `filter(isMeaningfulLine)` 之后再判）：
 *    滤掉空行会让「空行后的独立段落」被误并进上一条验收。
 *
 * @param {string} text
 * @returns {{ok: boolean, total: number, missing: string[]}}
 */
export function checkAcceptanceEvidence(text) {
  const items = []
  let sawTable = false
  // 代码块围栏状态：``` 或 ~~~ 开始 / 结束。支持 ```js 这种带语言标记的开头。
  let inFence = false
  /** 当前可以被软换行续接的条目下标；`-1` = 没有（空行 / 段落 / 围栏之后）。 */
  let openItem = -1

  for (const line of linesOf(text)) {
    // 围栏行本身不算内容，但它切换状态。
    // ⚠️ 必须**先**判围栏，否则 ``` 那一行会被当成普通文本漏掉，
    //    而代码块里的内容就全被当成验收条目了（那正是 §16 修掉的 bug）。
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence
      openItem = -1
      continue
    }
    // 代码块内部：一律不算验收条目。
    if (inFence) continue

    // 空行 / 分隔线 / HTML 注释：不是内容，且**结束**续接。
    if (!isMeaningfulLine(line)) {
      openItem = -1
      continue
    }

    if (isTableRow(line)) {
      openItem = -1 // 表格行自成一条，不吃续行也不被续接
      if (isTableSeparator(line)) { sawTable = true; continue }
      // 表格的第一行是表头：它后面紧跟分隔行才算"表头"。
      if (sawTable !== true) { sawTable = 'header'; continue }
      if (sawTable === 'header') sawTable = true
      items.push(line)
      continue
    }

    if (isListItem(line)) {
      items.push(line)
      openItem = items.length - 1
      continue
    }

    // ---- 不是列表项、不是表格行 ----
    //
    // ① 紧跟上一条列表项 → **软换行的续行**，并进去。
    //    标题行（`#` 开头）不算续行：那是新的一节，不是上一条验收的一部分。
    if (openItem >= 0 && !/^\s*#/.test(line)) {
      items[openItem] = `${items[openItem]}\n${line}`
      continue
    }
    // ② 段落文字（导语 / 解释）→ 不是验收条目，且结束续接。
    openItem = -1
  }

  // 判证据时用**合并后的整条**（软换行已并进来）；
  // 但报错文案里要**压成一行**，否则多行条目在提示里会被截断成半句话。
  const missing = items
    .filter((item) => !hasEvidence(item).ok)
    .map((item) => item.replace(/\s*\r?\n\s*/g, ' '))
  return { ok: items.length > 0 && missing.length === 0, total: items.length, missing }
}

// ---------------------------------------------------------------- 总校验

/**
 * 从条目列表里算「当前最小的 handover order」（M1.5 / **N5**）。
 *
 * ⚠️ **M1 的错在口径而不是取值**：它把**全部条目**的 order 拿来取 `Math.min`。
 * 于是只要项目里有**任何一份** `order: 0` 的非交接文档（比如 `read-order`），
 * **所有交接就永远报 H7**：
 *
 * ```
 * 实测（_review/proj-a）：read-order 的 order=10，handover-zero 的 order=0
 * → handover-probe（order 30）报 H7「order 是 30，不是项目里最小的 10」
 * ```
 *
 * H7 的语义是「**交接应当永远排第一**」，而"第一"是**在所有交接里第一**，
 * 不是"在所有文档里第一"。按后者写，H7 就变成一条**永远无法满足**的警告——
 * 正是 D9 自己批评过的形态（"一个永远无法满足的警告，会让所有警告都变得可疑"）。
 *
 * @param {Array<object>} entries 注册表条目
 * @returns {number | undefined} 没有 handover 时返回 undefined（H7 会跳过）
 */
export function handoverMinOrder(entries) {
  const orders = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.meta?.role === 'handover')
    .map((entry) => entry?.meta?.order)
    .filter((order) => typeof order === 'number' && Number.isFinite(order))
  return orders.length > 0 ? Math.min(...orders) : undefined
}

/**
 * 把条目折成 H6 要的 `handovers` 上下文（只留交接）。
 *
 * 与 `handoverMinOrder` 同一口径：**只认 `role: handover`**。
 *
 * @param {Array<object>} entries
 * @returns {Array<{id: string, status: string, order: number}>}
 */
export function handoverListOf(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.meta?.role === 'handover')
    .map((entry) => ({ id: entry.meta.id, status: entry.meta.status, order: entry.meta.order }))
}

/**
 * §1「我的意图」是否交代了「这个项目是什么」（M1.5 / **N8 辅修法**）。
 *
 * ⚠️ **判据刻意做得很宽，因为第一版设计错了。**
 * 原判据是「§1 必须包含 `role: index` 文档 summary 的**前 8 个字**」，
 * 拿三个真实项目实测，**三个全部不可能自然命中**：
 *
 * | 项目 | 索引 summary | 要求出现的 8 个字 |
 * |---|---|---|
 * | dogfood | 档 2 的入口索引：先读哪一份… | 「档 2 的入口索」 |
 * | proj-a | 评审 M1 用的最小 DDD 项目… | 「评审 M1 用的」 |
 * | _m1-drill | 项目的入口索引：先读哪一份… | 「项目的入口索引：」 |
 *
 * **正常作者绝不会写「档 2 的入口索」这种半截话** —— 那版判据会每次误报，
 * 而一个永远报的 warn 会被模型学会无视（正是 D9 批评的形态）。
 *
 * 改后的判据（命中**任一**即可）：
 *   1. 提到项目里 `role: index` 文档的 **`id`**（如 `read-order`）；
 *   2. 提到那份文档 **`title` 的完整短语**；
 *   3. 出现显式的「本项目 / 这个项目是……」句式。
 *
 * 命中不了 → **`warn`**（不是 error）。理由：索引块的【项目】行已经在**系统层**保证了；
 * 这条只是兜底。做成 error 会让所有没提过项目的**现存交接**一次性全挂。
 *
 * 已知宽松处（**如实记在 README**）：它仍可能被"机械地抄一句『本项目是 xxx』"绕过。
 * 所以它**不能替代**【项目】行，只是兜底。一旦被证明可绕过，触发 `A-2`。
 *
 * @param {string} text §1 的正文
 * @param {object} [context]
 * @param {Array<{id?: string, title?: string, summary?: string}>} [context.indexDocs]
 *        `role: index`（拿不到时退 spec）文档的 `{id, title, summary}`
 * @returns {{ok: boolean, why?: string}}
 */
export function mentionsProjectIntro(text, context = {}) {
  const body = typeof text === 'string' ? text : ''
  if (body.trim() === '') return { ok: false, why: '§1 是空的' }

  // 形态 3：显式句式。`本项目` / `这个项目` / `项目简介` 都算。
  if (/本\s*项目|这个项目|该项目|项目简介|项目是做什么/.test(body)) return { ok: true }

  const docs = Array.isArray(context?.indexDocs) ? context.indexDocs : []
  for (const doc of docs) {
    const id = typeof doc?.id === 'string' ? doc.id.trim() : ''
    // 形态 1：提到索引文档的 id。
    if (id !== '' && body.includes(id)) return { ok: true }
    // 形态 2：提到那份文档 title 的**完整短语**（不是前 N 字截断）。
    const title = typeof doc?.title === 'string' ? doc.title.trim() : ''
    if (title.length >= 4 && body.includes(title)) return { ok: true }
  }

  return { ok: false, why: '没有交代「这个项目是什么」' }
}

/**
 * 取项目里「入口索引」文档的 `{id, title}`，供 H9 的 §1 内容判据比对（M1.5 / N8）。
 *
 * 优先 `role: index`，拿不到退 `role: spec` —— 与索引块【项目】行的取法**同一口径**，
 * 否则两处会对"这个项目是什么"给出不同的答案。
 *
 * @param {Array<object>} entries
 * @returns {Array<{id: string, title: string}>}
 */
export function indexDocsOf(entries) {
  const list = Array.isArray(entries) ? entries : []
  const clean = list.filter((entry) => (
    entry?.hasError !== true
    && typeof entry?.meta?.id === 'string'
    && entry.meta.id !== ''
  ))
  const index = clean.filter((entry) => entry.meta.role === 'index')
  const pool = index.length > 0 ? index : clean.filter((entry) => entry.meta.role === 'spec')
  return pool.map((entry) => ({
    id: entry.meta.id,
    title: typeof entry.meta.title === 'string' ? entry.meta.title : '',
  }))
}

/**
 * 校验一份交接文档（H1–H7）。
 *
 * @param {object} input
 * @param {object|null} input.meta frontmatter（`docs/frontmatter.js` 的解析结果）
 * @param {string} input.body 正文
 * @param {object} [input.context]
 * @param {number} [input.context.minOrder] 当前项目里最小的 order（H7 用；不给就跳过 H7）
 * @param {Array<{id: string, status: string, order: number}>} [input.context.handovers]
 *        项目里所有 `role: handover` 的文档（H6 用；不给就跳过 H6）
 * @param {boolean} [input.context.strict] false 时 H1–H4 降为 warn（配置 `handoverCheckStrict`）
 * @param {Array<{id?: string, title?: string}>} [input.context.indexDocs]
 *        `role: index` 文档的 `{id, title}`（H9 用；不给就跳过 H9）
 * @returns {{ok: boolean, errors: Array<object>, warnings: Array<object>,
 *            sections: Record<string, object>, stats: object}}
 */
export function checkHandover(input) {
  const opts = input !== null && typeof input === 'object' ? input : {}
  const meta = opts.meta !== null && typeof opts.meta === 'object' ? opts.meta : null
  const body = typeof opts.body === 'string' ? opts.body : ''
  const context = opts.context !== null && typeof opts.context === 'object' ? opts.context : {}
  const strict = context.strict !== false

  const errors = []
  const warnings = []
  /** 硬规则（H1–H4）的级别：严格模式是 error，调试模式降为 warn。 */
  const hardLevel = strict ? 'error' : 'warn'
  const push = (rule, level, message, section) => {
    const item = { rule, level, message, ...(section === undefined ? {} : { section }) }
    if (level === 'error') errors.push(item)
    else warnings.push(item)
  }

  const sections = parseHandoverSections(body)

  // ---- H1：七段标题都能匹配到
  const missingSections = SECTIONS.filter((spec) => sections[spec.key].found !== true)
  if (missingSections.length > 0) {
    push(
      'H1',
      hardLevel,
      `缺少 ${missingSections.length} 个必填段落：${missingSections.map((spec) => `§${spec.index} ${spec.label}`).join('、')}。`
        + '（二级或三级标题，含对应关键词即可）',
    )
  }

  // ---- H2：§1/§2/§4/§6 段落非空
  const substanceRules = [
    ['intent', 1, '我的意图', {}],
    ['status', 2, '现在到哪了', {}],
    ['pitfalls', 4, '坑', { enumerable: true }],
    ['nonGoals', 6, '刻意没做', { enumerable: true }],
  ]
  for (const [key, index, label, ruleOpts] of substanceRules) {
    const section = sections[key]
    if (section.found !== true) continue // 已经在 H1 报过，不重复报
    const verdict = hasSubstance(section.text, ruleOpts)
    if (verdict.ok !== true) {
      push('H2', hardLevel, `§${index} ${label}：${verdict.why}`, index)
    }
  }

  // ---- H3：§3 至少 1 条具体的下一步
  if (sections.next.found === true) {
    const verdict = checkNextActions(sections.next.text)
    if (verdict.ok !== true) {
      push(
        'H3',
        hardLevel,
        '§3 下一刀：没有一条含具体路径、工具名或反引号命令。'
          + '「继续做下一步」「按照计划推进」这类空话会被拒绝 —— '
          + '请写成「改 `core/render.js` 的 fitBudget」「用 doc_new 建一份 spec」这种能直接照做的形式。',
        3,
      )
    }
  }

  // ---- H4：§5 每条验收都有证据形式
  //
  // ---- 2026-11-14 M2.6（用户拍板）：**H4 从 error 降为 warn** ----
  //
  // ---- 为什么降级：它逼的是"人话迁就正则"，不是"把话写清" ----
  //
  // 实测（本轮）：一份**人话写得很实在**的交接被判 2/2 全挂 ——
  //
  //   - 两份文档正文严格为 1 和 2：我用 PowerShell 逐份比对，两行都输出 OK
  //   - 索引已登记：我读了一遍 read-order，两个条目都在
  //
  // 这两条**确实真的验过了**，但都不是判据认识的"形状"。
  // AI 自己的总结：「**我手里有证据，但我不知道判据在找什么形状**……
  // 这一步的成本没法靠"更认真地验"降下来，只能靠"读过一遍报错"。」
  //
  // 这就是根本矛盾：**H4 的 error 级别等于把"会不会写正则"当成交接合格的前置条件**。
  // 而它对文档质量的贡献，主要在于"逼你想清楚验了什么" —— 那件事 warn 也能做到。
  //
  // ---- 为什么不是删掉 ----
  //
  // 它仍是有价值的方向性提示（§5 别写成"看起来没问题"）。只是**不该阻断交接**：
  // 阻断的代价是 AI 反复重写整份文档（实测连建 4 份、44 步、被用户中止）。
  //
  // ---- 与 strict 的关系 ----
  //
  // 原来 H4 走在 `hardLevel` 上（strict=true → error）。现在**硬编码 warn**，
  // strict 只影响 H1–H3。理由：H4 是"形状"判据，而 H1–H3 是"有没有这段/有没有内容"——
  // 后者是结构性的，前者是风格性的。
  //
  // ⚠️ 保留 `H4` 这个规则名与全部文案（含"可用的写法示例"）：
  // 它是"怎么改"的唯一指引，降级只影响**是否阻断**，不影响**是否提示**。
  const h4Level = 'warn'
  if (sections.acceptance.found === true) {
    const verdict = checkAcceptanceEvidence(sections.acceptance.text)
    if (verdict.total === 0) {
      push('H4', h4Level, '§5 验收：这一段没有任何验收条目（列表项或表格行）', 5)
    } else if (verdict.ok !== true) {
      push(
        'H4',
        h4Level,
        `§5 验收：有 ${verdict.missing.length}/${verdict.total} 条没有证据形式。`
          + '每条都要能核对（会话 id + seq / 哈希 / 测试输出 / 可复现的命令）。'
          // ⚠️ 必须给**可照抄的样例**（SPEC-M2 §9.5.4）。
          // 演练里的模型被拒 3 次都不知道自己差在哪，于是跑去读 `core/handover.js` 源码逆向正则，
          // 而它猜出来的写法（`3/3 通过`）恰恰被上面那个 `\b` bug 挡着 —— 试了 4 次才蒙对。
          // 判据的本意是逼它写具体，不是逼它逆向工程。给了样例它就不必读源码。
          //
          // ---- 2026-11-14 M2.6：**只报第一条 + 不报原因 = 逼模型猜正则** ----
          //
          // AI 自述（`session-3ef1b3b2`）：
          //   「真正难的地方在于：失败返回只告诉我"第一条缺证据的是哪条"，
          //     不告诉我为什么它不合格。我只能改写法再试，这本质上是在猜一个评分标准的正则表达式。」
          //
          // 实测它就是据此连挂两轮（2/5 → 2/6 → 才过）。
          //
          // ⇒ 两处改进：
          //   ① **列出全部**不合格条目（最多 3 条），而不是只给第一条 ——
          //      否则修完第一条还有第二条，又是一轮往返；
          //   ② **说清为什么不算**：判据要"分数 + 结果词"或"带上下文的值"，
          //      并直接把"你写的那种为什么不算"点出来。
          + '可用的写法示例：`seq=42`、`session-abc123`、`sha256: a1b2c3d4`、'
          + '`722/722 全绿`、`3/3 通过`、`3/3 命中`、`tests 691 / pass 691`。'
          + `\n**不合格的条目**（共 ${verdict.missing.length} 条，这里列出前 ${Math.min(3, verdict.missing.length)} 条）：\n`
          + verdict.missing.slice(0, 3).map((line) => `  - ${line.trim().slice(0, 80)}`).join('\n')
          + '\n**为什么不算**：判据认的是这四类——'
          + '① `seq=` 跟数字；② `session-` 跟 id；'
          + '③ 算法名 + 至少 8 位十六进制；④ `N/N` 后面跟**结果词**（通过/命中/全绿/passed）。'
          + '所以 `文件数: 4`、`共 12/12 条`、`跑了 3/3 次`、`看起来没问题` 都不算 —— '
          + '它们没有"结果"语义。**改成 `3/3 通过` 或 `3/3 命中` 就行。**'
          // ---- 2026-11-15 M2.8（第 29 轮）：**比值必须合理** ----
          //
          // 第 29 轮 AI 写了一句 `0/0 通过`，被判合格。它自己发现了并报告：
          // > 校验通过 ≠ 内容为真，这次是我自己发现并修的。
          //
          // 报错文案必须**说清这一点**，否则模型下次只会以为"形状不对"、
          // 继续换措辞，而真正的问题是**它一项都没验**。
          + '\n**另外：比值必须成立。** `0/0 通过` 不算（**零项被验证 = 什么都没验**），'
          + '`5/3 通过` 也不算（分子不能大于分母）。'
          + '写之前先问自己：这个分母是**我实际验过的项数**吗？',
        5,
      )
    }
  }

  // ---- H5：§7 若为空，正文里必须出现「无」（warn）
  if (sections.open.found === true) {
    const section = sections.open
    const meaningful = linesOf(section.text).filter(isMeaningfulLine)
    const hasNone = NONE_RE.test(section.text) || /^\s*(无|没有|暂无)[。.!！]?\s*$/m.test(section.text)
    if (meaningful.length === 0) {
      push('H5', 'warn', '§7 仍未决：这一段是空的。若确实没有未决项，请显式写「无」。', 7)
    } else if (!hasNone && meaningful.length === 1 && meaningful[0].trim().length <= 4) {
      push('H5', 'warn', '§7 仍未决：这一段只有几个字，看不出是「确实没有」还是「忘了写」。请显式写「无」。', 7)
    }
  }

  // ---- H11：**会过期的"当前事实"断言**（warn，M2.9）
  //
  // ---- 为什么加这一条（第 36 轮 `session-2e2873ec` 的真实现场）----
  //
  // 技能手册 §3.4 明确写着：
  //   > 别在文档里断言"文件仍在 `docs/`"——**那是会过期的**。
  //   > 同理别写"坟场里现在是空的"——那是随时会变的快照。
  //
  // 那一轮的 AI **读到了这条、在自述里引用了它**，然后**还是写了**：
  //
  //   - 没归档任何文档：没有需要作废的对象，**坟场为空是正常状态**。
  //
  // 它自己的复盘原文：
  //   > 我确实犯了一条……「坟场为空是正常状态」正是被点名禁止的那类断言。
  //   > `doc_handover_check` 查不出来，`doc_health` 也查不出来，
  //   > 只有我自己能拦。**这次没拦住。**
  //
  // ---- 为什么是 warn 而不是 error ----
  //
  // 用户拍板：**只加 warn**。理由与 H4 同源：
  // 这类句子**不一定错**（刚初始化时"坟场为空"确实是事实），
  // 它错在"写死了一个会变的状态"。阻断交接的代价远大于提醒一句。
  //
  // ---- 判据为什么只认这几种句式 ----
  //
  // 「会过期」无法一般化判定（任何一句话都可能被未来推翻）。
  // 所以只抓**已知会随用户操作立刻变化**的那几种事实：
  //   · 文件/文档的**位置**（"仍在 docs/"、"还在 docs/"）
  //   · 坟场的**内容**（"坟场为空"、"坟场里没有…"）
  //   · 交付区的**内容**（"deliverables 为空"、"还没交付任何"）
  //
  // ⚠️ 刻意**不**抓"共 N 份文档"这类计数 —— 那已经由 H-6 的候选行提示覆盖，
  //    两条判据抓同一件事会互相稀释。
  const STALE_FACT_PATTERNS = [
    {
      key: 'location',
      // ---- 2026-11-16 M2.9：**第一版误报了，收紧判据** ----
      //
      // 第一版正则：`(?:仍在|还在|仍留在|留在)\s*`?docs\/?`?\s*(?:里|目录|下)?`
      // 它在第 36 轮那份真交接上抓到了：
      //   「这两份「1」「2」文档最终是**留在** `docs/` 当演练记录，**还是**会被归档进坟场 —— 未定」
      //
      // **那是待决选项，不是当前事实断言。** 它说的恰恰是"还没定"，
      // 完全符合"别把会变的东西写成事实"这条要求 —— 抓它等于惩罚正确写法。
      //
      // ⇒ 收紧两处：
      //   ① 只认"仍/还"这种**断言仍在原处**的副词，不再认单字「留在」
      //      （「留在」既可能是陈述，也可能是"是留在A还是B"的选项）；
      //   ② 出现「还是 / 或者 / 未定 / 待定」这类**选择/未决**措辞就整体跳过。
      re: /(?:仍|还|尚)(?:然)?在\s*`?docs\/?`?\s*(?:里|目录|下)?/,
      skipIf: /还是|或者|或是|未定|待定|待用户/,
      hint: '文件位置会随用户在界面「归档」立刻改变',
    },
    {
      key: 'graveyard-empty',
      // "坟场为空" / "坟场是空的" / "坟场里没有…" / "没有文档进坟场"
      re: /坟场\s*(?:为|是|里|中)?\s*(?:空|没有|无)|(?:没有|无)\s*[^。\n]{0,6}(?:进|在)\s*坟场/,
      skipIf: /还是|或者|未定|待定|待用户/,
      hint: '坟场内容随时会被用户改变',
    },
    {
      key: 'deliverables-empty',
      re: /`?deliverables\/?`?\s*(?:为|是|里|中)?\s*(?:空|没有|无)|(?:还没|尚未|没有)\s*交付/,
      skipIf: /还是|或者|未定|待定|待用户/,
      hint: '交付区内容随时会被用户改变',
    },
  ]
  {
    const hits = []
    for (const pattern of STALE_FACT_PATTERNS) {
      // ⚠️ 逐行判，不是整篇判：`skipIf` 只在**同一行**里有意义
      //    （同一句里出现"还是"就说明这是选项，不是断言）。
      for (const line of linesOf(body)) {
        if (pattern.skipIf !== undefined && pattern.skipIf.test(line)) continue
        const matched = pattern.re.exec(line)
        if (matched === null) continue
        hits.push({ key: pattern.key, text: matched[0], hint: pattern.hint })
        break // 同一种模式最多报一次
      }
    }
    if (hits.length > 0) {
      push(
        'H11',
        'warn',
        '正文里写了**会过期的"当前事实"**（warn，不阻断）：\n'
          + hits.map((hit) => `  - 「${hit.text}」—— ${hit.hint}`).join('\n')
          + '\n**为什么这算问题**：这些状态**用户一操作就变**，而写下来的那句话不会跟着变。\n'
          + '**改法**：写成"此刻的状态 + 它会变"，或者干脆只写**不变量**。\n'
          + '例：把「坟场为空是正常状态」改成「本轮未归档任何文档」。\n'
          + '⚠️ 这不是判决 —— 如果你确认那句话**永远不会变**，忽略它即可。',
      )
    }
  }

  // ---- **H9 已删除**（2026-11-15 M2.8，用户拍板「砍掉」）----
  //
  // ---- 为什么删（用户质疑后复核，确认它在误报）----
  //
  // 用户原话：
  // > Q3 砍掉（但 Q3 的问题这真的存在吗？我记得是被简化过的）
  //
  // **用户记得没错。** 复核发现它的第一个判定松到几乎无意义：
  //
  //     if (/本\s*项目|这个项目|该项目|项目简介|项目是做什么/.test(body)) return ok
  //
  // 只要出现「本项目」三个字就直接通过 —— 换句话说它**根本不检查内容**，
  // 检查的是"有没有用这几个词"。
  //
  // 第 26 轮（`session-b5657ffd` seq 73）的 §1 写的是：
  //
  //     在一个刚初始化的 DDD 工作区（`DDD全流程测试26`）里走一遍 建文档 → … 的最小回路
  //
  // **信息完全给了**（说了这是 DDD 工作区、叫什么名字、要干什么），
  // 但判 **MISS** —— 因为"工作区"不在词表里。
  //
  // 实测四种写法：
  //   `在一个刚初始化的 DDD 工作区（…）里…`  → MISS   ← 内容对，句式不对
  //   `项目简介：DDD全流程测试26 是…`      → HIT
  //   `本项目是 DDD 全流程测试 26`          → HIT
  //   `这是 DDD 全流程测试 26 工作区`        → MISS   ← 内容对，句式不对
  //
  // ⇒ 它认的是**句式**，不是内容。这与 H4 是同一类错误
  //   （把"某种正确写法"写成了唯一写法），而 H4 已经因此降级过。
  //
  // ---- 而且它要的信息系统已经免费给了 ----
  //
  // 索引块里每一轮都有【项目】行：
  //
  //     【项目】本项目的阅读入口：先读哪一份、哪些是陷阱、哪些已过期。
  //
  // H9 自己的提示文案也承认这一点：「系统层的【项目】行已经在索引块里，这条只是兜底」。
  // **兜底的东西在误报，所以砍掉。**
  //
  // ---- 删了什么、留了什么 ----
  //
  // · 删：`push('H9', ...)` 这段判定；
  // · 留：`mentionsProjectIntro` / `indexDocsOf` 两个**纯函数**与它们的单测
  //   （它们本身是对的，将来若要做"真正的语义判断"还能用）；
  // · 留：`context.indexDocs` 参数（`doc_handover_check` 仍在传，不影响行为）。
  //
  // ⚠️ 这不影响 H8 / H6 / H7 —— 它们各自独立。

  // ---- **H8**：`verifiedAt` 是否 ≥ 本交接的创建时间（M1.5 / **D4**，**warn**）
  //
  // ⚠️ **编号从 H8 改成了 H9 —— 因为撞车。**
  //
  // 交接文档里 **H8 被两个不同的判据同时占用**：
  //   - §0.4（第 72 行）：「`handover` 多一条 **H8** 判据」→ 指 **N8**（§1 项目简介），**我实现的这个**；
  //   - §3.6 的 **D4**：「`verifiedAt` + **H8**」，定义是「交接时所有 authoritative 文档的
  //     `verifiedAt` 必须 ≥ 本交接的创建时间」。
  //
  // 两个判据语义完全不同、都要用 H8 这个名字。而**编号撞车是这个项目反复批评的毛病**
  // （`M1-评审报告.md` §9.7「编号撞车提醒」、§11「两套 D 撞车会让人把决策 P3 看成缺陷 D3」）。
  //
  // 我的处置：
  //   - **N8 的判据用 H9**（它是 M1.5 的施工对象，先落地）；
  //   - **H8 这个编号留给 D4**（交接文档 §3.6 的原始分配），D4 本轮**没做**（见验收报告 §六）；
  //   - 在 README 的已知限制里记一笔，下一位就不会再撞。
  //
  // ⚠️ 为什么不让 N8 继续叫 H8 而把 D4 改名：因为**D4 是交接文档 §3.6 明确写死的编号**
  // （有定义、有判据描述），而 N8 只在 §0.4 被顺口提了一句「多一条 H8 判据」——
  // **改那句顺口提的，比改一个有完整定义的条目代价小**。
  //
  // 它不复用 H1 的"七段齐全"判据 —— 那会打挂所有现存交接（方案 A 的代价，`P13` 已否决）。
  //
  // ---- 2026-11-15 M2.8：**H9 判定已删除**（见上面那段说明）----
  //
  // 保留这行注释是刻意的：`mentionsProjectIntro` 函数仍在（附单测），
  // 将来若要做**真正的语义判断**（而不是句式匹配）可以从它开始。
  // `context.indexDocs` 参数也仍在传，只是不再影响任何判定。

  // ---- **H8**：`verifiedAt` 是否 ≥ 本交接的创建时间（M1.5 / **D4**，**warn**）
  //
  // 语义（交接 §3.6 的 D4）：
  // > 「交接时，所有 `authoritative` 文档的 `verifiedAt` 必须 ≥ 本交接的创建时间」
  //
  // **为什么这条判据有意义**：交接是"上一轮把结论交给下一轮"。
  // 如果某份 `authoritative` 文档的"上次验证时间"**早于**本轮交接，
  // 那说明**本轮没有重新确认过它** —— 而它仍然是权威文档，新会话会拿它当依据。
  // 这正是"文档在骗人"的形态（`doc_health` 的 H-1~H-5 都在抓这一类）。
  //
  // ---- 三条设计约束（都是踩过坑的形状）----
  //
  // 1. **必须是 warn，不是 error**（`P13` 的同理）：
  //    做成 error 会让所有**没有 `verifiedAt` 字段**的现存文档一次性全挂 ——
  //    而 `verifiedAt` 是 M1.5 才引入的可选字段。**迁移成本必须由 warn 期吸收。**
  //
  // 2. **拿不到比较基准就跳过**（不猜）：
  //    「本交接的创建时间」从哪来？frontmatter 里**没有** `createdAt` 字段
  //    （加它会改 schema、且 `doc_new` 要写时间 → 索引块会因时间戳每轮变，违反 M0-5）。
  //    所以这里只接受**显式传入**的 `context.handoverCreatedAt`。
  //    拿不到 → **整段跳过**，不报"查不出原因"的 warn（那正是 M1 第一版 N8 判据的错）。
  //
  // 3. **只查 `authoritative`**：`draft` / `superseded` / `sealed` / `void` 不参与 ——
  //    它们本来就不该被当依据，要求它们"验证过"没有意义。
  //
  // ⚠️ **编号说明**：这条是 **H8**（交接 §3.6 的 D4 明确分配）。
  // N8 的 §1 判据用的是 **H9**（因为交接文档里 H8 被两个判据同时占用，见上面 H9 那段）。
  const docsForH8 = Array.isArray(context.verifiedDocs) ? context.verifiedDocs : undefined
  const createdAt = typeof context.handoverCreatedAt === 'string' && DATE_ONLY_RE.test(context.handoverCreatedAt)
    ? context.handoverCreatedAt
    : undefined
  if (docsForH8 !== undefined && createdAt !== undefined) {
    const stale = []
    for (const doc of docsForH8) {
      if (doc?.status !== 'authoritative') continue
      const id = typeof doc?.id === 'string' && doc.id !== '' ? doc.id : '(未知文档)'
      // 缺 `verifiedAt` → **不算 stale**（字段是可选的；缺它由别的地方说，不在这条判据里）
      if (typeof doc.verifiedAt !== 'string' || doc.verifiedAt === '') continue
      if (!DATE_ONLY_RE.test(doc.verifiedAt)) continue // 格式坏的由 V12 报，这里不重复
      if (doc.verifiedAt < createdAt) stale.push(`${id}（${doc.verifiedAt}）`)
    }
    if (stale.length > 0) {
      push(
        'H8',
        'warn',
        `有 ${stale.length} 份 authoritative 文档的 verifiedAt 早于这份交接的创建时间（${createdAt}）：`
          + `${stale.join('、')}。`
          + '说明本轮没有重新确认过它们 —— 而它们仍然会被当成依据。'
          + '要么去验证并把 verifiedAt 更新成本轮，要么把 status 降成 draft / partial。',
      )
    }
  }

  // ---- H6：存在多份 authoritative handover（warn）
  const handovers = Array.isArray(context.handovers) ? context.handovers : undefined
  if (handovers !== undefined) {
    const authoritative = handovers.filter((item) => item?.status === 'authoritative')
    if (authoritative.length > 1) {
      push(
        'H6',
        'warn',
        `有 ${authoritative.length} 份 status 为 authoritative 的交接：${authoritative.map((item) => item.id).join('、')}。`
          + '建议把旧的标成 superseded 并写上 supersededBy。',
      )
    }
  }

  // ---- H7：handover 的 order 必须是最小的 handover order（**M1.5 起是 error**）
  //
  // 三处 M1.5 的改动，**顺序与理由都在这里**：
  //
  // ① **口径**（N5）：`minOrder` 由 `handoverMinOrder()` 算，只认 `role: handover`。
  //    M1 扫全部条目 → 有 `order: 0` 的非交接文档时 H7 永远报警。
  //
  // ② **跳过 superseded**（D9 第 ③ 步，**评审者补的，执行者的建议里没有**）：
  //    已被取代的旧交接**本来就不该排第一** —— 它的 order 大是**正确**的。
  //    实测反例（`_review/proj-a`，minOrder=-10）：
  //      `旧交接(status=superseded, order=0)` → `WARN [H7] order 是 0，不是最小的 -10`
  //    M1 的 H7 **完全不看 status**。所以「标成 superseded」挡不住它。
  //    一旦升成 error，**每一份被取代的旧交接都会立刻变红**，
  //    而 §4.1 的 D9 正向判据要求的正是"旧交接 ok:true"。
  //    **只做 ①②④ 不做 ③，等于自己造一个永远修不好的红灯。**
  //
  // ③ **级别**（D9 第 ④ 步）：`warn` → `error`。
  //    这条**必须最后做**，且必须与 ①②③ 在同一次改动里（`P6`）。
  const minOrder = typeof context.minOrder === 'number' && Number.isFinite(context.minOrder)
    ? context.minOrder
    : undefined
  const isSuperseded = meta !== null && meta.status === 'superseded'
  if (minOrder !== undefined && meta !== null && !isSuperseded && typeof meta.order === 'number') {
    if (meta.order !== minOrder) {
      push(
        'H7',
        'error',
        `这份交接的 order 是 ${meta.order}，不是最小的 handover order ${minOrder}。`
          + '交接应当永远排第一，否则新会话会先读到别的交接。'
          + '（新建交接时 `doc_new` 默认会取「最小 order - 10」；已存在的那份用 edit 改 frontmatter 的 order。）',
      )
    }
  }

  // ---- 附：基础元数据（不是 H1–H7，但会让交接不可用，所以一起报）
  if (meta === null) {
    push('M1', 'error', '这份文档没有可解析的 frontmatter（交接必须是受管文档）。')
  } else if (meta.role !== 'handover') {
    push('M1', 'error', `这份文档的 role 是 ${String(meta.role)}，不是 handover。`, undefined)
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    sections,
    stats: {
      sectionsFound: SECTIONS.filter((spec) => sections[spec.key].found === true).length,
      sectionsTotal: SECTIONS.length,
      concreteActions: sections.next.found === true ? checkNextActions(sections.next.text).concrete.length : 0,
      acceptanceItems: sections.acceptance.found === true
        ? checkAcceptanceEvidence(sections.acceptance.text).total
        : 0,
    },
  }
}

/**
 * 判断一份文本是不是「交接文档该有的样子」的**廉价预检**（工具层用它给出更好的提示）。
 *
 * 只回答「像不像」，不做裁决——裁决在 `checkHandover`。
 *
 * @param {string} body
 * @returns {boolean}
 */
export function looksLikeHandover(body) {
  const sections = parseHandoverSections(body)
  return SECTIONS.filter((spec) => sections[spec.key].found === true).length >= 4
}

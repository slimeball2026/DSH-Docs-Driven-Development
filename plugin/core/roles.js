/**
 * 按 role 的写权限表 + 「仅追加」判定（SPEC §7.3）。
 *
 * **纯函数，无 IO。**
 *
 * 为什么 role 要参与门禁：文档不是同质的。`evidence` 是**证据**，模型改它等于改证据；
 * `handover` 是**上一轮交接**，模型改它等于改历史。这两类必须拒绝一切写入。
 * 而 `spec` / `log` 本来就该被施工者更新。
 *
 * > `decision` 允许 `edit` 但要求**纯追加**：决策台账只能往后加，不能改前面。
 *
 * "仅追加"的判定放在这里（纯函数），由 `adapters/guard.js` 用 readSet 里缓存的文本执行——
 * **不在同步 guard 里读盘**。
 */

/** 写入动作。 */
export const WRITE = 'write'
export const EDIT = 'edit'

/** 放行。 */
export const ALLOW = 'allow'
/** 拒绝。 */
export const DENY = 'deny'
/** 放行但要求纯追加。 */
export const APPEND_ONLY = 'append-only'

/**
 * 策略表（SPEC §7.3 原样落地）。
 *
 * | role | write | edit |
 * |---|---|---|
 * | spec | 放行 | 放行 |
 * | decision | 拒绝 | 仅追加 |
 * | evidence | 拒绝 | 拒绝 |
 * | handover | 拒绝 | 拒绝 |
 * | instruction | 拒绝（除非 draft） | 拒绝 |
 * | log | 放行 | 放行 |
 * | index / fact | 放行 | 放行 |
 */
export const ROLE_WRITE_POLICY = Object.freeze({
  spec: Object.freeze({ write: ALLOW, edit: ALLOW }),
  decision: Object.freeze({ write: DENY, edit: APPEND_ONLY }),
  evidence: Object.freeze({ write: DENY, edit: DENY }),
  // ---- 2026-11-14 M2.6：**交接允许 edit**（用户第二次拍板，彻底放开）----
  //
  // 演进（三行看完）：
  //   1. 原实现：`{ write: DENY, edit: DENY }`，注释「改交接 = 改历史」。
  //      但 **SPEC-M1 §4.4 的原设计是允许 edit draft 的** —— 实现与设计不符。
  //   2. 我第一版只放开 `draft`（`core/gate.js` 里那条例外）。
  //      实测（`session-47f59223`）**不够**：AI 在"还有东西要改"的时候就标了 authoritative，
  //      随后发现 read-order 的哈希过时了 —— 于是又卡住，且陷入了 33 000 字的往返思考
  //      （原话：「handover 现在是 authoritative 了，改不了……要不要建新的？太重了」）。
  //   3. 用户第二次拍板：**彻底允许任意 edit 交接**。
  //
  // ---- 安全性依据（用户要求先核实）----
  //
  // 用户原话：「至于安全性，可以看看你自己有没有改过给你的交接文档。」
  // 核实结果（`git log -- 交接-M2.6.md`）：**一次都没改过** ——
  // 那份交接从 M2.5 交给我的那一刻起，到最后一次提交都是原样。
  //
  // ⇒ 真实使用中，交接是"**照做**"的对象，不是"改"的对象；
  //   而演练里 AI 是"边写边验"，哈希必然变化，锁死它只会逼出重写和冗余思考。
  //   两者的成本不对称：**锁死的代价（每次交接多写 3000 字 + 数千字思考）远大于
  //   放开的风险（理论上有人可以悄悄改上一轮记录）**。
  //
  // ---- 仍然守住的边界 ----
  //
  // `write` **仍然一律拒绝**：新建交接必须走 `doc_new`，因为它会
  // ① 生成合法 frontmatter ② 自动把旧交接标 superseded 并链到新版。
  // 直接 `write` 会绕过这条链，留下两份互不相认的交接。
  handover: Object.freeze({ write: DENY, edit: ALLOW }),
  instruction: Object.freeze({ write: DENY, edit: DENY }),
  log: Object.freeze({ write: ALLOW, edit: ALLOW }),
  index: Object.freeze({ write: ALLOW, edit: ALLOW }),
  fact: Object.freeze({ write: ALLOW, edit: ALLOW }),
})

/** 「仅追加」检查的尾部窗口（SPEC §7.3：末尾 200 字符内）。 */
export const APPEND_WINDOW_CHARS = 200

/**
 * 查表拿策略。
 *
 * 未知 role（含文档写坏了）一律返回 `DENY`——**保守拒绝**。
 * 理由：拿不到 role 说明文档本身有问题，这时放行写入等于让坏文档继续被改；
 * 而 §5.4 的原则是「error 不阻塞读取，只阻塞用它当依据」，写入不属于"读"。
 *
 * @param {string} role
 * @param {'write'|'edit'} action
 * @returns {'allow'|'deny'|'append-only'}
 */
export function policyFor(role, action) {
  const entry = ROLE_WRITE_POLICY[role]
  if (entry === undefined) return DENY
  return action === WRITE ? entry.write : entry.edit
}

/**
 * 判断一次 `edit` 是否算「纯追加」。
 *
 * 三个条件同时满足才算（SPEC §7.3）：
 *   1. `old_string` 匹配位置在文件**末尾 `APPEND_WINDOW_CHARS` 字符内**；
 *   2. `new_string` **包含** `old_string`（即没删改原文，只是把它连同新内容一起写回）；
 *   3. `old_string` 非空（空串是"在任意位置插入"，不是追加）。
 *
 * 为什么要第 2 条：`edit` 是字面替换。若 `new_string` 不含 `old_string`，
 * 那就是**改写**了已有内容——对决策台账来说等于篡改历史。
 *
 * @param {object} input
 * @param {string} input.oldText 文件当前全文（来自 readSet 缓存；拿不到就传 null）
 * @param {string} input.oldString
 * @param {string} input.newString
 * @param {boolean} [input.replaceAll] 传 true 直接判否（全量替换必然不是追加）
 * @returns {{append: boolean, reason?: string}}
 */
export function isAppendOnly(input) {
  const opts = input !== null && typeof input === 'object' ? input : {}
  const { oldText, oldString, newString, replaceAll } = opts

  if (replaceAll === true) return { append: false, reason: 'replace_all 会改全文，不是追加' }
  if (typeof oldString !== 'string' || oldString === '') {
    return { append: false, reason: 'old_string 为空，无法判定为追加' }
  }
  if (typeof newString !== 'string') return { append: false, reason: 'new_string 不是字符串' }
  if (!newString.includes(oldString)) {
    return { append: false, reason: 'new_string 不包含 old_string，这是在改已有内容' }
  }

  // 拿不到缓存文本时降级为放行并 warn（SPEC §7.3 明确要求）。
  if (typeof oldText !== 'string') {
    return { append: true, reason: 'degenerate: 没有缓存文本，降级放行' }
  }

  const index = oldText.lastIndexOf(oldString)
  if (index < 0) return { append: false, reason: 'old_string 在文件里找不到' }

  const tailStart = Math.max(0, oldText.length - APPEND_WINDOW_CHARS)
  if (index < tailStart) {
    return { append: false, reason: `匹配位置距文件末尾超过 ${APPEND_WINDOW_CHARS} 字符，不是在追加` }
  }

  return { append: true }
}

/**
 * 生成拒绝文案（SPEC §7.4 的三条要求：说清缺什么、给下一步、不指责）。
 *
 * @param {object} input
 * @param {string} input.id 文档 id
 * @param {string} input.role
 * @param {'write'|'edit'} input.action
 * @param {string} [input.why] 额外的具体原因
 * @returns {string}
 */
export function denyMessage(input) {
  const { id, role, action, why } = input ?? {}
  const name = typeof id === 'string' && id !== '' ? id : '这份文档'
  const head = `\`${name}\` 的 role 是 \`${role}\`，不允许用 ${action} 改动它。`

  if (role === 'evidence') {
    return `${head}证据类文档只能追加新文件，不能被改写。`
      + '如果你需要新的证据，请新建一份（或用 deliverables/ 放产物）。'
  }
  if (role === 'handover') {
    // ---- 2026-11-14 M2.6：交接的 `edit` 已彻底放开，这条文案现在只服务 `write` ----
    //
    // 演进：原实现 write/edit 全拒 → 我第一版只放开 draft →
    // 用户第二次拍板**彻底放开 edit**（理由见上面 `ROLE_WRITE_POLICY` 那条）。
    //
    // 所以走到这里的只可能是 `write`（`edit` 已经在 policy 层放行）。
    // 文案要说清"为什么不能 write、那该怎么新建"。
    return `${head}新建交接请用 \`doc_new\`，不要用 ${action}。`
      + '`doc_new` 会①生成合法 frontmatter ②自动把旧交接标 superseded 并链到新版；'
      + '直接写会绕过这条链，留下两份互不相认的交接。'
      + '（要**修改**已有交接的正文，`edit` 是允许的。）'
  }
  if (role === 'instruction') {
    // ---- 2026-11-15 M2.8（用户拍板）：**这句文案原来在说谎** ----
    //
    // 原文：「指令类文档只有 status: draft 时才能被写。要改它，先确认它是不是 draft；正式指令请让用户来改。」
    //
    // 而 `ROLE_WRITE_POLICY.instruction` 是 `{ write: DENY, edit: DENY }` —— **无条件拒绝**，
    // 与 status 无关。于是这句话给出了一个**不存在的解法**。
    //
    // 实测（第 25 轮 `session-18b07bcb` seq 66）：
    //   `instruction-1` 的 status 就是 `draft`，模型照着文案去确认了它确实 draft，
    //   然后再试 —— 仍然被同一规则拒。那一轮它把这个死胡同写进了交接 §4：
    //   > **`instruction-1` 不能 `edit`**：…而本次尝试仍被拒（角色级限制）。
    //
    // AI 的反馈（seq 186 第 4 条）把这条列为"改哪些地方会更轻松"之一：
    //   > 真实规则是角色级禁止（只有用户能改）。文案把我引向一个不存在的解法，
    //   > 我会去怀疑"是不是我 status 判断错了"，然后白试一轮。
    //
    // ⇒ 如实说清：这是**角色级**的，任何 status 都不行，工具侧没有出路。
    //    同时给出真正的替代路径（让用户改，或新建一份新指令），
    //    否则模型只能猜"那我该怎么办"。
    return `${head}**指令类文档对工具完全只读**（角色级限制，与 status 无关 —— 即使它是 draft）。`
      + '这不是权限配置问题，工具侧没有绕过办法。'
      + '两条正当出路：① **请用户**手工改这份文件；'
      + '② 若内容已经变了，用 `doc_new` **新建一份** role: instruction 的文档（旧的可标 superseded）。'
  }
  if (role === 'decision') {
    return `${head}决策台账只能往后追加，不能改已有内容。`
      + (typeof why === 'string' && why !== '' ? `（${why}）` : '')
      + '请用 edit 把新决策追加到文件末尾。'
  }
  return head + (typeof why === 'string' && why !== '' ? `（${why}）` : '')
}

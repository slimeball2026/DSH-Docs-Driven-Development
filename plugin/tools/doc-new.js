/**
 * `doc_new` —— 新建一份带合法 frontmatter 的文档（M1，会写文件）。
 *
 * 为什么必须是工具（SPEC §5.1）：
 * `write` 表达不了「生成一个 id 唯一、字段齐全、order 自动插值的 frontmatter」。
 * 让模型手写 frontmatter，等于让它每次重新发明 schema —— 而 schema 错了会进 `anomalies`。
 *
 * ---- 三件必须做对的事 ----
 * 1. **必须触发 `rescan()`**（交接 §5.3 #15）。
 *    不触发 = 新文档不进索引 = 重造 M0 的 D2「降级模式下新建文档永不被发现」。
 * 2. **必须把新文档记进本会话的 readSet**（README 订正清单第 2 条）。
 *    否则 `doc_new` → `doc_mark` 这条主流程会被门禁自己拒绝：
 *    注册表说「你没读过它」，而门禁对未读的必读文档一律拒绝。
 *    语义上也成立：**写它的人当然见过它的字节**。
 * 3. **不自动改 id**。id 冲突直接报错——id 是 kebab-case 的永久标识，
 *    自动加后缀会让「引用它的文档」全部指向一个不再存在的 id。
 */

import { defineTool } from './define-tool.js'
import { BASES, ROLES, STATUSES } from '../docs/schema.js'
import { handoverMinOrder } from '../core/handover.js'
import { setFrontmatterFields } from '../core/frontmatterEdit.js'
// M2.8：新交接自动登记进入口索引的必读清单（拆「交接 ↔ read-order」循环依赖）。
import { registerHandoverInIndexFile } from '../core/registerHandover.js'

const DESCRIPTION = [
  '在 docs/ 下新建一份带合法 frontmatter 的文档。只给 role/title/summary 就能建。',
  'id 不填则从 title 派生（中文标题派生不出合法 kebab-case 时**必须显式给 id**）。',
  'order 不填时：role=handover 取「最小 handover order − 10」（交接永远排第一），其余取当前最大 order + 10。',
  '建 role: handover 的文档时，会把旧的 authoritative 交接自动标成 superseded（supersededBy 指向新这份）。',
  '建完会自动重扫索引，并把这份文档记进本会话的已读集合（因为是你写的），所以紧接着可以 doc_mark。',
].join('')

/** 标题 → kebab-case。中文会全部被丢掉，所以派生失败时必须要求显式 id。 */
export function deriveId(title) {
  const text = typeof title === 'string' ? title : ''
  const ascii = text
    // 先把常见的分隔符变成连字符
    .replace(/[\s_/\\·—–]+/g, '-')
    // 只留 ASCII 字母数字与连字符（中文标题会在这里被清空）
    .replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
  return ascii
}

/**
 * 派生出来的 id **是否可信**（2026-11-15 M2.8，第 30 轮 `session-84b1e3ea`）。
 *
 * ---- 缺陷现场 ----
 *
 * AI 建交接时**没传 `id`**，标题是「交接：全流程测试30」。
 * `deriveId` 把中文全丢掉，只剩数字 → id = **`"30"`**。
 * 而 `ID_RE`（`^[a-z0-9]+(?:-[a-z0-9]+)*$`）**接受纯数字** → 没报错，
 * 于是 `docs/30.md` 被创建，`id: "30"` 进了索引。
 *
 * 然后 AI 发现不对，又建了第二份 `handover-1`，把 `30` 标成 `void`。
 * 代价：多一次 `doc_new` + 一次 `read` + 一次 `doc_mark` + 一次索引修正。
 *
 * ---- 为什么"纯数字 id"必须当成派生失败 ----
 *
 * 纯数字 id 有三个具体害处（都不是风格问题）：
 *
 * 1. **它一定是"从标题里捡到的数字"**，不是有意义的标识。
 *    中文标题里唯一能活下来的 ASCII 就是数字（年份、轮次、序号）。
 *    这个项目里已经出现过 `id: 1` 的坏文档（`M2.7` 的 V1 校验就是为它加的）。
 * 2. **YAML 会把 `30` 解析成数字而不是字符串**，于是按 id 查找可能匹配不上
 *    （`M2.7` 已为此给像布尔的 id 加引号，但那是补救，不如不产生）。
 * 3. **它不表达任何语义**。`handover-1` 一看就知道是什么；`30` 谁也不知道。
 *
 * ⇒ 判据：派生结果**必须含至少一个字母**。全是数字 → 视为派生失败，
 *   走 `doc_new` 里已有的那条「title 里没有能派生出 kebab-case id 的 ASCII 字符」报错。
 *
 * ⚠️ 这**不影响**显式传 `id` 的情形：`id: "30"` 仍然允许（用户/模型明确要这个 id）。
 *    只在**派生**这条路上收紧 —— 因为派生是工具的猜测，猜错就该拒绝，不该静默接受。
 *
 * @param {string} derived `deriveId` 的产物
 * @returns {boolean} 是否可以直接用
 */
export function isDerivedIdUsable(derived) {
  const text = typeof derived === 'string' ? derived : ''
  if (text === '') return false
  if (!ID_RE.test(text)) return false
  // 必须含字母：纯数字是"从中文标题里捡到的数字"，不是标识。
  return /[a-z]/.test(text)
}

/** kebab-case 校验（与 `docs/schema.js` 的 ID_RE 一致）。 */
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * 由现有条目算下一个 order。
 * @param {Array<object>} entries
 * @returns {number}
 */
export function nextOrder(entries) {
  let max = 0
  for (const entry of Array.isArray(entries) ? entries : []) {
    const order = entry?.meta?.order
    if (typeof order === 'number' && Number.isFinite(order) && order > max) max = order
  }
  // 空项目第一份给 10（不是 0）：order 0 与「没设」在渲染里不好区分。
  return max === 0 && !(Array.isArray(entries) && entries.some((entry) => entry?.meta?.order === 0))
    ? 10
    : max + 10
}

/**
 * 新建**交接**时该给的 order（M1.5 / D1 第 ① 步）。
 *
 * 交接必须排第一（设想原文：「把交接文档放到第一位」），所以取
 * **最小 handover order − 10**，而不是「最大 + 10」。
 *
 * 没有现存交接时给 **-10**（而不是 10）：让第一份交接也天生在
 * 所有 `order >= 0` 的文档之前 —— 那正是"新会话会先读到它"的意思。
 *
 * @param {Array<object>} entries 注册表条目
 * @returns {number}
 */
export function nextHandoverOrder(entries) {
  const min = handoverMinOrder(entries)
  return typeof min === 'number' ? min - 10 : -10
}

/** 用插件认得的 YAML 子集序列化 frontmatter（与 `core/frontmatterEdit.js` 同一套形态）。 */
function formatValue(value) {
  if (Array.isArray(value)) return JSON.stringify(value)
  if (typeof value === 'number') return String(value)
  const text = String(value)
  // ---- 2026-11-15 M2.7：**长得像数字/布尔/null 的字符串必须加引号** ----
  //
  // 缺陷（`session-4f229c6b`）：AI 建 `docs/1.md` 时 id 传的是字符串 `"1"`，
  // 这里不加引号写成 `id: 1`；重扫时 `parseFrontmatter` 按通用 YAML 语义
  // 把它解析成**数字** `1`，于是 `entryById("1")` 永远找不到它 ——
  // 索引块没有它、图谱没有它、`doc_new` 还报"重扫失败"。
  //
  // **完全静默**：文件在、注册表条目在，但所有按 id 的查找全失效。
  //
  // ⇒ 写盘时就把"看起来像别的类型"的字符串引起来。
  //   这比"事后在 schema 里报 error"更根本：**不要生成坏数据**。
  //   （schema 层也补了校验，两道一起：这里防生成，那里防手写。）
  //
  // 覆盖：`1` / `1.5` / `-2` / `1e3` / `true` / `false` / `null` / `~`。
  // 不做全量 JSON.stringify：那会让 `role: spec` 变成 `role: "spec"`，
  // 所有现存文档的形态都变，diff 会爆炸。
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)
    || /^(?:true|false|null|~|yes|no|on|off)$/i.test(text)) {
    return JSON.stringify(text)
  }
  return /[:#[\]{}",'\n\r\t]|^\s|\s$/.test(text) ? JSON.stringify(text) : text
}

/**
 * 由工具执行上下文推出沙箱 policy 的**模式**部分（workspace root 由调用方按目标填）。
 *
 * 为什么需要它：`dsh-fs-sandbox` 的写操作是**按每次调用**围栏的，
 * 不传 policy 就会用默认 root（= 会话建立时的 cwd），
 * 于是"切进另一个项目后 doc_new"会被误拒。实机验收时踩到过。
 *
 * @param {object} [exec]
 * @returns {{mode: string}}
 */
export function sandboxPolicyOf(exec) {
  // 会话上的模式字段名不保证稳定；拿不到就退回 workspace-write
  // （不退回 danger-full-access：那是**放宽**权限，绝不能因为读不到就默认放宽）。
  const header = exec?.agent?.session?.header
  const mode = header?.sandboxMode ?? header?.sandbox?.mode ?? exec?.sandboxMode
  if (mode === 'read-only' || mode === 'workspace-write' || mode === 'danger-full-access') return { mode }
  return { mode: 'workspace-write' }
}

/**
 * 渲染一份新文档的全文。
 *
 * @param {object} meta
 * @param {string} [body]
 * @returns {string}
 */
export function renderDocText(meta, body) {
  const order = ['id', 'title', 'role', 'order', 'status', 'summary', 'basis']
  const extra = ['scope', 'supersededBy', 'verifiedDsh', 'verifiedBundle', 'verifiedCommit', 'tokens']
  const lines = ['---']
  for (const key of [...order, ...extra]) {
    const value = meta[key]
    if (value === undefined || value === null) continue
    if (Array.isArray(value) && value.length === 0) continue
    lines.push(`${key}: ${formatValue(value)}`)
  }
  lines.push('---', '')
  const text = typeof body === 'string' && body.trim() !== ''
    ? body
    : `# ${meta.title}\n\n<!-- 这里写正文。写完用 doc_handover_check / doc_health 复查。 -->\n`
  // frontmatter 与正文之间留一个空行；正文末尾保证有且只有一个换行。
  return `${lines.join('\n')}\n${text.replace(/\s+$/, '')}\n`
}

/**
 * 把旧的交接标成 `superseded`（M1.5 / D1 第 ② 步）。
 *
 * 为什么由 `doc_new` 做，而不是让模型自己 `doc_mark`：
 * `superseded` 要求 `supersededBy`，那个值**只有这里知道**（新 id 刚生成）。
 * 让模型补一遍 = 每次交接都留一个"忘了补就 H6 报警"的坑。
 *
 * ---- 取代范围（**M1.5 端到端验证后修正**）----
 *
 * 第一版只标 `authoritative`。真实场景立刻打脸：**新建的交接默认是 `draft`**
 * （`doc_new` 的默认 status），所以"建第二份"时旧的那份也是 draft —— 一个都不标。
 * 结果：两份 draft 交接共存，H6 照报，且"新交接取代旧的"这个语义完全没发生。
 *
 * 现在的口径：**同 role 的现存交接，只要不是已经被取代/封存/作废的，都标 superseded**。
 * 排除 `superseded` / `void` / `sealed` —— 它们已经是终态，再标一次只会多一次无意义的写入。
 *
 * 失败只 warn、不抛：交接排序是**优化**，「新文档已经写好了」是**事实**，
 * 不能让优化失败去否认事实（否则模型会以为没建成，然后重复建一份）。
 *
 * @param {object} input
 * @param {object} input.reg 注册表
 * @param {object} input.fs ctx.fs
 * @param {object} input.session
 * @param {object} input.exec 工具执行快照（要 sandbox policy）
 * @param {string} input.selfId 刚建好的那份的 id
 * @param {string} [input.projectRoot] 项目根（沙箱 policy 用）
 * @param {object} [input.logger]
 * @returns {Promise<string[]>} 被标 superseded 的旧交接 id
 */
export async function supersedeOldHandovers(input) {
  const { reg, fs, session, exec, selfId, logger, projectRoot: root } = input
  void session
  const done = []

  /** 已经是终态的状态：再标一次毫无意义，只会多一次写入。 */
  const TERMINAL = new Set(['superseded', 'void', 'sealed'])

  const targets = (reg?.entries ?? []).filter((entry) => (
    entry?.meta?.role === 'handover'
    && entry.meta.id !== selfId
    && !TERMINAL.has(entry.meta.status)
  ))
  if (targets.length === 0) return done

  for (const entry of targets) {
    try {
      const original = typeof entry.text === 'string' ? entry.text : ''
      if (original === '') continue
      const edited = setFrontmatterFields(original, {
        status: 'superseded',
        supersededBy: [selfId],
      })
      if (edited.ok !== true) {
        logger?.warn?.(`[ddd] 自动 supersede ${entry.meta.id} 失败：${edited.message ?? 'frontmatter 改写失败'}`)
        continue
      }
      if (typeof fs?.writeText !== 'function' || typeof fs?.resolve !== 'function') continue

      const target = await fs.resolve(entry.path, { cwd: root })
      await fs.writeText(target, edited.text, undefined, exec?.signal, {
        ...sandboxPolicyOf(exec),
        ...(typeof root === 'string' && root !== '' ? { workspaceRoot: root } : {}),
      })
      done.push(entry.meta.id)
    } catch (error) {
      logger?.warn?.(`[ddd] 自动 supersede ${entry.meta?.id} 抛错：${error?.message ?? error}`)
    }
  }

  // ---- 反填 `supersedes`（M1.5 重验时发现的不对称，**这一条是补的**）----
  //
  // 第一版只往**旧的那份**写 `supersededBy: [新id]`，**没往新的那份写 `supersedes`**。
  // 于是 `doc_health` 的 H-1（「A.supersededBy 含 B，但 B.supersedes 不含 A」）
  // **在每一份被自动取代的交接上都会报** —— 一个正常交接的项目，H-1 会随交接次数**线性增长**。
  //
  // 实测：重验时 6 份交接 → 5 条 H-1（`live-evidence-v2.md` 有原文）。
  //
  // 这不是探针项目的问题，是**真的记账不对称**：
  // H-1 要求双向，而自动取代只写单向。
  //
  // 修法：取代完成后，把被取代的 id 列表反填进**新那份**的 `supersedes`。
  // ⚠️ 这一步在 `done` 之后做，所以**取代本身已经成功了**；反填失败只 warn，不回滚。
  if (done.length > 0 && typeof fs?.writeText === 'function' && typeof fs?.resolve === 'function') {
    try {
      const selfEntry = (reg?.entries ?? []).find((entry) => entry?.meta?.id === selfId)
      const selfPath = selfEntry?.path
      if (typeof selfPath === 'string' && selfPath !== '') {
        const selfText = typeof selfEntry.text === 'string' ? selfEntry.text : ''
        if (selfText !== '') {
          const backfilled = setFrontmatterFields(selfText, { supersedes: done })
          if (backfilled.ok === true) {
            const target = await fs.resolve(selfPath, { cwd: root })
            await fs.writeText(target, backfilled.text, undefined, exec?.signal, {
              ...sandboxPolicyOf(exec),
              ...(typeof root === 'string' && root !== '' ? { workspaceRoot: root } : {}),
            })
          }
        }
      }
    } catch (error) {
      // 反填失败不影响"取代已完成"这个事实。H-1 会继续报，那是**可见的**，不是静默的。
      logger?.warn?.(`[ddd] 反填 supersedes 失败（H-1 会继续报）：${error?.message ?? error}`)
    }
  }

  // 标完要重扫：否则注册表里那几份还是 authoritative，H6 照报。
  if (done.length > 0 && typeof reg?.rescan === 'function') {
    try {
      await reg.rescan()
    } catch (error) {
      logger?.debug?.(`[ddd] supersede 后重扫失败：${error?.message ?? error}`)
    }
  }

  return done
}

/**
 * 判断新建的**交接**是否排错了位置（M1.5 / **L34**，用户 2026-10-12 拍板**选项 c**）。
 *
 * ---- 这条为什么存在（实机抓到的真事）----
 *
 * `_m15/live-evidence.md` 的 L6 段：我显式传 `order: 999` 建了一份交接，
 * 工具照常把它**取代逻辑跑了**（把正确的 `handover-live-2` 标成 superseded），
 * 然后它自己又被 H7 判 `ok:false`。
 * **结果：交接链断在一个不合格的节点上。**
 *
 * ---- 为什么选 (c) 而不是改行为 ----
 *
 * | 选项 | 做法 | 为什么没选 |
 * |---|---|---|
 * | (a) 不改 | 接受 | 留着"静默出错"的口子 |
 * | (b) 只在新 order 更小时才取代 | 加比较 | **会挡住合法用法** —— "故意传 999 做测试"本身是合理的（我这次实机验证就是）；而且把"裁决顺序"从 H7 挪到了 doc_new，两处都管顺序反而打架 |
 * | **(c)（选定）** | 不改行为，**但说出来** | 与 N2 同一个精神：**不许静默** |
 *
 * `doc_new` 的职责是**创建**，不是**裁决顺序**（那是 H7 的活）。
 * 但它**不该假装一切正常** —— 所以这里只产生一条**给人看的警告**，不改任何落盘行为。
 *
 * @param {object} input
 * @param {number} input.order 实际写入的 order
 * @param {string} input.role 文档角色
 * @param {number|undefined} input.handoverMinOrder 建之前项目里最小的 handover order
 * @returns {string} 空串 = 没问题
 */
export function handoverOrderWarningOf(input) {
  const opts = input !== null && typeof input === 'object' ? input : {}
  const { order, role, handoverMinOrder } = opts

  // 只对交接有意义：非交接的 order 是"阅读顺序"，不存在"必须排第一"的语义。
  if (role !== 'handover') return ''
  if (typeof order !== 'number' || !Number.isFinite(order)) return ''

  // 建**第一份**交接时（没有现存交接）不可能排错：它天然是最小的。
  if (typeof handoverMinOrder !== 'number' || !Number.isFinite(handoverMinOrder)) return ''

  // 正常路径：`doc_new` 自己算的 order 一定 = min - 10，必然小于 min。
  // 只有**显式传了 order** 且它 >= 现存最小值时，才会走到这里。
  if (order < handoverMinOrder) return ''

  return `⚠️ 这份交接的 order 是 ${order}，而项目里已有一份 order ${handoverMinOrder} 的交接。`
    + `**它不是最小的**，所以 \`doc_handover_check\` 会用 H7 判它不合格。`
    + '（如果这是你要的，忽略这条；如果你想让交接排第一，别传 order，让 doc_new 自己算「最小 - 10」。）'
}

/**
 * 交接「没能自动登记」时，附在提示后面的**分流说明**（M2.9 新增）。
 *
 * ---- 缺陷现场（第 32 轮 `session-1fe6505f` seq 74）----
 *
 * AI 先在 `read-order` 里手写了一条 `handover-1`，再建交接。工具看到那个 id
 * 已经在清单里，按设计**不覆盖模型写的措辞**，于是返回：
 *
 * ```
 * ⚠️ 没能把本份交接自动登记进入口索引（必读清单里已经有 `handover-1`，不覆盖模型写的措辞）。
 * **你需要在交接里如实说明**，或者自己 `edit` 索引补一行 —— 别写"已登记"。
 * ```
 *
 * **第二句是错的。** 索引里那条已经在，不需要再补一行。
 * 但 AI 看到的字面意思是"没登记上"，它会去 `edit` 补 —— 要么写重复，要么怀疑自己。
 *
 * ---- 为什么必须分流 ----
 *
 * `indexRegistrationReason` 有两种**性质完全不同**的形态：
 *
 *   · **「已经有」** —— 成功了，只是工具没动手（模型先写了）。**不需要任何补救。**
 *   · **真失败** —— 没登记上（没有 index 文档 / 没有「必读清单」小节 / 写盘失败）。
 *     **这时才**需要模型自己补。
 *
 * 旧文案把两者混成一句，于是"成功"被报成"失败"。这属于**回执与事实不符**，
 * 和 M2.8 第 30 轮修的 `doc_mark` 回执矛盾是同一类缺陷。
 *
 * ---- 顺带补上 `order` 的对账（同一个现场的第二处摩擦）----
 *
 * 第 32 轮 AI 手写清单时把交接的 `order` 猜成 `0`，而 `doc_new` 实际给的是 `-10`。
 * 根因是**顺序死锁**：手册要求"先改 read-order 再建交接"，但清单要写交接的 `order`，
 * 而 `order` 要建完才知道。用户拍板方案 A（`doc_new` 支持显式传 `order`）——
 * 那个能力**早就有**（见下面 `typeof args?.order === 'number'`），缺的只是**有人告诉它**。
 * 所以这里点明：要么别写数字，要么建之前就显式传 `order`。
 *
 * @param {string} reason `registerHandoverInIndexFile` 返回的原因
 * @param {number} [order] 本份交接的实际 order（用于对账提示）
 * @returns {string} 要插在提示里的一段话（可能为空）
 */
export function handoverIndexHintOf(reason, order) {
  const text = typeof reason === 'string' ? reason : ''
  const orderText = typeof order === 'number' && Number.isFinite(order) ? `\`${order}\`` : '上面的值'
  // 「已经有」的措辞来自 `core/registerHandover.js` 的唯一那条分支。
  if (/必读清单里已经有/.test(text)) {
    return '⚠️ 这**不是失败**：清单里已经有这一条了（你手写的），工具只是不去覆盖你的措辞。'
      + '**不需要再 `edit` 补一行** —— 补了会出现两条讲同一份交接的条目。'
      + `⚠️ 但请确认你手写那行的 \`order\` 与工具返回的 \`order\` 一致（本份是 ${orderText}）；`
      + '不一致就把它改成这个值 —— `order` 猜错是**顺序死锁**：清单要写交接的 order，'
      + '而 order 建完才知道。下次要么别写数字（只写 `id` 和理由），'
      + '要么在 `doc_new` 时就显式传 `order`（它支持，传了就一定一致）。'
  }
  return ''
}

/**
 * 建工具。
 * @param {object} deps
 * @param {object} deps.config
 * @param {(session: object|undefined) => object|undefined} deps.registry
 * @param {object} deps.fs `ctx.fs`
 * @param {(session: object|undefined) => string} deps.projectRoot 当前会话的项目根（同步）
 * @param {(session: object|undefined) => string} deps.cwdOf
 * @param {object} [deps.logger]
 * @returns {object}
 */
export function createNewTool(deps) {
  const { registry, fs, projectRoot, cwdOf, logger } = deps

  return defineTool({
    name: 'doc_new',
    description: DESCRIPTION,
    parameters: {
      role: {
        type: 'string',
        required: true,
        enum: [...ROLES],
        description: '文档角色。handover 是交接文档，spec 是施工图，decision 是决策台账。',
      },
      title: { type: 'string', required: true, description: '标题（会成为文档的一级标题）。' },
      summary: { type: 'string', required: true, description: '一句话摘要，≤80 字，索引块里显示它。' },
      id: { type: 'string', description: '文档 id（kebab-case，永不变）。不填则从 title 派生；派生不出合法 id 时会报错。' },
      order: {
        type: 'number',
        description: '阅读顺序。不填时：role=handover 取「最小 handover order − 10」（交接永远排第一），'
          + '其余 role 取当前最大 order + 10。',
      },
      status: { type: 'string', enum: [...STATUSES], description: '默认 draft。' },
      basis: { type: 'string', enum: [...BASES], description: '默认 未验证。' },
      scope: { type: 'array', items: { type: 'string' }, description: 'status 为 partial 时必填：适用切片。' },
      body: { type: 'string', description: '正文初始内容（含一级标题）。不填则生成占位正文。' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string', required: true },
          path: { type: 'string', required: true },
          order: { type: 'number', required: true },
          status: { type: 'string', required: true },
          // M2.3 演练 D2：render 需要知道 role 才能给交接补"修订请新建"的说明。
          role: { type: 'string', required: true },
          indexed: { type: 'boolean', required: true },
          recorded: { type: 'boolean', required: true },
          supersededOld: {
            type: 'array',
            required: true,
            items: { type: 'string' },
          },
          orderWarning: { type: 'string', required: true },
          // ---- 2026-11-15 M2.8：交接自动登记进入口索引（拆循环依赖）----
          //
          // ⚠️ **必须在 schema 里声明**：M2.6 踩过这个坑（`session-f36fd404`）——
          // 返回值里多一个 schema 没声明的键，宿主直接判 `additionalProperties: false`
          // 拒绝**整个工具调用**，那一轮交接回合从 8 657 字符打回 25 038。
          indexRegistered: { type: 'boolean', required: true },
          indexRegistrationReason: { type: 'string', required: true },
          // ---- M2.8 第 27 轮：把"清单条数变了"告诉模型 ----
          //
          // ⚠️ 必须在 schema 里声明。宿主是 `additionalProperties: false`，
          // 返回值里多一个没声明的键 → **整个工具调用被拒**（M2.6 的教训：
          // 那一轮交接回合从 8 657 字符打到 25 038）。
          indexCountBefore: { type: 'number', required: true },
          indexCountAfter: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已创建 \`${value.path}\`（id: \`${value.id}\`，order: ${value.order}，status: ${value.status}）。\n`
          + (value.indexed
            ? '索引已刷新，它现在就出现在索引块里。'
            : '⚠️ 文件已写入，但重扫失败（索引可能还没收录它）。稍后重试或调用 doc_health 检查。')
          + (value.recorded
            // ---- 2026-11-14 M2.5：这句话曾经**明确误导**（摩擦台账 F3）----
            //
            // 原文是「已记入本会话的已读集合，可以直接 doc_mark。」
            // 但实测（session-10f26ffe seq 222/225）紧接着 `doc_mark` 就被拒：
            //
            //   Error: `handover-002` 你读过的是旧版（vae1cb0），磁盘已是 vc9a19a。
            //
            // 原因：`doc_new` 之后如果还有别的工具动过这份文件（比如
            // `doc_handover_check` 触发的 supersedes 回填），指纹就变了，
            // 那条"已读"立刻失效。AI 当时**猜了三个原因才猜对**。
            //
            // 所以不能承诺"可以直接"，只能如实说"记了，但可能已经过期"。
            ? '已记入本会话的已读集合。'
              + '⚠️ 但若随后有其他工具改动过这份文件（索引重扫、交接回填等），'
              + '它的已读会失效 —— `doc_mark` 之前若被要求重读，那不是 bug。'
            : '⚠️ 没能记入本会话的已读集合 —— 紧接着 doc_mark 会要求你先 read 一次它。')
          + (value.supersededOld.length > 0
            ? `\n已把旧的交接自动标为 superseded：${value.supersededOld.join('、')}`
              + '（它们的 supersededBy 都指向这份）。'
            : '')
          // ---- 2026-11-15 M2.8：**这一次不再需要你纠结"先登记还是先建交接"** ----
          //
          // 拆掉「交接 ↔ read-order」的循环依赖。第 24 轮 AI 为此在 turn 3 的
          // 第一步烧掉 10 879 字符纯推演（自我否决 6 个方案）；
          // 第 25 轮它把这条列为"第二难"，并自认「我选了最糟的中间方案」。
          //
          // ⇒ 现在 `doc_new` 建交接时就**顺手把它登记进必读清单**了。
          //   所以交接正文里可以放心写「索引已登记本份交接」—— **那一刻就是真的**。
          //
          // ⚠️ 措辞必须说清"登记了/没登记"，否则模型还是会去猜。
          //
          // ---- 2026-11-15 M2.8（第 27 轮 `session-6bd267f1` 反馈 P0 第一条）----
          //
          // 原来的回执只说「不用你再改 read-order 加自己」。那句字面是真的，
          // 但**漏了最重要的副作用**：AI 几分钟前手写的清单是 3 条，现在变 4 条。
          // 而它交接正文 §2 写的正是「必读清单（3 条）」—— **写下那一刻就是假的**。
          //
          // AI 的原话（值得逐字读）：
          // > 这不是「把没做的事写成做了」，那种错还能自查；
          // > 这是**你核对过的状态在核对之后被工具改掉了**，
          // > 而手册的顺序规则里没有这一步的位置。
          //
          // ⇒ 工具既然改了别人的文件，就有义务说清**改成了什么**。
          //   带上条数变化，模型才知道要回去改哪一句。
          + (value.role === 'handover'
            ? (value.indexRegistered
              ? '\n✅ **入口索引的必读清单已自动登记本份交接**（不用你再改 `read-order` 加自己）。'
                + '所以交接里写「索引已登记」这一刻是真的。'
                + (typeof value.indexCountBefore === 'number' && typeof value.indexCountAfter === 'number'
                  && value.indexCountAfter !== value.indexCountBefore
                  ? `\n⚠️ **但它刚刚改了你已经定稿的索引**：必读清单从 `
                    + `${value.indexCountBefore} 条变成了 ${value.indexCountAfter} 条（多了本份交接）。`
                    + '\n   ⇒ 如果你在交接正文或索引里写过"必读清单 N 条"这类**计数**，现在就是过期的。'
                    + '\n   改它要**整份重读**（`edit` 会让已读失效），所以：**宁可写状态、别写计数**。'
                  : '')
                + '你仍要手写更新的是索引的**其它小节**（下一步 / 陷阱 / 依据文档）。'
                // ---- 2026-11-15 M2.8（第 29 轮 `session-dd0e36b5` 反馈）----
                //
                // 缺陷现场：AI 在**建交接之前**手写 read-order 时，很自然地写了一条
                // 泛指条目占位：
                //
                //   3. 最新交接（`role: handover`，order 最小）—— 想知道"上一轮做到哪"就读它…
                //
                // 然后 `doc_new` 自动插入了具体的 `handover-1`。于是清单里**两条都在讲交接**
                // —— 一条泛指、一条具体，内容重叠。AI 只好再读一遍 + 再改一遍。
                //
                // AI 的原话：
                // > 这条铁律在这个点上自相矛盾：建交接本身就是对索引的写入，
                // > 所以「落笔前索引已定稿」永远不可能成立。
                //
                // ⇒ 光说"会自动登记"不够 —— 必须**明确告诉它别自己写这一条**。
                //   这是"事前一句话"能省掉"事后一轮重读+编辑"的典型。
                + '\n⚠️ **手写 `## 必读清单` 时，别给交接留位置**：'
                + '不要写「最新交接（role: handover）」这种泛指条目 —— '
                + '本份交接已经由工具插进去了，你再写一条会变成**两条讲交接的条目**（一条泛指、一条具体），'
                + '下一位读者会以为有两份交接。'
                // ---- 2026-11-15 M2.8（第 30 轮 `session-84b1e3ea` 反馈）----
                //
                // 上面这句被**误解过**。第 30 轮 AI 把它读成"清单里根本不要出现交接"，
                // 于是它 `edit` 时把工具自动登记的那一行 `handover-1` **一起删掉了**，
                // 改成一句「交接由工具自动登记在清单第一条」。
                //
                // 结果：`doc_health` 的 **H-3** 如实报
                // 「`handover-1` 是 authoritative，但没有任何 role: index 的文档提到它」。
                // AI 只好再读一遍 read-order、再改一遍 —— 而它以为自己是在遵守我的指示。
                //
                // AI 的原话：
                // > 工具说「必读清单已自动登记本份交接（不用你再改 read-order 加自己）」，
                // > 然后 doc_health H-3 说「没有任何 role: index 的文档提到它」。
                // > 所以自动登记 apparently 不算 "mention"。工具承诺和健康检查不一致。
                // > 这花了我 2 次调用。
                //
                // ⇒ **不是**工具不一致，是这句提示有歧义。必须说清两件事：
                //   ① 别写**泛指**条目（那会重复）；
                //   ② 但工具插的**那一条具体条目**（带本份 id 的那行）**要留着**，别删。
                + '\n⚠️ **但工具插的那一条具体条目（带本份 id 的那行）必须留着** —— '
                + '它不重复，而且 `doc_health` 的 H-3 靠它判断"这份权威交接有没有人提到"。'
                + '你把它删掉换成一句"交接由工具自动登记"，H-3 立刻会报「没有任何 index 文档提到它」。'
              : `\n⚠️ 没能把本份交接自动登记进入口索引（${value.indexRegistrationReason}）。`
                // ---- 2026-11-16 M2.9：**"已经有"不是失败，不能再说"你自己补一行"** ----
                //
                // 这句原来无条件收尾：
                //   > **你需要在交接里如实说明**，或者自己 `edit` 索引补一行 —— 别写"已登记"。
                //
                // 但在**「清单里已经有」**这条分支上，索引里那条**已经在**了。
                // 再让它去补 = 要么写重复、要么怀疑自己（第 32 轮 `session-1fe6505f` seq 74 现场）。
                //
                // ⇒ 分流：`handoverIndexHintOf` 处理"已经有"（并给出 order 对账），
                //   只有**真失败**才保留那句"你自己补"。
                + handoverIndexHintOf(value.indexRegistrationReason, value.order)
                + (handoverIndexHintOf(value.indexRegistrationReason, value.order) === ''
                  ? '**你需要在交接里如实说明**，或者自己 `edit` 索引补一行 —— 别写"已登记"。'
                  : ''))
            : '')
          // ---- 2026-11-16 M2.9：**`order` 顺序死锁的出路**（用户拍板方案 A）----
          //
          // ⚠️ **位置很重要**：这一段原来被我放在 `indexRegistered === true` 的分支**里面**，
          //    而第 32 轮（`session-1fe6505f`）恰恰是**没登记成功**那条分支 ——
          //    于是最关键的一句在真实现场**根本不会显示**。
          //    是我自己写的测试（`test/m29-order-deadlock.test.js`）把它抓出来的。
          //
          // 所以它现在在**分叉之外**：无论自动登记成功与否，AI 都需要知道这件事。
          //
          // ---- 它要解决什么 ----
          //
          // 现场：AI 严格照技能手册的顺序（先改 `read-order` 再建交接），
          // 在清单里给交接写了 `order 0` —— 而 `doc_new` 实际给的是 `-10`
          // （第一份交接 = 最小 handover order − 10 = `-10`）。
          // 建完发现对不上 → 重读整份 `read-order`（`edit` 已让它失效）→ 再 `edit` 一次。
          // 那份 `read-order` 里还留下了自相矛盾的痕迹：
          // 第 28 行写 `order -10`，第 46 行仍写着"交接固定排最前（order 0）"。
          //
          // ---- 根因不是"它粗心"，是**顺序死锁** ----
          //
          // ```
          // 手册要求：先改 read-order（这样交接里那句"索引已更新"才是真的）
          // 清单要求：写交接的 order
          // 而 order：只有 doc_new 建完才知道
          // ```
          //
          // 三条要求不可能同时满足。这和 M2.8 修掉的「交接 ↔ 索引循环依赖」是**同一个形状**，
          // 只是那次修的是"条目存在与否"，这次是"条目里的数字"。
          //
          // ---- 出路（用户拍板 A：`doc_new` 支持显式传 order）----
          //
          // 那个能力**早就有**（执行体里 `typeof args?.order === 'number'` 那条），
          // 缺的只是**没有任何地方告诉 AI 它能用**。所以这一批改的全是文案，不是加判据。
          //
          // ⚠️ 只对交接说：非交接的 order 是"阅读顺序"，不存在"必须先知道"的问题。
          + (value.role === 'handover'
            ? '\n💡 **关于交接的 `order`（省你一次返工）**：它是"**建完才知道**"的'
              + '（第一份交接是 `-10`，之后是"现存最小 − 10"）。所以手写 `read-order` 的必读清单时，'
              + '两种写法都不会返工：'
              + '① **只写 `id` 和理由，不写数字** —— 最省事；'
              + '② 或者建交接时**显式传 `order`**（`doc_new` 支持），这样你写下的数字与它一定一致。'
              + '**别凭感觉填 `0`** —— 那是第 32 轮为此重读 + 重改一次的原因。'
            : '')
          // ---- M2.3 演练复盘 D2：把"交接是一次性文档"说清 ----
          //
          // 2026-11-14 实机演练（session-10f26ffe）：AI 校验被拒后**又建了一份**，
          // 而不是改原来那份 —— 用户的原话是「ai 不知道写交接文档要新建而不是改原来的，
          // 这会增加多余摩擦」。
          //
          // 核实后确认**AI 的做法是对的**（新建即替代是已实现的行为），
          // 错在**我们没告诉它**。真实数据：那次演练留下了 handover-001(superseded)
          // + handover-002(authoritative) 两份，这是正确结局，但 AI 是"猜"对的。
          //
          // ---- 2026-11-14 M2.6 修正（第二次）：**交接任何状态都可以 edit** ----
          //
          // 演进：原实现 write/edit 全拒 → 我第一版只放开 draft →
          // 用户第二次拍板彻底放开（理由见 `core/roles.js` 的 `handover` 那条）。
          //
          // 实测（`session-47f59223`）第一版**不够**：AI 在"还有东西要改"时就把交接
          // 标成了 authoritative，随后发现 read-order 的哈希过时了 —— 锁死，
          // 于是产生 33 000 字的往返思考（原话：「改不了……要不要建新的？太重了」）。
          //
          // ⇒ 现在文案直接说"可以改，别重写"。
          //
          // ---- 2026-11-14 M2.6（第三轮）：**别把还没做的事写成已做** ----
          //
          // AI 自述（`session-916967d2`，用户让它总结难点）：
          //
          // > `doc_new` 建交接的那一刻，我在正文里已经写了「`read-order` 的必读清单
          // > 与「下一步」已按这两份更新」——**但那时我还没改 `read-order`**。
          // > 我在陈述一个尚未发生的状态，然后把"改阅读顺序"当成交接之后的收尾动作。
          // > 这中间有个真实的窗口：如果会话在那个点断掉，下一位看到的是一份
          // > 声称索引已更新、实际没更新的交接。**七段结构全合规、健康度全过，
          // > 但有一句话在说假话** —— 校验器查不出来，只有我自己知道。
          //
          // 实测确认：`doc_new` 在 seq 97，`read-order` 到 seq 124 才改 ——
          // **中间 27 步里那份交接都在说假话**。
          //
          // ⇒ 这是**校验器查不出来**的一类问题：H1–H7 只查结构（七段齐不齐、
          //   证据有没有"形状"），**不查内容真实性**（它无法知道 read-order 改没改）。
          //   所以只能**事前提醒**，而且必须放在建交接时（而不是事后检查）。
          //
          // ⚠️ 措辞要点：不能说"写完再检查"（检查不出来），要说"**先做，再写**"。
          //
          // ================================================================
          // ---- 2026-11-15 M2.7：交接流程的**总纲**（用户拍板）----
          //
          // 用户原话：
          // > 我想了一下交接流程，它应该是这样的，只有 3 步：
          // >   1. 写交接文档
          // >   2. 给文档标置信度
          // >   3. 重排阅读顺序
          // > 交接文档本身的结构必须要保证或近似，但我认为它**可以只是提示词层面的
          // > 东西**，不必完全一致。
          //
          // ⇒ 所以：
          //   · 下面这段**总纲**是唯一的"流程定义"，三件事说清就够；
          //   · 其余七段结构、§3 具体路径、§5 证据、不要放代码块……全部作为
          //     **建议**列在后面，不再是校验项；
          //   · `doc_mark` 标绿时的 H1–H7 硬门禁**已删除**（同一天，同一个决定）。
          //
          // 为什么放在最前面：之前 7 段交接提示散落在返回值各处、没有总纲，
          // 实测（第 20/21 轮）AI 要靠自己拼出顺序，拼错就多花 6~10 步。
          // **先给顺序，再给细节** —— 这是注入层该有的形状（架构分析 §5 第 ① 层）。
          + (value.role === 'handover'
            ? '\n## 交接只有三步（顺序不能乱）\n'
              + '**⓪ 前置**：先把**所有要引用的东西**定稿 —— 要登记进 `read-order` 的、'
              + '要标置信度的、`basis` 要改的，**全部做完**，再动这份交接。'
              + '否则你写的每句"已完成 X"都会在下一步变成假话，而且改它又要整份重读。\n'
              // 2026-11-15 M2.8（第 29 轮）：这条"前置"和"自动登记"是冲突的，
              // 必须在这里说清怎么共存 —— 见下面那段。
              + '⚠️ **但"⓪ 前置"有一条例外**：你手写 `read-order` 的 `## 必读清单` 时，'
              + '**不要**给交接留位置（别写「最新交接（role: handover）」这种泛指条目）。'
              + '本份交接会由工具自动插进清单第一条 —— 你手写一条、工具再插一条，'
              + '清单里就会出现两条讲交接的条目，下一位读者会以为有两份交接。\n'
              + '1. **写交接文档**（正文按下面建议的结构写；每句"已完成 X"都必须此刻为真）；\n'
              + '2. **给文档标置信度**（`doc_mark` 改 `status` 与 `basis`）；\n'
              + '3. **重排阅读顺序**（改各文档 `order` + 手写入口索引正文）。\n'
              // ---- 2026-11-16 M2.9：**这句原来是反的，已实测证伪** ----
              //
              // 原文（从 M2.7 起一直这么说）：
              //   > ⚠️ 第 3 步在第 2 步**之后**：标完置信度再动 `read-order`，
              //   > 否则标绿那一刻引用的内容已经过时（H-6 会报）。
              //
              // **实测证明它是错的**（`_m28/probe-order-conflict.mjs`，真 `apply()` 装配）：
              //
              //   顺序 A（先改 read-order → 写交接 → 标绿）：H-6 = **0 条**
              //   顺序 B（写交接 → 标绿 → 再改 read-order）：H-6 = **1 条**
              //     · `handover-1` 标成 authoritative 之后，这些文档改过：
              //       `read-order`：标绿时 9537a6，现在 ce3576
              //
              // 原因很直白：**H-6 的定义就是"标绿之后改过的文档"**。
              // 所以"标绿之后再改 read-order"**必然**触发它 —— 原句把因果说反了。
              //
              // 而且它与本段**自己上面那句**（⓪ 前置：先把要引用的东西全定稿）
              // 以及 `ddd-workflow` 手册 §4.1.1 的顺序**直接矛盾**。
              // 第 34 轮 `session-c93b9e05` 的 AI 把这条列为"两条指导互相打架，
              // 我只能自己裁决"——它是对的。
              //
              // ⇒ 改成正向的、与 ⓪ 一致的说法。
              + '⚠️ 第 3 步在第 2 步**之前**：`read-order` 的正文与 `order` 要在**标绿之前**定稿。'
              + '因为 H-6 的定义就是「标绿之后改过的文档」—— 标绿后再动索引**必然**报它。'
              + '（这和上面的 ⓪ 前置是同一条规矩，不是两条。）\n'
              + '⚠️ 这三步都**不校验**（结构只是建议）。但漏了第 3 步，'
              + '下个会话会照着过时的索引去读。'
            : '')
          + (value.role === 'handover'
            ? '\n⚠️ **别把还没做的事写成已做**：交接正文里每一句"已完成 X"，'
              + '都必须是**此刻真的已完成**。典型错误是先 `doc_new` 建交接、'
              + '之后才去改 `read-order` —— 那么交接里「阅读顺序已更新」这句就是假的，'
              + '而 **H1–H7 查不出来**（它只查结构，不查真实性）。'
              + '**先把要引用的东西全做完，再落笔写交接。**'
            : '')
          + (value.role === 'handover'
            ? '\n**交接可以直接 `edit`**（任何状态都行，包括已标 authoritative）：'
              + '校验没过就**原地改**，不要为了改一行重写一整份新的。'
              + '新建才需要 `doc_new`（它会自动把旧的标 superseded 并链到新版）。'
            : '')
          // ---- 2026-11-15 M2.8（用户拍板）：**删掉"先打草稿"那段** ----
          //
          // 原文：「**别在 `docs/` 里反复重写交接**：先把正文写到
          //       `_artifacts/handover-draft.md`（那里门禁不拦、不进索引、不算交接），
          //       自查七段齐全、§3 有具体路径、§5 每条都有证据之后，再 `doc_new` 一次定稿。」
          //
          // 它是 M2.6 时代（`2026-11-14`）的对策：那时 `edit` 交接还被锁死
          //（`roles.js` 是 `handover: { write: DENY, edit: DENY }`），
          // 改一个错就得整份重写 —— 所以先在外面写、自查、再 `doc_new` 一次定稿。
          //
          // **那个前提在 M2.6 同一轮就被推翻了**（用户第二次拍板「彻底允许任意 edit 交接」），
          // 但这段提示留了下来 —— 于是它变成一条**为了绕开不存在的限制**而存在的建议。
          //
          // 实测（第 24 轮 `session-5b5f5c68`）：
          //   · seq 61 AI 明确计划「Let me draft in `_artifacts/handover-draft.md` first」；
          //   · **全会话 `_artifacts` 写入 0 次**（我逐条扫过 tool/call 的 file_path）；
          //   · 它事后自述「交接草稿直接一次成稿，没有反复重建」。
          //   ⇒ 这条提示**没有产生任何草稿，只产生了一次犹豫**。
          //
          // 真正防返工的是**下面那段顺序纪律**（先把引用定稿，再建交接），
          // 不是"在哪写正文"。所以这里只保留顺序纪律，删掉打草稿。
          //
          // ⚠️ 保留的边界：`_artifacts/` 门禁不拦这个**事实**仍然有用
          //（写长文档时可以借用），但它是通用技巧，不该写成交接的必经步骤 ——
          // 那件事已经在 `ddd-workflow` skill 的 §4.1 里说明。
          //
          // ---- ⚠️ 我第一版把整段删了，被测试抓住（这是真回归）----
          //
          // `test/tools.test.js` 的「结构引导仍然在 `doc_new` 的提示里」断言
          // 渲染结果里必须有 `七段|七|段` —— 而**那段里唯一提到"七段"的地方
          // 就是"自查七段齐全"**。整段删掉 = 把结构清单也一起丢了，
          // 那正是那条测试注释里写的"为了省步数把要求也一起丢了"。
          //
          // ⇒ 所以这里**不删清单，只把"先打草稿"换成"直接写全"**：
          //   保留「七段齐全 / §3 有具体路径 / §5 每条有证据」这三个自查点，
          //   它们是交接质量的实质内容，与"在哪写正文"无关。
          + (value.role === 'handover'
            ? '\n**一次写全，别在 `docs/` 里反复重写交接**：落笔前先自查'
              + '**七段齐全**、§3 有具体路径、§5 每条都有证据，然后 `doc_new` 一次定稿。'
              + '写错了**原地 `edit`**（任何状态都能改），不要重写整份新的。'
            : '')
          // ---- 2026-11-14 M2.6：交接**必须同时改阅读顺序** ----
          //
          // 实测（同一会话 turn 9 → turn 10）：AI 建完交接、归档旧交接、跑完 doc_health，
          // **始终没碰 `read-order`**。用户不得不提醒：「你大概忘了做一件事，
          // 你还得把阅读顺序修改了」。
          //
          // ---- ⚠️ 2026-11-14 用户指出的修正：**不只是改 order** ----
          //
          // 我第一版把「改阅读顺序」简化成了「改 order」，**那只说对了一半**。
          // 核实后「阅读顺序」其实是**两份东西**：
          //
          //   | 载体 | 谁在读 | 怎么维护 |
          //   |---|---|---|
          //   | 各文档 frontmatter 的 `order` | **机器**（`core/index.js` 的 `byOrderThenId` 升序） | `edit` 改那一行 |
          //   | `role: index` 文档的**正文** | **人和 AI**（`## 必读清单` / `## 下一步` / `## 陷阱` / `## 依据文档`） | **手写维护** |
          //
          // 只改 `order` 的话：索引块和看板排序会变，但入口索引正文里那张
          // 「先读谁、哪些已作废、有什么坑」的地图**会和实际不符** ——
          // 而那张地图正是新会话真正照着读的东西。
          //
          // 反过来说，演练项目里 AI 最终写出来的 `read-order.md` 正文
          // 正是这个形状（必读清单按 order 排列、逐条写"为什么读它"、
          // 单独列出已作废的、再加下一步/陷阱/依据文档）——**那是手写的，不是生成的**。
          //
          // ⇒ 所以这里必须把两件事都点名，否则就是教一半。
          //   索引块的【怎么做】行（每轮都有）同样只说了一半，已一并修。
          + (value.role === 'handover'
            ? '\n**交接还没做完 —— 阅读顺序要改两处**：\n'
              + '  1. **`order` 值**（机器读）：把本轮被推后的文档 `order` 调大，'
              + '交接本身排第一（`edit` frontmatter 的 `order:` 那一行）；\n'
              + '  2. **入口索引正文**（人和 AI 读）：更新 `role: index` 那份文档里的 '
              + '`## 必读清单`（按 order 排、写清为什么读它）、`## 下一步`、'
              + '`## 陷阱`、`## 依据文档` —— 只改 order 不改正文，地图就和实际对不上。\n'
              + '改完用 `doc_health` 复检。'
            : '')
          // ---- 2026-11-16 M2.9：**删掉「§5 不要放代码块」这条过时提示** ----
          //
          // ---- 它当年为什么存在（2026-11-14 M2.5）----
          //
          // 摩擦台账 F6：H4 判据把 §5 里的列表项与表格行都算作"验收条目"，
          // 而代码块内的表格行**也会被算进去** —— 于是贴一段样例就变成 7 条、其中 4 条
          // "没有证据形式"。实测（`session-c03fc8c8` seq 248）AI 为了通过 H4，
          // **去读插件源码逆向那个正则**。
          //
          // 当时的处置是"写前告知"（不改判据），理由记在这里：
          //   > 改判据会让交接文档变成"代码仓库"，降低可读性。
          //
          // ---- 它为什么现在必须删 ----
          //
          // **那个前置事实已经不成立了。** M2.8 用户拍板决策 #8 修了 `checkAcceptanceEvidence`：
          // 它现在会跟踪围栏状态，**代码块内部的行一律不算验收条目**
          // （`core/handover.js`，`if (inFence) continue`）。
          //
          // 于是这条提示变成了**教人迁就一个已经不存在的缺陷** ——
          // 而且它与 `ddd-workflow` 技能手册**直接矛盾**：
          // 手册 §4.3 明确写着「✅ **§5 可以放代码块了**（2026-11-16 起）。
          // 解析器现在会跳过围栏内的行」。
          //
          // ---- 现场（第 33 轮 `session-4473f62b`，AI 自己报的）----
          //
          // 它被要求"说说哪些步骤难"，原文：
          // > skill 手册说 §5 CAN have code blocks now (2026-11-16 change),
          // > but the doc_new response said 「§5「验收」里不要放代码块」.
          // > **That's a direct contradiction between skill manual and tool feedback.**
          //
          // 它把这条列为**拖累最大的一项**：不是 token 成本，是
          // "两个权威同时说话、我该信哪个"的判断成本。
          //
          // ⇒ 删掉。**提示与判据必须同源**：判据已修，提示就不能留着旧结论。
          //   （这正是 M2.8 反复吃的亏：修一处不等于修一类。）
          //
          // ⚠️ 不要把它改成"§5 可以放代码块"的**正向**提示 ——
          //   那等于为一件本来就该正常的事再花一行 token。默认行为不需要广播。
          // ---- 2026-11-14 M2.6（第三轮）：**`basis` 默认是「未验证」** ----
          //
          // AI 自述（`session-916967d2`）：
          //
          // > 我先 `doc_mark` 标了 `authoritative`，才跑 `doc_health`，然后被 H-5 告知
          // > "标了权威却 `basis: 未验证`"。这两份文档的 `basis` 在 `doc_new` 时是默认值，
          // > 我在建的时候完全没想它 —— 因为它**不是七段之一**，也不影响 H1–H7。
          // > 结果就是：定稿 → 复检 → 回头改 `basis` → 两份文档指纹变了、又变回未读。
          //
          // ⇒ 这是"校验器能兜住、但代价是返工"的典型。
          //   在**建的那一刻**提醒一句，成本是 0；等 H-5 提醒，成本是两次重读 + 两次 edit。
          //
          // ⚠️ 不只对交接生效 —— 任何 role 都可能被标成 authoritative，
          //   而 H-5 的判据是「authoritative 但 basis 未验证」，与 role 无关。
          + '\n**`basis` 默认是「未验证」**：如果你打算把它标成 `authoritative`，'
            + '现在就一起写对（`实测` / `推断`）—— 等 `doc_health` 的 H-5 来提醒时，'
            + '你已经在标绿后改过一轮，指纹会变、还要重读。'
          // ================================================================
          // ---- 2026-11-15 M2.7（#3）：**顺序纪律 —— 先定稿，最后才写交接** ----
          //
          // 依据（**三轮不同的模型独立得出同一个结论**，这是本项目最强的信号之一）：
          //
          //   `session-c2555c7b`（第 20 轮）AI 自述：
          //   > 最难：交接文档和「它引用的东西」是循环依赖。
          //   > 交接正文要写「入口索引已登记本份交接」，但入口索引要登记的那份文档
          //   > 就是正在写的这份交接 —— 它还不存在。
          //
          //   `session-b1c9883d`（第 21 轮）AI 自述：
          //   > 如果重来一次，我会把顺序改成：先把索引、`basis`、所有要引用的东西
          //   > 全部定稿 → 跑 `doc_health` 确认干净 → **最后**一次性建交接并标绿，
          //   > 中途一个字都不改。这样上面三条全部不会发生。
          //
          //   `交接-M2.7.md` §4（M2.6 记的）也是同一条：
          //   > 把取证据当成了收尾动作，但它其实是**最后一个**动作。
          //
          // ⇒ 三次独立观察指向同一件事：**AI 把"建交接"当成了开始，而它必须是结束。**
          //
          // 为什么这句话放这里而不是索引块：pinned 预算只剩 14 字符（见 `core/render.js`
          // 的注释），加不进【门禁】行。而这里**恰好是对的时机** ——
          // 建交接那一刻正是顺序已经走错的时刻，此时说才有用。
          //
          // 它是**引导**，不是判据（架构分析 §5 第 ① 层）：不拦任何操作，
          // 只把"正确的顺序"在正确的时刻说出来。
          + (value.role === 'handover'
            ? '\n**建交接应该是最后一步，不是第一步**。常见错序与代价：\n'
              + '  · 先建交接 → 再改 `read-order`（把本份登记进必读）→ 交接正文里那句'
              + '「已登记」才成立 → 回头改交接 → **指纹失效、整份重读**；\n'
              + '  · 顺序应当是：**所有内容文档定稿（含 `read-order` 正文与 `order`）'
              + '→ `doc_health` 归零 → 再建交接 → 最后 `doc_mark` 标绿**。\n'
              + '  · 标绿之后再动任何被它引用的文档，会触发 H-6（"标绿后这些文档改过"）。'
            : '')
          // ================================================================
          // ---- 2026-11-15 M2.7（#2）：**别把计数写进 §5 证据** ----
          //
          // 依据（`session-b1c9883d` 第 21 轮，AI 自己指出的机制）：
          //
          //   > 为了让 §2 那句「必读清单登记了三份文档」不成为假话，我必须**先**把
          //   > `handover-1` 登记进 `read-order` 的必读清单，**再**写交接。
          //   > 但这一步直接把 `doc_health` 的输出从「4 份受管文档，**1 份必读**」
          //   > 变成了「4 份受管文档，**2 份必读**」。
          //   > 我写进 §5 的计数证据，在写完的同一刻就已经不是最新的了。
          //
          // 这是「哈希脆弱」（技能手册反复警告的那条）的**推广**：
          // 不只是哈希，**计数型证据也会自我失效** —— 而且更隐蔽，
          // 因为没有具体的哈希值让人警觉"它变了"。
          //
          // 实测代价（第 20/21 轮都撞到）：
          //   - 第 20 轮：§2「三份文档」→ 建了交接变四份 → §2 和 §5 各改一处 → 改一次作废一次；
          //   - 第 21 轮：§5 写「4 份受管文档，1 份必读」→ 登记完交接变 2 份必读 → 证据过期。
          //
          // ⇒ 解法不是"更认真地数"，而是**别写会变的数**：
          //   把"4 份受管 / 1 份必读"换成"`doc_health` 无 warn"这种**状态陈述**。
          //   状态陈述在被后续操作改变之前一直为真；计数在落笔那一刻就可能已经假了。
          //
          // ⚠️ 与 H4 的关系：H4 要的是"可核对的形状"（`N/N 通过` 之类），
          //    它并不要求你写**文档数量**。所以这条建议**不冲突** ——
          //    写 `doc_health 5/5 通过` 是安全的，写「4 份受管文档」是不安全的。
          + (value.role === 'handover'
            ? '\n**§5 别写会变的计数**：写「4 份受管文档、1 份必读」这类数字，'
              + '会在你**下一步**（比如把本份登记进 `read-order`）就过期，'
              + '而改它又要重读整份。改成**状态陈述**：'
              + '「`doc_health` 无 warn」/「`doc_handover_check` 7/7 通过」。'
              + '（H4 要的是可核对的形状，不是文档数量 —— 两者不冲突。）'
            : '')
          // L34（选项 c）：**只报告，不改行为**。空串时不显示任何东西。
          + (value.orderWarning !== '' ? `\n${value.orderWarning}` : ''),
      }],
    },
    execute: async (args, exec) => {
      // S2 执行期兜底（见 tools/when.js）：子代理不许写文档。
      await deps.assertAllowed?.(exec)

      const session = exec?.agent?.session
      const reg = typeof registry === 'function' ? registry(session) : registry
      if (reg === undefined || reg === null) {
        throw new Error('DDD 注册表还没就绪：这个会话不是 DDD 项目，或扫描失败了。')
      }

      const role = args?.role
      if (!ROLES.includes(role)) {
        throw new Error(`role 不合法：${String(role)}（允许：${ROLES.join(' / ')}）`)
      }
      const title = typeof args?.title === 'string' ? args.title.trim() : ''
      if (title === '') throw new Error('title 不能为空。')
      const summary = typeof args?.summary === 'string' ? args.summary.trim() : ''
      if (summary === '') throw new Error('summary 不能为空（索引块里显示的就是它）。')

      const status = typeof args?.status === 'string' ? args.status : 'draft'
      if (!STATUSES.includes(status)) {
        throw new Error(`status 不合法：${status}（允许：${STATUSES.join(' / ')}）`)
      }
      const basis = typeof args?.basis === 'string' ? args.basis : '未验证'
      if (!BASES.includes(basis)) {
        throw new Error(`basis 不合法：${basis}（允许：${BASES.join(' / ')}）`)
      }
      if (status === 'partial' && !(Array.isArray(args?.scope) && args.scope.length > 0)) {
        throw new Error('status 为 partial 时必须给 scope（它只在 scope 内有效）。')
      }

      // ---- id：给了就用，没给就派生；派生不出来就报错（不猜、不编号）
      let id = typeof args?.id === 'string' ? args.id.trim() : ''
      if (id === '') {
        const derived = deriveId(title)
        // ---- 2026-11-15 M2.8（第 30 轮 `session-84b1e3ea`）----
        //
        // 这里原来只判 `derived === '' || !ID_RE.test(derived)`。
        // 但 `ID_RE` **接受纯数字**，而中文标题里唯一能活下来的 ASCII 就是数字。
        // 实测：`deriveId('交接：全流程测试30')` → `'30'` → 通过 → 建出 `docs/30.md`。
        //
        // 第 30 轮的现场代价：AI 建出 `id: "30"` 的交接 → 发现不对 →
        // 又建一份 `handover-1` → 把 `30` 标 `void` → 再修索引。
        // 多花 `doc_new` + `read` + `doc_mark` + 一次 `edit`。
        //
        // ⇒ 改用 `isDerivedIdUsable`（要求含至少一个字母）。
        if (isDerivedIdUsable(derived) !== true) {
          // ---- 2026-11-16 M2.9：**压缩文案**（用户拍板 §7 第 1 项「顺手做」）----
          //
          // 原文 ~230 字，四句话在讲同一件事，其中「纯数字 id 不接受」那段是**设计依据**，
          // 对模型没用 —— 它只需要知道"现在该传什么"。
          //
          // 但**保留那个具体的例子**（`id: "handover-m1"`）：第 31 轮实测
          // 这个例子让它**一步就改对了**（补上 `handover-1` 就成功）。
          // 压缩的是论证，不是那条能照抄的出路。
          throw new Error(
            `中文标题派生不出合法 id（这次只捡到 ${derived === '' ? '空串' : `\`${derived}\``}）。`
              + '请显式传 `id`，例如 `id: "handover-m1"`。',
          )
        }
        id = derived
      }
      if (!ID_RE.test(id)) throw new Error(`id 不是 kebab-case：${id}`)

      const entries = reg.entries ?? []
      const existing = entries.find((entry) => entry?.meta?.id === id)
      if (existing !== undefined) {
        // **不自动改 id**：id 永不变，自动加后缀会让引用它的文档全部指向一个不存在的 id。
        throw new Error(
          `id \`${id}\` 已被占用（${existing.path ?? '(未知路径)'}）。`
            + '请换一个 id，或直接 read 并 edit 现有文档。',
        )
      }

      const root = typeof projectRoot === 'function' ? projectRoot(session) : deps.layout?.projectRoot
      if (typeof root !== 'string' || root === '') throw new Error('找不到项目根，无法创建文档。')

      const docsDir = deps.config.docsDir
      const relativePath = `${docsDir}/${id}.md`
      const absolutePath = `${root.replace(/[\\/]+$/, '')}/${relativePath.replaceAll('/', '\\')}`

      // L34（选项 c）：**建之前**记下现存最小的 handover order ——
      // 建完之后这份新文档也在 entries 里了，那时再算就分不清是谁。
      const minHandoverOrderBefore = handoverMinOrder(entries)

      // ---- order 默认值（M1.5 / D1 第 ① 步）
      //
      // ⚠️ **M1 的规格就是错的，不只是实现错**（`P4` 拍板改 SPEC 文本）：
      // 原来一律「当前最大 order + 10」，于是**交接永远排在最后** ——
      // 而设想里交接要「被放到第一位」（用户原话）。两条直接相反。
      //
      // 现在：`role === 'handover'` 时取「最小 handover order − 10」，
      // 保证新交接**必然排在所有交接之前**，且留了插值空间（-10, -20, ...）。
      // 其余 role 仍取「最大 + 10」（阅读顺序是渐进的，这个直觉是对的）。
      //
      // 注意 `handoverMinOrder` 的口径与 H7 **必须完全一致**（N5 的教训），
      // 所以两者共用同一个 helper，而不是各写一份 `Math.min`。
      const order = typeof args?.order === 'number' && Number.isFinite(args.order)
        ? args.order
        : (role === 'handover'
          ? nextHandoverOrder(entries)
          : nextOrder(entries))

      const text = renderDocText({
        id,
        title,
        role,
        order,
        status,
        summary,
        basis,
        scope: Array.isArray(args?.scope) ? args.scope.filter((item) => typeof item === 'string') : undefined,
      }, args?.body)

      // ---- 写盘：走 ctx.fs，**不走 guard**（这是插件自己的写，不是模型的 write）
      //
      // ⚠️ **必须把沙箱 policy 传下去**（实机验收时踩到的真 bug）。
      // `dsh-fs-sandbox` 的 `writeText(target, content, expected, signal, sandboxPolicy)`
      // 是**按每次调用**围栏的：`workspace-write` 只允许写「policy.workspaceRoot 之下」。
      // 不传 policy 时沙箱会用**默认** workspace root（= 会话建立时的 cwd），
      // 于是「切进另一个 DDD 项目后 doc_new」会得到
      // `file access denied under workspace-write mode` —— 而那个路径其实**在**工作区里。
      // 宿主的 `write` 工具就是这么传的（`sandbox.resolvePolicy(...)` 后作为第 5 个参数）。
      //
      // 我们拿不到宿主内部的 `sandbox.resolvePolicy`，所以自己拼一个最小 policy：
      // 目标所在的项目根就是 workspace root。**模式取会话当前模式**（拿不到就 read-only 之外最保守的 workspace-write）。
      const policy = sandboxPolicyOf(exec)
      if (typeof fs?.writeText !== 'function' || typeof fs?.resolve !== 'function') {
        throw new Error('文件系统服务不可用，无法创建文档。')
      }
      const target = await fs.resolve(absolutePath, { cwd: root })
      try {
        await fs.writeText(target, text, undefined, exec?.signal, { ...policy, workspaceRoot: root })
      } catch (error) {
        throw new Error(
          `写 ${relativePath} 失败：${error?.message ?? error}`
            + '（如果提示 file access denied，说明沙箱不允许写这个目录——请确认它在当前工作区内。）',
        )
      }

      // ---- ① 记进本会话的 readSet（否则 doc_new → doc_mark 会被门禁拒）
      //
      // ⚠️ **路径必须用注册表认得的那一种**（实机验收时踩到的第二个真 bug）。
      // 我原来传的是自己拼的 `${root}/${相对路径.replaceAll('/','\\')}`，结果
      // `...\_m1-probe/docs\handover-m1.md` —— **混用 `/` 与 `\`**。
      // 而 `registry.entryByPath()` 是**字符串全等**比较，扫描器给出的却是全 `\` 的路径，
      // 所以 `markRead` 永远匹配不上 → 进待补记队列 → `flushPendingReads` 也匹配不上
      // → **`doc_new` 之后 `doc_mark` 永远报"没读过"**。
      //
      // 修法：优先用 `fs.resolve()` 给出的 `displayPath`（后端自己的规范化结果）。
      const ledgerPath = typeof target?.displayPath === 'string' && target.displayPath !== ''
        ? target.displayPath
        : absolutePath
      try {
        if (typeof reg.markRead === 'function') {
          const verdict = reg.markRead(ledgerPath, session, exec?.seq, text)
          if (verdict !== true) {
            // 还没入册 → markRead 已经把它放进"待补记队列"，下面的 rescan 会补上（D3 的机制）。
            logger?.debug?.('[ddd] doc_new：新文档尚未入册，已排入待补记队列')
          }
        }
      } catch (error) {
        // 记账失败不能连累"文件已建好"这个事实。
        logger?.warn?.(`[ddd] doc_new 记账失败：${error?.message ?? error}`)
      }

      // ---- ② 必须触发 rescan（交接 §5.3 #15：不扫就是重造 D2）
      let indexed = false
      try {
        if (typeof reg.rescan === 'function') {
          await reg.rescan()
          indexed = reg.entries?.some((entry) => entry?.meta?.id === id) === true
        }
      } catch (error) {
        logger?.warn?.(`[ddd] doc_new 后重扫失败：${error?.message ?? error}`)
      }

      // ---- ③ rescan 之后**再记一次**：这时文档肯定已入册，用注册表里的真实路径。
      //
      // 为什么不能只靠 ① 的待补记队列：那条路依赖"路径字符串完全相等"，
      // 而后端规范化路径的方式不止一种（`/` 与 `\` 混用就会对不上）。
      // 这里用 `entryById(id)` 拿注册表**自己**的 `path`，那是唯一不会对不上的写法。
      let recorded = false
      try {
        const fresh = typeof reg.entryById === 'function' ? reg.entryById(id) : undefined
        if (fresh !== undefined && typeof reg.markRead === 'function') {
          recorded = reg.markRead(fresh.path, session, exec?.seq,
            typeof fresh.text === 'string' ? fresh.text : text) === true
        }
      } catch (error) {
        logger?.debug?.(`[ddd] doc_new 二次记账失败：${error?.message ?? error}`)
      }

      // ---- ④ 新交接落地后，把旧的 `authoritative` 交接自动标 `superseded`（M1.5 / D1 第 ② 步）
      //
      // 为什么必须做：H6 会报「有 2 份 authoritative 的交接」，而**模型没有任何手段
      // 自己收拾**——`doc_mark` 把 handover 标 superseded 需要 `supersededBy`，
      // 而"谁取代了它"这个信息**只有 `doc_new` 知道**（新 id 是它生成的）。
      // 让模型手动补一遍，等于每次交接都留一个"忘了补就报警"的坑。
      //
      // 顺序要求：必须在 rescan **之后**（③ 之后），否则新文档还没进注册表，
      // `handoverListOf` 拿不到它，可能把"刚建的这份"也算进去。
      //
      // ⚠️ 只标 `authoritative`：`draft` 的旧交接不该被动（它可能还没写完就被取代了）。
      // 失败不影响"新文档已建好"这个事实，只记 warn —— 交接顺序是**优化**，
      // 而"文件写坏了"是**事故**，两者不能用同一个错误级别。
      const supersededOld = []
      if (role === 'handover') {
        supersededOld.push(...await supersedeOldHandovers({
          reg,
          fs,
          session,
          exec,
          selfId: id,
          projectRoot: root,
          logger,
        }))
      }

      // ---- ④.5 **supersede 之后必须重新记账**（2026-11-15 M2.8，第 30 轮 `session-84b1e3ea`）----
      //
      // ---- 缺陷现场 ----
      //
      // `seq 135` doc_new 建 handover-1 ✅（回执说"已记入本会话的已读集合"）
      // `seq 152` doc_mark 把误生成的 `30` 标 void ✅
      // `seq 168` doc_mark handover-1 ❌ **「你读过的是旧版（v24b7de），磁盘已是 va60b3e」**
      //
      // 而 seq 135 → 168 之间**没有任何工具碰过 handover-1**。
      //
      // ---- 根因 ----
      //
      // `doc_new` 的记账顺序是：
      //   ① markRead(写文件时的 text)   ← 指纹 = A
      //   ② rescan
      //   ③ markRead(fresh.text)        ← 指纹 = B（此时对）
      //   ④ supersedeOldHandovers()     ← **它会把 supersedes 反填进这份新交接**
      //
      // ④ 的那次反填（`supersedeOldHandovers` 第 280 行起）**又写了一次 handover-1**，
      // 指纹从 B 变成 C。而 ③ 记的是 B → **门禁认为"你读过的是旧版"**。
      //
      // ⇒ 谁写谁记账。④ 之后必须重记一次，否则 `doc_new` 那句
      //   "已记入本会话的已读集合"就是**假话** —— 而且它会把代价转嫁给下一次
      //   `doc_mark`（模型莫名其妙被要求整份重读）。
      //
      // ⚠️ 只在新交接**真的被取代过**时才需要（`supersededOld.length > 0`）——
      //    没有旧交接可取代时，④ 不会写这份文件。
      if (supersededOld.length > 0) {
        try {
          const after = typeof reg.entryById === 'function' ? reg.entryById(id) : undefined
          if (after !== undefined && typeof reg.markRead === 'function') {
            reg.markRead(after.path, session, exec?.seq,
              typeof after.text === 'string' ? after.text : undefined)
            logger?.debug?.('[ddd] supersede 反填后已重新记账')
          }
        } catch (error) {
          logger?.debug?.(`[ddd] supersede 后重新记账失败：${error?.message ?? error}`)
        }
      }

      // ---- ⑤ 新交接自动登记进入口索引的必读清单（M2.8，用户拍板）----
      //
      // 拆掉「交接 ↔ read-order」的循环依赖，详见 `core/registerHandover.js` 的文件头。
      // 一句话：两条要求（清单里要有交接 / 交接里的话必须此刻为真）在时间上无法同时满足，
      // 而模型只有三种写法、全都有代价。第 24 轮为此烧掉 10 879 字符的纯推演。
      //
      // 为什么放在 `supersedeOldHandovers` **之后**：old 交接被标 superseded 后
      // `role: index` 的那个条目不受影响，但顺序上"先收拾旧的、再登记新的"更符合直觉，
      // 且两条都失败时报告顺序稳定（便于测试断言）。
      //
      // ⚠️ **必须在 rescan 之后**（③ 之后）：要靠注册表拿到 `read-order` 的真实路径与正文。
      const indexRegistration = role === 'handover'
        ? await registerHandoverInIndexFile({
          reg,
          fs,
          session,
          exec,
          selfId: id,
          order,
          summary: typeof args?.summary === 'string' ? args.summary : '',
          projectRoot: root,
          logger,
        })
        : { changed: false, reason: '不是交接文档' }

      return {
        id,
        path: relativePath,
        order,
        status,
        // 给 render 用：role: handover 时要多一句"修订请新建"的说明（M2.3 演练 D2）。
        role,
        indexed,
        recorded,
        supersededOld,
        // M2.8：交接是否已自动登记进入口索引（拆循环依赖）。
        indexRegistered: indexRegistration.changed === true,
        indexRegistrationReason: indexRegistration.reason ?? '',
        // M2.8 第 27 轮：清单条数变化（告诉模型哪句计数过期了）。
        // 拿不到就当 0/0（渲染那边会判"没变化"，不输出那一段）。
        indexCountBefore: typeof indexRegistration.countBefore === 'number' ? indexRegistration.countBefore : 0,
        indexCountAfter: typeof indexRegistration.countAfter === 'number' ? indexRegistration.countAfter : 0,
        // L34（选项 c）：**只报告，不改行为**。空串 = 没问题。
        orderWarning: handoverOrderWarningOf({
          order,
          role,
          handoverMinOrder: minHandoverOrderBefore,
        }),
      }
    },
  })
}

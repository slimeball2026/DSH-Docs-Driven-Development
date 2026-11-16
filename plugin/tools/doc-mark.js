/**
 * `doc_mark` —— 结构化改状态（M1，会写文件）。
 *
 * 为什么必须是工具（SPEC §5.2）：
 * `edit` 做字面替换改 `status` 太脆（M0 的 `roles.js` 甚至禁止 `evidence`/`handover` 被 edit），
 * 而且 `sections` 是流式 JSON，**手写必然出错**（M1-Q6）。
 *
 * ---- 这个工具**曾经**是 M1-C 的硬落点（2026-11-15 M2.7 已降级）----
 *
 * SPEC 原设计里，「交接失败会被拒绝」只体现在 `doc_handover_check` 的**返回值**上。
 * 但返回值拦不住模型：它完全可以跳过检查、直接 `doc_mark`。
 * 所以这里曾经加过一条**代码里的 if**：
 *
 * > 把 `role: handover` 的文档标成 `authoritative` 时，**内部跑 H1–H4**，
 * > 不过就**拒绝这次写入**。
 *
 * ---- 那条 if 已被用户要求删除（2026-11-15）----
 *
 * 用户原话：
 * > 交接文档本身的结构必须要保证或近似，但我认为它**可以只是提示词层面的东西**，
 * > 不必完全一致。
 *
 * 实测代价：跨 5 轮实机会话，H4「证据形状」反复逼 AI 把人话改写成正则形状
 * （`5 项检查全过` → `5/5 通过`），H10 甚至数学上不可满足。
 * 判定降级成引导：结构要求全部保留在 `doc_new` 的返回值里，
 * 但**没有任何 `if` 会因为"交接写得不够好"而拒绝落盘**。
 *
 * 详见下面第 5 步那段注释（`// ---- 5. 交接标绿：**不再校验**`）。
 *
 * ---- 门禁不绕过 ----
 * 它仍然要求目标文档**已被读过**（与 `write`/`edit` 同一条规则）：
 * 改状态就是改文档的语义，没读过就改等于凭想象改。
 * 例外只有一个：**本会话用 `doc_new` 新建的文档**（那时 `doc_new` 已经把正文记进 readSet）。
 */

import { defineTool } from './define-tool.js'
import { sandboxPolicyOf } from './doc-new.js'
import { setFrontmatterFields } from '../core/frontmatterEdit.js'
import { STATUSES, BASES } from '../docs/schema.js'

const DESCRIPTION = [
  '结构化修改文档状态：文档级 status，或段落级 sections（anchor + sectionStatus）。',
  '只改 frontmatter，正文最多追加一个可追溯的 <!-- ddd:mark ... --> 标记块，其余字节不动。',
  '改成 sealed / void 必须给 reason（会写进标记块，别人能查到为什么）。',
  '改成 superseded 必须给 supersededBy（谁取代了它）。',
  // ---- 2026-11-15 M2.8（用户拍板）：**这句话原来在说谎，必须改** ----
  //
  // 原文：「把 role: handover 的文档标成 authoritative 时会自动跑交接校验（H1–H4），不合格会被拒绝。」
  //
  // M2.7 的 `b3be171` 已经把那条硬门禁**整条删了**（见下面第 5 步「不再校验」），
  // 但这句工具描述没跟着改 —— 于是**工具描述承诺了一个代码已经不做的约束**。
  //
  // 危害不是"少拦一次"，而是**模型读了描述会以为自己被卡住**：
  // 它可能为了"过校验"去反复改交接（M2.6 实测连建 4 份、44 步、被用户中止），
  // 或者反过来**不敢标绿**。**描述与行为不一致比没有描述更糟。**
  //
  // 现在如实说明：标绿**不再**校验；要体检请显式跑 `doc_handover_check`。
  '把 role: handover 的文档标成 authoritative 时**不校验**交接结构（M2.7 起，结构只是提示词层）。要体检请先跑 `doc_handover_check`。',
  '⚠️ 它**不改** order / role / title / summary / basis —— 传这些参数会直接报错（不静默丢弃）。',
  '⚠️ 本会话**自己写过**的文档，标状态前不必重读（外部改动仍需重读）。',
  '要改阅读顺序或结构字段，用 edit 只改 frontmatter 那一块（嵌套多份请逐份调用）。',
].join('')

/** 段落级状态允许的取值（与文档级 status 同一套枚举，语义是"这一节的置信度"）。 */
const SECTION_STATUSES = Object.freeze(['authoritative', 'partial', 'superseded', 'sealed', 'void', 'draft'])

/**
 * `doc_mark` 认得的参数（**必须与 `parameters` 表逐字一致**）。
 *
 * 为什么要有这份白名单（M1.5 / **N2**）：
 * `define-tool.js` 的根节点**刻意不写 `additionalProperties: false`**
 * （宿主会把多出来的参数判成 `isError`，整次调用就废了）——
 * 那个宽容是对的，但**宽容的代价是"静默丢弃"**：
 *
 * ```
 * doc_mark({ id: 'x', order: 0, status: 'draft' })
 * → 返回「已更新 x 的 frontmatter：status」
 * → 磁盘上 order 还是 30
 * ```
 *
 * 那条实测记录在 `_review/proj-a/docs/handover-probe.md`：评审者传了 `order: 0`，
 * 拿到成功回执，而磁盘那一行**从来没变过**。
 *
 * **无声失败比报错危险**：模型不会去核对 `changed` 里少了谁，
 * 它会以为改成了，然后在一个错误的 order 上继续施工。
 *
 * 所以这里加一条**代码里的 if**：认不出的参数直接报错，并**告诉它正确的做法**。
 */
const KNOWN_PARAMS = Object.freeze(['id', 'status', 'anchor', 'sectionStatus', 'reason', 'supersededBy', 'basis'])

/**
 * 找出 `doc_mark` 不认识的参数（M1.5 / N2）。
 *
 * @param {object} args 模型传来的原始参数
 * @returns {string[]} 不认识的参数名（空数组 = 全部认识）
 */
export function unknownParamsOf(args) {
  if (args === null || typeof args !== 'object') return []
  return Object.keys(args).filter((key) => !KNOWN_PARAMS.includes(key))
}

/**
 * 生成可追溯的标记块（M1-Q6 第 2 条：改 sealed/void 要留理由）。
 *
 * 形态刻意保持单行、可 diff：
 * `<!-- ddd:mark 2026-11-11 status=sealed reason="已被第 3 版推翻" -->`
 *
 * ⚠️ **`reason` 必须消毒**：它是模型给的自由文本，而它会被放进 HTML 注释里。
 * 一个 `-->` 就能提前闭合注释，把后面的内容变成正文（**注入**）。
 * 所以这里把 `-->` 拆开写，并去掉换行（块必须是单行）。
 *
 * ⚠️ 时间戳会让**正文**每次都变。所以只在**真的有变更**时才追加。
 *
 * @param {object} input
 * @returns {string}
 */
export function markBlock(input) {
  const parts = []
  if (typeof input.status === 'string' && input.status !== '') parts.push(`status=${input.status}`)
  if (typeof input.anchor === 'string' && input.anchor !== '') parts.push(`anchor=${input.anchor}`)
  if (typeof input.sectionStatus === 'string' && input.sectionStatus !== '') {
    parts.push(`sectionStatus=${input.sectionStatus}`)
  }

  const reason = typeof input.reason === 'string' ? input.reason : ''
  if (reason !== '') {
    // 1) 压成单行；2) 先拆 `-->` 再 JSON 引号（顺序不能反，否则又会拼回来）。
    const oneLine = reason.replace(/\s+/g, ' ').trim().replace(/-->/g, '-- >')
    if (oneLine !== '') parts.push(`reason=${JSON.stringify(oneLine)}`)
  }

  if (parts.length === 0) return ''
  const stamp = typeof input.at === 'string' && input.at !== '' ? ` ${input.at.replace(/[^\d.-]/g, '')}` : ''
  return `<!-- ddd:mark${stamp} ${parts.join(' ')} -->`
}

/**
 * 把标记块追加到正文末尾（保持原有行尾与 BOM 语义）。
 * @param {string} text 整份文档
 * @param {string} block 标记块
 * @returns {string}
 */
export function appendMarkBlock(text, block) {
  if (block === '') return text
  const hasCrlf = text.includes('\r\n')
  const eol = hasCrlf ? '\r\n' : '\n'
  const trimmed = text.replace(/(\r?\n)+$/, '')
  return `${trimmed}${eol}${eol}${block}${eol}`
}

/**
 * 建工具。
 *
 * @param {object} deps
 * @param {object} deps.config
 * @param {(session: object|undefined) => object|undefined} deps.registry
 * @param {object} deps.fs `ctx.fs`
 * @param {(session: object|undefined) => (string|undefined)} deps.readRecordOf
 *        取本会话对某 id 的已读记录（`{fingerprint, text}`）
 * @param {() => string} [deps.now] 时间源（注入以便测试）
 * @returns {object}
 */
export function createMarkTool(deps) {
  const { config, registry, fs } = deps
  const now = typeof deps.now === 'function' ? deps.now : () => new Date().toISOString().slice(0, 10)
  // `config` 现在只用于构造（不参与交接硬门禁，见第 5 步的说明）。
  void config

  return defineTool({
    name: 'doc_mark',
    description: DESCRIPTION,
    parameters: {
      id: { type: 'string', required: true, description: '目标文档 id。' },
      status: { type: 'string', enum: [...STATUSES], description: '文档级状态。' },
      anchor: { type: 'string', description: '段落级状态的目标锚点，形如 "#7"。' },
      sectionStatus: { type: 'string', enum: [...SECTION_STATUSES], description: '段落级状态（需要 anchor）。' },
      // ---- 2026-11-15 M2.8：**`basis` 归 doc_mark 管**（第 28 轮反馈）----
      //
      // AI 的原话（它把这叫"分类错误"，我同意）：
      // > 另外 `doc_mark` 拒绝改 `basis` 我觉得是分类错误 ——
      // > `basis`（实测/推断/未验证）是**置信度**，和 `status` 是同一维度的东西，
      // > 不是结构字段。为了改它专门绕 `edit` + 重读，收益为零。
      //
      // 实际代价（每一轮都在发生）：`doc_new` 建出来 `basis: 未验证`，
      // 想标 `authoritative` 就得**两次操作**：
      //   ① `edit` 改 basis → 指纹变 → 已读失效；
      //   ② `doc_mark` 标 status → 又要整份重读（M2.8 已豁免，但仍然是两次调用）。
      //
      // ⇒ 现在一次调用就能同时改 `status` 和 `basis`。
      //
      // ⚠️ 为什么 `order` **不**跟着放开：
      //    `order` 是**结构**字段，改了它还要同步改 `read-order` 正文的清单
      //    （"改阅读顺序是两件事"那条纪律）。让它留在 `edit` 上是刻意的：
      //    那一步必须被看见，不能顺手做掉。
      basis: {
        type: 'string',
        enum: [...BASES],
        description: '置信度：实测 / 推断 / 未验证。可与 status 同时给（推荐）。',
      },
      reason: { type: 'string', description: '改 sealed / void 时必填：为什么封存/作废。会写进标记块。' },
      supersededBy: {
        type: 'array',
        items: { type: 'string' },
        description: 'status 为 superseded 时必填：谁取代了它（id 列表）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string', required: true },
          changed: { type: 'array', required: true, items: { type: 'string' } },
          added: { type: 'array', required: true, items: { type: 'string' } },
          removed: { type: 'array', required: true, items: { type: 'string' } },
          marked: { type: 'boolean', required: true },
          indexed: { type: 'boolean', required: true },
          // M2.8 第 27 轮：标绿时 basis 是否仍是「未验证」。
          // ⚠️ 声明是**必须**的 —— `additionalProperties: false`，
          //    返回值里多一个没声明的键会让**整个 doc_mark 调用被拒**（M2.6 的血泪）。
          basisPending: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => {
        const what = [...value.changed, ...value.added].filter((item) => item !== '')
        return [{
          type: 'text',
          text: `已更新 \`${value.id}\` 的 frontmatter：${what.length > 0 ? what.join('、') : '（无变化）'}`
            + `${value.removed.length > 0 ? `（删除：${value.removed.join('、')}）` : ''}。`
            + (value.marked ? '\n正文追加了可追溯的 `<!-- ddd:mark -->` 标记块。' : '')
            + (value.basisPending
              ? '\n⚠️ **它的 `basis` 还是「未验证」** —— `doc_health` 的 **H-5** 下一步就会报。'
                + '\n   现在就要改的话，用 `edit` 改 frontmatter 的 `basis:` 一行（`实测` / `推断` 由你判断）。'
                + '\n   ⚠️ 别在标绿**之后**才改：那样指纹会变、又得重读一遍。'
              : '')
            + (value.indexed ? '\n索引已刷新。' : '\n⚠️ 重扫失败，索引可能还没更新。'),
        }]
      },
    },
    execute: async (args, exec) => {
      // S2 执行期兜底（见 tools/when.js）：子代理不许改文档状态。
      await deps.assertAllowed?.(exec)

      const session = exec?.agent?.session

      // ---- 0. N2：不认识的参数**直接报错**，绝不静默丢弃
      //
      // 放在最前面：否则模型会先拿到「已更新」的回执，再也不会回头核对。
      // 文案必须给出**替代做法**（只报"不认这个参数"等于让模型去猜）。
      const unknown = unknownParamsOf(args)
      if (unknown.length > 0) {
        const detail = unknown.map((key) => {
          if (key === 'order') {
            return `order —— doc_mark 不改阅读顺序（工具的 parameters 里根本没有这个字段）。`
              + '要改 order 请用 `edit` 直接改 frontmatter 那一行，或新建一份（`doc_new` 会算 order）。'
          }
          if (key === 'role' || key === 'title' || key === 'summary') {
            return `${key} —— doc_mark 只改 status / sections / basis。改结构字段请用 \`edit\`（只动 frontmatter 那一块）。`
          }
          if (key === 'basis') {
            // 实际上走不到这里（`basis` 已在 2026-11-15 M2.8 加入 parameters）。
            // 留着是为了万一 parameters 和这段校验不同步时，报错能说清。
            return 'basis —— doc_mark 现在**支持**它了（2026-11-15 M2.8）。'
              + '若你看到这条，说明 parameters 与校验不同步，请报 bug。'
          }
          return `${key} —— 不认识的参数。`
        })
        throw new Error(
          `doc_mark 不认这些参数：${unknown.join('、')}。它只改 status 与 sections（文档级/段落级状态）。\n`
            + detail.join('\n'),
        )
      }
      const reg = typeof registry === 'function' ? registry(session) : registry
      if (reg === undefined || reg === null) {
        throw new Error('DDD 注册表还没就绪：这个会话不是 DDD 项目，或扫描失败了。')
      }

      const id = typeof args?.id === 'string' ? args.id.trim() : ''
      if (id === '') throw new Error('id 不能为空。')
      const entry = typeof reg.entryById === 'function' ? reg.entryById(id) : undefined
      if (entry === undefined) throw new Error(`找不到 id 为 \`${id}\` 的受管文档。`)

      // ---- 0. 证据类文档不许 AI 改（与 `roles.js` 的写策略一致，不能从这里开后门）
      //
      // ⚠️ 这条是自查时补的：`doc_mark` **完全绕过** `core/roles.js` 的写策略表
      // （它不经过 `guard`，guard 只拦 write/edit）。于是 `role: evidence` 的文档
      // 可以用 `doc_mark` 把 status 从 authoritative 改成 draft —— 等于**改证据**。
      // `handover` 不在此列：交接的 status 迁移正是它存在的理由，
      // 但那种迁移有 H1–H4 硬门禁（见下面第 5 步）。
      if (entry.meta?.role === 'evidence') {
        throw new Error(
          `\`${id}\` 是 evidence（证据类文档），不允许用 doc_mark 改它的状态。`
            + '证据只能新增，不能被改写——如果你需要新的证据，请用 doc_new 建一份。',
        )
      }

      const status = typeof args?.status === 'string' ? args.status : undefined
      // M2.8：`basis` 与 `status` 同为"置信度"维度，一次调用可同时改（见 parameters 注释）。
      const basis = typeof args?.basis === 'string' ? args.basis : undefined
      const anchor = typeof args?.anchor === 'string' ? args.anchor.trim() : undefined
      const sectionStatus = typeof args?.sectionStatus === 'string' ? args.sectionStatus : undefined
      const reason = typeof args?.reason === 'string' ? args.reason.trim() : ''
      const supersededBy = Array.isArray(args?.supersededBy)
        ? args.supersededBy.filter((item) => typeof item === 'string' && item !== '')
        : undefined

      // ---- 1. 至少给一样东西
      //
      // ---- 2026-11-15 M2.8：`basis` 也算"给了东西" ----
      //
      // 场景：文档已经 `authoritative` 了，只是 `basis` 还是「未验证」——
      // 这时模型只想 `doc_mark({id, basis: '实测'})`。
      // 旧实现会报"至少要给 status" —— 逼它去 `edit`，多一次指纹失效。
      const doesDocument = status !== undefined
      const doesSection = anchor !== undefined || sectionStatus !== undefined
      const doesBasis = basis !== undefined
      if (!doesDocument && !doesSection && !doesBasis) {
        throw new Error('至少要给 status、basis，或（anchor + sectionStatus）之一。')
      }
      if (doesDocument && !STATUSES.includes(status)) {
        throw new Error(`status 不合法：${String(status)}（允许：${STATUSES.join(' / ')}）`)
      }
      if (doesBasis && !BASES.includes(basis)) {
        throw new Error(`basis 不合法：${String(basis)}（允许：${BASES.join(' / ')}）`)
      }
      if (anchor !== undefined && sectionStatus === undefined) {
        throw new Error('给了 anchor 就必须同时给 sectionStatus。')
      }
      if (sectionStatus !== undefined) {
        if (anchor === undefined || anchor === '') throw new Error('给了 sectionStatus 就必须同时给 anchor。')
        if (!SECTION_STATUSES.includes(sectionStatus)) {
          throw new Error(`sectionStatus 不合法：${sectionStatus}（允许：${SECTION_STATUSES.join(' / ')}）`)
        }
      }

      // ---- 2. sealed / void 必须给理由（Q12：AI 必须给理由）
      if ((status === 'sealed' || status === 'void') && reason === '') {
        throw new Error(
          `把 \`${id}\` 改成 ${status} 必须给 reason：说明为什么它不能再用。`
            + '这个理由会写进正文的 <!-- ddd:mark --> 标记块，别人能查到。',
        )
      }

      // ---- 3. superseded 必须给 supersededBy（V3 的同类要求，提前到写入前拦）
      if (status === 'superseded' && !(supersededBy !== undefined && supersededBy.length > 0)) {
        throw new Error('改成 superseded 必须给 supersededBy：谁取代了它。')
      }

      // ---- 4. 门禁：改状态也是改文档，没读过不许改
      //
      // ⚠️ 这里**不能读盘**：用 readSet 里的已读记录 + 注册表缓存的指纹。
      // 与 `write`/`edit` 走同一条规则（doc_mark 不是后门）。
      const record = typeof deps.readRecordOf === 'function' ? deps.readRecordOf(session, id) : undefined
      const currentFingerprint = typeof reg.fingerprintOf === 'function' ? reg.fingerprintOf(id) : undefined

      // ---- 2026-11-15 M2.8（用户拍板）：**认 `selfWritten`** ----
      //
      // 缺陷（`交接-M2.8.md` §3.2，第 23 轮 seq 192 现场）：
      //   读完整份 → edit 改正文（成功）→ doc_mark 标绿 → **被拒**「你读过的是旧版」。
      //
      // 为什么这是纯浪费：
      //   · 改正文的那一笔 `edit` 是**模型自己发的**，它当然知道自己改了什么；
      //   · `edit` 之后磁盘指纹必然变（这就是铁律 7 的机制），于是**每次**
      //     「edit 正文 → doc_mark 标绿」这个最常见的交接收尾动作**必然多一次整份重读**；
      //   · 交接是 `docs/` 里最长的一份（实测 65 行），代价最高。
      //
      // 实测代价（`_m28/probe-selfwritten.mjs` 的最小复现，第 3 条）：
      //   自己 edit 过 → 不重读 → doc_mark → ❌「你读过的是旧版（v46648e），磁盘已是 v12f7b3」
      //
      // ---- 为什么这条是**放宽**，以及它为什么不会误放行 ----
      //
      // `selfWritten` 是**纯内存**的会话级集合（`adapters/registry.js` 的
      // `selfWrittenBySession`），只在 `observe.js` 观测到**写类工具成功**时才记：
      //   · 被门禁拒 / `edit` 没匹配上 → **不记**（内容没变，不该给豁免）；
      //   · 别人 / 另一个会话 / 编辑器改的 → **不记**（那是外部改动，必须重读）；
      //   · 宿主重启 → 内存清空 → 退回严格行为（不会留下永久豁免）。
      //
      // 所以它豁免的**只有**「本会话自己成功写过的那些文档」，与
      // 「外部改动必须重读」这条判据**正交**，不会互相污染。
      // 最小复现的第 4 条专门钉死这一点（外部改动后仍必须被拒）。
      //
      // ---- 为什么只跳过「指纹比对」而不是跳过整段读校验 ----
      //
      // `record === undefined` 那条**必须保留**：从没读过的文档，即使本会话写过，
      // 也可能是一次「别人先建、我盲改」的情形 —— 那种情况下模型确实没看过内容。
      // 只在**已有读记录**的前提下才跳过指纹比对。
      const selfWritten = typeof reg.isSelfWritten === 'function' && reg.isSelfWritten(id, session) === true

      if (record === undefined || record === null) {
        throw new Error(
          `改 \`${id}\` 的状态之前必须先读它：用 read 工具读一遍，然后重试。`
            + '（改状态就是改语义，没读过就改等于凭想象改。doc_new 刚建的文档不受这条限制。）',
        )
      }
      if (!selfWritten && typeof currentFingerprint === 'string' && record.fingerprint !== currentFingerprint) {
        throw new Error(
          `\`${id}\` 你读过的是旧版（v${String(record.fingerprint ?? '').slice(0, 6)}），`
            + `磁盘已是 v${currentFingerprint.slice(0, 6)}。用 read 重读它，然后再改状态。`,
        )
      }

      // ---- 5. 交接标绿：**不再校验**（2026-11-15 M2.7，用户拍板）----
      //
      // ---- 为什么删掉这条硬门禁 ----
      //
      // 用户 2026-11-15：
      // > 交接文档本身的结构必须要保证或近似，但我认为它**可以只是提示词层面的东西**，
      // > 不必完全一致。
      //
      // 历史：这条 `if` 从 M1 起就是 error 级硬门禁（H1–H7 不合格就拒绝标绿）。
      // 实测代价（跨 5 轮实机会话）：
      //   · H4「证据形状」逼 AI 把"我用 PowerShell 逐份比对，两行都输出 OK"
      //     改写成 `2/2 命中` —— **人话迁就正则**；
      //   · H10 曾经数学上不可满足，造成"无限后退"死锁，已删；
      //   · 第 20 轮 AI 自述：「难受的点在于 `5 项检查全过` 比 `5/5 通过` 更准确，
      //     但为了过门禁我得选那个稍微不那么准的说法」。
      //
      // ⇒ 结论：**结构该保留在提示词层（`doc_new` 的返回值里说清楚），
      //    但不再用 error 拦落盘。** 这与架构分析 §5 的判别法一致：
      //    判「有没有」机器可靠；判「好不好」不可靠，且成本落在 AI 身上。
      //
      // ⚠️ **`doc_handover_check` 仍然保留**，但它现在只是**体检工具**：
      //    它会把缺什么、建议怎么写都列出来（`strict: false` → 全部 warn），
      //    但不阻断任何操作。要不要照它改，由 AI 自己判断。
      //
      // ⚠️ 这不是"删掉功能"，是**把判定降级成引导**：
      //    - 七段结构、§3 具体路径、§5 证据 —— 全部还在 `doc_new` 的提示里；
      //    - `doc_health` 的 H-5/H-6 仍然会报事实；
      //    - 只是**没有任何一个 `if` 会因为"交接写得不够好"而拒绝落盘**。
      //
      // 用户明确要的是这个取舍：宁可偶尔拿到一份格式松散的交接，
      // 也不要每轮都为了过校验而多花十几步。

      // ---- 6. 结构化写入 frontmatter（正文一个字节都不动）
      const original = typeof entry.text === 'string' ? entry.text : ''
      if (original === '') throw new Error(`读不到 \`${id}\` 的正文，无法改写。`)

      const fields = {}
      if (status !== undefined) {
        fields.status = status
        if (status === 'superseded') fields.supersededBy = supersededBy
        // 从 superseded 改回别的状态时，把 supersededBy 清掉（否则 V3 的语义会残留）
        if (status !== 'superseded' && entry.meta?.supersededBy !== undefined) fields.supersededBy = null
      }

      // ---- 2026-11-15 M2.8：`basis` 也在这里改（与 status 同一次落盘）----
      //
      // 理由见 parameters 里那段长注释：`basis` 是**置信度**，与 `status` 同维度。
      //
      // ⚠️ 与 H-5 的关系（这条必须想清）：
      //    H-5 报的是「`basis: 未验证` 却标了 `authoritative`」。
      //    现在可以在**同一次调用里**把两者都改对 → **H-5 从根上不会触发**。
      //    这正是 AI 反馈里要的"要么拒、要么允许一次改完"中的后者。
      //
      // ⚠️ 合法组合检查：`draft` + `basis: 实测` 是允许的（做了但还没定稿），
      //    所以不做交叉校验 —— 那是 `doc_health` 的 H-5 的职责（它只查
      //    "authoritative 却未验证" 这一种组合）。
      if (basis !== undefined) fields.basis = basis

      // 段落级状态：读出现有 sections（可能是空的），按 anchor 合并。
      if (anchor !== undefined && sectionStatus !== undefined) {
        const existing = Array.isArray(entry.meta?.sections) ? entry.meta.sections : []
        const cleaned = existing.filter((item) => item !== null && typeof item === 'object')
        const index = cleaned.findIndex((item) => item.anchor === anchor)
        const next = { anchor, status: sectionStatus }
        if (reason !== '') next.reason = reason
        if (index >= 0) cleaned[index] = { ...cleaned[index], ...next }
        else cleaned.push(next)
        fields.sections = cleaned
      }

      const edited = setFrontmatterFields(original, fields)
      if (edited.ok !== true) throw new Error(edited.message ?? 'frontmatter 改写失败。')

      // 标记块：只有"改状态"这种需要追溯的动作才追加，避免每次调用都改正文。
      const shouldMark = reason !== '' || status === 'sealed' || status === 'void'
      const block = shouldMark
        ? markBlock({ status, anchor, sectionStatus, reason, at: now() })
        : ''
      const nextText = block === '' ? edited.text : appendMarkBlock(edited.text, block)
      const changedBytes = nextText !== original

      if (changedBytes) {
        if (typeof fs?.writeText !== 'function' || typeof fs?.resolve !== 'function') {
          throw new Error('文件系统服务不可用，无法写入。')
        }
        // 与 doc_new 同理：**必须把沙箱 policy 传下去**，否则切项目后会被误拒。
        // workspace root 取这份文档所在的项目根（由路径推到 docs 的上一级）。
        const root = deps.projectRootOf ? deps.projectRootOf(session) : undefined
        const target = await fs.resolve(entry.path, { cwd: root })
        try {
          await fs.writeText(target, nextText, undefined, exec?.signal, {
            ...sandboxPolicyOf(exec),
            ...(typeof root === 'string' && root !== '' ? { workspaceRoot: root } : {}),
          })
        } catch (error) {
          throw new Error(`写 ${id} 失败：${error?.message ?? error}`)
        }
      }

      // ---- 7. rescan（与 doc_new 同理：状态变了，索引与 AGENTS.md 都要跟上）
      let indexed = false
      try {
        if (typeof reg.rescan === 'function') {
          await reg.rescan()
          indexed = true
        }
      } catch {
        // 重扫失败不影响"已经写好了"这个事实。
      }

      // ---- 7.5 **标完之后它仍然是"读过"的**（M2.8，第 27 轮反馈）----
      //
      // ---- 缺陷现场（`session-6bd267f1` seq 114 → 125 → 131）----
      //
      // ```
      // seq 114  doc_mark handover-1 → authoritative   ✅
      // seq 120  doc_health                            ✅
      // seq 124  模型自述：「The gate says handover-1 is unread. That's fine;…
      //                     Actually let me read it to make sure gate is clean.」
      // seq 125  read handover-1 整份（73 行）          ← 纯浪费
      // seq 131  edit handover-1（把「3 条」改成「4 条」）
      // ```
      //
      // **它只是把 `status: draft` 改成了 `authoritative`，正文一个字节都没变**，
      // 却被要求整份重读。而它接下来要编辑的正是正文 —— 正文它明明刚读过。
      //
      // 用户 2026-11-15：
      // > 插件时不时就要 AI 严苛地去按某个规则做，一不小心就碰壁。
      //
      // ---- 为什么"标完仍算读过"是**正确**的，不是偷懒 ----
      //
      // 门禁防的是"**你读过的正文不是磁盘上这一版**"。
      // `doc_mark` 只改 frontmatter 里的一行 state，**正文没动** ——
      // 所以模型对正文的认知仍然准确。让已读失效在这里**不提供任何保护**，
      // 只制造一次重读。
      //
      // ⚠️ 与 `edit` 后失效的区别（这条必须留住）：
      //     `edit` 改的是**正文**，模型的认知确实过时了 → 必须失效。
      //     `doc_mark` 改的是**状态**，正文认知没过时 → 不该失效。
      //
      // ⚠️ 只在本工具**成功写完**之后做，且用**写后的真实指纹**（rescan 已跑完）。
      if (typeof reg.markRead === 'function') {
        try {
          // `entry` 在函数开头（第 241 行）就取好了，这里复用 —— 不新建 helper。
          const absPath = typeof entry?.path === 'string' ? entry.path : entry?.absPath
          if (typeof absPath === 'string' && absPath !== '') {
            reg.markRead(absPath, session, exec?.seq, undefined)
          }
        } catch {
          // 记不上只意味着"下次还要求重读一次"，不影响已写好的事实。
        }
      }

      // ---- 7.6 标绿时 `basis` 还是「未验证」→ **当场说**（第 27 轮反馈 P1）----
      //
      // 缺陷现场：`doc_new` 建出来 `basis: 未验证`；标 `authoritative` 时
      // `doc_mark` 一句话不说，等 `doc_health` 的 **H-5** 才报 ——
      // 而那时 AI **刚标绿、又要再改一轮**（改 basis 用 `edit`，于是已读又失效）。
      //
      // AI 原话：
      // > `doc_mark(status=authoritative)` 遇到 `basis: 未验证` 时，
      // > 要么直接拒（"请先给 basis"），要么允许同时传 `basis` 一次改完。
      //
      // ⇒ 采用**不改行为、只当场告知**的中道（不拒：拒会打挂"先标绿后补 basis"的合法流程）：
      //   在回执里说清"这一步之后 H-5 必报"，并给出**一次做完**的做法。
      //
      // ⚠️ 不做成 error：`doc_mark` 只改状态是有界限的（规则里写着它不改结构字段），
      //    拒它等于把两个工具的职责搅在一起。
      //
      // ---- 2026-11-15 M2.8（第 30 轮 `session-84b1e3ea` 反馈）：**这里曾经自相矛盾** ----
      //
      // 原实现只看 `entry.meta.basis`（**写盘前**的注册表缓存）。
      // 而本次调用可能**刚把 basis 改成了「实测」**（`basis` 参数），
      // 于是回执变成：
      //
      //   已更新 `handover-1` 的 frontmatter：status、basis。
      //   ⚠️ **它的 `basis` 还是「未验证」** —— doc_health 的 H-5 下一步就会报。
      //
      // **同一段话里前后矛盾**。AI 的原话：
      // > `doc_mark` 在成功消息里撒谎 ——「已更新 frontmatter：status、basis」
      // > 紧接着又说「它的 basis 还是『未验证』」。这是自相矛盾的输出。
      // > 不管哪句是真的，这直接摧毁了「读工具输出即可确认」的前提，
      // > 逼我对每次标绿都回读验证。
      //
      // 它为此多读了 2 次文档（seq 87 / 103）。
      //
      // ⇒ 判据要**按"这次调用之后的实际状态"**算：传了 basis 就以参数为准。
      const effectiveBasis = basis !== undefined ? basis : entry?.meta?.basis
      const basisPending = status === 'authoritative'
        && typeof effectiveBasis === 'string'
        && effectiveBasis === '未验证'

      // ---- 8. **标绿快照**（M2.6 · 用户拍板方案 B）----
      //
      // ---- 为什么在这里做（用户原话）----
      //
      // > 不该预设 AI 能预料到自己真的没东西要改。
      //
      // 现有做法是**事前提醒**（"别过早标绿"），它把责任压在「AI 能否准确预见未来」上。
      // 实测（`session-916967d2`）AI 自己承认：「七段全合规、健康度全过，
      // **但有一句话在说假话**」—— 它在标绿之后才去改 read-order。
      //
      // ⇒ 方案 B：**不要求预判，只做事实对账**。
      //   标绿这一刻把「其它文档此刻的指纹」记进 `_artifacts/ddd-mark-snapshots.json`；
      //   之后任何时候都能回答「我标绿时 read-order 是 v3BC5014，现在变了」。
      //
      // ---- 三条纪律 ----
      //
      // 1. **只对 `authoritative` 做**（那是"标绿"的语义）。draft/sealed/void 不需要。
      // 2. **完全静默失败**：快照是辅助信息，写不进去（沙箱/权限/fs 缺失）
      //    绝不能变成"你已经改成功了但工具报错"。与 `rescan` 那条同一个立场。
      // 3. **不进入返回值**：快照是 sidecar，模型要的信息在 `doc_health` 的 H-6 里。
      //    （第一版我把它加进返回值 → output schema 不认 → **整个 doc_mark 报错**，
      //      见下面返回值那里的注释。）
      if (status === 'authoritative') {
        try {
          const root = deps.projectRootOf ? deps.projectRootOf(session) : undefined
          const layout = typeof reg.layoutOf === 'function' ? reg.layoutOf() : undefined
          const artifactsRel = typeof layout?.artifactsDir === 'string' && layout.artifactsDir !== ''
            ? layout.artifactsDir
            : '_artifacts'
          if (typeof root === 'string' && root !== ''
            && typeof fs?.writeText === 'function' && typeof fs?.resolve === 'function') {
            const { snapshotOf, mergeSnapshot, MARK_SNAPSHOT_FILE } = await import('../core/markSnapshot.js')
            const registryEntries = Array.isArray(reg.entries) ? reg.entries : []
            const snapshotPath = `${root}/${artifactsRel}/${MARK_SNAPSHOT_FILE}`.replaceAll('\\', '/')
            // 读旧表（读不到就当空表 —— 第一次标绿时它当然不存在）。
            let existing
            try {
              const readTarget = await fs.resolve(snapshotPath, { cwd: root })
              const text = await fs.readText(readTarget)
              if (typeof text === 'string' && text !== '') existing = JSON.parse(text)
            } catch { existing = undefined }

            const record = snapshotOf({
              id,
              status,
              at: now(),
              refs: registryEntries
                // 只记**受管且能解析出 id** 的其它文档（unmanaged 没指纹，记了也没法对账）。
                .filter((each) => each !== null && typeof each === 'object'
                  && each.unmanaged !== true
                  && typeof each.meta?.id === 'string' && each.meta.id !== ''
                  && each.meta.id !== id)
                .map((each) => ({ id: each.meta.id, fingerprint: String(each.fingerprint ?? '') })),
            })
            const nextTable = mergeSnapshot(existing, record)
            const writeTarget = await fs.resolve(snapshotPath, { cwd: root })
            // ⚠️ 参数形状照抄本文件第 374 行的成功写法（`writeText(target, text, undefined, signal, policy)`）：
            // 第三位是"写入模式"，传 `undefined` = 默认覆盖；传一个不存在的 kind 可能被判成非法。
            await fs.writeText(
              writeTarget,
              `${JSON.stringify(nextTable, null, 2)}\n`,
              undefined,
              exec?.signal,
              { ...sandboxPolicyOf(exec), workspaceRoot: root },
            )
          }
        } catch {
          // 静默失败：见上面纪律 2。
          // （快照写不进去只意味着"下次对账没有基线"，不能影响本次标绿。）
        }
      }

      return {
        id,
        changed: edited.changed ?? [],
        added: edited.added ?? [],
        removed: edited.removed ?? [],
        marked: block !== '',
        indexed,
        // M2.8 第 27 轮：标绿时 `basis` 还是「未验证」→ 提醒一句（不改行为）。
        // ⚠️ 必须在 schema 里声明（`additionalProperties: false`，见下面那段血泪）。
        basisPending,
        // ⚠️ **不要往返回值里加 `snapshotRefs`** —— 2026-11-14 M2.6 血泪：
        //
        // 我第一版加了这个字段，宿主立刻拒绝：
        //   Error: tool "doc_mark" returned invalid output:
        //   "value.snapshotRefs" is not a declared property (additionalProperties: false)
        //
        // 后果（`session-f36fd404`）：**每次标绿都失败**，AI 只能从头再来 ——
        // 那一轮 turn 3 输出 25 038 字符（上一轮 8 657），read 15 次、doc_new 4 次，
        // 用户直接说「反而表现更糟糕了」。
        //
        // 根因：`tools/define-tool.js` 编译出的 output schema 是
        // `additionalProperties: false`，**返回值里多一个键就整个工具报错**。
        // 而快照是 **sidecar 文件**，本来就不需要报告给模型 ——
        // 它要的信息在 `doc_health` 的 H-6 里（事实对账），不在标绿的返回值里。
        //
        // ⇒ 教训：**给工具加返回值字段时，必须同步改 output schema**，
        //   否则不是"多返回一个字段"，而是"这个工具坏了"。
      }
    },
  })
}

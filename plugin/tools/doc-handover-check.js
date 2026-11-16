/**
 * `doc_handover_check` —— 交接校验（**只读**，M1-A）。
 *
 * 为什么它必须是工具（SPEC §2.2 第 3 条，也是 M1-C 成立的前提）：
 * > **它要「拒绝」。「拒绝」是工具返回错误、或 `guard` 返回字符串才能做的事，
 * > 一条 shell 命令拒绝不了模型。**
 *
 * ---- 与 `doc_mark` 的分工（SPEC §4.4 的流程，我按现场情况改了一处）----
 * SPEC 写「`doc_handover_check` 在**写之前**跑」，但它的参数是 `id`（查一份**已存在**的文档）——
 * 没写的文档没法查。所以实际用法是：
 *
 *   1. `doc_new` 建一份 `role: handover` 的 **draft**；
 *   2. **本工具**校验它（这时它已经存在，但还没被标成 authoritative）；
 *   3. `doc_mark` 把它标成 `authoritative`（那一步会**再校验一次**，见 doc-mark.js）。
 *
 * 所以本工具是**预检**，`doc_mark` 里的那次才是硬门禁。
 */

import { defineTool } from './define-tool.js'
import { SECTIONS, checkHandover, handoverListOf, handoverMinOrder, indexDocsOf } from '../core/handover.js'

const DESCRIPTION = [
  '校验一份交接文档（role: handover）是否合格：跑 H1–H7，返回 error / warning 清单。只读，不改任何文件。',
  '七段：我的意图 / 现在到哪了 / 下一刀 / 坑 / 验收 / 刻意没做 / 仍未决。',
  'H3 要求「下一刀」至少有一条含具体路径、工具名或反引号命令——「继续做下一步」这类空话会被拒。',
  // ---- 2026-11-15 M2.8：把 H4 的**完整词表**搬到工具描述里（第 27 轮反馈 P0 第二条）----
  //
  // 缺陷：词表原来只在**校验失败之后**才出现在报错里。模型的处境是"盲猜一个闭集"。
  // 第 27 轮 AI 的原话：
  // > 问题在于**判据是个正则，而我是在盲猜它的词表**。手册给了示例，但示例是开放的，
  // > 我无法确定「符合」算不算——只能写完被打回、再对照报错改。
  // > 这不贵（一轮），但它是纯粹的格式猜谜，不是内容工作。
  //
  // 它写挂的三条正是「`2/2 符合`」「`1/1 已读完`」「复检通过」——
  // 形状全对，只是结果词不在闭集里。**这是纯信息不对称，不该让模型试错。**
  'H4 要求「验收」每一条都带**可核对的证据**，判据认这四类：'
    + '① `seq=` 跟数字；② `session-` 跟 id；③ 算法名 + 至少 8 位十六进制（如 `sha256: a1b2c3d4`）；'
    + '④ `N/N` 后跟**结果词**——只认 `通过` / `命中` / `全绿` / `全过` / `passed` / `tests`，'
    + '**不认** `符合` / `已读完` / `完成` / `OK`。',
  'H4 是最常打回的一条：写完先自查每个验收条目有没有 `N/N + 结果词`。'
    + '例如把「`2/2 符合`」改成「`2/2 通过`」即可（内容不变，只改结果词）。',
  '不填 id 时校验 order 最小的那份（优先 authoritative）。',
].join('')

/**
 * 取全量受管文档的 `{id, status, verifiedAt}`，供 H8 判据用（M1.5 / **D4**）。
 *
 * 为什么给**全部**而不是只给 authoritative：
 * 判据自己有「只查 authoritative」那一句 —— 让判据负责这件事，
 * 调用方只管"把事实交上去"。反过来（调用方先筛）会让判据变成
 * "永远只看到已经符合条件的数据"，那正是 M1 的 H-3 被判"恒真不可达"的成因。
 *
 * @param {Array<object>} entries
 * @returns {Array<{id: string, status: string, verifiedAt: string|undefined}>}
 */
export function verifiedDocsOf(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.hasError !== true)
    .filter((entry) => typeof entry?.meta?.id === 'string' && entry.meta.id !== '')
    .map((entry) => ({
      id: entry.meta.id,
      status: entry.meta.status,
      verifiedAt: typeof entry.meta.verifiedAt === 'string' ? entry.meta.verifiedAt : undefined,
    }))
}

/**
 * 把 frontmatter 里的值收成一个日期串；不是 `YYYY-MM-DD` 就返回 undefined。
 *
 * **不猜**：拿不到就 undefined → H8 整段跳过（交接 §3.6 对 D6 的同一条要求）。
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function dateOf(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined
}

/**
 * 在注册表里挑一份交接文档。
 *
 * **SPEC 原文是「order 最小的那份」**，但 dogfood 里那样会选中一份 `superseded` 的旧交接
 * （`order: 20` 的 `handover-to-tier2`）。所以优先取 `authoritative`，没有再退回 order 最小。
 * 这是 README 订正清单第 9 条。
 *
 * @param {Array<object>} entries
 * @param {string} [id]
 * @returns {{entry?: object, reason?: string}}
 */
export function pickHandover(entries, id) {
  const list = Array.isArray(entries) ? entries : []
  const handovers = list.filter((entry) => entry?.meta?.role === 'handover' && typeof entry.meta.id === 'string')

  if (typeof id === 'string' && id !== '') {
    const found = handovers.find((entry) => entry.meta.id === id)
    if (found === undefined) {
      const known = handovers.map((entry) => entry.meta.id).join('、')
      return { reason: `找不到 id 为 \`${id}\` 的交接文档。项目里的交接有：${known === '' ? '（一份都没有）' : known}` }
    }
    return { entry: found }
  }

  if (handovers.length === 0) {
    return { reason: '项目里没有任何 role: handover 的文档。先用 doc_new 建一份（role 选 handover）。' }
  }

  const orderOf = (entry) => (typeof entry.meta.order === 'number' ? entry.meta.order : Number.MAX_SAFE_INTEGER)
  const authoritative = handovers.filter((entry) => entry.meta.status === 'authoritative')
  const pool = authoritative.length > 0 ? authoritative : handovers
  pool.sort((a, b) => (orderOf(a) - orderOf(b)) || String(a.meta.id).localeCompare(String(b.meta.id)))
  return { entry: pool[0] }
}

/**
 * 建工具。
 * @param {object} deps
 * @param {object} deps.config
 * @param {(session: object|undefined) => object|undefined} deps.registry
 * @returns {object}
 */
export function createHandoverCheckTool(deps) {
  const { config, registry, logger } = deps

  return defineTool({
    name: 'doc_handover_check',
    description: DESCRIPTION,
    parameters: {
      id: {
        type: 'string',
        description: '要校验的交接文档 id。不填则取 order 最小的那份（优先 authoritative）。',
      },
      // ---- 2026-11-15 M2.8：**落笔前预检**（第 28 轮反馈）----
      //
      // AI 把这条称为"自指悖论"，并如实承认：
      // > §5 里那条「`doc_handover_check` 复检 `7/7 通过`」，我是**先写进正文、后跑校验**的。
      // > 它最后确实通过了，但写下那一刻它还不是事实。
      // > 这条正是技能里说「H1–H7 查结构不查真实性」的那个洞。
      //
      // **但它其实不是悖论，是缺一个入口。**
      // `checkHandover` 是**纯函数**（实测：对一段纯文本 body 直接调用就能出结果），
      // 它根本不需要文件先存在。所以「先写后验」不是工具限制，是**没有别的路可走**。
      //
      // ⇒ 给一个 `body` 参数：把**打算写的正文**直接送来预检。
      //   这样「§5 说 7/7 通过」可以在 **`doc_new` 之前**就被验证 ——
      //   顺序变成：写草稿 → `doc_handover_check({body})` → 改 → 一次 `doc_new` 定稿。
      //
      // ⚠️ 传了 `body` 就**不看磁盘**（`id` 会被忽略）：这是"预检一个尚未存在的文档"。
      body: {
        type: 'string',
        description: '（可选）要预检的**交接正文**（还没落盘的那种）。'
          + '传了它就只校验这段文本、不看磁盘 —— 用于在 doc_new 之前先把 §5 证据写对。',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          errors: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                rule: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
          },
          warnings: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                rule: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
          },
          sections: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer', required: true },
                label: { type: 'string', required: true },
                found: { type: 'boolean', required: true },
                title: { type: 'string', required: true },
              },
            },
          },
          stats: {
            type: 'object',
            required: true,
            properties: {
              sectionsFound: { type: 'integer', required: true },
              sectionsTotal: { type: 'integer', required: true },
              concreteActions: { type: 'integer', required: true },
              acceptanceItems: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.ok === true && value.warnings.length === 0) {
          return [{
            type: 'text',
            text: `交接 \`${value.id}\` 通过了 H1–H7（${value.stats.sectionsFound}/7 段齐全，`
              + `${value.stats.concreteActions} 条具体动作，${value.stats.acceptanceItems} 条验收）。可以交接。`,
          }]
        }
        const blocks = []
        if (value.errors.length > 0) {
          // ---- 2026-11-15 M2.8（用户拍板）：**「不能交接」这句话是假的** ----
          //
          // M2.7 的 `b3be171` 删掉了 `doc_mark` 标绿时的 H1–H7 硬门禁
          // （`tools/doc-mark.js` 第 5 步「不再校验」）。所以现在**没有任何 `if`**
          // 会因为"交接不合格"而阻止标绿 —— 而这里仍在说「不合格，不能交接」。
          //
          // 危害：模型读到"不能交接"会去反复改交接（M2.6 实测连建 4 份、44 步、
          // 最后被用户中止），或者干脆卡住不动。**它被一句不存在的约束拦住了。**
          //
          // ⇒ 改成如实说明：这些是 error 级**发现**，但不阻断落盘；
          //    要不要改由模型自己判断（架构分析 §5 的「报事实，不判决」）。
          //
          // ⚠️ 仍然保留 `[规则号] 消息` 的格式：它是"改什么"的唯一指引。
          blocks.push(
            `交接 \`${value.id}\` 有 ${value.errors.length} 条**严重**发现（error 级）：`,
            ...value.errors.map((item) => `- [${item.rule}] ${item.message}`),
            '',
            '⚠️ **它不阻断任何操作**：M2.7 起标 `authoritative` 不再校验交接结构，'
              + '你可以直接 `doc_mark` 标绿。',
            '但这些是**真的问题**（不是风格意见），建议**原地 `edit`** 改完再标绿：'
              + '下一位接手者读到的就是这份交接。',
          )
          // ---- M2.3 演练复盘 D2：告诉它"改"的正确姿势 ----
          //
          // 2026-11-14 实机（session-10f26ffe）：AI 被拒后**又建了一份**，
          // 用户以为这是 AI 不懂规矩。核实后：**新建就是正确做法**
          // （`doc_new` 会自动把旧的标 superseded），但插件从没说过，
          // 所以 AI 是猜对的。这里把推荐路径写明，省一轮摩擦。
          //
          // ---- 2026-11-14 M2.6：**别重写，draft 直接改** ----
          //
          // 这段原来是「交接是一次性文档 → 用 doc_new 建一份新的，不要 edit 旧的」。
          // 在"改一个错"的场景下代价过大：每修一行就要重写 3000 字。
          // 实测（`session-e951840c`）AI 连建 4 份交接、44 步、最后被用户中止。
          //
          // 用户拍板：**draft 状态的交接允许 edit**（`core/gate.js` 已放开）。
          // 所以修法改成"先原地改，改完再定稿"。
          blocks.push(
            '',
            '**修法（先看这一条）**：**直接 `edit` 这份交接**，把上面列出的问题一次改完。',
            '',
            '⚠️ **任何状态都可以 edit**（包括已标 `authoritative` 的）—— '
              + '不要为了改一行就重写一整份新的。实测有会话因此连建 4 份交接、44 步、'
              + '最后被用户中止；另有一次因为"已定稿不能改"陷入 33 000 字的往返思考。',
            '',
            '新建才需要 `doc_new`（它会自动把旧交接标 `superseded` 并链到新版），'
              + '但那是"换一代"，不是"改一个错"。',
            // ---- 2026-11-15 M2.8（用户拍板）：**删掉"先打草稿"那句** ----
            //
            // 原文：「⚠️ 更省事的做法：**先在 `_artifacts/handover-draft.md` 打草稿**
            //       （那里门禁不拦、不进索引），自查 §5 每条都有证据之后，再 `doc_new` 一次定稿。」
            //
            // 三处都不对：
            //   ① **时机倒置**：这句话出现在"交接已经建好了、校验没过"的场景里，
            //      此时叫人回去打草稿再 `doc_new`，等于把已完成的事推倒重做 ——
            //      与上面那句「直接 edit，不要重写整份」**直接矛盾**。
            //   ② **前提消失了**：打草稿是为了绕开「edit 交接被锁死」，
            //      而 `core/roles.js` 现在是 `handover: { write: DENY, edit: ALLOW }`。
            //   ③ **实测没人执行**（第 24 轮 `session-5b5f5c68`）：AI 计划打草稿，
            //      最后一次都没写；它自述「交接草稿直接一次成稿，没有反复重建」。
            //
            // ⇒ 提示一条没人执行、且与上下文矛盾的对策，只会制造犹豫。
            '⚠️ **别过早标 `authoritative`**：标绿之后如果还要改别的文档（比如 `read-order`），'
              + '你交接 §5 里写的哈希就会过时。虽然现在允许改回来，但那要多一轮返工。',
          )
        }
        if (value.warnings.length > 0) {
          const head = value.errors.length > 0 ? '另外还有' : '通过，但有'
          blocks.push(
            `${head} ${value.warnings.length} 条提醒：`,
            ...value.warnings.map((item) => `- [${item.rule}] ${item.message}`),
          )
        }
        const missing = value.sections.filter((section) => section.found !== true)
        if (missing.length > 0) {
          blocks.push(`缺失段落：${missing.map((section) => `§${section.index} ${section.label}`).join('、')}`)
        }
        return [{ type: 'text', text: blocks.join('\n') }]
      },
    },
    execute: async (args, exec) => {
      // S2 执行期兜底（见 tools/when.js）。
      await deps.assertAllowed?.(exec)

      const session = exec?.agent?.session
      const reg = typeof registry === 'function' ? registry(session) : registry
      if (reg === undefined || reg === null) {
        throw new Error('DDD 注册表还没就绪：这个会话不是 DDD 项目，或扫描失败了。')
      }

      const picked = pickHandover(reg.entries ?? [], args?.id)

      // ---- 2026-11-15 M2.8：`body` 预检（落笔前就能验证据形状）----
      //
      // 传了 `body` 就**不看磁盘**，只验这段文本。
      // 语义：模型打算写这份交接，但还没 `doc_new`。
      //
      // 这样 §5 里"`doc_handover_check` 复检 7/7 通过"就可以**先验后写**，
      // 不再需要"先写一句可能为假的话、再跑一次看它成真没有"。
      //
      // ⚠️ `meta` 用一个最宽松的假值：预检的是**正文**，不是 frontmatter。
      //    order 取"当前最小 handover order − 10"，这样 H7（order 必须最小）不会误报
      //    —— 预检阶段还没有 order 呢，报它没有意义。
      const draftBody = typeof args?.body === 'string' ? args.body : undefined
      if (draftBody !== undefined) {
        const minOrder = handoverMinOrder(reg.entries)
        const handovers = handoverListOf(reg.entries)
        const preflight = checkHandover({
          meta: {
            id: typeof args?.id === 'string' && args.id !== '' ? args.id : '(预检)',
            role: 'handover',
            order: (typeof minOrder === 'number' ? minOrder : 0) - 10,
            status: 'draft',
          },
          body: draftBody,
          context: {
            minOrder: (typeof minOrder === 'number' ? minOrder : 0) - 10,
            handovers,
            strict: config.handoverCheckStrict,
            indexDocs: indexDocsOf(reg.entries),
            verifiedDocs: verifiedDocsOf(reg.entries),
            handoverCreatedAt: undefined,
          },
        })
        logger?.debug?.(`[ddd] doc_handover_check 预检：${preflight.errors.length} error / ${preflight.warnings.length} warn`)
        // ⚠️ 返回形状必须与下面那条正式路径**完全一致**（schema 是 required 的）——
        //    少一个键宿主就拒整个调用（M2.6 的血泪）。
        return {
          ok: preflight.ok,
          id: typeof args?.id === 'string' && args.id !== '' ? args.id : '(预检)',
          errors: preflight.errors.map((item) => ({ rule: item.rule, message: item.message })),
          warnings: preflight.warnings.map((item) => ({ rule: item.rule, message: item.message })),
          sections: SECTIONS.map((spec) => {
            const found = preflight.sections[spec.key]?.found === true
            return {
              index: spec.index,
              label: spec.label,
              found,
              title: found ? String(preflight.sections[spec.key].title ?? '') : '',
            }
          }),
          stats: {
            sectionsFound: preflight.stats.sectionsFound,
            sectionsTotal: preflight.stats.sectionsTotal,
            concreteActions: preflight.stats.concreteActions,
            acceptanceItems: preflight.stats.acceptanceItems,
          },
        }
      }

      if (picked.entry === undefined) throw new Error(picked.reason ?? '找不到要校验的交接文档。')
      const target = picked.entry

      // H7 要「当前最小的 **handover** order」（M1.5 / N5）。
      // ⚠️ M1 这里扫的是**全部条目**：只要项目里有 `order: 0` 的非交接文档（如 `read-order`），
      // 所有交接就永远报 H7 —— 一条永远无法满足的警告。口径由 `handoverMinOrder` 统一。
      const minOrder = handoverMinOrder(reg.entries)
      const handovers = handoverListOf(reg.entries)

      const verdict = checkHandover({
        meta: target.meta,
        body: target.body ?? '',
        context: {
          minOrder,
          handovers,
          strict: config.handoverCheckStrict,
          // M1.5 / N8 辅修法：§1 的内容判据要拿项目里的索引文档来比。
          indexDocs: indexDocsOf(reg.entries),
          // M1.5 / D4（H8）：`verifiedAt` 的新鲜度判据。
          // `verifiedDocs` 给全量受管文档（判据自己筛 authoritative）。
          verifiedDocs: verifiedDocsOf(reg.entries),
          // ---- 「本交接的创建时间」从哪来（**一处刻意的语义近似**）----
          //
          // 交接文档的 frontmatter 里**没有**「创建时间」字段，而且**不该加**：
          //   - 加它就是改 schema（`REQUIRED_FIELDS` 之外的新必填字段 → 现存文档全挂）；
          //   - 若由 `doc_new` 自动写时间，索引块的 digest 里会含时间戳 →
          //     每轮渲染都可能变 → **违反 M0-5 红线**（索引块不许含快变量）。
          //
          // 所以这里用**交接文档自己的 `verifiedAt`** 当"本交接成立于哪一天"。
          // 语义上说得通：交接写的那天，就是作者认为"当前状态已确认"的那天。
          // **代价**：交接没写 `verifiedAt` → H8 整段跳过（不猜）。
          // 这是 D4 的**已知限制**，已记进 README。
          handoverCreatedAt: dateOf(target.meta?.verifiedAt),
        },
      })

      // ---- 2026-11-14 M2.6：**H10 已删除**（它自己制造了死锁）----
      //
      // 我上一轮加的 H10 是：入口索引的 `order` 不比这份交接小 → warn。
      // **它的判据方向错了**，实测（`session-e951840c`）导致无限后退：
      //
      //   交接 order=-10 → read-order=0  → 报
      //   AI 把 read-order 改到 -30，交接 order=-40 → **仍然报**
      //   AI 再把 read-order 改到 -60，交接 order=-70 → **仍然报**
      //
      // 根因：`doc_new` 建交接时 order 永远取「最小 handover order − 10」，
      // 所以**交接的 order 每轮都在变小**；而 H10 要求 read-order 比它更小。
      // 这是一场**双方无限后退的军备竞赛** —— 判据永远满足不了。
      //
      // 这正是本项目反复批评的形态：「一个永远无法满足的警告，
      // 会让所有警告都变得可疑」（`core/handover.js` 里 D9 的注释原文）。
      //
      // ---- 换成什么 ----
      //
      // 真正想抓的是「交接建完了，但这一轮压根没碰阅读顺序」。
      // 那件事**已经由 `doc_new` 的建交接提示**说清了（事前告知），
      // 且【怎么做】行每轮都出现。
      //
      // 而"是否真的改过"需要**会话级**信息（这一轮动过哪些文件），
      // 这个工具拿不到（它只看注册表快照）。**没有可靠判据就不加判据** ——
      // 编一个"看起来能报"的，比不报更糟。
      //
      // ⇒ 删除。如果将来要做，应当在 host 侧记「本会话 edit 过哪些 role: index 文档」，
      //   而不是从 order 数值大小去猜。

      return {
        ok: verdict.ok,
        id: target.meta.id,
        errors: verdict.errors.map((item) => ({ rule: item.rule, message: item.message })),
        warnings: verdict.warnings.map((item) => ({ rule: item.rule, message: item.message })),
        sections: SECTIONS.map((spec) => {
          const found = verdict.sections[spec.key]?.found === true
          return {
            index: spec.index,
            label: spec.label,
            found,
            title: found ? String(verdict.sections[spec.key].title ?? '') : '',
          }
        }),
        stats: {
          sectionsFound: verdict.stats.sectionsFound,
          sectionsTotal: verdict.stats.sectionsTotal,
          concreteActions: verdict.stats.concreteActions,
          acceptanceItems: verdict.stats.acceptanceItems,
        },
      }
    },
  })
}

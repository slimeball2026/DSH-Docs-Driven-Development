/**
 * M2-D 交付成品的**真源**（纯函数 + 一个注入式扫描器）。
 *
 * ---- R-10 说"判定链是空的"，到底空在哪 ----
 *
 * SPEC §11 R-10：
 * > 「这个文件被 `present` 过」**没有**落成 host 可查的事实：
 * > `present` 工具存在、`dsh-deliverable-file-references` 包存在，
 * > 但**两者之间的桥没有**。
 *
 * 我核实了这条桥在哪里 —— **它在会话事件流里**：
 *
 * | 来源 | 内容 |
 * |---|---|
 * | `@deepseek-ai/dsh-tool-present/lib/index.js:119` | `session.append('deliverables/presented', { turn, callId, files })` |
 * | `dsh-client-ui-deliverables` README | 客户端就是折叠这个事件来渲染交付卡片的 |
 *
 * 所以桥**存在**，只是**没有文档化的 host API**。本文件就是那座桥：
 * 从会话事件流里折叠 `deliverables/presented`，得到"已声明的路径集合"。
 *
 * ⚠️ **这是本切片里第二处"照实现反推契约"的地方**（第一处是预览地址格式）。
 * 如果 DSH 改了事件名或载荷形状，`presented` 会静默变成"全都是未声明"——
 * 那个症状**不会报错**，只会让每一格都显示「未声明」。
 * 所以 M2-9 的验收必须**真的构造一个未 present 的文件**，不能只看代码。
 */

/**
 * 从会话事件里折叠出「被 `present` 过的绝对路径」集合。
 *
 * 事件形状（`dsh-tool-present/lib/index.js:119`）：
 * ```js
 * session.append('deliverables/presented', { turn, callId, files })
 * ```
 * 其中 `files` 是 `Array<{ path: string, description?: string }>`，
 * `path` 是**绝对路径**（README：「新声明保存绝对路径」）。
 *
 * @param {Array<object>} events 会话事件（`session.snapshotEvents()` 或 `.ownEvents()`）
 * @returns {Set<string>} 归一化后的绝对路径（小写、`/` 分隔）
 */
export function presentedPathsOf(events) {
  const found = new Set()
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'deliverables/presented') continue
    const files = Array.isArray(event?.data?.files) ? event.data.files : []
    for (const file of files) {
      const path = typeof file?.path === 'string' ? file.path : ''
      if (path === '') continue
      found.add(normalizePath(path))
    }
  }
  return found
}

/**
 * 路径归一化：**只为比较**，不改原值。
 *
 * Windows 上大小写不敏感，且分隔符可能是 `/` 或 `\`。
 * 这里统一成小写 + `/`；展示时仍用原始路径。
 *
 * @param {string} path
 * @returns {string}
 */
export function normalizePath(path) {
  return String(path ?? '').replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 把 `deliverables/` 的目录项折成 UI 的网格数据。
 *
 * ⚠️ **`presented` 必须是真事实**，不能猜。三种情况：
 * 1. 事件里**有**这个路径 → `presented: true`；
 * 2. 事件里没有 → `presented: false`（显示「未声明」）；
 * 3. **拿不到会话事件**（session 找不到 / 没有 `snapshotEvents`）→ 也是 `false`，
 *    但**同时要给出 `presentedKnown: false`**，让 UI 能说清
 *    "不知道有没有声明"，而不是谎称"确定没声明"。
 *
 * @param {object} input
 * @param {Array<{name: string, type: string, size?: number, mtime?: number}>} input.items 目录项
 * @param {string} input.dirAbs `deliverables/` 的绝对路径
 * @param {Set<string>} [input.presented] 已声明路径集合
 * @param {boolean} [input.presentedKnown] 事件是否取到了
 * @returns {Array<object>}
 */
export function deliverablesOf(input) {
  const opts = input !== null && typeof input === 'object' ? input : {}
  const items = Array.isArray(opts.items) ? opts.items : []
  const dirAbs = typeof opts.dirAbs === 'string' ? opts.dirAbs : ''
  const presented = opts.presented instanceof Set ? opts.presented : new Set()
  const known = opts.presentedKnown === true

  return items
    .filter((item) => item?.type !== 'dir')
    .map((item) => {
      const name = typeof item?.name === 'string' ? item.name : ''
      // 用注入的 join 语义拼（避免 import node:path —— server/ 不许碰内置模块）
      const abs = dirAbs === '' ? name : `${dirAbs.replace(/[\\/]+$/, '')}/${name}`
      return {
        path: abs,
        presented: known ? presented.has(normalizePath(abs)) : false,
        presentedKnown: known,
        size: typeof item?.size === 'number' ? item.size : 0,
        mtime: typeof item?.mtime === 'number' ? item.mtime : 0,
      }
    })
    .sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * 从正文的 `<!-- ddd:mark ... -->` 标记块里取 `reason`（M2.5 · W8 修）。
 *
 * ---- 为什么需要这个函数 ----
 *
 * `doc_mark` 把 reason 写进**正文的标记块**（`tools/doc-mark.js` 的 `markBlock`），
 * 而 `graveyardCandidatesOf` 原来去 `entry.meta.reason` 找 —— 那个字段**永远不存在**
 * （frontmatter 里没有 `reason`）。
 *
 * 后果：待归档清单里每条都显示「⚠️ 没有理由」，而 AI 明明给了理由。
 * 这正是 SPEC §8.4 M2-5c 要防的状态：「没有理由的提议等于没提议」。
 *
 * 实测证据（`_m23/verify-w8-proposal.mjs`）：
 *
 *   doc_mark 写入：`<!-- ddd:mark 2026-11-14 status=void reason="已被 w8-new 取代…" -->`
 *   meta.reason ：`undefined`
 *   旧实现返回 ：`reason: ""`   ← UI 会显示「⚠️ 没有理由」
 *
 * ---- 取哪一条 ----
 *
 * 一份文档可能被 mark 过多次（先 sealed 再 void，或改过 reason）。
 * 取**最后一条**带 reason 的块 —— 它代表最新一次判断。
 *
 * @param body 文档正文（不含 frontmatter）
 * @returns reason；找不到时为空串（**绝不编一个**）
 */
export function markReasonOf(body: unknown): string {
  if (typeof body !== 'string' || body === '') return ''
  // 全局匹配所有标记块，取最后一个带 reason 的。
  const blocks = body.match(/<!--\s*ddd:mark\b[\s\S]*?-->/g)
  if (blocks === null) return ''
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const match = /reason="([^"]*)"/.exec(blocks[index])
    if (match === null) continue
    // 还原 `markBlock` 的转义（`-->` 被写成 `-- >`），并去掉首尾空白。
    const reason = match[1].replace(/-- >/g, '-->').trim()
    if (reason !== '') return reason
  }
  return ''
}

/**
 * 待归档候选（M2-E）：`status: void` 的文档。
 *
 * ⚠️ **`reason` 是必需字段的语义**（SPEC §8.4 M2-5c：
 * 「没有理由的提议等于没提议」）。取不到就用空串，
 * **不编一个理由** —— UI 会把空 reason 显示成「⚠️ 没有理由」，
 * 那是在提醒"AI 该给理由"，而不是假装有理由。
 *
 * ⚠️ **M2.5 修**：原来只读 `meta.reason`（永远不存在），
 * 现在优先读正文标记块（`doc_mark` 真正写的地方），`meta.reason` 作为兼容兜底。
 *
 * @param {Array<object>} entries 注册表条目
 * @returns {Array<{id: string, summary: string, status: string, reason: string}>}
 */
export function graveyardCandidatesOf(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.meta?.status === 'void' && entry?.inGraveyard !== true)
    .map((entry) => {
      // 优先 frontmatter 显式声明的 reason（有人手写），否则读正文标记块。
      const declared = typeof entry?.meta?.reason === 'string' ? entry.meta.reason.trim() : ''
      return {
        id: typeof entry?.meta?.id === 'string' ? entry.meta.id : '',
        summary: typeof entry?.meta?.summary === 'string' ? entry.meta.summary : '',
        status: 'void',
        reason: declared !== '' ? declared : markReasonOf(entry?.text ?? entry?.body),
      }
    })
    .filter((item) => item.id !== '')
    .sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * 坟场清单（M2-E）：`docs/_graveyard/` 下的文件。
 *
 * ⚠️ 归档**不是删除**：这些文件仍占磁盘、仍进 git。
 *
 * @param {Array<{name: string, type: string, mtime?: number}>} items
 * @param {string} graveyardDir 相对项目根的坟场目录（`docs/_graveyard`）
 * @returns {Array<{path: string, archivedAt: number}>}
 */
export function graveyardOf(items, graveyardDir) {
  const dir = typeof graveyardDir === 'string' && graveyardDir !== '' ? graveyardDir : 'docs/_graveyard'
  return (Array.isArray(items) ? items : [])
    .filter((item) => item?.type !== 'dir')
    .map((item) => ({
      path: `${dir}/${typeof item?.name === 'string' ? item.name : ''}`,
      archivedAt: typeof item?.mtime === 'number' ? Math.floor(item.mtime / 1000) : 0,
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

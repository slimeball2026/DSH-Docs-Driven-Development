/**
 * M2.8 · 交接 ↔ `read-order` 的循环依赖，自动登记（用户 2026-11-15 拍板「1 要修」）。
 *
 * ---- 要解决的到底是什么 ----
 *
 * 两条要求**在时间上不可能同时满足**：
 *   ① `read-order` 的必读清单里要列出**交接自己**；
 *   ② 交接正文里每句「已完成 X」，在**落笔那一刻**必须是真的。
 *
 * 于是模型只有三种选择，**全都有代价**：
 *   · 先建交接 → 交接里说"索引已更新"是**假话**，然后再补清单；
 *   · 先改清单 → 引用一个**还不存在**的 id（悬空），再建交接；
 *   · 两头都不写死 → 在交接里留一句"待补"，交接就不是完成了。
 *
 * ---- 代价有多大（两次实测）----
 *
 * 第 24 轮 `session-5b5f5c68`：AI 在 turn 3 的**第一步**输出 **10 879 字符**，
 *   只调了 2 个工具 —— 内容全是这个循环的自我推演，它自己否决了 6 个方案
 *   （「Hmm messy」「Honestly…」「OK final decision…」「You know, I'll just…」）。
 * 第 25 轮 `session-18b07bcb`：AI 在反馈里把它列为**第二难的步骤**：
 *   > 我选了最糟的中间方案（先建交接再补清单）——交接诞生时就带了一句假话。
 *
 * ---- 为什么由 `doc_new` 来做 ----
 *
 * 它是**唯一知道新交接 id 的那一刻**（id 是它生成的）。而且它已经在做同性质的事：
 * 自动标旧交接 `superseded`（`supersedeOldHandovers`）—— 那件事同样
 * "只有 doc_new 知道答案，让模型手动补就等于每次留一个坑"。
 *
 * ---- 边界（不许越界）----
 *
 * · **只动 `role: index` 文档的「必读清单」小节**，正文其它部分一个字节不动；
 * · **只在建 `role: handover` 时做**，建 spec/decision 等一概不碰；
 * · **找不到 `## 必读清单` 就不写**（不同项目的索引正文结构可能不同，不猜）；
 * · **失败只 warn**：登记失败不能连累"交接已建好"这个事实
 *   （与 `supersedeOldHandovers` 同一立场：优化 vs 事故，不能同级）。
 */

/** 必读清单小节标题（与 `server/init-workspace.ts` 生成的一致）。 */
const LIST_HEADING = '## 必读清单'

/**
 * 在 `read-order` 正文的「必读清单」里插入/更新一行交接条目。
 *
 * **纯函数**：给正文和要写的内容，返回新正文（或 undefined = 不改）。
 *
 * 行为：
 *   · 清单里**已经提到**这个 id → **不改**（模型可能已经写得更详细，别覆盖它的措辞）；
 *   · 清单是**空的（占位符）** → 替换占位符；
 *   · 否则 → 插到清单**第一条**（交接的 `order` 最小，本来就该排第一）。
 *
 * @param {object} input
 * @param {string} input.text `read-order` 的整份正文（含 frontmatter）
 * @param {string} input.id 新交接的 id
 * @param {number} input.order 新交接的 order
 * @param {string} [input.summary] 新交接的 summary（写进"为什么读它"）
 * @returns {{text: string, changed: boolean, reason: string}}
 */
export function registerHandoverInIndex(input) {
  const opts = input !== null && typeof input === 'object' ? input : {}
  const text = typeof opts.text === 'string' ? opts.text : ''
  const id = typeof opts.id === 'string' ? opts.id.trim() : ''
  const order = typeof opts.order === 'number' && Number.isFinite(opts.order) ? opts.order : undefined
  const summary = typeof opts.summary === 'string' ? opts.summary.trim() : ''

  const no = (reason) => ({ text, changed: false, reason })

  /** 数一遍清单里有几条真正的列表项（用来告诉模型"条数变了"）。 */
  const countItems = (list) => list.filter((line) => (
    /^\s*(?:\d+\.|[-*])\s+\S/.test(line) && !/^\s*<!--/.test(line)
  )).length

  if (text === '') return no('索引正文是空的')
  if (id === '') return no('没有 id')

  const lines = text.split(/\r?\n/)
  const headIndex = lines.findIndex((line) => line.trim() === LIST_HEADING)
  if (headIndex < 0) return no('索引里没有「必读清单」小节（不猜结构）')

  // 小节范围：从标题下一行到下一个 `## ` 标题（或文件末尾）。
  let endIndex = lines.length
  for (let i = headIndex + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) { endIndex = i; break }
  }
  const body = lines.slice(headIndex + 1, endIndex)

  // ---- ① 已经提到这个 id → 不改 ----
  //
  // 用「反引号包住 id」或「裸 id 出现在列表行」两种形态都算提到。
  // 保守判：只要该 id 作为独立 token 出现过就算 —— 宁可不动，也不覆盖模型写好的措辞。
  const idToken = new RegExp(`(^|[^A-Za-z0-9_-])${escapeRe(id)}([^A-Za-z0-9_-]|$)`)
  if (body.some((line) => idToken.test(line))) {
    return no(`必读清单里已经有 \`${id}\`，不覆盖模型写的措辞`)
  }

  const orderText = order === undefined ? '' : `，order ${order}`
  const why = summary === '' ? '本轮交接：先读它，再开工。' : `本轮交接 —— ${summary}`
  const entry = `1. \`${id}\`（${orderText.replace(/^，/, '') || 'order 最小'}，handover）—— **先读这份**。${why}`

  // ---- ② 空清单（初始化占位符）→ 替换占位符 ----
  const countBefore = countItems(body)
  const placeholderIndex = body.findIndex((line) => /^\s*[-*]\s*（还没有必读文档/.test(line))
  if (placeholderIndex >= 0) {
    body[placeholderIndex] = entry
    const next = [...lines.slice(0, headIndex + 1), ...body, ...lines.slice(endIndex)]
    return {
      text: next.join('\n'), changed: true,
      reason: '把初始化占位符换成了交接条目',
      countBefore, countAfter: countItems(body),
    }
  }

  // ---- ③ 插到清单第一条 ----
  //
  // 找第一条真正的列表项（`1.` / `-` / `*` 开头，且不是注释）。
  const firstItem = body.findIndex((line) => /^\s*(?:\d+\.|[-*])\s+\S/.test(line) && !/^\s*<!--/.test(line))

  // 已有的编号列表要整体 +1，否则会出现两个 `1.`（Markdown 会自己重排，
  // 但源码里两个 1 会让下一位读者以为写错了）。
  const renumber = (list, fromIndex) => {
    for (let i = fromIndex; i < list.length; i += 1) {
      const matched = /^(\s*)(\d+)\.(\s+)/.exec(list[i])
      if (matched === null) continue
      list[i] = `${matched[1]}${Number(matched[2]) + 1}.${matched[3]}${list[i].slice(matched[0].length)}`
    }
  }

  if (firstItem < 0) {
    // 清单里没有任何条目（但有别的内容，比如"按 order 升序："这种引导句）→ 追加到末尾
    body.push('', entry)
    const next = [...lines.slice(0, headIndex + 1), ...body, ...lines.slice(endIndex)]
    return {
      text: next.join('\n'), changed: true,
      reason: '必读清单原本为空，追加了交接条目',
      countBefore, countAfter: countItems(body),
    }
  }

  renumber(body, firstItem)
  // 插在引导语之后、第一条之前；保留引导语自己的空行
  let insertAt = firstItem
  while (insertAt > 0 && body[insertAt - 1].trim() === '') insertAt -= 1
  body.splice(insertAt, 0, entry)

  const next = [...lines.slice(0, headIndex + 1), ...body, ...lines.slice(endIndex)]
  return {
    text: next.join('\n'), changed: true,
    reason: '把交接插到了必读清单第一条',
    countBefore, countAfter: countItems(body),
  }
}

/** 正则转义（只处理 id 里可能出现的字符）。 */
function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 执行登记：读 `read-order` → 改 → 写回。
 *
 * **永不抛**：任何失败都折成 `{ changed: false, reason }`，
 * 因为"索引没登记上"是**优化失败**，"交接建好了"是**事实**，两者不能同级。
 *
 * @param {object} input
 * @param {object} input.reg 注册表
 * @param {object} input.fs `ctx.fs`
 * @param {object} [input.session]
 * @param {object} [input.exec]
 * @param {string} input.selfId 新交接的 id
 * @param {number} input.order 新交接的 order
 * @param {string} [input.summary]
 * @param {string} input.projectRoot
 * @param {object} [input.logger]
 * @returns {Promise<{changed: boolean, reason: string, path?: string}>}
 */
export async function registerHandoverInIndexFile(input) {
  const opts = input !== null && typeof input === 'object' ? input : {}
  const { reg, fs, session, exec, selfId, order, summary, projectRoot, logger } = opts
  const quiet = (reason) => ({ changed: false, reason })

  try {
    if (typeof fs?.readText !== 'function' || typeof fs?.writeText !== 'function' || typeof fs?.resolve !== 'function') {
      return quiet('fs 不可用')
    }
    const entries = Array.isArray(reg?.entries) ? reg.entries : []
    const indexEntry = entries.find((entry) => entry?.meta?.role === 'index' && typeof entry?.path === 'string')
    if (indexEntry === undefined) return quiet('项目里没有 role: index 的文档')

    const original = typeof indexEntry.text === 'string'
      ? indexEntry.text
      : await fs.readText(await fs.resolve(indexEntry.path, { cwd: projectRoot }))
    if (typeof original !== 'string' || original === '') return quiet('读不到索引正文')

    const result = registerHandoverInIndex({ text: original, id: selfId, order, summary })
    if (result.changed !== true) return quiet(result.reason)

    const target = await fs.resolve(indexEntry.path, { cwd: projectRoot })
    await fs.writeText(target, result.text, undefined, exec?.signal, {
      mode: 'workspace-write',
      workspaceRoot: projectRoot,
    })
    // ---- 回传"清单条数变了"（第 27 轮反馈 P0 第一条）----
    //
    // 缺陷现场（`session-6bd267f1`）：
    //   · AI 严格照手册顺序：先定稿 read-order（清单写 3 条）→ doc_health 全过
    //     → 才 `doc_new` 建交接；
    //   · `doc_new` 自动把交接插进清单 → **变成 4 条**；
    //   · 而 AI 交接正文 §2 写的正是「必读清单（3 条）」——
    //     **在我写下的那一刻它就是假的**，而 H1–H7 查不出（只查结构）。
    //
    // AI 原话：
    // > 这不是「把没做的事写成做了」，那种错还能自查；
    // > 这是**你核对过的状态在核对之后被工具改掉了**，
    // > 而手册的顺序规则里没有这一步的位置。
    //
    // ⇒ 工具既然改了别人的文件，就有义务**说清改了什么**。
    return {
      changed: true,
      reason: result.reason,
      path: indexEntry.path,
      countBefore: result.countBefore,
      countAfter: result.countAfter,
    }
  } catch (error) {
    // 静默降级：见文件头的「边界」第 4 条。
    logger?.debug?.(`[ddd] 交接自动登记进索引失败（不影响交接本身）：${error?.message ?? error}`)
    return quiet(`写索引失败：${error?.message ?? error}`)
  }
}

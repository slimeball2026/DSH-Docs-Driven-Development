/**
 * 归档 / 还原的**物理移动**（M2-E）。
 *
 * ---- 这一项的关键不是"移动"，是"谁来移动" ----
 *
 * SPEC §6.5 / M2-Q6 的分工是照架构评审 §3.3 原文执行的：
 *
 * | 谁 | 能做什么 |
 * |---|---|
 * | AI | 标 `status: void` + 写理由。**永远不能移动文件** |
 * | UI（client） | 列出待归档清单、勾选、POST 到 host。**自己碰不到文件** |
 * | 用户 | 勾选 + 点归档/还原 |
 * | 插件（host） | 收到 POST 后走 `ctx.fs` **物理移动**，保留原路径元数据 |
 *
 * 所以本文件是**用户那只手**的落点，不是 AI 的新能力：
 * AI 依然没有任何能移动文件的工具（`Q12`），门禁一行都不用改。
 *
 * ---- 三条硬约束 ----
 *
 * 1. **不许 import `node:` 内置模块**（SPEC §5.3-3）。
 *    `test/decoupling.test.js` 的 `§5.3-3` 会逐字检查 `server/`。
 *    路径运算因此全部用字符串做（与 `server/deliverables.ts` 同一套取舍）。
 * 2. **必须走 `ctx.fs` + 沙箱 policy**（SPEC §5.3-4）。
 *    照抄 `tools/doc-new.js` 的 `sandboxPolicyOf` 语义：**拿不到模式就退回
 *    `workspace-write`，绝不退回 `danger-full-access`**（读不到 ≠ 可以放宽）。
 *    不传 policy 会撞 M1 踩过的 `file access denied` —— 那是**真 bug**，不是配置问题。
 * 3. **失败必须显式**（`ok: false` + 可读原因），不许静默当成成功。
 *    归档是"用户点了一个按钮"，静默失败会让用户以为文件已经进坟场了。
 *
 * ---- 原路径元数据存哪（SPEC R-6，**用户 2026-11-13 拍板：写进文件自己的 frontmatter**）----
 *
 * R-6 给了两个选项并明确要求「施工者必须先给出方案再动手」。选定的是**文件自带**：
 *
 * ```
 * archivedFrom: docs/old-plan.md          ← 还原时放回这里（项目内相对路径，`/` 分隔）
 * archivedAt: "2026-11-13T20:30:00.000Z"  ← 审计线索，人看
 * ```
 *
 * 为什么选它（对另外两个方案的实测性理由）：
 *
 * | 方案 | 代价 |
 * |---|---|
 * | `_artifacts/graveyard.json`（交接的倾向） | **插件从不创建目录**（README L20/L30）。选它就意味着归档时要顺带 mkdir —— 那是 M2 唯一新增的"创建目录"行为，而 `ctx.fs` 根本没有 mkdir（只能靠写占位文件造目录，等于往用户项目里塞垃圾）。另外 JSON 会与磁盘**漂移**：手工挪一个文件，索引就对不上了 |
 * | 编码进文件名（`docs__x.md`） | 零写入，但重名会丢信息、嵌套目录表达不了、文件名难看 |
 * | **文件自带（选定）** | 不建目录、无 sidecar 漂移、随文件一起进 git、还原只读自己就够。代价：schema 多两个"插件私有字段"（见下） |
 *
 * **这两个字段不需要改 schema**：`docs/schema.js` 只校验**已知字段的取值**，
 * 没有"未知字段一律报错"的规则（`V1`–`V12` 都不做这件事）。
 * 所以这里刻意**不往 schema 里加校验**——那只会扩大改动面而不增加安全性。
 * 还原时会**把这两个字段删掉**（`setFrontmatterFields(..., {archivedFrom: null})`），
 * 于是"归档 → 还原"是一个**可逆**操作，文件回到原处时字节层面只差这两个字段。
 *
 * ---- 一个必须说清的边界：只归档 `status: void` ----
 *
 * 本文件**无条件拒绝**归档任何非 `void` 的文档。理由不是安全洁癖，是 M2-5b/5c 的链路：
 *
 * > `void` 是 **AI 的提议**（`doc_mark{status:'void', reason:'…'}`），
 * > 归档是 **用户的决定**。两者之间必须有一个 AI 做不了的动作。
 *
 * 如果归档接受任意文档，这个"提议 → 决定"的两段式就退化成"用户随手把还在用的文档扔了"，
 * 而 `superseded`（自动取代）与 `void`（建议作废）也会被混成一个。
 */

import { setFrontmatterFields } from '../core/frontmatterEdit.js'
import { parseFrontmatter } from '../docs/frontmatter.js'

/** 归档元数据的字段名（`core/frontmatterEdit.js` 的 `KEY_RE` 允许下划线外的写法，这里是驼峰）。 */
export const ARCHIVE_META = Object.freeze({
  /** 归档前的项目内相对路径（`/` 分隔）。还原靠它。 */
  from: 'archivedFrom',
  /** 归档时刻（ISO 字符串，审计用）。 */
  at: 'archivedAt',
})

/** 只有这个状态可以被归档（见文件头「一个必须说清的边界」）。 */
export const ARCHIVABLE_STATUS = 'void'

/**
 * 统一分隔符成 `/`。**只用于比较与拼接**，不改磁盘上的真实路径。
 * @param {unknown} path
 * @returns {string}
 */
export function normalizeSlashes(path) {
  return String(path ?? '').replaceAll('\\', '/')
}

/**
 * 去掉末尾的 `/`（保留根 `/` 与盘符 `C:`）。
 * @param {string} path
 * @returns {string}
 */
function trimTrailingSlash(path) {
  const trimmed = String(path ?? '').replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

/**
 * 拼路径（不 import `node:path` 的代价：自己拼，但只有这一处）。
 * @param {string} base
 * @param {string} relative
 * @returns {string}
 */
export function joinPath(base, relative) {
  const head = trimTrailingSlash(normalizeSlashes(base))
  const tail = normalizeSlashes(relative).replace(/^\/+/, '')
  if (tail === '') return head
  return head === '/' ? `/${tail}` : `${head}/${tail}`
}

/**
 * 取最后一段（文件名）。
 * @param {string} path
 * @returns {string}
 */
export function baseNameOf(path) {
  const parts = normalizeSlashes(path).split('/').filter((segment) => segment !== '')
  return parts.length === 0 ? '' : parts[parts.length - 1]
}

/**
 * 取项目内相对路径。**不在项目根之下就返回空串**（拿不到就不猜）。
 *
 * 大小写处理与 `docs/path.js` 一致：Windows / darwin 上按不敏感比较
 * （NTFS 默认不敏感，`DOCS/x.md` 与 `docs/x.md` 是同一个文件），其余平台保留大小写。
 *
 * @param {string} absPath
 * @param {string} projectRoot
 * @returns {string} 形如 `docs/x.md`；不在根下返回 `''`
 */
export function relativeToRoot(absPath, projectRoot) {
  const root = trimTrailingSlash(normalizeSlashes(projectRoot))
  const full = normalizeSlashes(absPath)
  if (root === '' || full === '') return ''

  const insensitive = isCaseInsensitivePlatform()
  const a = insensitive ? root.toLowerCase() : root
  const b = insensitive ? full.toLowerCase() : full

  if (b === a) return ''
  if (!b.startsWith(a.endsWith('/') ? a : `${a}/`)) return ''
  return full.slice(root.length + (root.endsWith('/') ? 0 : 1))
}

/**
 * 本进程的文件系统是否大小写不敏感。
 *
 * 口径与 `docs/path.js` 的 `CASE_INSENSITIVE_FS` **完全一致**（那边也在用 `process.platform`）：
 * Windows / darwin 默认不敏感，其余平台敏感。
 *
 * `server/` 的禁令是**不许 import `node:` 内置模块**（SPEC §5.3-3），
 * 而 `process` 是全局对象、不是模块 —— 读它的 `platform` 不绕过任何沙箱政策，
 * 只是"这个平台怎么比路径"的纯信息。这也正是 `decoupling.test.js` 检查的边界。
 *
 * @returns {boolean}
 */
function isCaseInsensitivePlatform() {
  try {
    const platform = typeof process !== 'undefined' ? process.platform : ''
    return platform === 'win32' || platform === 'darwin'
  } catch {
    // 拿不到平台：按**敏感**处理（宁可还原时多报一次"不在项目内"，也不要拼错路径）。
    return false
  }
}

/**
 * 判断一份文档能不能归档。返回 `undefined` 表示可以，否则返回拒绝原因。
 *
 * @param {object} entry 注册表条目
 * @returns {string | undefined}
 */
export function archiveRefusalOf(entry) {
  const meta = entry?.meta !== null && typeof entry?.meta === 'object' ? entry.meta : null
  if (meta === null) return '这份文档没有合法 frontmatter，不能归档（它不是受管文档）。'
  if (meta.status !== ARCHIVABLE_STATUS) {
    return `\`${typeof meta.id === 'string' ? meta.id : '(无 id)'}\` 的状态是 \`${String(meta.status)}\`，不是 \`void\`。`
      + '只有 AI 主动标成 `void` 的文档才进待归档清单 —— 归档是用户的决定，但对象必须是 AI 的提议。'
  }
  if (entry?.inGraveyard === true) return '这份文档已经在坟场里了。'
  return undefined
}

/**
 * 在文本的 frontmatter 里写入归档元数据。
 *
 * @param {string} text 原文
 * @param {object} input
 * @param {string} input.from 归档前的项目内相对路径
 * @param {string} input.at ISO 时间串
 * @returns {{ok: true, text: string} | {ok: false, message: string}}
 */
export function withArchiveMeta(text, input) {
  const edited = setFrontmatterFields(text, {
    [ARCHIVE_META.from]: input?.from,
    [ARCHIVE_META.at]: input?.at,
  })
  if (edited.ok !== true) {
    return { ok: false, message: `写归档元数据失败：${edited.message ?? 'frontmatter 改写失败'}` }
  }
  return { ok: true, text: edited.text }
}

/**
 * 在文本的 frontmatter 里**删掉**归档元数据（还原时用，保证可逆）。
 *
 * @param {string} text
 * @returns {{ok: true, text: string} | {ok: false, message: string}}
 */
export function withoutArchiveMeta(text) {
  const edited = setFrontmatterFields(text, {
    [ARCHIVE_META.from]: null,
    [ARCHIVE_META.at]: null,
  })
  if (edited.ok !== true) {
    return { ok: false, message: `清归档元数据失败：${edited.message ?? 'frontmatter 改写失败'}` }
  }
  return { ok: true, text: edited.text }
}

/**
 * 读一份文本里的归档原路径。
 *
 * ⚠️ **拿不到就返回空串，绝不猜**（交接 §8 最后一句）：
 * 没有 `archivedFrom` 的坟场文件不是本插件归档的（或归档时失败了），
 * 那时还原的目标路径**不存在**，不能拿"坟场里的同名文件"顶替。
 *
 * @param {string} text
 * @returns {string}
 */
export function archivedFromOf(text) {
  const parsed = parseFrontmatter(text)
  if (parsed.present !== true || parsed.error !== null) return ''
  const meta = parsed.meta
  if (meta === null || typeof meta !== 'object') return ''
  const from = meta[ARCHIVE_META.from]
  return typeof from === 'string' ? from.trim() : ''
}

/**
 * 沙箱 policy：**拿不到模式就退回 `workspace-write`，绝不放宽**。
 *
 * 与 `tools/doc-new.js` 的 `sandboxPolicyOf(exec)` 是**同一条纪律**，
 * 但这里没有 `exec`（HTTP 路由不是工具调用，拿不到会话的 `sandboxMode`），
 * 所以模式只能是那个最保守的默认值 —— 这一点在文件头与 README 都写明了。
 *
 * @param {string} projectRoot
 * @returns {{mode: string, workspaceRoot: string}}
 */
export function sandboxPolicyFor(projectRoot) {
  return { mode: 'workspace-write', workspaceRoot: projectRoot }
}

/**
 * 一个失败结果的统一形状。
 *
 * ⚠️ **形状必须与成功时一致**（都带 `moved`/`restored`/`failed` 三个数组）。
 * 第一版只返回 `{ok:false, error}`，于是 client 读 `result.failed.length` 会拿到
 * `undefined.length` —— 那是"参数校验失败"和"归档部分失败"两种情况的**形状不一致**，
 * 而它们在 UI 上都该显示成"这一批里哪几份没成"。
 *
 * @param {string} error
 * @param {object} [extra]
 * @returns {object}
 */
function fail(error, extra) {
  return { ok: false, error, moved: [], restored: [], failed: [], ...(extra === undefined ? {} : extra) }
}

/**
 * 归档若干份文档：`docs/x.md` → `docs/_graveyard/x.md`，并保留原路径元数据。
 *
 * **一份失败不连累其它份**：返回值里 `moved` 与 `failed` 分开列，逐条带原因。
 * 这与 `registerRoutes` 的单条容错是同一条纪律（一次坏输入不能毁掉整批）。
 *
 * @param {object} input
 * @param {string[]} input.ids 要归档的文档 id（AI 用 `doc_mark` 标 `void` 时给的那个 id）
 * @param {Array<object>} input.entries 注册表条目（用来把 id 解析成路径与 status）
 * @param {object} input.fs `ctx.fs`
 * @param {string} input.projectRoot 项目根（绝对路径）
 * @param {string} input.graveyardDir 坟场目录（相对项目根，`docs/_graveyard`）
 * @param {string} [input.docsDir] 文档目录（相对项目根，`docs`）——用来拒绝归档不在 docs/ 的东西
 * @param {() => string} [input.now] 取时间（测试注入；默认 ISO）
 * @param {object} [input.logger]
 * @returns {Promise<{ok: boolean, moved: object[], failed: object[]}>}
 */
export async function archiveDocuments(input) {
  const opts = input !== null && typeof input === 'object' ? input : {}
  const fs = opts.fs
  const projectRoot = typeof opts.projectRoot === 'string' ? opts.projectRoot : ''
  const graveyardDir = typeof opts.graveyardDir === 'string' && opts.graveyardDir !== ''
    ? opts.graveyardDir
    : 'docs/_graveyard'
  const docsDir = typeof opts.docsDir === 'string' && opts.docsDir !== '' ? opts.docsDir : 'docs'
  const entries = Array.isArray(opts.entries) ? opts.entries : []
  const ids = Array.isArray(opts.ids) ? opts.ids.filter((id) => typeof id === 'string' && id !== '') : []
  const logger = opts.logger
  const at = typeof opts.now === 'function' ? opts.now() : new Date().toISOString()

  if (typeof fs?.resolve !== 'function' || typeof fs?.writeText !== 'function' || typeof fs?.readText !== 'function') {
    return fail('文件系统服务不可用，无法归档。')
  }
  if (projectRoot === '') return fail('找不到项目根，无法归档。')
  if (ids.length === 0) return fail('没有指定要归档的文档（`ids` 为空）。')

  const policy = sandboxPolicyFor(projectRoot)
  const moved = []
  const failed = []

  for (const id of ids) {
    const entry = entries.find((item) => item?.meta?.id === id)
    if (entry === undefined) {
      failed.push({ id, error: `找不到 id 为 \`${id}\` 的受管文档（它可能已被归档，或从未存在）。` })
      continue
    }

    const refusal = archiveRefusalOf(entry)
    if (refusal !== undefined) {
      failed.push({ id, error: refusal })
      continue
    }

    const sourceAbs = typeof entry.path === 'string' ? entry.path : ''
    const relative = relativeToRoot(sourceAbs, projectRoot)
    if (relative === '' || !relative.startsWith(`${normalizeSlashes(docsDir).replace(/\/+$/, '')}/`)) {
      failed.push({ id, error: `\`${id}\` 不在 \`${docsDir}/\` 之下（实际路径：${sourceAbs}），拒绝归档。` })
      continue
    }

    // 坟场是**平铺**的（`graveyardOf` 只列直接子项），所以目标只取文件名。
    // 代价：`docs/a/x.md` 与 `docs/b/x.md` 会撞名 —— 撞了就**显式拒绝**，不覆盖。
    const fileName = baseNameOf(relative)
    if (fileName === '') {
      failed.push({ id, error: `\`${id}\` 的路径取不出文件名：${sourceAbs}` })
      continue
    }
    const targetRelative = `${normalizeSlashes(graveyardDir).replace(/\/+$/, '')}/${fileName}`
    const targetAbs = joinPath(projectRoot, targetRelative)

    try {
      const source = await fs.resolve(sourceAbs, { cwd: projectRoot })
      const sourceInfo = typeof fs.stat === 'function' ? await fs.stat(source) : undefined
      if (sourceInfo === undefined && typeof fs.stat === 'function') {
        failed.push({ id, error: `源文件不存在：${relative}` })
        continue
      }

      const text = await fs.readText(source)
      if (typeof text !== 'string') {
        failed.push({ id, error: `读不到 \`${relative}\` 的正文。` })
        continue
      }

      const edited = withArchiveMeta(text, { from: relative, at })
      if (edited.ok !== true) {
        failed.push({ id, error: edited.message })
        continue
      }

      const destination = await fs.resolve(targetAbs, { cwd: projectRoot })
      if (typeof fs.stat === 'function') {
        const existing = await fs.stat(destination)
        if (existing !== undefined) {
          failed.push({
            id,
            error: `坟场里已经有 \`${fileName}\` 了，拒绝覆盖。请先还原或重命名那一份。`,
            target: targetRelative,
          })
          continue
        }
      }

      // `createIfAbsent` 是**原子**的存在性守卫：即使 stat 与 write 之间有人抢先建了它，
      // 这里也会抛而不是覆盖（stat 那一步只是为了让错误信息更好读）。
      try {
        await fs.writeText(destination, edited.text, { kind: 'createIfAbsent' }, undefined, policy)
      } catch (error) {
        failed.push({ id, error: `写入坟场失败：${error?.message ?? error}`, target: targetRelative })
        continue
      }

      // 目标已发布，再删源。两步是刻意的（与 `fs.moveFile` 的语义一致：
      // 「published destination with a retained source 是一个最终结果」）。
      let sourceDeleted = true
      let deleteError
      try {
        const guard = sourceInfo?.version === undefined ? undefined : { version: sourceInfo.version }
        await fs.deleteFile(source, guard, undefined, policy)
      } catch (error) {
        sourceDeleted = false
        deleteError = error?.message ?? String(error)
      }

      if (sourceDeleted !== true) {
        // **必须显式失败**：此时文件在两处都有。
        // 静默返回成功会让用户以为"已经挪走了"，而门禁那边它仍然在 docs/ 里活着。
        logger?.warn?.(`[ddd] 归档 ${id}：已复制到 ${targetRelative}，但源文件删不掉：${deleteError}`)
        failed.push({
          id,
          error: `已复制到 \`${targetRelative}\`，但源文件 \`${relative}\` 删不掉（${deleteError}）。`
            + '现在两处都有这份文件，请手动删掉源文件，或用「还原」把坟场那份退回。',
          target: targetRelative,
          sourceStillThere: true,
        })
        continue
      }

      moved.push({ id, from: relative, to: targetRelative })
    } catch (error) {
      failed.push({ id, error: `归档 \`${id}\` 时抛错：${error?.message ?? error}` })
    }
  }

  return { ok: failed.length === 0, moved, failed }
}

/**
 * 还原若干份坟场文档：`docs/_graveyard/x.md` → 它自己 `archivedFrom` 指的位置。
 *
 * @param {object} input
 * @param {string[]} input.paths 坟场里的文件路径（相对项目根 `docs/_graveyard/x.md` 或绝对路径都行）
 * @param {object} input.fs `ctx.fs`
 * @param {string} input.projectRoot
 * @param {object} [input.logger]
 * @returns {Promise<{ok: boolean, restored: object[], failed: object[]}>}
 */
export async function restoreDocuments(input) {
  const opts = input !== null && typeof input === 'object' ? input : {}
  const fs = opts.fs
  const projectRoot = typeof opts.projectRoot === 'string' ? opts.projectRoot : ''
  const paths = Array.isArray(opts.paths)
    ? opts.paths.filter((path) => typeof path === 'string' && path !== '')
    : []
  const logger = opts.logger

  if (typeof fs?.resolve !== 'function' || typeof fs?.writeText !== 'function' || typeof fs?.readText !== 'function') {
    return fail('文件系统服务不可用，无法还原。')
  }
  if (projectRoot === '') return fail('找不到项目根，无法还原。')
  if (paths.length === 0) return fail('没有指定要还原的文档（`paths` 为空）。')

  const policy = sandboxPolicyFor(projectRoot)
  const restored = []
  const failed = []

  for (const rawPath of paths) {
    const sourceAbs = rawPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rawPath)
      ? normalizeSlashes(rawPath)
      : joinPath(projectRoot, rawPath)

    try {
      const source = await fs.resolve(sourceAbs, { cwd: projectRoot })
      const sourceInfo = typeof fs.stat === 'function' ? await fs.stat(source) : undefined
      if (sourceInfo === undefined && typeof fs.stat === 'function') {
        failed.push({ path: rawPath, error: '坟场里没有这个文件。' })
        continue
      }

      const text = await fs.readText(source)
      if (typeof text !== 'string') {
        failed.push({ path: rawPath, error: '读不到坟场文件的内容。' })
        continue
      }

      const from = archivedFromOf(text)
      if (from === '') {
        failed.push({
          path: rawPath,
          error: '这份文件没有 `archivedFrom` 元数据，不知道它原来在哪 —— **不猜**。'
            + '（不是本插件归档的文件，或归档时元数据没写成功。）',
        })
        continue
      }

      const relative = normalizeSlashes(from).replace(/^\/+/, '')
      if (relative === '' || relative.split('/').includes('..')) {
        failed.push({ path: rawPath, error: `\`archivedFrom\` 指向了一个不安全的项目外路径：${from}` })
        continue
      }

      const targetAbs = joinPath(projectRoot, relative)
      const destination = await fs.resolve(targetAbs, { cwd: projectRoot })

      if (typeof fs.stat === 'function') {
        const existing = await fs.stat(destination)
        if (existing !== undefined) {
          // **绝不覆盖**：原位已经有一份（很可能是新写的），覆盖它就是数据丢失。
          failed.push({
            path: rawPath,
            error: `原位已经有 \`${relative}\` 了，拒绝覆盖。请先确认要把哪一份留下。`,
            target: relative,
          })
          continue
        }
      }

      const cleaned = withoutArchiveMeta(text)
      if (cleaned.ok !== true) {
        failed.push({ path: rawPath, error: cleaned.message })
        continue
      }

      try {
        await fs.writeText(destination, cleaned.text, { kind: 'createIfAbsent' }, undefined, policy)
      } catch (error) {
        failed.push({ path: rawPath, error: `写回 ${relative} 失败：${error?.message ?? error}` })
        continue
      }

      let sourceDeleted = true
      let deleteError
      try {
        const guard = sourceInfo?.version === undefined ? undefined : { version: sourceInfo.version }
        await fs.deleteFile(source, guard, undefined, policy)
      } catch (error) {
        sourceDeleted = false
        deleteError = error?.message ?? String(error)
      }

      if (sourceDeleted !== true) {
        logger?.warn?.(`[ddd] 还原 ${rawPath}：已写回 ${relative}，但坟场那份删不掉：${deleteError}`)
        failed.push({
          path: rawPath,
          error: `已写回 \`${relative}\`，但坟场那份删不掉（${deleteError}）。现在两处都有，请手动删掉坟场那份。`,
          restoredTo: relative,
          sourceStillThere: true,
        })
        continue
      }

      restored.push({ path: rawPath, to: relative })
    } catch (error) {
      failed.push({ path: rawPath, error: `还原 \`${rawPath}\` 时抛错：${error?.message ?? error}` })
    }
  }

  return { ok: failed.length === 0, restored, failed }
}

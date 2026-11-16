/**
 * `lastWriter` 记账（M1.5 / **D3**，`P10` 拍板）。
 *
 * ---- 为什么记，而不写回 frontmatter ----
 *
 * 缺陷文档 D3 说「`lastWriter` 未实现」。但在 `frontmatter` 里加一个
 * `lastWriter: {sessionId, seq, at}` 会**直接踩两个坑**：
 *
 * 1. **解析器不支持嵌套**（`docs/frontmatter.js` 明牌拒绝块式嵌套，
 *    `verifiedAgainst` 就是因此被拍平的）。要么再拍平三个键，要么存别处。
 * 2. **写回会改指纹** → 门禁判「你读的是旧版」→ **每次写入都要重读一次**。
 *    成本爆炸，而且是**自己给自己造门禁**。
 *
 * 所以 `P10` 拍的是：**记在 `_artifacts/`，不写回 frontmatter**。
 *
 * ---- 形态 ----
 *
 * 一份 JSON 模块（不是每份文档一个文件，避免 `_artifacts/` 被 N 个小文件铺满）：
 *
 * ```json
 * {
 *   "docs/spec-x.md": { "sessionId": "session-...", "seq": 42, "at": "2026-11-12T10:00:00.000Z", "tool": "edit" }
 * }
 * ```
 *
 * 键用**相对项目根**的路径（不用绝对路径：项目换机器/换盘符后仍然可读）。
 *
 * ---- 它为什么不是"门禁"----
 *
 * 这个模块**只写不读**、**失败只 warn**。它是**审计线索**，不是判据：
 * 任何一条门禁都**不能**依赖 `_artifacts/last-writer.json` 是否存在
 * （否则删掉这个文件就能绕开门禁）。
 */

/** 记账文件在 `_artifacts/` 下的相对名。 */
export const LAST_WRITER_FILE = 'last-writer.json'

/**
 * 把（可能绝对的）文档路径折成相对项目根的键。
 *
 * @param {string} absPath
 * @param {string} projectRoot
 * @returns {string | undefined} 不在项目根下 → undefined（不记）
 */
export function relativeKeyOf(absPath, projectRoot) {
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
 * 记一次写入。**永不抛、永不阻塞调用方。**
 *
 * @param {object} input
 * @param {string} input.absPath 被写的文档绝对路径
 * @param {string} input.projectRoot 项目根
 * @param {object} [input.session] 会话（取 id 与 cwd）
 * @param {number} [input.seq] 事件序号
 * @param {string} [input.tool] 工具名（write / edit / doc_mark / doc_new ...）
 * @param {object} [input.fs] `ctx.fs`（要有 readText / writeText / resolve）
 * @param {(path: string) => Promise<boolean>} [input.ensureDir] 确保目录存在
 * @param {() => string} [input.now] 时间源（注入以便测试）
 * @param {object} [input.logger]
 * @returns {Promise<boolean>} 是否记成功（失败不抛）
 */
export async function recordLastWriter(input) {
  const opts = input !== null && typeof input === 'object' ? input : {}
  const { absPath, projectRoot, session, seq, tool, fs, ensureDir, logger } = opts
  const now = typeof opts.now === 'function' ? opts.now : () => new Date().toISOString()

  try {
    const key = relativeKeyOf(absPath, projectRoot)
    if (key === undefined) return false
    if (typeof fs?.readText !== 'function' || typeof fs?.writeText !== 'function') return false

    const dir = `${projectRoot.replaceAll('\\', '/').replace(/\/+$/, '')}/_artifacts`
    const file = `${dir}/${LAST_WRITER_FILE}`

    // 读旧记录（不存在 / 坏了都当成空对象，**绝不因为历史记录坏了而拒绝记账**）。
    let record = {}
    try {
      const target = await fs.resolve(file, { cwd: projectRoot })
      const text = await fs.readText(target, { cwd: projectRoot })
      if (typeof text === 'string' && text.trim() !== '') {
        const parsed = JSON.parse(text)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) record = parsed
      }
    } catch {
      // 首次写入 / 读不到 → 空对象。
    }

    record[key] = {
      sessionId: typeof session?.id === 'string' ? session.id : '',
      seq: typeof seq === 'number' ? seq : 0,
      at: now(),
      tool: typeof tool === 'string' ? tool : '',
    }

    if (typeof ensureDir === 'function') await ensureDir(dir)

    const target = await fs.resolve(file, { cwd: projectRoot })
    try {
      await fs.writeText(target, `${JSON.stringify(record, null, 2)}\n`, undefined, undefined, {
        mode: 'workspace-write',
        workspaceRoot: projectRoot,
      })
    } catch (error) {
      // `_artifacts/` 目录不存在 → 写入失败。**这是已知限制**（D8：插件从不创建目录）。
      // 不在这里造目录：`doc_new` 也不建 `deliverables/`（订正清单第 6 条），
      // 两处保持一致；而且"替用户造目录"是 M2 的事。
      logger?.debug?.(`[ddd] lastWriter 写不进去（_artifacts/ 可能不存在）：${error?.message ?? error}`)
      return false
    }
    return true
  } catch (error) {
    // **永不冒泡**：审计线索写失败，不该让模型的一次正常写入变成失败。
    logger?.debug?.(`[ddd] lastWriter 记账失败（不影响写入）：${error?.message ?? error}`)
    return false
  }
}

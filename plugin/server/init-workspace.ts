/**
 * 一键把某个目录初始化成 DDD 工作区（M2.2）。
 *
 * ---- 为什么需要它（2026-11-13 用户实测）----
 *
 * 用户的原话：「要我手动建 ddd 工作区太麻烦了」。
 *
 * 手动流程是：建 `docs/` → 手写一份带合法 frontmatter 的 `.md`
 * → 再刷新面板让它被探测到。三步里每一步都可能写错
 * （frontmatter 少一个字段就不算标记），而**写错的症状是"面板说这不是 DDD 项目"**
 * —— 看起来像插件没工作，其实只是文件不合规。
 *
 * 所以把它做成一个动作：**建目录 + 写一份合规的入口索引 + 让它立刻可被探测到**。
 *
 * ---- 三条纪律 ----
 *
 * 1. **绝不覆盖已有文件**：目标已存在就报错并说清，而不是静默改写用户的文档。
 * 2. **失败形状与成功同形**（都带 `created` / `skipped` / `failed`）：
 *    client 会读这些数组，缺了就会炸在 `undefined.length`（M2.1 踩过）。
 * 3. **零 `node:` import**（SPEC §5.3-3）：文件操作全走注入的 `fs`。
 *    ⚠️ 唯一例外是**建目录** —— `ctx.fs` 没有 mkdir，见 `mkdir-bridge.ts` 的说明。
 */

import { ensureDirectory } from './mkdir-bridge.ts'
import { sandboxPolicyFor } from './write-engine.ts'

/** 初始化时写入的入口索引文件名（不带扩展名）。 */
export const INIT_DOC_ID = 'read-order'

/**
 * 生成入口索引的正文。
 *
 * ⚠️ frontmatter **必须**能被 `looksLikeDddDoc` 认出来：
 * 即 `id` / `role` / `status` 三个字段都在且非空。
 * 少任何一个，`docs/` 下这份文件就**不构成激活标记**，
 * 面板会继续说"这不是 DDD 项目"——而用户看不出哪里错了。
 *
 * @param {object} input
 * @param {string} input.projectName 项目显示名（取目录名）
 * @param {string} [input.title]
 * @returns {string}
 */
export function initialIndexDoc(input) {
  const projectName = typeof input?.projectName === 'string' && input.projectName !== ''
    ? input.projectName
    : '这个项目'
  const title = typeof input?.title === 'string' && input.title !== '' ? input.title : '入口索引'

  return [
    '---',
    `id: ${INIT_DOC_ID}`,
    'title: ' + title,
    'role: index',
    'order: 0',
    'status: authoritative',
    'summary: 本项目的长期说明与阅读入口。当前工作状态以已发布交接为准。',
    'basis: 实测',
    '---',
    '',
    `# ${title}`,
    '',
    `这是「${projectName}」的项目入口。可在这里补充长期有效的项目说明和关键约束。`,
    '',
    '实时目录见 DDD 面板；也可用 glob docs/*.md 定位，再读取 frontmatter。',
    '先看当前交接，再按任务选择依据。旧磁盘清单可能过时，以实时目录为准。',
    '无需维护目录成员、文档数量或重复抄写交接状态。',
    '',
  ].join('\n')
}

/**
 * 初始化一个 DDD 工作区。
 *
 * @param {object} input
 * @param {object} input.fs 宿主的文件抽象（`writeText` / `stat` / `listDir` 之类）
 * @param {string} input.projectRoot 目标目录（绝对路径）
 * @param {string} input.docsDir `docs` 的相对目录名
 * @param {(path: string) => string} input.joinPath 拼路径
 * @param {(path: string) => string} input.basenameOf 取目录名（做项目显示名）
 * @param {object} [input.logger]
 * @returns {Promise<{ok: boolean, created: string[], skipped: string[], failed: Array<{path: string, error: string}>}>}
 */
export async function initWorkspace(input) {
  const { fs, projectRoot, docsDir, joinPath, basenameOf, logger } = input
  const created = []
  const skipped = []
  const failed = []

  // ---- 失败形状与成功同形：任何早退都带三个数组
  const fail = (error) => ({
    ok: false,
    error: error?.message ?? String(error),
    created: [],
    skipped: [],
    failed: [{ path: projectRoot ?? '', error: error?.message ?? String(error) }],
  })

  if (typeof projectRoot !== 'string' || projectRoot === '') {
    return fail(new Error('没有指定项目根。'))
  }
  if (fs === undefined || fs === null) {
    return fail(new Error('宿主没有提供文件系统（ctx.fs），无法初始化。'))
  }

  const docsAbs = joinPath(projectRoot, docsDir)
  const docPath = joinPath(docsAbs, `${INIT_DOC_ID}.md`)

  // ---- 1. 建 docs/（幂等：已存在不算错）
  //
  // ⚠️ 走 `ensureDirectory` 而不是 `fs.mkdir` —— `ctx.fs` **没有 mkdir**。
  // 那一处是本项目唯一直接用 `node:fs` 的地方，理由与边界见 `mkdir-bridge.ts`。
  try {
    const made = await ensureDirectory(projectRoot, docsAbs)
    if (!made.ok) {
      // 建目录失败是**致命**的：后面写文件必然失败。但仍返回合法形状。
      return fail(new Error(`建 ${docsDir}/ 失败：${made.error ?? '未知原因'}`))
    }
    if (made.created) created.push(`${docsDir}/`)
    else skipped.push(`${docsDir}/（已存在）`)
  } catch (error) {
    return fail(new Error(`建 ${docsDir}/ 失败：${error?.message ?? error}`))
  }

  // ---- 2. 写入口索引（**绝不覆盖**）
  try {
    // 宿主的 fs 是**target 形态**的：先 resolve 成 FsTarget，再 stat / writeText。
    const target = await fs.resolve(docPath)
    const existing = await fs.stat(target)
    if (existing !== undefined && existing !== null) {
      // 目标已存在 → 跳过，并**明说**为什么没写。绝不静默改写用户的文档。
      skipped.push(`${docsDir}/${INIT_DOC_ID}.md（已存在，未覆盖）`)
    } else {
      const text = initialIndexDoc({
        projectName: typeof basenameOf === 'function' ? basenameOf(projectRoot) : '这个项目',
      })
      // `createIfAbsent` 是目标侧的原子守卫：并发下也不会覆盖（M2.1 的经验）。
      //
      // ⚠️ **必须传 sandbox policy**（实测踩过）：
      // `ctx.fs` 默认按**会话**的 workspace 执行沙箱。插件跑在 `DDD插件施工` 里，
      // 而用户想让 `DDDUI测试` 成为 DDD 项目 —— 于是写那个目录会被拒：
      //   `file access denied under workspace-write mode`
      // 与 `write-engine.ts` 的 `sandboxPolicyFor(projectRoot)` 同一条纪律：
      // **workspaceRoot 必须是目标项目根**，否则用户永远初始化不了别的目录。
      await fs.writeText(target, text, { kind: 'createIfAbsent' }, undefined, sandboxPolicyFor(projectRoot))
      created.push(`${docsDir}/${INIT_DOC_ID}.md`)
    }
  } catch (error) {
    failed.push({ path: `${docsDir}/${INIT_DOC_ID}.md`, error: (error as Error)?.message ?? String(error) })
    logger?.warn?.(`[ddd] 初始化写入口索引失败：${(error as Error)?.message ?? error}`)
  }

  return {
    ok: failed.length === 0,
    created,
    skipped,
    failed,
  }
}

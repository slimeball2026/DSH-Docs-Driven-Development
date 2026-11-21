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
    'summary: 本项目的阅读入口：先读哪一份、哪些是陷阱、哪些已过期。',
    // ---- 2026-11-15 M2.8（用户拍板「要改」）：`basis` 从 `未验证` 改成 `实测` ----
    //
    // 缺陷：这份文档由插件**自己生成**，`status` 直接写 `authoritative`，
    // 而 `basis` 却是默认的 `未验证` —— 于是 `doc_health` 的 H-5 判据
    //（「authoritative 但 basis 未验证」）**在每一个新建的 DDD 工作区里必然报一条**。
    //
    // 六轮实机实测（`_m28` 的统计，`19/20/21/22/23` 轮全中）：
    //   每一轮 AI 都要花 1~4 次 `edit` 去改 `read-order` 的 `basis`，
    //   而那是**插件自己造出来的 warn**，不是项目里的真问题。
    //
    // 为什么写 `实测` 而不是 `推断` 是诚实的：
    //   这份文档的正文（"怎么开始用 / 必读清单 / 下一步 / 陷阱 / 依据文档"这些小节）
    //   是**插件按固定模板写出来的**，不是关于项目的任何"结论" ——
    //   它的内容就是它自己的结构，没有"未经验证的断言"可言。
    //   而 `authoritative` 的含义是"新会话该信它"：它确实是这个项目的阅读入口。
    //
    // ⚠️ 只影响**新建**的工作区。已存在的工作区里那份文件已经写好了，
    //   不会被自动改写（那是用户文件，按铁律不能替用户改）。
    'basis: 实测',
    '---',
    '',
    `# ${title}`,
    '',
    `> 这份文件由 DDD 插件在初始化「${projectName}」时生成。`,
    '> 它是这个项目的**阅读入口**：AI 在改动 `docs/` 下的任何文档之前，',
    '> 必须先读过这里列出的必读项。',
    '',
    '## 怎么开始用',
    '',
    '1. 把项目里**真正该先读**的文档放进 `docs/`，每份都要有合法的 frontmatter',
    '   （至少 `id` / `title` / `role` / `status` / `summary`）。',
    '   `status` 是 `authoritative` / `partial` 的文档会**自动**进下面的「必读清单」。',
    '2. 「必读清单」的成员与顺序由插件按 frontmatter 维护（M3 起）——',
    '   **别手写成员**，把它下面那节「为什么读」写清就行。',
    '3. 交接时更新「下一步」与「依据文档」——这两行会显示在施工看板上。',
    '',
    '## 必读清单',
    '',
    '<!-- 这一节由插件自动维护：成员与顺序来自 frontmatter 的 status / order。别手写成员，也别改标记块内部。 -->',
    '<!-- ddd:auto:begin v1 -->',
    '<!-- ddd:auto:end -->',
    '',
    '**为什么读**（人手写，插件不覆盖）：',
    '',
    '- （先读谁、为什么、有什么坑。成员清单已由插件生成，这里只写判断。）',
    '',
    '## 下一步',
    '',
    '- （还没有安排。写清"下一刀做什么"，接手的人才知道从哪开始。）',
    '',
    '## 陷阱',
    '',
    '- （写清哪些东西**看起来该改但别改**，以及为什么。）',
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

/**
 * 文档驱动开发（DDD）· M0 引擎（宿主插件入口）。
 *
 * **挂载位置：profile 级 bundle（S1），不是 preset。**
 * 本插件的 `ctx` 是**全局**作用域，所以它出现在**所有会话**里；
 * 真正决定"要不要干活"的是每个 adapter 入口的 `shouldActivate()`。
 *
 * 职责分工（SPEC §10.3）：
 * - `core/` 纯核心，零 IO / 零时间 / 零随机 / 不 import 任何内置模块；
 * - `docs/` 文档域，纯逻辑 + 少量 IO（`node:path` / `node:crypto` 允许）；
 * - 本文件与 `adapters/` 是适配层，唯一允许接触 DSH 服务的地方。
 *
 * **本文件不导出 `Config`**：导出它需要 `@deepseek-ai/schemastery`，
 * 而 profile 装的 bundle 解析不到 dsh 自己的包，会导致整行加载失败。
 *
 * ---- 时序（这一节解释为什么要有 `adapters/probe.js`）----
 *
 * `systemPrompt.context()` 的 `text` 回调**必须同步**，而探测要读盘。
 * 所以不能"在回调里探测"，也不能"等探测完再说"——第一轮就得出索引。
 *
 * **真实时序**（读 `dsh-agent-loop` 源码确认，2026-11-11）：
 *
 * ```text
 * step()
 *   ├─ const assembly = await systemPrompt.assemble({...})     ← 第 1 次求值 text()
 *   │     （此时我们的探测还没跑，缓存是空的 → 返回 ''）
 *   ├─ const decision = await dispatch.waterfall('agent/pre-step', ...)
 *   │     （我们的处理器在这里 await 探测 + 扫描，把缓存填好）
 *   └─ const sections = renderContextSections(
 *          systemPrompt.refreshContext(assembly, ...))          ← **第 2 次求值 text()**
 * ```
 *
 * 关键在于最后那一步：`refreshContext()` 会用**当前的** provider 重新
 * `resolveContext()`（见 `dsh-system-prompt` 的 `refreshContext` 实现：
 * `contexts.push(provider === void 0 ? accepted : resolveContext(provider, context))`）。
 *
 * **所以第一轮就能拿到索引**——不必等第二轮。这也正是 SPEC §3.1 里
 * 「`refreshContext` 在 pre-step 与路由准备之后刷新已注册的运行时事实」的含义。
 *
 * 前提是：pre-step 处理器必须 `await` 完探测，且**不要**丢掉 `next()` 的返回值
 * （默认 decision 里带着 `kind: 'enter'` 与已渲染的 `messages`，丢掉会让这一轮进不去）。
 */

import { dirname, isAbsolute, join, resolve } from 'node:path'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { resolveConfig } from './config.js'
import { classifyPath } from './docs/path.js'
import { createRegistry } from './adapters/registry.js'
import { createProber } from './adapters/probe.js'
import { createGuard } from './adapters/guard.js'
import { createObserver } from './adapters/observe.js'
import { createFilter } from './adapters/filter.js'
import { registerIndexBlock } from './adapters/inject.js'
import { createAgentsMdWriter } from './adapters/agentsmd-writer.js'
import { createToolGate, safeWhen, assertToolAllowed, assertToolAllowedAsync } from './tools/when.js'
import { createNewTool } from './tools/doc-new.js'
import { createMarkTool } from './tools/doc-mark.js'
import { createHandoverCheckTool } from './tools/doc-handover-check.js'
import { createHealthTool } from './tools/doc-health.js'
import { makeRoutes, registerRoutes } from './server/routes.ts'
import { initWorkspace } from './server/init-workspace.ts'
import { deliverablesOf, graveyardCandidatesOf, graveyardOf, presentedPathsOf } from './server/deliverables.ts'
import { archiveDocuments, restoreDocuments } from './server/write-engine.ts'
import { projectLineOf, sliceLineOf } from './core/render.js'
import { handoverPointersOf } from './core/pointers.js'
import { currentHandoverOf } from './core/navigation.js'
import { computeBudget } from './core/budget.js'

/** 插件名（Cordis plugin name）。 */
export const name = 'ddd-engine'

/**
 * 硬依赖：工具注册表与提示词注册表；缺任何一个就不该激活。
 * `fs` 是本插件的核心数据来源，也列为硬依赖。
 *
 * ⚠️ **`webServer` 不在这个数组里**（M2 的实测结论，别改回去）：
 *
 * 1. 它在 Cordis 里是**可选服务**（`ctx.get("webServer")`，
 *    catalog 的 `access.optional.requiresUndefinedCheck: true`）；
 * 2. 如果放进硬依赖，headless / SDK 组合（没有 HTTP 层）里**整个插件都不激活** ——
 *    那时**门禁也会一起失效**，而门禁是 M0/M1/M1.5 的全部价值；
 * 3. SPEC §5.3-1 的原话是「拿不到 `webServer` 只 warn 不抛」——
 *    硬依赖会让它变成"整个插件消失"，比 warn 严重得多。
 *
 * **但**：`ctx.get('webServer')` 在**没声明 inject 时拿不到**（实测：
 * 探针写出 `hasWebServer: false`、`viaGet: "no-ctx.get"`，
 * 也就是说运行中的 `ctx` **连 `get` 方法都没有**，尽管服务本身是活的）。
 *
 * 所以正确做法就是 SPEC §3.5 说的原话：**插件级 `inject: ['webServer']`**，
 * 然后直接 `ctx.webServer.register(...)`（与 skill-explorer 同形）。
 *
 * ⚠️ **代价与对冲**：声明成硬依赖后，没有 `webServer` 的宿主（headless / SDK）
 * 会让整个插件不激活 —— 那会连门禁一起失效。所以 `registerRoutes` 仍然
 * **保留 `ctx.get` / `ctx.webServer` 两条取法 + 全 try/catch**，
 * 在真拿不到时只 warn。而实际部署形态（desktop / web profile）**一定有** `webServer`。
 */
export const inject = ['tools', 'systemPrompt', 'fs', 'webServer']

/** 本 bundle 的版本（V9 锚点用）。 */
export const BUNDLE_VERSION = '1.2.0-m4.4'

/**
 * 收集当前环境锚点（M1.5 / **D6**）。
 *
 * ---- 为什么不能写死 ----
 *
 * M1 的时候这里被写死成：
 * ```js
 * anchors: { dsh: undefined, bundle: BUNDLE_VERSION, commit: undefined }
 * ```
 * 于是 `dsh` 与 `commit` **恒为 undefined**，`core/health.js` 的 H-4 在这两个锚点上
 * 永远走"当前环境值未知 → skipped"那条分支 —— 也就是 **从未真正检查过**。
 * 这被 A4 评审判过一次「死分支」，M1 修了"要记账 skipped"这一半，
 * 但**取值这一半没做**：M1.5 的 D6 就是它。
 *
 * ---- 为什么现在也不"猜" ----
 *
 * 交接 §3.6 对 D6 的原话：**「拿不到就保持 `skipped`，不要瞎猜」**。
 * 这条很关键：把 `dsh` 猜成一个版本号会让 H-4 **报假警**（"你记的是 X，当前是 Y"），
 * 比 `skipped` 更糟 —— 假警会把真警淹没。
 *
 * 所以这里：
 *   - `bundle`：**有**（`BUNDLE_VERSION` 是编译期常量，确定可靠）；
 *   - `dsh`：**拿不到就不给**。宿主没有把版本暴露到 `ctx` 的公开面
 *     （`ctx.get('workingDirectory')` 有，但版本服务没有；`process.env` 被
 *     `core/` 的纯函数约束排除，而 `index.js` 虽然能读，但读环境变量
 *     会让同一份代码在不同机器上给出不同判据结果 —— **那不可复现**）；
 *   - `commit`：**拿不到就不给**。读 git 需要起子进程或读 `.git/HEAD`，
 *     两者都超出"同步、零成本"的预算，且 M1.5 **不该为此引入 IO**。
 *
 * **但这不等于"永远不检查"**：只要调用方显式提供（测试、将来的宿主适配层），
 * 就会真的判。`resolveAnchors()` 因此接受一个可选的 `overrides`。
 *
 * @param {object} [overrides] 显式提供的锚点（优先，用于测试与将来的宿主适配）
 * @returns {{dsh: string|undefined, bundle: string, commit: string|undefined}}
 */
export function resolveAnchors(overrides) {
  const given = overrides !== null && typeof overrides === 'object' ? overrides : {}
  const pick = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)

  return {
    // ⚠️ 顺序：显式提供 > 能探测到的常量 > undefined（**不猜**）
    dsh: pick(given.dsh),
    bundle: pick(given.bundle) ?? BUNDLE_VERSION,
    commit: pick(given.commit),
  }
}

/**
 * 从 YAML 配置里取锚点覆盖（M1.5 / D6 的接线）。
 *
 * `cordis.patch.yml` 的 `config` 里可以写：
 * ```yaml
 * - id: ddd-engine
 *   name: '@local/ddd'
 *   config:
 *     anchors:
 *       dsh: 0.2.2-rc.1
 *       commit: abc1234
 * ```
 * **这是"显式提供"那一档** —— 用户/部署方明确知道自己跑在什么版本上时才给。
 * 不给就是 `undefined` → HI-4 诚实记 `skipped`，**不猜**。
 *
 * 为什么走配置而不是自己探测：
 *   1. 宿主没把 DSH 版本暴露到 `ctx` 的公开面；
 *   2. 读 `process.env` 会让同一份代码在不同机器上给出不同判据结果 —— **不可复现**，
 *      而"可复现"是这个项目的底线（每条验收都要能重跑）；
 *   3. 读 git 要起子进程或读 `.git/HEAD`，超出"同步、零成本"的预算。
 *
 * @param {object} config 已 resolve 的插件配置
 * @returns {{dsh?: string, bundle?: string, commit?: string}}
 */
function anchorsOf(config) {
  const raw = config !== null && typeof config === 'object' ? config.anchors : undefined
  return resolveAnchors(raw)
}

/**
 * 插件入口。
 *
 * @param {object} ctx 全局作用域上下文
 * @param {object} config `cordis.patch.yml` 里该行的 `config`（可能整个缺失）
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const logger = ctx.logger
  const fsAdapter = createFsAdapter(ctx.fs)

  /** 由项目根算出绝对化布局。 */
  function layoutOf(projectRoot) {
    return {
      projectRoot,
      docsDir: resolved.docsDir,
      graveyardDir: resolved.graveyardDir,
      deliverablesDir: resolved.deliverablesDir,
      artifactsDir: resolved.artifactsDir,
      agentsMdName: resolved.agentsMdName,
      docsAbs: join(projectRoot, resolved.docsDir),
      agentsMdAbs: join(projectRoot, resolved.agentsMdName),
    }
  }

  const prober = createProber({ config: resolved, fsAdapter, layoutOf, logger })

  /** 每个项目根一个注册表（多会话共用同一个项目）。 @type {Map<string, object>} */
  const registries = new Map()
  /** 每个项目根一个 AGENTS.md 写者。 @type {Map<string, object>} */
  const writers = new Map()
  /** 正在初始化中的项目根（避免并发初始化）。 @type {Map<string, Promise<object>>} */
  const initializing = new Map()

  /**
   * 取（必要时初始化）某个项目根的注册表。
   * @param {string} projectRoot
   * @param {object} [probeInfo]
   * @returns {Promise<object>}
   */
  async function ensureRegistry(projectRoot, probeInfo) {
    const existing = registries.get(projectRoot)
    if (existing !== undefined) return existing

    const running = initializing.get(projectRoot)
    if (running !== undefined) return running

    const layout = layoutOf(projectRoot)
    const task = (async () => {
      const registry = createRegistry({
        config: resolved,
        layout,
        listDir: fsAdapter.listDir,
        readText: fsAdapter.readText,
        joinPath: join,
        classify: (absPath) => classifyPath(absPath, layout),
        anchors: anchorsOf(config),
        logger,
      })
      registries.set(projectRoot, registry)

      // 先登记再初始化：即使下面的步骤抛了，`registryOf()` 也能拿到一个
      // 处于 `failed` 状态的对象，而不是 undefined —— 门禁走"空注册表"路径，
      // 行为是**不拦**（保守），而不是让整个插件消失。
      try {
        await registry.rescan()
      } catch (error) {
        logger?.warn?.(`[ddd] 首次扫描失败，降级为空索引：${error?.message ?? error}`)
      }

      try {
        await registry.startWatching(ctx.fs, undefined)
      } catch (error) {
        logger?.debug?.(`[ddd] watch 初始化失败，退化为 touch 驱动：${error?.message ?? error}`)
      }

      // 扫描完成后写一次 AGENTS.md（慢变量）。失败不影响主流程。
      try {
        await agentsMdWriterFor(projectRoot, registry, layout, probeInfo).sync()
      } catch (error) {
        logger?.warn?.(`[ddd] 写 AGENTS.md 失败（不影响门禁）：${error?.message ?? error}`)
      }
      return registry
    })()

    initializing.set(projectRoot, task)
    try {
      return await task
    } finally {
      initializing.delete(projectRoot)
    }
  }

  /**
   * 取（或建）某个项目的 AGENTS.md 写者。
   *
   * **D1 的修法在这里**：写者建好之后**立刻订阅**注册表的 `onIndexChanged`，
   * 于是「文档新增 / 删除 / status 变化」都会触发一次 `sync()`。
   * 修之前它只在首次扫描后被调用过一次，之后 AGENTS.md 永远停在第一次的内容
   * （`dogfood/AGENTS.md` 至今还列着一份早已删除的坏文档，就是这个 bug 的活标本）。
   *
   * `sync()` 自带两重节流（内容相同不写 + `agentsMdMinWriteMs` 窗口内合并），
   * 所以「每次都调」是安全的；订阅回调本身也包了 try/catch，写失败不连累扫描。
   *
   * @param {string} projectRoot
   * @param {object} registry
   * @param {object} layout
   * @param {object} [probeInfo]
   * @returns {object}
   */
  function agentsMdWriterFor(projectRoot, registry, layout, probeInfo) {
    const existing = writers.get(projectRoot)
    if (existing !== undefined) return existing
    const writer = createAgentsMdWriter({
      config: resolved,
      fs: ctx.fs,
      registry: () => registry,
      probe: () => probeInfo ?? { hasMarker: true, projectRoot },
      ready: () => registry.state === 'ready',
      layout,
      logger,
    })
    writers.set(projectRoot, writer)

    // 订阅索引变化（D1）。写者可能是后面才被创建，但订阅只挂一次。
    if (typeof registry.onIndexChanged === 'function') {
      const unsubscribe = registry.onIndexChanged(() => {
        // 不 await：扫描链路不能被写文件拖住；失败由 writer 内部兜底。
        void writer.sync().catch((error) => {
          logger?.debug?.(`[ddd] AGENTS.md 同步失败（不影响门禁）：${error?.message ?? error}`)
        })
      })
      writer.onDispose = unsubscribe
    }

    return writer
  }

  /**
   * 会话当前的 cwd。
   *
   * ⚠️ **不能用 `session.header.cwd` 当唯一来源**（我踩过这个坑）。
   * `header.cwd` 是**会话创建时**的目录，用户在会话里切换工作目录
   * （`working_directory` 工具）之后它**不会变**。
   *
   * 实测证据：本会话 header.cwd 一直是
   * `...\DDD插件施工`，而 runtime-context 里 `working-directory:current`
   * 已经是 `...\DDD插件施工\dogfood`。若只看 header，
   * 切进 DDD 项目后索引**永远不会出现**（M0-11 在切目录场景下直接失效）。
   *
   * 取值优先级：
   *   1. `ctx.workingDirectory.get(session)` —— 运行时的真实 cwd（首选）
   *   2. `session.header.cwd` —— 建会话时的 cwd（兜底）
   *   3. `process.cwd()` —— 最后兜底
   *
   * 用 `ctx.get('workingDirectory')` 做**可选解析**：那个服务不一定挂载
   * （headless / SDK 组合就没有），拿不到就退回 header，不增加硬依赖。
   *
   * @param {object} [session]
   * @returns {string}
   */
  function cwdOf(session) {
    // 1. 运行时工作目录服务（最准）
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
      if (service !== undefined && service !== null && typeof service.get === 'function' && session !== undefined) {
        const current = service.get(session)
        if (typeof current === 'string' && current !== '') return current
      }
    } catch {
      // 服务不可用 / 接口变化：静默退回 header，不影响主流程。
    }

    // 2. 建会话时的 cwd
    const cwd = session?.header?.cwd
    if (typeof cwd === 'string' && cwd !== '') return cwd

    // 3. 进程 cwd
    return process.cwd()
  }

  /**
   * 同步取"当前会话对应的项目信息"（只读探测缓存）。
   * @param {object} [session]
   * @returns {{hasMarker: boolean, projectRoot?: string}}
   */
  function probeOf(session) {
    return prober.peek(cwdOf(session))
  }

  /**
   * 同步取"当前会话对应的注册表"。
   * @param {object} [session]
   * @returns {object | undefined}
   */
  function registryOf(session) {
    const info = probeOf(session)
    return info.projectRoot === undefined ? undefined : registries.get(info.projectRoot)
  }

  /** 把工具参数里的路径解析成绝对路径。 */
  function resolvePath(path, session) {
    if (typeof path !== 'string') return ''
    return isAbsolute(path) ? resolve(path) : resolve(cwdOf(session), path)
  }

  /** 当前会话所属项目的 classify（同步；未激活返回恒 outside）。 */
  function classifyFor(path, session) {
    const info = probeOf(session)
    if (info.projectRoot === undefined) return 'outside'
    return classifyPath(resolvePath(path, session), layoutOf(info.projectRoot))
  }

  /**
   * 确保某个会话的项目已就绪（异步）。
   *
   * 三件事，顺序有讲究：
   *   1. 探测（探到项目根 + 激活标记）；
   *   2. 首次扫描建注册表；
   *   3. **让「外部改动 / 新增文档」被发现** —— 这是 M0-8 与 D2 的落点。
   *
   * 第 3 步分两条路（SPEC §6.3：watch 优先，无 watch 则 touch 驱动）：
   *   - **有 watcher**：交给 watch 回调触发 `rescan()`。这里**不再**做全量
   *     指纹对账 —— 修 D2 之前这里无条件每轮重读全部文档，与 SPEC §6.3
   *     和本模块自己的注释都矛盾（实测 2.53 ms/步、434 步读 115 MB）。
   *   - **没有 watcher**（降级）：每轮 `rescanIfStale()` 重扫。
   *     ⚠️ 必须**重扫**而不只是重算指纹：`refreshAllFingerprints()` 只更新
   *     已在册条目，**永远发现不了新文件**（这就是 D2）。
   *
   * @param {object} session
   * @returns {Promise<void>}
   */
  async function prepareSession(session) {
    const cwd = cwdOf(session)
    const info = await prober.ensure(cwd)
    if (info.projectRoot === undefined || info.hasMarker !== true) return

    const registry = await ensureRegistry(info.projectRoot, info)

    try {
      if (typeof registry.isWatching === 'function' && registry.isWatching()) {
        // watch 已覆盖「新增 / 删除 / 改动」；它自己会触发 rescan。
        // 这里只兜一个边角：watcher 刚建好、还没收到任何事件时，
        // 指纹可能落后于磁盘（比如插件挂载期间被外部改过）。
        await registry.refreshAllFingerprints()
      } else if (typeof registry.rescanIfStale === 'function') {
        // 降级路径：重扫才能发现新文件（D2）。
        await registry.rescanIfStale()
      } else {
        // 极老的注册表对象（防御）：退回原来的行为。
        await registry.refreshAllFingerprints()
      }
    } catch (error) {
      logger?.debug?.(`[ddd] 文档状态对账失败（不影响本轮）：${error?.message ?? error}`)
    }
  }

  // ---------------------------------------------------------------- 装配

  // 1. 门禁：write / edit 按路径拦（Q9 = B / R1）。
  ctx.tools.guard(createGuard({
    config: resolved,
    registry: (session) => registryOf(session),
    probe: (session) => probeOf(session),
    classify: classifyFor,
    resolvePath,
    logger,
  }))

  // 2. 记账：tools/result 观测 read（SPEC §9）。
  const observer = createObserver({
    config: resolved,
    registry: (session) => registryOf(session),
    probe: (session) => probeOf(session),
    classify: classifyFor,
    resolvePath,
    // D3（M1.5）：lastWriter 记到 `_artifacts/last-writer.json`，不写回 frontmatter（`P10`）。
    fs: ctx.fs,
    logger,
  })
  ctx.on('tools/result', (exec, result) => {
    try {
      observer(exec, result)
    } catch (error) {
      logger?.warn?.(`[ddd] 记账监听异常：${error?.message ?? error}`)
    }
  })

  // 3. 坟场过滤：tools/post-execute（SPEC §8.2）。
  const filter = createFilter({
    config: resolved,
    probe: (session) => probeOf(session),
    classify: classifyFor,
    resolvePath,
    logger,
  })
  ctx.on('tools/post-execute', (exec, result, next) => filter(exec, result, next))

  // 4. 索引块：systemPrompt.context（同步 text / interpolate:false）。
  const injectDisposer = registerIndexBlock(ctx, {
    config: resolved,
    registry: (session) => registryOf(session),
    probe: (session) => probeOf(session),
    ready: (session) => {
      const registry = registryOf(session)
      return registry !== undefined && registry.state === 'ready'
    },
  })

  // 4.5 **M1 的 4 个工具：条件注册**（M1-Q8 / M1-L8）。
  //
  // 为什么必须条件注册：本插件是**全局挂载**（S1），无条件注册会让 4 份 schema
  // 出现在**所有人的所有会话**里 —— 那是 Q13 上限之外最不该付的固定成本。
  //
  // ⚠️ `when` 抛错 = `TOOL_ACTIVATION_FAILED` = **中止步骤准备**（整个会话卡死）。
  // 所以 `createToolGate` 内部整体 try/catch，外面再套一层 `safeWhen`。
  // 两道防线是刻意的：这一处一旦出错，症状是"会话打不开"，不是"工具不好用"。
  const toolsVisible = safeWhen(createToolGate({
    config: resolved,
    probe: (session) => probeOf(session),
    registry: (session) => registryOf(session),
    logger,
  }), logger)

  /** 取本会话对某 id 的已读记录（doc_mark 的门禁用）。 */
  function readRecordOf(session, id) {
    const reg = registryOf(session)
    if (reg === undefined) return undefined
    const set = typeof reg.readSetFor === 'function' ? reg.readSetFor(session) : reg.readSet
    return set?.get?.(id)
  }

  const toolDeps = {
    config: resolved,
    registry: (session) => registryOf(session),
    fs: ctx.fs,
    readRecordOf,
    projectRoot: (session) => probeOf(session).projectRoot,
    projectRootOf: (session) => probeOf(session).projectRoot,
    cwdOf,
    logger,
    // S2 的**执行期**兜底：子代理即使看到了工具也不能真的用（M1-14 实机教训）。
    //
    // ⚠️ 2026-11-14 M2.5：换成 async 版并传 `ensureProbe` ——
    // 修「全新目录里第一次调 doc_new 被误报 no-project-root」那个死循环。
    // 详见 `tools/when.js` 的 `assertToolAllowedAsync` 注释。
    assertAllowed: assertToolAllowedAsync({
      config: resolved,
      probe: (session) => probeOf(session),
      registry: (session) => registryOf(session),
      // 现探一次（读盘）。`probeOf` 用的是 `peek`（只读缓存），
      // 全新目录缓存为空 → 会被误判成 no-project-root。
      ensureProbe: async (session) => prober.ensure(cwdOf(session)),
    }),
    anchors: anchorsOf(config),
  }

  const m1Tools = [
    createNewTool(toolDeps),
    createMarkTool(toolDeps),
    createHandoverCheckTool(toolDeps),
    createHealthTool(toolDeps),
  ]

  ctx.effect(() => {
    const disposers = []
    for (const definition of m1Tools) {
      try {
        // 注册由 effect 持有（dsh-tools README 的要求），所以这里包在 ctx.effect 里。
        disposers.push(ctx.tools.register(definition, { when: toolsVisible }))
      } catch (error) {
        // 单个工具注册失败不能连累其它三个（更不能连累 M0 的索引与门禁）。
        logger?.warn?.(`[ddd] 注册工具 ${definition?.name} 失败：${error?.message ?? error}`)
      }
    }
    return () => {
      for (const dispose of disposers) {
        try { dispose() } catch { /* 释放失败不影响其它 */ }
      }
    }
  }, 'ddd.tools.register()')

  // 5. **关键时序**：每个 step 开始前把探测与扫描跑完（异步），
  //    这样同步的 `text` 回调在组装提示词时一定能读到缓存。
  ctx.on('agent/pre-step', async (payload, next) => {
    const session = payload?.agent?.session
    try {
      await prepareSession(session)
    } catch (error) {
      logger?.warn?.(`[ddd] 准备会话失败（降级为不激活）：${error?.message ?? error}`)
    }
    return typeof next === 'function' ? next() : undefined
  })

  // 6. 预热 process.cwd()（不同步等待，只是尽早入队）。
  void prober.ensure(process.cwd()).then(async (info) => {
    if (info.projectRoot !== undefined && info.hasMarker === true) {
      await ensureRegistry(info.projectRoot, info)
    }
  }).catch(() => {})

  // 7. **M2：HTTP 路由**（看板/图谱/预览的数据通道，M2-Q3）。
  //
  // ⚠️ 三条硬约束（SPEC §5.3）：
  //   1. 注册必须 try/catch —— `registerRoutes` 内部已经全兜住了，绝不抛；
  //   2. 拿不到 `webServer` 只 warn（host 的门禁与索引**不受影响**）；
  //   3. **只读优先**：GET /api/ddd/index 是纯读，不碰任何文件。
  //
  // 为什么走 HTTP 而不是工具：**Q13 的工具上限是 4 个，M1 已用满**。
  // 而且走工具会让看板数据每轮进模型上下文（花 token），它只该给人看。
  //
  // ---- `sessionId` 是必需参数（SPEC §4.2 订正 2）----
  //
  // `gate.read` 来自**会话级** readSet（`registry.readSetFor(session)`）。
  // 路由必须带 `sessionId`，否则要么报错、要么退化成"共享值"——
  // 两种都不是 M2-2 通过。所以下面先按 id 找会话，找不到就**明说**，
  // 不用共享 readSet 冒充。
  // ---- 共用：按 cwd / sessionId 定位"哪个项目 + 哪个会话" ----
  //
  // 三个 HTTP 处理（`index` / `archive` / `restore`）都需要同一套解析：
  // ① 按 sessionId 找活会话（`readSet` 与会话级审计都要它）；
  // ② 定项目根（优先 `cwd`，其次会话的 cwd）；
  // ③ 拿（必要时建）注册表。
  //
  // 抽成一个函数的理由不是"少写几行"，是**三处必须用同一套判据**：
  // 归档如果用了另一套路径解析，就会出现"看板说这是 DDD 项目、归档说找不到项目根"。
  async function locate(cwd, sessionId) {
    let session
    if (typeof sessionId === 'string' && sessionId !== '') {
      try {
        const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
        if (sessions !== undefined && sessions !== null && typeof sessions.get === 'function') {
          session = sessions.get(sessionId)
        }
      } catch {
        session = undefined
      }
    }

    const effectiveCwd = typeof cwd === 'string' && cwd !== ''
      ? cwd
      : (session === undefined ? undefined : cwdOf(session))

    // ⚠️ **这里必须用 `ensure` 而不是 `peek`**（实测踩过）。
    //
    // `prober.peek()` 是**同步、只读缓存、绝不读盘**的（`adapters/probe.js:140`）。
    // 而探测只在会话的 `agent/pre-step` 里触发 —— 于是**一个从没被任何会话打开过的
    // 目录，缓存里什么都没有**，`peek` 返回 `projectRoot: undefined`，
    // 看板就显示"这不是 DDD 项目"。
    //
    // 症状特别坏：**HTTP 200 + 结构合法 + 全是 0**，看起来像"这个项目没有必读文档"，
    // 而不像"探测没跑"。我第一版就是这样，`dogfood` 明明有 15 份 md 却返回
    // `gate.required: 0`。
    //
    // `ensure` 是异步读盘的，撞上了就现探一次，之后 `ensureRegistry` 会建好注册表。
    // 代价：第一次访问某个 cwd 会慢一点（读盘），之后走缓存。
    let info = { projectRoot: undefined, hasMarker: false }
    if (effectiveCwd !== undefined) {
      try {
        info = await prober.ensure(effectiveCwd)
      } catch (error) {
        logger?.warn?.(`[ddd] 路由探测 ${effectiveCwd} 失败：${error?.message ?? error}`)
      }
    }

    return { session, info, projectRoot: info.projectRoot }
  }

  const routes = makeRoutes({
    snapshotOf: async (cwd, sessionId) => {
      const { session, info, projectRoot } = await locate(cwd, sessionId)
      if (projectRoot === undefined) {
        // 不是 DDD 项目：给一个结构合法的空快照，**不编数据**。
        // client 据此显示"当前项目没有启用 DDD"，而不是显示 0/0（那会被误读成"没有必读文档"）。
        return { entries: [], sessionId: sessionId ?? '', projectRoot: '' }
      }

      const registry = registries.get(projectRoot)
      if (registry === undefined) {
        // 注册表还没建好（第一次访问就可能撞上）：**先建再答**，不要给半份数据。
        try {
          const made = await ensureRegistry(projectRoot, info)
          return await withDirs(snapshotInputOf(made, projectRoot, session, sessionId))
        } catch {
          return { entries: [], sessionId: sessionId ?? '', projectRoot }
        }
      }
      return await withDirs(snapshotInputOf(registry, projectRoot, session, sessionId))
    },

    // ---- M2-E：归档（用户点了按钮 → host 拿 ctx.fs 物理移动）----
    //
    // 三条纪律：
    //  1. **client 永远不碰文件**（M2-Q6）：它只 POST 一组 id；
    //  2. **只归档 `status: void`**（`write-engine.ts` 里硬拒）：`void` 是 AI 的提议，
    //     归档是用户的决定，两者之间必须有 AI 做不了的动作；
    //  3. 归档完**立刻重扫**：否则注册表还把坟场里那份当活文档，
    //     看板会显示它"还在待归档"，而磁盘上已经没有它了（D2 的同款症状）。
    archive: async (body) => {
      const { projectRoot } = await locate(body?.cwd, body?.sessionId)
      if (projectRoot === undefined) {
        // ⚠️ **失败形状必须与成功同形**（都带 moved / failed）。
        // 第一版这里只给 `{ok:false, error}`，于是 client 读 `result.failed.length`
        // 会炸在 `undefined.length` —— 而这条路径正是"用户在非 DDD 项目里点了归档"时走的。
        // 这是 `_m21/probe-routes-wired.mjs` 抓出来的（它断言"扣掉 501 之后形状仍合法"）。
        return {
          ok: false,
          error: '这不是一个 DDD 项目（或激活标记没探测到），不归档任何东西。',
          moved: [],
          failed: [],
        }
      }

      const registry = registries.get(projectRoot) ?? await ensureRegistry(projectRoot, undefined)
      const result = await archiveDocuments({
        ids: Array.isArray(body?.ids) ? body.ids : [],
        entries: Array.isArray(registry?.entries) ? registry.entries : [],
        fs: ctx.fs,
        projectRoot,
        graveyardDir: resolved.graveyardDir,
        docsDir: resolved.docsDir,
        logger,
      })

      // 无论成功与否都重扫：部分成功时前几份已经在坟场里了。
      try {
        await registry?.rescan?.()
      } catch (error) {
        logger?.warn?.(`[ddd] 归档后重扫失败（看板可能短暂落后）：${error?.message ?? error}`)
      }
      return result
    },

    // ---- M2-E：还原（从坟场放回 `archivedFrom` 指的位置）----
    restore: async (body) => {
      const { projectRoot } = await locate(body?.cwd, body?.sessionId)
      if (projectRoot === undefined) {
        // 同 archive：失败形状与成功同形（见上面的注释）。
        return {
          ok: false,
          error: '这不是一个 DDD 项目（或激活标记没探测到），不还原任何东西。',
          restored: [],
          failed: [],
        }
      }

      const registry = registries.get(projectRoot) ?? await ensureRegistry(projectRoot, undefined)
      const result = await restoreDocuments({
        paths: Array.isArray(body?.paths) ? body.paths : [],
        fs: ctx.fs,
        projectRoot,
        logger,
      })

      try {
        await registry?.rescan?.()
      } catch (error) {
        logger?.warn?.(`[ddd] 还原后重扫失败（看板可能短暂落后）：${error?.message ?? error}`)
      }
      return result
    },

    // ---- M2.2：已知项目根列表（**给 client 的显式选择器用**）----
    //
    // 为什么这条必须由 host 出，而不是 client 自己猜：
    //
    //   宿主设计上**不给 root-scope 的 `main` 席位任何会话绑定**
    //   （`dsh-client-ui-layout` 注释原文：「other keys receive no Session binding」），
    //   而 client 侧没有任何服务暴露"用户当前选中了哪个会话"——
    //   那是 UI 内部状态。所以 client **不可能**自己知道该查哪个项目。
    //
    // 所以：**host 列出所有已知 cwd（来自会话），并标出哪些真的是 DDD 项目**，
    // 由用户显式选一个。这符合 SPEC 的铁律「不猜」——
    // 显示错项目的门禁比不显示更糟（会把错误的信任可视化）。
    projects: async () => {
      const seen = new Map() // cwd → { cwd, sessions, isDdd }

      // 1) 收集所有会话的 cwd。`sessions` 是 host 侧服务，形状可能是
      //    Map / 数组 / 带 list() 的对象，所以这里**逐种试**而不是假定一种。
      let all = []
      try {
        const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
        if (sessions !== undefined && sessions !== null) {
          if (typeof sessions.values === 'function') all = [...sessions.values()]
          else if (typeof sessions.list === 'function') all = await sessions.list()
          else if (Array.isArray(sessions)) all = sessions
        }
      } catch (error) {
        logger?.warn?.(`[ddd] 列出会话失败（项目选择器会不完整）：${error?.message ?? error}`)
      }

      for (const session of Array.isArray(all) ? all : []) {
        let cwd
        try {
          cwd = cwdOf(session)
        } catch {
          cwd = undefined
        }
        if (typeof cwd !== 'string' || cwd === '') continue
        const key = cwd.replace(/[\\/]+$/, '')
        seen.set(key, { cwd: key, sessions: 1, projectRoot: '' })
      }

      // 2) 逐个探测是不是 DDD 项目。**只标，不丢** ——
      //    用户可能想把一个还没建 docs/ 的目录变成 DDD 项目，
      //    那时它得出现在列表里（否则无从选起）。
      const projects = []
      for (const entry of seen.values()) {
        let projectRoot = ''
        try {
          // 用 `ensure`（读盘）而不是 `peek`（只读缓存）：
          // 从没被会话打开过的目录在缓存里没有记录，`peek` 会误报"不是 DDD 项目"。
          const info = await prober.ensure(entry.cwd)
          projectRoot = info?.projectRoot ?? ''
        } catch {
          projectRoot = ''
        }
        projects.push({ cwd: entry.cwd, projectRoot, isDdd: projectRoot !== '' })
      }

      // 3) DDD 项目排前面（用户最可能要的就是它们），其余按路径字母序稳定排列。
      projects.sort((left, right) => {
        if (left.isDdd !== right.isDdd) return left.isDdd ? -1 : 1
        return left.cwd.localeCompare(right.cwd)
      })
      return projects
    },

    // ---- M2.2：让某个目录的探测缓存失效（"刷新"按钮真的重新读盘）----
    //
    // ⚠️ **这条不存在的后果很坏**（用户实测）：在目录里新建 `docs/` 之后点刷新，
    // 面板仍然说"这不是 DDD 项目" —— 因为 `prober.ensure()` 有 2 秒 TTL 缓存，
    // 而刷新只重拉了列表，没让这个 cwd 重新探测。
    // 用户看到的"点刷新没用、但换个目录就好了"就是这个。
    recheck: async (body) => {
      const cwd = typeof body?.cwd === 'string' ? body.cwd : ''
      if (cwd === '') {
        return { ok: false, error: '没有指定 cwd。', hasMarker: false }
      }
      try {
        prober.forget(cwd)
      } catch (error) {
        logger?.warn?.(`[ddd] 清除探测缓存失败（${cwd}）：${error?.message ?? error}`)
      }
      // 立刻重新探一次，把结果带回去（前端可以据此更新提示，不用再猜）。
      let info = { hasMarker: false, projectRoot: undefined }
      try {
        info = await prober.ensure(cwd)
      } catch (error) {
        logger?.warn?.(`[ddd] 重新探测 ${cwd} 失败：${error?.message ?? error}`)
      }
      // 新建的项目根要让注册表跟上（否则看板说"这是 DDD 项目"但一份文档都列不出）。
      if (info?.projectRoot !== undefined) {
        try {
          await ensureRegistry(info.projectRoot, info)
        } catch (error) {
          logger?.warn?.(`[ddd] 重新探测后建注册表失败：${error?.message ?? error}`)
        }
      }
      return {
        ok: true,
        cwd,
        isDdd: info?.projectRoot !== undefined,
        projectRoot: info?.projectRoot ?? '',
      }
    },

    // ---- M2.2：一键把目录初始化成 DDD 工作区 ----
    //
    // 用户原话：「要我手动建 ddd 工作区太麻烦了」。
    // 手动流程（建 docs/ → 手写合规 frontmatter → 刷新）每一步都可能写错，
    // 而写错的症状是"面板说这不是 DDD 项目"——看起来像插件没工作。
    init: async (body) => {
      const cwd = typeof body?.cwd === 'string' ? body.cwd : ''
      if (cwd === '') {
        return {
          ok: false,
          error: '没有指定要初始化的目录。',
          created: [],
          skipped: [],
          failed: [],
        }
      }
      const result = await initWorkspace({
        fs: ctx.fs,
        projectRoot: cwd,
        docsDir: resolved.docsDir,
        joinPath: join,
        basenameOf: (path) => path.split(/[\\/]/).filter(Boolean).pop() ?? path,
        logger,
      })

      // 初始化成功后**立刻重新探测**，否则面板还要等 TTL 才认。
      if (result.ok || result.created.length > 0) {
        try {
          prober.forget(cwd)
          const info = await prober.ensure(cwd)
          if (info?.projectRoot !== undefined) {
            await ensureRegistry(info.projectRoot, info)
          }
          return { ...result, isDdd: info?.projectRoot !== undefined, projectRoot: info?.projectRoot ?? '' }
        } catch (error) {
          logger?.warn?.(`[ddd] 初始化后重新探测失败：${error?.message ?? error}`)
        }
      }
      return result
    },

    logger,
  })

  const routeDisposer = registerRoutes(ctx, routes, logger)

  // **R-1 的自证探针**：把注册结果写到工作区里，好让施工者能在**不重启、不碰浏览器**的情况下
  // 确认"路由真的被宿主接上了"。
  //
  // 为什么需要它：宿主的认证发生在**路由匹配之前**，所以外部 HTTP 探测无法区分
  // "路由已注册" 与 "路由不存在"（两者都返回 401）。实测四个路径全部 401。
  // 而宿主的运行日志不在可读位置（只有 crash-*.log）。所以这个文件是唯一可靠的观测点。
  //
  // ⚠️ 它**只是诊断**：写失败绝不影响插件（整个包在 try/catch 里）。
  try {
    // 诊断：把"几种拿法各自拿到了什么"都记下来。
    // 这是定位"为什么 ctx.get('webServer') 拿不到"的唯一直接证据。
    let viaGet
    try { viaGet = typeof ctx.get === 'function' ? typeof ctx.get('webServer') : 'no-ctx.get' } catch (error) { viaGet = `throw:${error?.message}` }
    let injectNames = 'no-ctx.inject'
    try { injectNames = typeof ctx.inject === 'function' ? 'has-ctx.inject' : 'no-ctx.inject' } catch { /* 忽略 */ }
    let ctxKeys = []
    try { ctxKeys = Object.keys(ctx ?? {}).filter((key) => /web|server|http/i.test(key)).slice(0, 20) } catch { /* 忽略 */ }
    // 原型链：Cordis 的 ctx 通常是代理，服务挂在原型上而不是自有属性。
    let protoKeys = []
    try {
      let proto = Object.getPrototypeOf(ctx)
      let depth = 0
      while (proto !== null && depth < 2) {
        protoKeys.push(...Object.getOwnPropertyNames(proto).filter((key) => /web|server|http|get|inject/i.test(key)))
        proto = Object.getPrototypeOf(proto)
        depth += 1
      }
      protoKeys = [...new Set(protoKeys)].slice(0, 30)
    } catch { /* 忽略 */ }
    let inOperator = false
    try { inOperator = 'webServer' in (ctx ?? {}) } catch { /* 忽略 */ }

    const probe = JSON.stringify({
      at: Date.now(),
      pid: process.pid,
      // 把 inject 声明也记下来：这样能区分"加载的是新代码还是旧代码"。
      inject,
      registered: routeDisposer !== undefined,
      routes: routes.map((route) => `${route.kind} ${route.path}`),
      hasWebServer: typeof ctx?.webServer?.register === 'function',
      viaGet,
      injectNames,
      ctxKeys,
      protoKeys,
      inOperator,
    }, null, 2)
    // 只写临时目录：**不污染工作区**（工作区里出现 `_m2-route-probe.json` 会被 git 看到，
  // 也可能被误当成项目文件）。
    for (const probePath of [join(tmpdir(), '_m2-route-probe.json')]) {
      try { writeFileSync(probePath, probe, 'utf8') } catch { /* 单处失败不影响另一处 */ }
    }
  } catch { /* 诊断写盘失败不影响任何功能 */ }

  /**
   * 取 `nextStep` / `basisDoc`（M2.3）。
   *
   * ---- 真源链条（**每一环都可追**）----
   *
   * ```
   * registry.entries
   *   → primaryHandoverOf()      只认 role:handover，取 order 最小（同 order 按 id）
   *   → registry.textOf(id)      扫描时缓存的全文（**同步**，不读盘）
   *   → handoverPointersOf()     解析 §3「下一刀」与 §5「验收」里的引用
   *   → registry.fingerprintOf() 给 basisDoc 补指纹
   * ```
   *
   * ⚠️ **任何一环断掉都返回空**，绝不猜：
   *   - 没有交接文档 → `{ nextStep: '', basisDoc: null }`
   *   - 有文档但没缓存全文 → 同上
   *   - 有全文但没那一节 → 对应字段空
   *
   * 为什么不让它抛：这是看板的**装饰性**数据。为了显示"下一步"而让整个
   * `/api/ddd/index` 500，是拿主要功能换次要功能 —— 与 `registerRoutes` 同一条纪律。
   *
   * @param {object} registry 注册表
   * @param {string} sessionId 会话 id（目前没用，留给将来"按会话过滤交接"）
   * @returns {{nextStep: string, basisDoc: object|null}}
   */
  function pointersOf(registry, sessionId) {
    const empty = { nextStep: '', basisDoc: null }
    try {
      const entry = currentHandoverOf(registry?.entries)
      if (entry === undefined) return empty

      const id = entry?.meta?.id
      if (typeof id !== 'string' || id === '') return empty

      const body = typeof registry?.textOf === 'function' ? registry.textOf(id) : undefined
      if (typeof body !== 'string' || body === '') return empty

      const fingerprintOf = (docId) => {
        const value = typeof registry?.fingerprintOf === 'function' ? registry.fingerprintOf(docId) : undefined
        return typeof value === 'string' ? value : ''
      }

      // 判断某个 id 是不是**受管文档**。`report`（交付物）必须被排除，
      // 否则交接 §5 里提到 `report.md` 就会被当成"依据文档"（2026-11-14 演练复盘）。
      const knownIds = (docId) => {
        try {
          const meta = typeof registry?.metaById === 'function' ? registry.metaById(docId) : undefined
          return meta !== undefined && meta !== null
        } catch {
          return false
        }
      }

      return handoverPointersOf(body, fingerprintOf, knownIds)
    } catch (error) {
      logger?.debug?.(`[ddd] 取 nextStep/basisDoc 失败（留空）：${error?.message ?? error}`)
      return empty
    }
  }

  /** 把注册表折成 `buildSnapshot` 的入参（抽出来是因为有两条调用路径）。 */
  function snapshotInputOf(registry, projectRoot, session, sessionId) {    const entries = Array.isArray(registry?.entries) ? registry.entries : []
    // ⚠️ 会话级 readSet。拿不到 session 时**给空 Map**，
    // 而不是 `registry.readSet`（共享的那份）—— 用共享的会让两个会话互相"替对方读过"。
    const readSet = session === undefined
      ? new Map()
      : registry.readSetFor(session)

    // ---- M2-D：交付成品的真源（R-10 那座桥）----
    //
    // `present` 会往**会话事件流**里 append `deliverables/presented`
    // （`dsh-tool-present/lib/index.js:119`）。那是唯一可查的事实来源。
    // 拿不到会话事件时 `presentedKnown: false` —— UI 要能说"不知道"，
    // 而不是谎称"确定没声明"。
    let presented = new Set()
    let presentedKnown = false
    try {
      if (session !== undefined && typeof session.snapshotEvents === 'function') {
        const events = typeof session.ownEvents === 'function' ? session.ownEvents() : session.snapshotEvents()
        presented = presentedPathsOf(events)
        presentedKnown = true
      }
    } catch (error) {
      logger?.debug?.(`[ddd] 读会话事件失败（交付声明未知）：${error?.message ?? error}`)
    }

    return {
      entries,
      readSet,
      sessionId: typeof sessionId === 'string' ? sessionId : '',
      projectRoot,
      project: projectLineOf(registry),
      slice: sliceLineOf(registry),
      // 预算：**字段是 `over`**（SPEC §4.2 订正 1）。
      budget: computeBudget(registry?.index?.required ?? [], resolved.coldStartBudgetTokens),
      // 交付/坟场由**异步补齐**（它们要列目录），这里先给空数组，
      // 由 `snapshotOf` 在外面 await 之后填进去。
      _pending: { deliverablesDir: join(projectRoot, resolved.deliverablesDir), presented, presentedKnown },
      // ---- M2.3：`nextStep` / `basisDoc` 的真源 ----
      //
      // 真源 = **`role: handover` 且 `order` 最小的那份交接文档的正文**，
      // 取它的 §3「下一刀」与 §5「验收」里的引用。
      //
      // ⚠️ 三个"取不到就留空"的点（都不猜）：
      //   1. 项目里没有交接文档 → 两个字段都空；
      //   2. 交接文档没有 §3 / §5 → 对应字段空；
      //   3. 注册表没缓存到全文（`textOf` 返回 undefined）→ 空。
      //
      // 用 `registry.textOf()` 是**同步**的（读的是扫描时缓存的全文），
      // 所以可以在这里算，不需要 async。
      ...pointersOf(registry, sessionId),
    }
  }

  /**
   * 补齐需要列目录的两块（交付 / 坟场）。
   *
   * ⚠️ 它们必须是**异步**的（要 `ctx.fs.listDir`），
   * 而 `buildSnapshot` 是纯函数 —— 所以在这里 await 完再喂进去。
   */
  async function withDirs(input) {
    const base = input !== null && typeof input === 'object' ? input : {}
    const pending = base._pending
    const { _pending, ...rest } = base
    if (pending === undefined || _pending === undefined) return base

    let deliverables = []
    let graveyard = []
    try {
      const items = await fsAdapter.listDir(pending.deliverablesDir)
      deliverables = deliverablesOf({
        items,
        dirAbs: pending.deliverablesDir,
        presented: pending.presented,
        presentedKnown: pending.presentedKnown,
      })
    } catch { /* 目录不存在是常态：不是错误 */ }

    try {
      const items = await fsAdapter.listDir(join(base.projectRoot, resolved.graveyardDir))
      graveyard = graveyardOf(items, resolved.graveyardDir)
    } catch { /* 同上 */ }

    return {
      ...rest,
      deliverables,
      graveyard,
      graveyardCandidates: graveyardCandidatesOf(base.entries),
    }
  }

  // 释放：关 watcher / 停写入 / 清缓存。
  ctx.effect(() => () => {
    injectDisposer?.()
    for (const writer of writers.values()) {
      // 先退订（D1 的订阅），再停写者。
      if (typeof writer.onDispose === 'function') {
        try { writer.onDispose() } catch { /* 退订失败不影响释放 */ }
      }
      writer.dispose()
    }
    for (const registry of registries.values()) void registry.stopWatching()
    writers.clear()
    registries.clear()
    initializing.clear()
    prober.clear()
  }, 'ddd.dispose()')

  logger?.debug?.('ddd-engine 已挂载：索引块 + 门禁 + 记账 + 坟场过滤（全局挂载，按项目激活）')
}

/**
 * 把 `ctx.fs` 包成 `docs/marker.js` / `docs/scan.js` 期望的形状。
 *
 * 只做三件事：列目录、读全文、读开头。**全部异步**。
 * 任何失败都返回 undefined / 空数组——探测与扫描失败不该让会话挂掉。
 *
 * @param {object} fs `ctx.fs`
 * @returns {object}
 */
export function createFsAdapter(fs) {
  if (fs === undefined || fs === null) {
    return {
      listDir: async () => [],
      readText: async () => undefined,
      readHead: async () => undefined,
    }
  }

  /** 解析路径（ctx.fs 的操作都作用在 resolve 出来的 target 上）。 */
  async function target(path) {
    return fs.resolve(path)
  }

  /**
   * 列直接子项。
   *
   * ⚠️ 下面三个函数都写成**闭包**、不用 `this`：
   * 它们会被单独取出来传给 `docs/marker.js` / `docs/scan.js`
   * （`probeMarker({ listDir: fsAdapter.listDir, ... })`），
   * 一旦用 `this.xxx` 就会因为 `this` 丢失而抛错，而抛错又被
   * 探测层的 `catch` 吞成"没命中" —— 表现就是**T1 永远探测不到**，
   * 且没有任何日志。这个坑我踩过一次。
   */
  const api = {
    async listDir(path) {
      try {
        const entries = await fs.listDir(await target(path))
        if (!Array.isArray(entries)) return []
        return entries.map((entry) => ({ name: entry.name, type: entry.type }))
      } catch {
        return []
      }
    },

    async readText(path) {
      try {
        return await fs.readText(await target(path))
      } catch {
        return undefined
      }
    },

    /**
     * 读开头（探测标记用）。
     *
     * SPEC §4.3 要求"只读 frontmatter 头，不要全文读"。
     * `ctx.fs` 的 `readByteRange` 不是所有后端都实现，所以这里读全文再截断——
     * 对 10~50 份、每份几十 KB 的量级，探测成本仍在可接受范围。
     */
    async readHead(path, maxBytes = 2048) {
      let text
      try {
        text = await fs.readText(await target(path))
      } catch {
        return undefined
      }
      return typeof text === 'string' ? text.slice(0, maxBytes) : undefined
    },
  }

  return api
}

/** 供冒烟脚本用：导出内部装配点（不参与 Cordis 生命周期）。 */
export const __internals = { createFsAdapter, BUNDLE_VERSION, dirname }

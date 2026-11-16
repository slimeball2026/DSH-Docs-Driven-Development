/**
 * 门禁适配（SPEC §7）。`ctx.tools.guard()` 的同步回调。
 *
 * **为什么用 guard 而不是新增工具**（Q9 = B，已冻结）：
 *   1. 歧义：两个工具都能改文件，模型会按习惯选（教练模式实机日志里
 *      模型在专用 `coach_research` 和通用 `web_search` 之间选了后者）。
 *   2. 门禁会被静默绕过：门禁建在专用工具上，模型用 `write` 改，你不报错、
 *      只会发现文档没更新——比没有门禁更糟。
 *   3. 重复实现：`write`/`edit` 已经做了定位、替换、原子写、diff 元数据、沙箱提权。
 *
 * **为什么不能在"注册时"跳过子代理**：`dsh-tools` 的 `checkGuards` 遍历
 * `[guards.global, ...chainLayers(exec.agent)]`——`guard()` 注册的是**全局层**，
 * 子代理调用工具时照样会跑。所以 S2 必须在回调**内部**判 `origin` 后返回 undefined。
 */

import { decideGate, pathArgOf } from '../core/gate.js'
import { decideSubagentWrite, isSubagentSession, shouldActivate } from '../core/scope.js'

/**
 * `pathArgOf` 的安全包装：任何异常都折成 `undefined`（= 抽不出路径 → 下面不拦）。
 *
 * 为什么不让它抛：guard 抛错会让**整次工具调用失败**，
 * 而"插件自己算不出路径"不该变成对模型的拒绝（与 `decideGate` 里那个 try/catch 同理）。
 */
function pathArgOfSafe(name, args) {
  try {
    return pathArgOf({ name, arguments: args })
  } catch {
    return undefined
  }
}

/**
 * 组装 guard 回调。
 *
 * @param {object} deps
 * @param {object} deps.config
 * @param {() => object} deps.registry 取注册表（同步）
 * @param {() => {hasMarker: boolean, projectRoot?: string}} deps.probe 取激活探测结果
 * @param {(absPath: string) => string} deps.classify
 * @param {(path: string) => string} deps.resolvePath 把（可能相对的）路径解析成绝对路径
 * @param {object} [deps.logger]
 * @returns {(exec: object) => string | undefined} guard 回调
 */
export function createGuard(deps) {
  const { config, registry, probe, classify, resolvePath, logger } = deps

  return function dddGuard(exec) {
    const session = exec?.agent?.session

    // ---- 第 0 句：**子代理写 docs/ 一律拒绝**（M1.5 / N9，`P14` 授权）
    //
    // ⚠️ **必须先于下面那句 `shouldActivate`**：S2 里子代理是"不激活 → return undefined"，
    // 也就是**整条门禁对它 no-op**。所以如果把 N9 的判定放在后面，永远走不到。
    //
    // 这正是 N9 的成因：M1 把 S2 的"不注入索引"当成了"什么都不管"，
    // 结果子代理能往 `docs/` 里塞一份**主 agent 永远改不了、索引里也看不见**的文件
    // （实测物证：`_review/proj-a/docs/subagent-probe.md`，18 bytes，无 frontmatter）。
    //
    // 现在的分工（用户原话）：**子代理只干工程活，`docs/` 只有主 agent 能改。**
    const name = exec?.name
    if (typeof name === 'string' && isSubagentSession(session)) {
      const path = pathArgOfSafe(name, exec?.arguments)
      if (typeof path === 'string') {
        const abs = typeof resolvePath === 'function' ? resolvePath(path, session) : path
        const verdict = decideSubagentWrite({
          toolName: name,
          path: abs,
          kind: typeof classify === 'function' ? classify(path, session) : 'outside',
          isSubagent: true,
          excludeSubagents: config.excludeSubagents,
        })
        if (typeof verdict === 'string') {
          logger?.debug?.(`[ddd] 子代理写 docs/ 被拒：${name} ${path}`)
          return verdict
        }
      }
      // 写 src/ 等非 docs/ 的工程活：**继续往下走**（下面会因为 S2 返回 undefined = 放行）。
      // 读也一样放行。**这是刻意的**：拦读会让子代理没法理解上下文。
    }

    // ---- 入口第一句：**要不要干活**（S1 / S2）。漏了这句，门禁就会在所有会话里生效。
    const info = typeof probe === 'function' ? probe(session) : {}
    const activated = shouldActivate({
      hasMarker: info.hasMarker === true,
      hasProjectRoot: info.projectRoot !== undefined,
      isSubagent: isSubagentSession(session),
      requireMarker: config.requireMarker,
      excludeSubagents: config.excludeSubagents,
      enabled: config.gateEnabled,
    })
    if (!activated) return undefined

    const reg = typeof registry === 'function' ? registry(session) : registry
    if (reg === undefined || reg === null) return undefined

    // 注册表没扫成功（failed）或还是空的 → **放行**。
    //
    // 为什么不拦：扫描失败的原因可能是沙箱、权限、超大目录，
    // 这些都不是"模型没读文档"的错。把插件自身的故障变成对模型的拒绝，
    // 等于让一个坏掉的插件阻断整个项目施工 —— 这比漏管一次严重得多
    // （交接 §8：「门禁漏一次只是少管一次，误伤一次会让模型没法干活」）。
    if (reg.state !== 'ready') return undefined

    // `name` 在上面的 N9 分支已经取过并做过类型判断，这里不重复声明。
    if (typeof name !== 'string') return undefined

    let verdict
    try {
      verdict = decideGate({
        toolName: name,
        args: exec.arguments,
        gateEnabled: config.gateEnabled,
        required: reg.index?.required ?? [],
        readSet: typeof reg.readSetFor === 'function' ? reg.readSetFor(session) : reg.readSet,
        currentFingerprint: (id) => reg.fingerprintOf(id),
        // M2.8：本会话自己写过的文档，`edit` 不必再为"自己刚改的指纹"重读。
        // 与 `tools/doc-mark.js` 第 4 步同一条语义、同一份内存集合。
        // ⚠️ 只豁免**指纹比对**，不豁免"必须先读"（`core/gate.js` 的注释里有论证）。
        isSelfWritten: (id) => (typeof reg.isSelfWritten === 'function' ? reg.isSelfWritten(id, session) : false),
        classify: (path) => classify(path, session),
        metaOf: (path) => {
          const abs = typeof resolvePath === 'function' ? resolvePath(path, session) : path
          return reg.entryByPath(abs)?.meta
        },
        knownOf: (path) => {
          const abs = typeof resolvePath === 'function' ? resolvePath(path, session) : path
          return reg.entryByPath(abs) !== undefined
        },
        // M1.5 / N1：`unmanaged`（完全没有 frontmatter）要能放行写入。
        //
        // 数据源与 `knownOf` **同一个**：`registry.entries` 里就含 unmanaged 条目
        // （`adapters/registry.js` 的注释写明「所有条目（含 unmanaged 与坏文档）」），
        // 只是 `buildIndex` 把它们从三份清单里排除掉了。**不用新开接口。**
        unmanagedOf: (path) => {
          const abs = typeof resolvePath === 'function' ? resolvePath(path, session) : path
          return reg.entryByPath(abs)?.unmanaged === true
        },
        // M1.5 / N1b：「只改 frontmatter 的 edit」判定要用原文比对匹配位置。
        //
        // 取的是**注册表缓存的全文**（`entry.text`），**不读盘** —— 这里的回调是同步的。
        // 缓存按 `rescan` / `tools/result` 更新，与门禁其它判据用的是同一份快照，
        // 所以不会出现「门禁看到的内容」与「指纹判据看到的内容」来自两个时刻。
        textOfPath: (path) => {
          const abs = typeof resolvePath === 'function' ? resolvePath(path, session) : path
          return reg.entryByPath(abs)?.text
        },
        errorOf: (id) => reg.hasError(id),
        textOf: (id) => reg.textOf(id),
      })
    } catch (error) {
      // guard 抛错会让整次工具调用失败。宁可放行也不能让插件故障阻断施工。
      logger?.warn?.(`[ddd] 门禁判定异常，本次放行：${error?.message ?? error}`)
      return undefined
    }

    if (verdict.warn !== undefined) logger?.debug?.(`[ddd] ${verdict.warn}`)
    return verdict.decision === 'deny' ? verdict.reason : undefined
  }
}

/**
 * client bundle 的**入口**（tsdown 打成单文件 `lib/client.js`）。
 *
 * ---- 为什么要这一层薄壳 ----
 *
 * `__ModuleLoader__.load({ id, factory })` 的 `factory(require)` 里
 * **只能 `require` 白名单里的包**，**不能 import 本地文件**
 * （SPEC §3.1 + `@local/dsh-plugin` 的真实源码）。
 *
 * 所以：**所有本地模块必须被 tsdown 打进同一个文件**，
 * 而 `react` 等白名单包必须保持 `require(...)` 的形态、**不许被打包进去**。
 *
 * ---- `id` 必须与 package 名一致 ----
 *
 * `smoke-ddd.mjs` 有一条断言钉住它（SPEC §8.2 第 3 条）：
 * `lib/client.js` 里有 `__ModuleLoader__.load` 且 `id` 与 package name 一致。
 *
 * ---- ⚠️ 2026-11-13 的实机事故（**别再犯**）----
 *
 * 这个文件里曾经直接写 `const sidebarRight = ctx?.sidebarRight`。
 * cordis 的 `ctx` 是 **Proxy**：读一个**没写进 `inject` 的服务会直接抛**
 * `cannot get property "sidebarRight" without inject`，`?.` 拦不住。
 * 结果 `apply()` 在第一行就死 → 双注册永不执行 → **面板不出现**，
 * 而 entry 仍是 active、factory 仍已注册、**且不写 crash 日志**。
 *
 * 现在所有可选服务一律走 `entry-logic.ts` 的 `softService`（即 `ctx.get(...)`）。
 * 那个文件的逻辑有 `test/client-entry.test.js` 钉着。
 *
 * ⚠️ **纯逻辑不要写在这个 `.tsx` 里**：Node 的类型剥离不处理 JSX，
 * `.tsx` 无法被单测 import（`ERR_UNKNOWN_FILE_EXTENSION`）。
 * 想被测到 → 放 `entry-logic.ts`。
 */

import { createController, registerPanel, registerSessionTab, setPreviewOpener } from './index.tsx'
import { pickProjectDirectory, sessionInfoOf, wirePreviewOf } from './entry-logic.ts'
import { fetchProjects, fetchSnapshot, postInit, postRecheck, previewAddressOf } from './api.ts'
import { resolveCwd } from './session-tab.ts'

/** 与 `package.json` 的 `name` **必须逐字一致**（smoke 有断言）。 */
export const CLIENT_ID = '@local/ddd'

/**
 * 在会话作用域里开预览。
 *
 * 与 `wirePreview` 的区别：那条是"把 opener 装进槽位给 root 面板用"（可能降级），
 * 这条是**当场调用**（页签里点文档时）。两者共用同一个 `ctx.sidebarRight`。
 *
 * 拿不到 `sidebarRight` 时**抛**，由调用方 warn —— 页签里点了没反应比抛更难查。
 */
function openPreviewVia(ctx: any, address: string): void {
  const sidebarRight = ctx?.sidebarRight
  if (sidebarRight === undefined || typeof sidebarRight?.openResource !== 'function') {
    throw new Error('sidebarRight 不可用')
  }
  sidebarRight.openResource(address)
}

/**
 * 注入预览通道（M2-B）。
 *
 * 真实现与"拿不到时怎么降级"都在 `entry-logic.ts` 的 `wirePreviewOf` 里，
 * 这里只负责把结果装进 `index.tsx` 的 opener 槽位。
 */
function wirePreview(ctx: any): void {
  const wire = wirePreviewOf(ctx)
  if (wire.kind === 'unavailable') {
    // eslint-disable-next-line no-console
    console.warn(wire.warning)
  }
  setPreviewOpener(wire.open)
}

/**
 * Cordis 客户端插件入口。
 *
 * ---- `inject` 里为什么有 `sidebarRight` / `sidebarRightTabs` ----
 *
 * 这两个都是 `dsh-client-ui-sidebar-right` 用 `ctx.reflect.provide` 提供的。
 * `provide()` 写的与 `get()` 读的是**同一个 store**，所以 `ctx.get` 并非"永远拿不到"
 * —— 但 `get(name, strict = true)` 在**提供方 fiber 还没 active** 时返回 `undefined`，
 * 那是时序问题。写进 `inject` 后由 cordis 负责等它 active，才是正路
 * （官方 `ui-reference` / `ui-chat` / `ui-plan` / `ui-sidebar-documentpreview` 都这么做）。
 *
 * 不写 `sidebarRight` 的后果（2026-11-13 用户实测）：「鼠标放上去会变手势，但点击没有反应」。
 * 不写 `sidebarRightTabs` 的后果（M2.3）：会话右栏的 DDD 页签**不出现**。
 *
 * ⚠️ 其余可选服务（`layout` / `sessions` / `uiWorkspace`）仍然走 `ctx.get(...)` 软取，
 * 保持「缺服务只降级，不让插件消失」的纪律。
 */
export default {
  inject: ['slots', 'sidebarRight', 'sidebarRightTabs'] as string[],
  apply(ctx: any): () => void {
    wirePreview(ctx)
    // cwd 由用户显式选（宿主不给 root-scope 面板会话绑定，见 entry-logic.ts 的说明）。
    // 这里传空串起动：面板会显示"请先选择项目根"，选完才取数。
    const { cwdOf, sessionIdOf } = sessionInfoOf(ctx, '')
    const controller = createController({
      cwdOf,
      sessionIdOf,
      projectsOf: fetchProjects,
      // 候选只含"被会话打开过"的目录；新项目靠这个原生选择器指定。
      pickDirectoryOf: () => pickProjectDirectory(ctx),
      // ⟳ 必须真的让 host 清探测缓存，否则"新建 docs/ 后点刷新"永远没反应。
      recheckOf: postRecheck,
      // 一键初始化：建 docs/ + 写入口索引。
      initOf: postInit,
    })

    // 两个**互相独立**的注册：root 侧（左栏 + 主栏）与 session 侧（会话右栏页签）。
    // 任何一个失败都不该连累另一个 —— 所以这里**真的**用 try/catch 隔开，
    // 而不是只靠"各自内部应该不会抛"这种假设（M2.2 的教训：apply 第一行抛 = 全没了）。
    const disposePanel = registerPanel(ctx, controller)
    let disposeTab: () => void = () => {}
    try {
      disposeTab = registerSessionTab(ctx, {
        // ⚠️ **纯快照读**，不是 hook。2026-11-14 的事故就是把 hook 藏进了这条链。
        cwdOf: (sessionId) => resolveCwd(ctx, sessionId),
        fetchSnapshot,
        // 页签自己造 controller（通过 wiring 传，避免与 index.tsx 循环依赖）。
        makeController: (options) => createController(options),
        // 会话作用域里**能**开预览 —— 走与主栏同一个 opener（entry-logic 已接好）。
        openDoc: (address) => {
          try {
            openPreviewVia(ctx, address)
          } catch (error) {
            // eslint-disable-next-line no-console
            console.warn(`[ddd] 页签内打开预览失败：${(error as Error)?.message ?? error}`)
          }
        },
        addressOf: previewAddressOf,
      })
    } catch (error) {
      // 页签挂了只影响右栏，主栏照常工作。
      // eslint-disable-next-line no-console
      console.warn(`[ddd] 会话右栏页签注册失败（主栏不受影响）：${(error as Error)?.message ?? error}`)
    }

    return () => {
      try { disposeTab() } catch { /* 释放失败不影响主面板 */ }
      try { disposePanel() } catch { /* 忽略 */ }
    }
  },
}

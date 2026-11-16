/**
 * tsdown 构建配置（M2-Q5 = TypeScript + tsdown）。
 *
 * ---- 三条硬要求（缺一条就白做）----
 *
 * 1. **单文件 bundle**：`__ModuleLoader__.load` 的 `factory(require)` 里
 *    **不能 import 本地文件**（SPEC §3.1）。所以本地模块必须全部打进来。
 * 2. **`react` 必须是 external**：宿主通过 ModuleLoader 提供同一个 React 实例。
 *    自己打一份进去会让 hooks 崩（"Invalid hook call"），体积也会翻倍。
 * 3. **产物必须是 `window.__ModuleLoader__.load({ id, factory })` 的形态**。
 *
 * ---- 为什么用 `cjs` 格式而不是 `iife`（**这一步踩过坑**）----
 *
 * 宿主那段契约是：
 * ```js
 * window.__ModuleLoader__.load({ id, factory: (require) => { ... return module.exports } })
 * ```
 * 也就是说 **`require` 是宿主的 `factory` 参数**，不是全局函数。
 *
 * 我第一版用 `format: 'iife'` + `external: ['react']`，结果是打包器把
 * `react` 变成**全局变量引用**（`window.React`）—— 而宿主根本不提供它。
 * 症状会是：面板引用 `React.createElement` 时 `undefined`，整个 bundle 抛错，
 * **面板不出现**，而它与"没注册"在 UI 上长得完全一样。
 *
 * 正确的做法是照**真实可运行的范例**抄（`dsh-cuigengji-plugin/lib/client.js` 的头尾）：
 * ```js
 * window.__ModuleLoader__.load({id:"...",factory:(require)=>{var module={exports:{}};
 *   ... CJS 产物 ...
 * return module.exports;}});
 * ```
 * 即：**CJS 格式**（这样 `require('react')` 原样保留，由宿主注入的 `require` 解析）
 * + `banner`/`footer` 手工包成那个外壳。
 *
 * ---- 为什么输出到 `lib/client.js` ----
 *
 * `package.json` 的 `exports['./client']` 指向它，而宿主**缺这个文件时会让整个插件
 * 加载失败**（R-11）—— 不是"面板静默消失"，是**连门禁一起哑火**。
 */

import { defineConfig } from 'tsdown'

/** 与 `package.json` 的 `name` 必须逐字一致（`smoke-ddd.mjs` 有断言）。 */
export const CLIENT_ID = '@local/ddd'

export default defineConfig({
  entry: { client: 'src/client/boot.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  clean: false,
  sourcemap: false,
  minify: false,
  // 由宿主提供，**绝不能打进来**。
  // ⚠️ tsdown 0.23 起 `external` 已弃用，`deps.neverBundle` 是新写法。
  deps: { neverBundle: ['react', 'react-dom', 'react/jsx-runtime'] },
  // ⚠️ cjs 格式默认扩展名是 `.cjs`，但 `package.json` 的 `exports['./client']`
  // 与宿主的约定都是 `lib/client.js` —— 名字不一致 = 文件不存在 = 插件整体加载失败（R-11）。
  outExtensions: () => ({ js: '.js' }),
  inputOptions: {
    // cjs 默认按 Node 目标处理；我们的产物跑在浏览器里、`require` 由宿主注入。
    platform: 'browser',
  },
  // ⚠️ `boot.tsx` 里已经手工写了 `window.__ModuleLoader__.load(...)`，
  // 但那里的 `require` 是**参数**，打包成 CJS 后模块顶层的 `require('react')`
  // 会被解析成这个参数 —— 这正是我们要的。
  banner: `window.__ModuleLoader__.load({id:${JSON.stringify(CLIENT_ID)},factory:(require)=>{var module={exports:{}};var exports=module.exports;`,
  footer: 'return module.exports.default !== undefined ? module.exports.default : module.exports;}});',
})

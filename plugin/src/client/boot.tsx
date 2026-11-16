/**
 * client bundle 的构建入口（tsdown 打成单文件 `lib/client.js`）。
 *
 * ---- 这个文件**不写** `window.__ModuleLoader__.load` ----
 *
 * 那个外壳由 `tsdown.config.ts` 的 `banner` / `footer` 包：
 * ```js
 * window.__ModuleLoader__.load({id:"@local/ddd",factory:(require)=>{var module={exports:{}};
 *   ... 本文件的 CJS 产物 ...
 * return module.exports.default ... ;}});
 * ```
 *
 * **为什么不在这个文件里手写外壳**：那样 `require('react')` 会变成**模块顶层的
 * 自由变量引用**，打包后指向全局 `require`（宿主的 `factory` 参数作用域外），
 * 运行时 `require is not defined`。外壳必须由打包器在**最外层**加上，
 * 这样 CJS 的 `require(...)` 才落在 `factory(require)` 的参数作用域里。
 *
 * （真实可运行的范例：`dsh-cuigengji-plugin/lib/client.js` 的头尾。）
 *
 * ---- `factory(require)` 里能用什么 ----
 *
 * 只能 `require` 白名单里的包（`dsh.client.inject` + `PLATFORM_MODULES`），
 * **不能 import 本地文件** —— 所以本文件及其依赖必须被**打进同一个文件**。
 */

import plugin from './entry.tsx'

export default plugin

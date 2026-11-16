/**
 * 目录创建（**本项目唯一一处直接用 `node:fs` 的地方**）。
 *
 * ---- 为什么必须破这条纪律（2026-11-13 用户拍板）----
 *
 * 本项目的既有纪律是「**插件从不创建目录**」：
 * `ctx.fs` 抽象里**没有 mkdir**（只有 resolve / stat / read / write / move / delete），
 * 所以要建目录只能绕开它。
 *
 * 原纪律的动机是对的：M2.1 选"归档元数据写进文件自己"而不是 `_artifacts/graveyard.json`，
 * 理由之一就是后者会逼插件建目录，而"造目录"是往用户项目里塞东西。
 *
 * 但「一键把目录初始化成 DDD 工作区」这个功能**本质上就需要建 `docs/`** ——
 * 用户原话：「要我手动建 ddd 工作区太麻烦了」。
 * 让用户先手建一个空目录、再让插件写文件，是把同一件事拆成两步且**中间没有任何收益**。
 *
 * 所以这里**显式地**破这条纪律，并且：
 *
 * 1. **只建 `docs/` 这一个目录**，不递归、不建其它任何目录；
 * 2. **只在用户显式点"初始化"时调用** —— 不在任何自动路径上；
 * 3. **目标已存在就什么都不做**（幂等，绝不碰用户已有内容）；
 * 4. **越界检查**：解析后的路径必须仍在项目根之内。
 *
 * ⚠️ 这个文件**故意**与 `server/write-engine.ts` 分开：
 * 后者被 `test/decoupling.test.js` 断言"零 `node:` import"。
 * 把越界的那一处单独隔离，那条断言就仍然有效，而且**一眼能看出哪里破了纪律**。
 */

import { mkdir, realpath, stat } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

/** 建目录的结果。**形状固定**，调用方不用判空。 */
export interface MakeDirResult {
  ok: boolean
  /** 这次真的创建了（false = 已经存在）。 */
  created: boolean
  /** 失败时的原因（`ok:false` 时必有）。 */
  error?: string
}

/**
 * 判断 `child` 是否在 `parent` 之内（含相等）。
 *
 * ⚠️ **不能只比字符串**（实测踩过）：
 * Windows 的 `realpath` 会把长名折叠成 **8.3 短名**（`SLIMEB~1`），
 * 而调用方给的 `target` 是长名形式。直接 `startsWith` 会**误判为越界**，
 * 于是"在临时目录里建 docs/"这种完全正常的操作被拒绝。
 *
 * 所以：能 `realpath` 的一律 `realpath` 后再比；
 * 目标不存在时（`realpath` 抛错），退回到**比较它的父目录**。
 *
 * @param parent 已 realpath 的父目录
 * @param child 子路径（可能不存在）
 */
async function isInside(parent: string, child: string): Promise<boolean> {
  const parentAbs = resolve(parent)
  const childAbs = resolve(child)

  const withSep = (path: string): string => (path.endsWith(sep) ? path : path + sep)
  const looksInside = (a: string, b: string): boolean => a === b || a.startsWith(withSep(b))

  // 1) 目标已存在 → 两边都 realpath，用真实形态比。
  try {
    const childReal = await realpath(childAbs)
    return looksInside(childReal, parentAbs)
  } catch {
    // 目标不存在，继续。
  }

  // 2) 逐级向上找**最近一个存在的祖先**，realpath 它，再把剩下的相对段拼回去。
  //
  //    为什么必须这样（实测踩过两次）：Windows 的 `realpath` 会把长名折成 8.3 短名
  //    （`SLIMEB~1`）。如果拿"不存在的深层路径"按字面比，就会**误判为越界**，
  //    于是"在项目里建一个两层深的目录"被拒绝，而错误信息还说"在项目根之外"——完全误导。
  let current = childAbs
  const tail = []
  while (true) {
    try {
      const real = await realpath(current)
      const joined = resolve(real, ...tail)
      return looksInside(joined, parentAbs)
    } catch {
      const parentOfCurrent = dirname(current)
      // 到盘根还解析不了 → 没法判断，**保守拒绝**。
      if (parentOfCurrent === current) return false
      tail.unshift(current.slice(parentOfCurrent.length).replace(/^[\\/]+/, ''))
      current = parentOfCurrent
    }
  }
}

/**
 * 确保 `target` 这个目录存在。
 *
 * @param projectRoot 项目根（绝对路径）；`target` 必须落在它之内
 * @param target 要建的目录（绝对路径）
 * @returns 结果；**绝不抛**
 */
export async function ensureDirectory(projectRoot: string, target: string): Promise<MakeDirResult> {
  if (typeof projectRoot !== 'string' || projectRoot === '') {
    return { ok: false, created: false, error: '没有项目根，拒绝建目录。' }
  }
  if (typeof target !== 'string' || target === '') {
    return { ok: false, created: false, error: '没有目标目录。' }
  }

  let rootReal: string
  try {
    rootReal = await realpath(projectRoot)
  } catch (error) {
    return { ok: false, created: false, error: `项目根不可解析：${(error as Error)?.message ?? error}` }
  }

  if (!await isInside(rootReal, target)) {
    return { ok: false, created: false, error: `拒绝在项目根之外建目录：${target}` }
  }

  const targetAbs = resolve(target)

  try {
    // 先看是否已存在：已存在就**绝不**碰它（mkdir 的 recursive 会静默成功，这里要能区分）。
    try {
      const info = await stat(targetAbs)
      if (info.isDirectory()) return { ok: true, created: false }
      return { ok: false, created: false, error: `目标已存在但不是目录：${targetAbs}` }
    } catch {
      // 不存在 → 往下建。
    }

    // ⚠️ **只建这一层**（不 recursive）：`docs/` 的父目录是项目根，必然存在。
    // 用 recursive 会让"父目录也缺失"这种异常输入被静默补全成一条长目录链。
    await mkdir(targetAbs)
    return { ok: true, created: true }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    // 并发下可能被别人抢先建好 —— 那不是错误。
    if (code === 'EEXIST') {
      return { ok: true, created: false }
    }
    // 父目录不存在：这是调用方的问题，明说。
    if (code === 'ENOENT') {
      return { ok: false, created: false, error: `父目录不存在：${dirname(targetAbs)}` }
    }
    return { ok: false, created: false, error: (error as Error)?.message ?? String(error) }
  }
}

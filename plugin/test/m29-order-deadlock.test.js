/**
 * M2.9 · 交接提示里 **`order` 的顺序死锁**必须有出路（用户拍板方案 A）。
 *
 * ---- 现场（第 32 轮 `session-1fe6505f`）----
 *
 * AI 严格照技能手册的顺序：**先改 `read-order`，再建交接**。
 * 但它在 `read-order` 的必读清单里给交接写了 `order 0` —— 而 `doc_new`
 * 实际给的是 `-10`（第一份交接 = 最小 handover order − 10 = `-10`）。
 *
 * 结果：建完发现对不上 → 重读整份 `read-order`（`edit` 已让它失效）→ 再 `edit` 一次。
 * 那份 `read-order` 里甚至留下了自相矛盾的痕迹：第 28 行写 `order -10`，
 * 第 46 行还写着"交接固定排最前（order 0）"。
 *
 * ---- 根因不是"它粗心"，是**顺序死锁** ----
 *
 * ```
 * 手册要求：先改 read-order（这样交接里那句"索引已更新"才是真的）
 * 清单要求：写交接的 order
 * 而 order：只有 doc_new 建完才知道
 * ```
 *
 * 三条要求不可能同时满足 —— 这和 M2.8 修掉的「交接 ↔ 索引循环依赖」是**同一个形状**，
 * 只是那次修的是"条目存在与否"，这次是"条目里的数字"。
 *
 * ---- 修法（用户拍板 A：`doc_new` 支持显式传 `order`）----
 *
 * 那个能力**早就有**（`tools/doc-new.js` 里 `typeof args?.order === 'number'` 那条），
 * 缺的只是**没有任何地方告诉 AI 它能用**。所以这一批改的全是**文案**：
 *
 *   ① 建交接的提示里给出两条不会返工的写法（不写数字 / 显式传 order）；
 *   ② 「清单里已经有」的回执里带上实际 order，供对账；
 *   ③ 明确说"别凭感觉填 0"—— 那是实测返工过的具体错法。
 *
 * ⚠️ **这不是"加判据"**。没有新增任何 `if`，只是把已有的出路说出来。
 *    M2.9 的方向是减摩擦，而"信息没给到"是纯摩擦。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createNewTool, nextHandoverOrder } from '../tools/doc-new.js'
import { resolveConfig } from '../config.js'

const CONFIG = resolveConfig({})

/** 最小的假 world（与 `tools.test.js` 的 fakeWorld 同形，这里只取需要的部分）。 */
function fakeWorld(entries = []) {
  const files = new Map()
  const registry = {
    state: 'ready',
    entries,
    index: { required: [], forbidden: [], anomalies: [] },
    readSetFor: () => new Map(),
    readSet: new Map(),
    entryById: (id) => entries.find((e) => e.meta?.id === id),
    entryByPath: (p) => entries.find((e) => e.path === p),
    fingerprintOf: () => 'FINGERPRINT',
    hasError: () => false,
    textOf: (id) => entries.find((e) => e.meta?.id === id)?.text,
    markRead: async () => {},
    noteSelfWrite: () => {},
    isSelfWritten: () => false,
    rescan: async () => {},
  }
  const fs = {
    async resolve(path) { return { displayPath: path, targetKey: path } },
    async readText(target) {
      if (files.has(target.targetKey)) return files.get(target.targetKey)
      const found = entries.find((e) => e.path === target.targetKey)
      return found?.text
    },
    async writeText(target, text) { files.set(target.targetKey, text) },
  }
  return { registry, fs, files }
}

const execOf = () => ({ agent: { session: { header: { cwd: 'C:/proj' } } }, signal: undefined })

test('nextHandoverOrder：没有现存交接时给 **-10**（不是 0）', () => {
  // 这条数字是"猜 0 会返工"的根源，必须钉住。
  assert.equal(nextHandoverOrder([]), -10)
})

test('nextHandoverOrder：已有 -10 时给 **-20**（留插值空间）', () => {
  assert.equal(nextHandoverOrder([{ meta: { role: 'handover', order: -10 } }]), -20)
})



test('**显式传 order 时真的用它**（方案 A 的工具侧能力，此前无测试）', async () => {
  // ⚠️ 这个能力**早就实现了**，但从来没有任何测试钉住它。
  // 于是"文档说能传、实际不能用"这种漂移不会被发现。
  const world = fakeWorld([])
  const tool = createNewTool({
    config: CONFIG, registry: () => world.registry, fs: world.fs,
    projectRoot: () => 'C:/proj', cwdOf: () => 'C:/proj',
  })
  const value = await tool.execute(
    { role: 'handover', title: '交接', summary: '甲', id: 'handover-1', order: -10, body: '# 交接\n' },
    execOf(),
  )
  assert.equal(value.order, -10, '显式传的 order 没被采用 —— 方案 A 的文案会变成空头支票')
})

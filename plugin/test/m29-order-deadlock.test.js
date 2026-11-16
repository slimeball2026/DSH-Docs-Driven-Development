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

import { createNewTool, handoverIndexHintOf, nextHandoverOrder } from '../tools/doc-new.js'
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

test('**建交接的提示必须给出 `order` 的两条出路**（否则 AI 只能猜 0）', async () => {
  const world = fakeWorld([])
  const tool = createNewTool({
    config: CONFIG, registry: () => world.registry, fs: world.fs,
    projectRoot: () => 'C:/proj', cwdOf: () => 'C:/proj',
  })
  const value = await tool.execute(
    { role: 'handover', title: '交接', summary: '甲', id: 'handover-1', body: '# 交接\n' },
    execOf(),
  )
  const rendered = tool.output.render({}, value).map((item) => item.text ?? '').join('\n')

  // ① 必须说清 order 是"建完才知道"的（否则 AI 以为它该算得出来）
  assert.match(rendered, /建完才知道/, '没说清 order 的可知时机 —— AI 会继续凭感觉猜')
  // ② 出路一：不写数字
  assert.match(rendered, /不写数字|只写 `id`/, '没给"不写数字"这条最省事的出路')
  // ③ 出路二：显式传 order
  assert.match(rendered, /显式传 `order`/, '没告诉 AI "doc_new 支持显式传 order"（方案 A 的落点）')
  // ④ 点名那个实测错法
  assert.match(rendered, /0/, '没点名"别填 0"这个具体错法')
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

test('显式传一个**排不到最前**的 order → 如实警告（不静默改）', async () => {
  // 已有 order 500 的交接，新建时显式传 600 → 它不是最小的，H7 会判不合格。
  // 工具**不改**用户给的值（那是明确要求），但必须说出来。
  const oldText = '---\nid: h-old\ntitle: 旧\nrole: handover\norder: 500\nstatus: authoritative\nsummary: 旧\nbasis: 实测\n---\n\n# 旧\n'
  const world = fakeWorld([
    {
      path: 'C:/proj/docs/h-old.md',
      text: oldText,
      body: oldText,
      meta: { id: 'h-old', role: 'handover', order: 500, status: 'authoritative' },
      fingerprint: 'F', unmanaged: false, hasError: false,
    },
  ])
  const tool = createNewTool({
    config: CONFIG, registry: () => world.registry, fs: world.fs,
    projectRoot: () => 'C:/proj', cwdOf: () => 'C:/proj',
  })
  const value = await tool.execute(
    { role: 'handover', title: '新交接', summary: '乙', id: 'handover-2', order: 600, body: '# 新\n' },
    execOf(),
  )
  assert.equal(value.order, 600, '工具擅自改了显式传的 order')
  assert.match(value.orderWarning, /不是最小的|H7/, '排错了却不警告，AI 会以为没问题')
})

test('「清单里已经有」的回执必须带上**实际 order** 供对账', () => {
  const hint = handoverIndexHintOf('必读清单里已经有 `handover-1`，不覆盖模型写的措辞', -10)
  assert.match(hint, /`-10`/, '没给实际 order —— AI 无法发现自己写的是 0')
  assert.match(hint, /一致/, '没要求它去对账')
})

/**
 * `nextStep` / `basisDoc` 真源的测试（M2.3 收尾 · M2 最后一条遗留判据）。
 *
 * ---- 这个文件要钉住的核心 ----
 *
 * **取不到就留空，绝不猜。**
 *
 * 这两行从 M2 起就一直不显示（因为没人填），补上它们的价值在于"让看板完整"，
 * 而不在于"无论如何都要显示点什么"。所以最坏的结果不是"没有内容"，
 * 是"显示了一个编造的内容"—— 那会让人照着错的方向干活。
 *
 * 因此每个"取不到"的分支都单独钉一条断言。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  basisDocOf,
  handoverPointersOf,
  nextStepOf,
  nextStepsOf,
  primaryHandoverOf,
  withFingerprint,
} from '../core/pointers.js'

/** 造一份最小交接文档。 */
function handover(nextBody, extra = {}) {
  return [
    '# 交接',
    '',
    '## 1. 我的意图',
    '把某件事做完。',
    '',
    '## 2. 现在到哪了',
    '做到一半。',
    '',
    '## 3. 下一刀',
    nextBody,
    '',
    '## 4. 坑',
    '无',
    '',
    '## 5. 验收',
    extra.acceptance ?? 'tests 100/100 全绿',
    '',
    '## 6. 刻意没做的事',
    '无',
    '',
    '## 7. 仍未决',
    '无',
  ].join('\n')
}

test('nextStepsOf：认有序列表，且**保持原顺序**', () => {
  const body = handover([
    '1. 修 `_rv/mutate.mjs` 的 2 个 BAD-ANCHOR',
    '2. 做 `nextStep` 真源',
    '3. 坟场支持同名',
  ].join('\n'))
  const items = nextStepsOf(body)
  assert.equal(items.length, 3, '夹具没被解析出来 —— 后面的断言会变成恒真')
  assert.deepEqual(items.map((item) => item.text), [
    '修 `_rv/mutate.mjs` 的 2 个 BAD-ANCHOR',
    '做 `nextStep` 真源',
    '坟场支持同名',
  ])
  assert.deepEqual(items.map((item) => item.seq), [1, 2, 3])
})

test('nextStepsOf：认无序列表', () => {
  const body = handover(['- 第一件', '* 第二件', '+ 第三件'].join('\n'))
  const items = nextStepsOf(body)
  assert.equal(items.length, 3)
  assert.deepEqual(items.map((item) => item.text), ['第一件', '第二件', '第三件'])
})

test('nextStepsOf：认表格（取"任务"那一列），跳过表头与分隔行', () => {
  const body = handover([
    '| 顺序 | 任务 | 落点 |',
    '|---|---|---|',
    '| 1 | 修 BAD-ANCHOR | `_rv/mutate.mjs` |',
    '| 2 | nextStep 真源 | `core/handover.js` |',
  ].join('\n'))
  const items = nextStepsOf(body)
  assert.equal(items.length, 2, `表格没被正确解析（实际 ${items.length} 条）`)
  assert.deepEqual(items.map((item) => item.text), ['修 BAD-ANCHOR', 'nextStep 真源'])
})

test('nextStepsOf：**跳过已完成的条目**（删除线 / ✅）', () => {
  const body = handover([
    '1. ~~重启后验页签~~ ✅',
    '2. 真的还没做的事',
    '3. ✅ 也做完了',
    '4. ~~另一个做完的~~',
  ].join('\n'))
  const items = nextStepsOf(body)
  assert.equal(items.length, 1, '已完成的条目没被跳过 —— 会把"做完了"当成"下一步"')
  assert.equal(items[0].text, '真的还没做的事')
})

test('nextStepsOf：**没有「下一刀」这一节 → 空数组**（不猜）', () => {
  const body = [
    '# 交接',
    '## 1. 我的意图',
    '只有意图，没有下一刀。',
  ].join('\n')
  assert.deepEqual(nextStepsOf(body), [])
})

test('nextStepsOf：空正文 / 坏输入 → 空数组，不抛', () => {
  assert.deepEqual(nextStepsOf(''), [])
  assert.deepEqual(nextStepsOf(undefined), [])
  assert.deepEqual(nextStepsOf(null), [])
  assert.deepEqual(nextStepsOf(42), [])
})

test('nextStepsOf：跳过子标题（`### 5.1` 不是条目）', () => {
  const body = handover([
    '### 5.1 已完成',
    '1. 真正的事',
    '### 5.2 未完成',
    '2. 另一件真正的事',
  ].join('\n'))
  const items = nextStepsOf(body)
  assert.equal(items.length, 2)
  assert.deepEqual(items.map((item) => item.text), ['真正的事', '另一件真正的事'])
})

test('nextStepOf：**只取第一条**（看板那一行只放得下一件事）', () => {
  const body = handover([
    '1. 第一优先的事',
    '2. 第二件事',
  ].join('\n'))
  assert.equal(nextStepOf(body), '第一优先的事')
})

test('nextStepOf：没有条目时返回**空串**（不是 undefined、不是占位符）', () => {
  assert.equal(nextStepOf(handover('')), '')
  assert.equal(nextStepOf(''), '')
  assert.equal(nextStepOf(undefined), '')
})

// ---- basisDocOf 的入参变了（2026-11-14 演练复盘）----
//
// 现在它**只扫 §5「验收」**，且可以用 `knownIds` 校验 id 是否受管文档。
// 这一组 helper 把"引用放在 §5 里"这件事封装掉，避免每条测试都写整份文档。

/** 把一段 §5 正文包成一份最小交接。 */
function withAcceptance(text) {
  return handover('1. 下一件事', { acceptance: text })
}

/** 全部 id 都认（不校验）—— 用于测解析规则本身。 */
const knowsAll = () => true

test('basisDocOf：认反引号文档名 + `§` 小节（在 §5 里）', () => {
  const ref = basisDocOf(withAcceptance('详见 `SPEC-M2-文档驱动开发插件.md` §4.2'), knowsAll)
  assert.deepEqual(ref, { id: 'SPEC-M2-文档驱动开发插件', section: '4.2', fingerprint: '' })
})

test('basisDocOf：没有小节时 section 是空串（不编一个）', () => {
  const ref = basisDocOf(withAcceptance('见 `M2.3-事故记录-右栏被炸空.md`'), knowsAll)
  assert.equal(ref.id, 'M2.3-事故记录-右栏被炸空')
  assert.equal(ref.section, '')
})

test('basisDocOf：**不接受裸文件名**（散文里到处都是，取它等于把"提到过"当"依据"）', () => {
  assert.equal(basisDocOf(withAcceptance('详见 SPEC-M2-文档驱动开发插件.md 第 4 节'), knowsAll), null)
  assert.equal(basisDocOf(withAcceptance('参考 README.md'), knowsAll), null)
})

test('basisDocOf：**不接受代码文件**（没有 `.md` 的不算文档）', () => {
  assert.equal(basisDocOf(withAcceptance('依据 `core/handover.js` 的 §二'), knowsAll), null)
})

test('basisDocOf：带目录的路径取 basename（id 不带目录）', () => {
  const ref = basisDocOf(withAcceptance('见 `docs/read-order.md` §1'), knowsAll)
  assert.equal(ref.id, 'read-order', 'id 必须是 basename，不能带 docs/ 前缀')
  assert.equal(ref.section, '1')
})

test('basisDocOf：反斜杠路径也取 basename', () => {
  const ref = basisDocOf(withAcceptance('见 `docs\\read-order.md`'), knowsAll)
  assert.equal(ref.id, 'read-order')
})

test('basisDocOf：没有任何引用 → **null**（UI 据此不显示那一行）', () => {
  assert.equal(basisDocOf('', knowsAll), null)
  assert.equal(basisDocOf(undefined, knowsAll), null)
  assert.equal(basisDocOf(withAcceptance('这段文字里没有文档引用。'), knowsAll), null)
})

test('basisDocOf：多条引用时取**第一条**', () => {
  const ref = basisDocOf(withAcceptance('先看 `a.md` §1，再看 `b.md` §2'), knowsAll)
  assert.equal(ref.id, 'a')
})

// ---- 2026-11-14 演练复盘 D1'：只扫 §5，且要能排除交付物 ----

test('**basisDocOf：只扫 §5，不扫 §3**（演练里 §3 提到的 report.md 被误当依据）', () => {
  // 真实事故：handover-002 的 §3「下一刀」写了
  //   让用户确认 `report.md` 的表格格式…
  // 旧实现扫全文，于是把**交付物** report.md 当成了"依据文档"。
  const body = [
    '# 交接',
    '## 1. 我的意图', '做一件事。',
    '## 2. 现在到哪了', '| a | b |', '|---|---|', '| x | y |',
    '## 3. 下一刀', '- 让用户确认 `report.md` 的表格格式',
    '## 4. 坑', '| # | 坑 |', '|---|---|', '| 1 | 无 |',
    '## 5. 验收', '- 会话 id：session-aaa111bbb222',
    '## 6. 刻意没做', '- 无',
    '## 7. 仍未决', '无',
  ].join('\n')
  assert.equal(
    basisDocOf(body, knowsAll),
    null,
    '§3 里提到的 report.md 不该被当成依据文档 —— 那是交付物',
  )
})

test('**basisDocOf：`knownIds` 把非受管文档挡掉**（交付物不是依据）', () => {
  const body = withAcceptance('详见 `report.md` §1，另见 `spec-a.md` §2')
  // 只有 spec-a 是受管文档。
  const ref = basisDocOf(body, (id) => id === 'spec-a')
  assert.equal(ref?.id, 'spec-a', '应当跳过 report（不受管），取 spec-a')
})

test('basisDocOf：**不给 knownIds 时退回"全都认"**（向后兼容，但仍只扫 §5）', () => {
  const ref = basisDocOf(withAcceptance('见 `report.md`'))
  assert.equal(ref?.id, 'report', '不给校验函数时不该额外过滤')
})

test('basisDocOf：**没有 §5 就没有依据**（不退回全文扫）', () => {
  const body = '# 交接\n\n## 3. 下一刀\n- 见 `spec-a.md`\n'
  assert.equal(basisDocOf(body, knowsAll), null, '没有 §5 时不该去 §3 里找')
})

test('withFingerprint：能找到就补上，**找不到就保持空串**（不编指纹）', () => {
  const ref = { id: 'spec-a', section: '1', fingerprint: '' }
  const filled = withFingerprint(ref, (id) => (id === 'spec-a' ? 'abc123' : ''))
  assert.equal(filled.fingerprint, 'abc123')

  // 注册表里没有那份文档 → 空串。
  const missing = withFingerprint(ref, () => '')
  assert.equal(missing.fingerprint, '')

  // 取指纹的函数抛错 → 也保持空串（不许让看板因为补指纹而炸）。
  const throwing = withFingerprint(ref, () => { throw new Error('boom') })
  assert.equal(throwing.fingerprint, '')
})

test('withFingerprint：ref 为 null 时返回 null（不造一个假对象）', () => {
  assert.equal(withFingerprint(null, () => 'x'), null)
})

test('handoverPointersOf：两个字段一次取齐', () => {
  const body = handover('1. 下一件事', { acceptance: '依据 `spec-a.md` §2，tests 10/10 全绿' })
  const pointers = handoverPointersOf(body)
  assert.equal(pointers.nextStep, '下一件事')
  assert.equal(pointers.basisDoc.id, 'spec-a')
  assert.equal(pointers.basisDoc.section, '2')
})

test('handoverPointersOf：**都没有时两个都是空**（看板两行都不显示）', () => {
  const pointers = handoverPointersOf('随便一段没有结构的文字')
  assert.equal(pointers.nextStep, '')
  assert.equal(pointers.basisDoc, null)
})

test('primaryHandoverOf：只认 `role: handover`，取 order 最小的', () => {
  const entries = [
    { meta: { id: 'spec-a', role: 'spec', order: 10 } },
    { meta: { id: 'h-new', role: 'handover', order: -60 } },
    { meta: { id: 'h-old', role: 'handover', order: -70 } },
    { meta: { id: 'doc-b', role: 'evidence', order: 5 } },
  ]
  const primary = primaryHandoverOf(entries)
  assert.equal(primary.meta.id, 'h-old', '必须取 order 最小的那份交接')
})

test('primaryHandoverOf：没有交接文档 → undefined', () => {
  assert.equal(primaryHandoverOf([]), undefined)
  assert.equal(primaryHandoverOf([{ meta: { id: 'spec-a', role: 'spec', order: 1 } }]), undefined)
  assert.equal(primaryHandoverOf(undefined), undefined)
})

test('primaryHandoverOf：order 相同按 id 排序（**结果必须稳定**）', () => {
  const entries = [
    { meta: { id: 'hb', role: 'handover', order: -70 } },
    { meta: { id: 'ha', role: 'handover', order: -70 } },
  ]
  // 跑两次，必须一致（同一份输入永远同一份输出）。
  assert.equal(primaryHandoverOf(entries).meta.id, 'ha')
  assert.equal(primaryHandoverOf([...entries].reverse()).meta.id, 'ha')
})

test('primaryHandoverOf：order 缺失时排到最后（不假设它是 0）', () => {
  const entries = [
    { meta: { id: 'no-order', role: 'handover' } },
    { meta: { id: 'has-order', role: 'handover', order: 999 } },
  ]
  assert.equal(primaryHandoverOf(entries).meta.id, 'has-order', '缺 order 的应当排最后，不能当 0')
})

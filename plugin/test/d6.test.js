/**
 * M1.5 / **D6** 的正式单测：环境锚点的取值与接线。
 *
 * `core/anchors.js` 的 `declaredAnchorOf` 已经在 `m15-misc.test.js` 之外被
 * `repro-n3.mjs` 验过；但 **D6 是"取值来源"这一半**，之前只在 `index.js` 里改了
 * 却没有单测。这个文件补上。
 *
 * ---- D6 是什么（交接 §3.6）----
 * > 按 N3 修完之后，`anchors` 要给齐 `dsh`/`commit`
 * > （拿不到就保持 `skipped`，**不要瞎猜**）
 *
 * 修之前 `index.js` 写死成：
 * ```js
 * anchors: { dsh: undefined, bundle: BUNDLE_VERSION, commit: undefined }
 * ```
 * 于是 `dsh` 与 `commit` **恒为 undefined** → H-4 在这两个锚点上
 * 永远走"当前环境值未知 → skipped"那条分支 —— **从未真正检查过**。
 * A4 评审判它是「死分支」，M1 只修了"要记账 skipped"这一半。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { BUNDLE_VERSION, resolveAnchors } from '../index.js'

test('D6：没有任何覆盖时，bundle 有值、dsh/commit 为 undefined（**不猜**）', () => {
  const anchors = resolveAnchors()
  assert.equal(anchors.bundle, BUNDLE_VERSION)
  assert.equal(anchors.bundle, '1.2.0-m4.4', 'BUNDLE_VERSION 必须与候选包一致')
  assert.equal(anchors.dsh, undefined, '宿主没暴露版本 → 不能猜')
  assert.equal(anchors.commit, undefined, '读 git 要起子进程 → 不能猜')
})

test('D6：显式提供就真的用（这是"将来能真检查"的接口）', () => {
  const anchors = resolveAnchors({ dsh: '0.2.2-rc.1', commit: 'abc1234' })
  assert.equal(anchors.dsh, '0.2.2-rc.1')
  assert.equal(anchors.commit, 'abc1234')
  assert.equal(anchors.bundle, BUNDLE_VERSION, '没覆盖 bundle 时仍取常量')
})

test('D6：显式提供 bundle 可以覆盖（测试/宿主适配用）', () => {
  assert.equal(resolveAnchors({ bundle: '9.9.9' }).bundle, '9.9.9')
})

test('D6：空串 / 空白 / 非字符串**一律当没给**（不能把空白当成版本号）', () => {
  const anchors = resolveAnchors({ dsh: '', commit: '   ' })
  assert.equal(anchors.dsh, undefined)
  assert.equal(anchors.commit, undefined)

  const weird = resolveAnchors({ dsh: 42, commit: null })
  assert.equal(weird.dsh, undefined, '非字符串不采信')
  assert.equal(weird.commit, undefined)
})

test('D6：字符串两端空白被 trim（避免 " 0.2.2 " 这种假不匹配）', () => {
  assert.equal(resolveAnchors({ dsh: ' 0.2.2-rc.1 ' }).dsh, '0.2.2-rc.1')
})

test('D6：垃圾输入不抛（null / undefined / 数组 / 字符串）', () => {
  for (const input of [null, undefined, [], 'x', 42, true]) {
    assert.doesNotThrow(() => resolveAnchors(input), `输入 ${JSON.stringify(input)} 抛了`)
  }
})

test('D6：返回值**永远是三个键**（不能少键，否则 H-4 的 destructuring 会拿到 undefined 而无感）', () => {
  for (const input of [undefined, null, {}, { dsh: 'x' }]) {
    const anchors = resolveAnchors(input)
    assert.deepEqual(Object.keys(anchors).sort(), ['bundle', 'commit', 'dsh'])
  }
})

// ---------------------------------------------------------------- 接线：真的进到 H-4 了吗

test('D6 接线：给了 anchors 之后，H-4 **真的能报**（不是永远 skipped）', async () => {
  const { checkHealth } = await import('../core/health.js')
  const entry = {
    path: '/proj/docs/spec-x.md',
    text: '---\nid: spec-x\n---\n',
    body: '# x\n',
    meta: {
      id: 'spec-x',
      title: 'x',
      role: 'spec',
      order: 10,
      status: 'authoritative',
      summary: 'x',
      basis: '实测',
      verifiedDsh: '0.0.1',
      verifiedCommit: 'deadbee',
    },
    issues: [],
    hasError: false,
  }

  // 不给 dsh/commit（= M1 的现状）→ H-4 只能报 bundle，另两个进 skipped
  const without = checkHealth({ entries: [entry], required: [entry], anchors: resolveAnchors() })
  const h4Without = without.issues.filter((item) => item.rule === 'H-4')
  assert.equal(h4Without.length, 0, 'bundle 没被声明 → 0 条')
  assert.ok(
    (without.skipped ?? []).length > 0,
    'dsh/commit 应当被诚实记进 skipped（不能静默跳过）',
  )

  // 给了 → 三条都能报
  const withAnchors = checkHealth({
    entries: [entry],
    required: [entry],
    anchors: resolveAnchors({ dsh: '0.2.2-rc.1', commit: 'abc1234' }),
  })
  const h4With = withAnchors.issues.filter((item) => item.rule === 'H-4')
  assert.equal(h4With.length, 2, `应当报 2 条（dsh + commit），实际 ${h4With.length}`)
  assert.ok(h4With.every((item) => item.level === 'warn'), 'H-4 是 warn，不能升 error')

  // 反向：说了"一致"就不该报
  const matching = checkHealth({
    entries: [{ ...entry, meta: { ...entry.meta, verifiedDsh: '0.2.2-rc.1', verifiedCommit: 'abc1234' } }],
    required: [entry],
    anchors: resolveAnchors({ dsh: '0.2.2-rc.1', commit: 'abc1234' }),
  })
  assert.equal(matching.issues.filter((item) => item.rule === 'H-4').length, 0, '一致时不该报')
})

/**
 * M1 新增的两个配置项（§9）。
 *
 * M0 的核心约定是「**非法值一律静默回落默认值，绝不抛**」——
 * 因为 `cordis.patch.yml` 里的 config 没有 schema 校验（本包不导出 `Config`）。
 * 所以这两个新项也必须遵守，而且要有断言钉住。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { CONFIG_DEFAULTS, resolveConfig } from '../config.js'

test('M1 新增配置项存在，默认值符合 SPEC §9', () => {
  assert.equal(CONFIG_DEFAULTS.coldStartBudgetTokens, 30000)
  const config = resolveConfig({})
  assert.equal(config.coldStartBudgetTokens, 30000)
})

test('coldStartBudgetTokens：合法值生效', () => {
  assert.equal(resolveConfig({ coldStartBudgetTokens: 50000 }).coldStartBudgetTokens, 50000)
  assert.equal(resolveConfig({ coldStartBudgetTokens: 1 }).coldStartBudgetTokens, 1)
})

test('coldStartBudgetTokens：非法值静默回落，不抛', () => {
  // 注意：`'1000'` 这种**数字字符串是被接受的**（`naturalOf` 用 Number() 转，
  // 这是 M0 就有的行为，YAML 里写 `1000` 与 `"1000"` 应当等价）。所以它不在非法值里。
  assert.equal(resolveConfig({ coldStartBudgetTokens: '1000' }).coldStartBudgetTokens, 1000)
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, {}, [], 'abc']) {
    assert.doesNotThrow(() => resolveConfig({ coldStartBudgetTokens: bad }))
    assert.equal(
      resolveConfig({ coldStartBudgetTokens: bad }).coldStartBudgetTokens,
      30000,
      `budget=${String(bad)} 没有回落默认值`,
    )
  }
})



test('**本包仍然不导出 Config**（导出它会让整行插件加载失败）', async () => {
  const module = await import('../config.js')
  assert.equal(Object.hasOwn(module, 'Config'), false)
})

test('配置是 frozen 的（运行期改不动）', () => {
  const config = resolveConfig({})
  assert.equal(Object.isFrozen(config), true)
})

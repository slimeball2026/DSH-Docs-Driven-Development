/** M4: H8 freshness gate retired; verifiedAt schema coverage remains. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { validateMeta } from '../docs/schema.js'

test('D4 / V12：verifiedAt 格式合法 → 不报', () => {
  const result = validateMeta({
    id: 'a', title: 't', role: 'spec', order: 10, status: 'draft', summary: 's', basis: '实测',
    verifiedAt: '2026-11-12',
  }, {})
  assert.equal(result.issues.some((item) => item.rule === 'V12'), false)
})

test('D4 / V12：格式坏 → **warn 不是 error**（不能把文档踢出必读清单）', () => {
  for (const bad of ['2026/11/12', '昨天', '2026-13-01', '20261112']) {
    const result = validateMeta({
      id: 'a', title: 't', role: 'spec', order: 10, status: 'draft', summary: 's', basis: '实测',
      verifiedAt: bad,
    }, {})
    const v12 = result.issues.filter((item) => item.rule === 'V12')
    assert.equal(v12.length, 1, `${bad} 应当报 1 条 V12`)
    assert.equal(v12[0].level, 'warn', 'V12 必须是 warn')
    assert.equal(result.hasError, false, `${bad} 不该让 hasError 变 true`)
  }
})

test('D4 / V12：**不填 verifiedAt 完全合法**（可选字段）', () => {
  const result = validateMeta({
    id: 'a', title: 't', role: 'spec', order: 10, status: 'draft', summary: 's', basis: '实测',
  }, {})
  assert.equal(result.issues.some((item) => item.rule === 'V12'), false)
  assert.equal(result.hasError, false)
})

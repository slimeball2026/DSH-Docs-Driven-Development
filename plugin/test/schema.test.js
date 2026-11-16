/**
 * V1–V10 校验的单测（SPEC §12.1）。
 *
 * 重点：**error 不阻塞读取，只阻塞进必读清单**——所以校验只产出问题，不做裁决。
 * V9 必须是 warn 且**绝不自动改 status**（Q5 = D）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BASES,
  LEVEL_ERROR,
  LEVEL_WARN,
  REQUIRED_FIELDS,
  ROLES,
  STATUSES,
  bodyHasAnchor,
  countIds,
  validateMeta,
} from '../docs/schema.js'

/** 一份最小合法元数据。 */
function goodMeta(overrides = {}) {
  return {
    id: 'spec-tier2',
    title: '档 2 施工图',
    role: 'spec',
    order: 20,
    status: 'authoritative',
    summary: '档 2 的全部功能切片',
    basis: '实测',
    ...overrides,
  }
}

/** 取某条规则的问题列表。 */
function rulesOf(result) {
  return result.issues.map((item) => item.rule)
}

test('枚举与字段表与 SPEC 一致', () => {
  assert.equal(ROLES.length, 8)
  assert.equal(STATUSES.length, 6)
  assert.deepEqual(BASES, ['实测', '推断', '未验证'])
  assert.deepEqual([...REQUIRED_FIELDS].sort(), ['basis', 'id', 'order', 'role', 'status', 'summary', 'title'])
})

test('最小合法元数据无 error', () => {
  const result = validateMeta(goodMeta())
  assert.equal(result.hasError, false)
  assert.deepEqual(result.issues, [])
})

// ---------------------------------------------------------------- V1

test('V1：每个必填字段缺失都报 error', () => {
  for (const field of REQUIRED_FIELDS) {
    const meta = goodMeta()
    delete meta[field]
    const result = validateMeta(meta)
    assert.equal(result.hasError, true, `缺 ${field} 应报错`)
    assert.ok(result.issues.some((item) => item.rule === 'V1' && item.message.includes(field)))
  }
})

test('V1：meta 为 null（解析失败）按 V1 报 error', () => {
  const result = validateMeta(null)
  assert.equal(result.hasError, true)
  assert.deepEqual(rulesOf(result), ['V1'])
})

test('V1：id 不是 kebab-case 报 error', () => {
  assert.equal(validateMeta(goodMeta({ id: 'Spec_Tier2' })).hasError, true)
  assert.equal(validateMeta(goodMeta({ id: 'spec tier2' })).hasError, true)
  assert.equal(validateMeta(goodMeta({ id: 'spec-tier2' })).hasError, false)
})

test('V1：order 不是有限数报 error', () => {
  assert.equal(validateMeta(goodMeta({ order: 'abc' })).hasError, true)
  assert.equal(validateMeta(goodMeta({ order: Number.NaN })).hasError, true)
  assert.equal(validateMeta(goodMeta({ order: Number.POSITIVE_INFINITY })).hasError, true)
})

test('V1：summary 超长只 warn，不拦', () => {
  const result = validateMeta(goodMeta({ summary: '啊'.repeat(81) }))
  assert.equal(result.hasError, false)
  assert.ok(result.issues.some((item) => item.level === LEVEL_WARN))
})

// ---------------------------------------------------------------- V2

test('V2：role / status / basis 不在枚举内都是 error', () => {
  assert.equal(validateMeta(goodMeta({ role: 'bogus' })).hasError, true)
  assert.equal(validateMeta(goodMeta({ status: 'bogus' })).hasError, true)
  assert.equal(validateMeta(goodMeta({ basis: '瞎猜' })).hasError, true)
})

test('V2：六个 status 都合法', () => {
  for (const status of STATUSES) {
    const meta = goodMeta({ status })
    if (status === 'superseded') meta.supersededBy = ['other']
    if (status === 'partial') meta.scope = ['tier2']
    const result = validateMeta(meta)
    assert.equal(result.hasError, false, `status=${status} 不该报错：${JSON.stringify(result.issues)}`)
  }
})

// ---------------------------------------------------------------- V3 / V4

test('V3：superseded 但 supersededBy 为空 → error', () => {
  const result = validateMeta(goodMeta({ status: 'superseded' }))
  assert.equal(result.hasError, true)
  assert.ok(rulesOf(result).includes('V3'))
})

test('V3：supersededBy 是空数组也算空', () => {
  assert.equal(validateMeta(goodMeta({ status: 'superseded', supersededBy: [] })).hasError, true)
})

test('V4：partial 但 scope 为空 → error', () => {
  const result = validateMeta(goodMeta({ status: 'partial' }))
  assert.equal(result.hasError, true)
  assert.ok(rulesOf(result).includes('V4'))
})

// ---------------------------------------------------------------- V5 / V6

test('V5：supersedes 指向不存在的 id → error', () => {
  const result = validateMeta(
    goodMeta({ supersedes: ['nope'] }),
    { knownIds: ['spec-tier2'], selfId: 'spec-tier2' },
  )
  assert.equal(result.hasError, true)
  assert.ok(rulesOf(result).includes('V5'))
})

test('V5：带锚点的引用只校验 `#` 之前的 id', () => {
  const result = validateMeta(
    goodMeta({ supersededBy: ['spec-tier1#13'] }),
    { knownIds: ['spec-tier1', 'spec-tier2'], selfId: 'spec-tier2' },
  )
  assert.equal(result.hasError, false)
})

test('V5：没给 knownIds 时不判（避免误报）', () => {
  assert.equal(validateMeta(goodMeta({ supersedes: ['nope'] })).hasError, false)
})

test('V6：id 重复报 error 且带次数', () => {
  const counts = countIds([{ meta: { id: 'a' } }, { meta: { id: 'a' } }, { meta: { id: 'b' } }])
  const result = validateMeta(goodMeta({ id: 'a' }), { idCounts: counts })
  assert.equal(result.hasError, true)
  const found = result.issues.find((item) => item.rule === 'V6')
  assert.match(found.message, /2 次/)
})

test('V6：id 唯一时不报', () => {
  const counts = countIds([{ meta: { id: 'a' } }, { meta: { id: 'b' } }])
  assert.equal(validateMeta(goodMeta({ id: 'a' }), { idCounts: counts }).hasError, false)
})

// ---------------------------------------------------------------- V7 / V8

test('V7：sections 锚点在正文里找不到 → warn', () => {
  const result = validateMeta(
    goodMeta({ sections: [{ anchor: '#99', status: 'authoritative' }] }),
    { body: '# 1 标题\n\n## 2 另一个\n' },
  )
  assert.equal(result.hasError, false)
  assert.ok(result.issues.some((item) => item.rule === 'V7' && item.level === LEVEL_WARN))
})

test('V7：锚点能找到时不报', () => {
  const result = validateMeta(
    goodMeta({ sections: [{ anchor: '#7', status: 'authoritative' }] }),
    { body: '## 7 施工顺序\n' },
  )
  assert.equal(result.issues.filter((item) => item.rule === 'V7').length, 0)
})

test('V7：非 `#` 开头的 anchor 跳过不判', () => {
  const result = validateMeta(
    goodMeta({ sections: [{ anchor: 'whatever', status: 'authoritative' }] }),
    { body: '' },
  )
  assert.equal(result.issues.filter((item) => item.rule === 'V7').length, 0)
})

test('V8：supersededBy 未反填 → warn，不是 error', () => {
  const other = { meta: { id: 'new-spec', supersedes: [] } }
  const result = validateMeta(
    goodMeta({ supersededBy: ['new-spec'] }),
    {
      knownIds: ['new-spec', 'spec-tier2'],
      selfId: 'spec-tier2',
      metaById: [other, { meta: goodMeta({ supersededBy: ['new-spec'] }) }],
    },
  )
  assert.equal(result.hasError, false)
  const found = result.issues.find((item) => item.rule === 'V8')
  assert.equal(found?.level, LEVEL_WARN)
})

test('V8：对方已反填时不报', () => {
  const result = validateMeta(
    goodMeta({ supersededBy: ['new-spec'] }),
    {
      knownIds: ['new-spec', 'spec-tier2'],
      selfId: 'spec-tier2',
      metaById: [{ meta: { id: 'new-spec', supersedes: ['spec-tier2'] } }],
    },
  )
  assert.equal(result.issues.filter((item) => item.rule === 'V8').length, 0)
})

// ---------------------------------------------------------------- V9

test('V9：锚点漂移只 warn，且绝不改 status（Q5 = D）', () => {
  const meta = goodMeta({
    verifiedDsh: '0.2.1-rc.1',
    verifiedBundle: '0.4.2',
    verifiedCommit: 'abc1234',
  })
  const result = validateMeta(meta, {
    anchors: { dsh: '0.2.2-rc.1', bundle: '0.4.4', commit: 'def5678' },
  })
  assert.equal(result.hasError, false, 'V9 不许升级成 error')
  assert.equal(result.issues.filter((item) => item.rule === 'V9').length, 3)
  assert.equal(meta.status, 'authoritative', 'V9 绝不能自动改 status')
  assert.ok(result.issues.every((item) => item.level === LEVEL_WARN))
})

test('V9：锚点一致时不报', () => {
  const result = validateMeta(
    goodMeta({ verifiedDsh: '0.2.2-rc.1' }),
    { anchors: { dsh: '0.2.2-rc.1' } },
  )
  assert.equal(result.issues.filter((item) => item.rule === 'V9').length, 0)
})

test('V9：文档没写锚点时不报（没声明就没有漂移）', () => {
  const result = validateMeta(goodMeta(), { anchors: { dsh: '0.2.2-rc.1' } })
  assert.equal(result.issues.filter((item) => item.rule === 'V9').length, 0)
})

// ---------------------------------------------------------------- V10（不是错误）

test('V10：fingerprint 不符**不产生任何问题**（插件自动重算，SPEC §5.4）', () => {
  const result = validateMeta(goodMeta({ fingerprint: 'deadbeef' }))
  assert.equal(result.hasError, false)
  assert.equal(result.issues.filter((item) => item.rule === 'V10').length, 0)
})

// ---------------------------------------------------------------- 锚点判断

test('bodyHasAnchor：斜杠式与数字式都能命中', () => {
  const body = '# 施工顺序\n\n## 7 验收\n\n正文\n'
  assert.equal(bodyHasAnchor(body, '#7'), true)
  assert.equal(bodyHasAnchor(body, '#施工顺序'), true)
  assert.equal(bodyHasAnchor(body, '#不存在'), false)
})

test('bodyHasAnchor：空锚点视为命中（不误报）', () => {
  assert.equal(bodyHasAnchor('', '#'), true)
})

// ---------------------------------------------------------------- 多问题并存

test('一份文档可以同时报多条问题，hasError 只看 error', () => {
  const result = validateMeta(
    goodMeta({ role: 'bogus', status: 'partial', summary: '啊'.repeat(81) }),
  )
  assert.equal(result.hasError, true)
  assert.ok(result.issues.length >= 3)
})

// ---------------------------------------------------------------- V11（M1 新增）

test('**V11：basis 未验证 + status authoritative → warn**（H-5 的数据来源）', () => {
  const result = validateMeta({ ...goodMeta(), basis: '未验证', status: 'authoritative' })
  const v11 = result.issues.filter((item) => item.rule === 'V11')
  assert.equal(v11.length, 1)
  assert.equal(v11[0].level, 'warn', 'V11 必须是 warn：error 会把文档踢出必读清单，那是过罚')
  assert.ok(v11[0].message.includes('未验证'))
})

test('V11：其它 status 组合不报', () => {
  for (const status of ['draft', 'partial', 'superseded', 'sealed', 'void']) {
    const meta = { ...goodMeta(), basis: '未验证', status }
    if (status === 'superseded') meta.supersededBy = ['other']
    if (status === 'partial') meta.scope = ['tier2']
    const result = validateMeta(meta)
    assert.equal(result.issues.filter((item) => item.rule === 'V11').length, 0, `status=${status} 被误报`)
  }
})

test('V11：basis 是实测/推断时不报', () => {
  for (const basis of ['实测', '推断']) {
    const result = validateMeta({ ...goodMeta(), basis, status: 'authoritative' })
    assert.equal(result.issues.filter((item) => item.rule === 'V11').length, 0)
  }
})

test('V11：**不会让 hasError 变真**（warn 不影响可读性）', () => {
  const result = validateMeta({ ...goodMeta(), basis: '未验证', status: 'authoritative' })
  assert.equal(result.hasError, false)
})
/**
 * M2.8 · 三笔修复的回归网（用户 2026-11-15 拍板）。
 *
 * 每一笔都先**证明缺陷存在**，再钉死修好之后的行为：
 *
 *   §1 `doc_mark` 认 `selfWritten`（缺陷 #5）—— 附"不许误放行"的反例
 *   §2 H4 正则允许比值与结果词之间夹量词 —— 附"不许放宽过头"的反例
 *   §3 `init-workspace` 生成的 `read-order` 的 `basis` 不再是 `未验证`
 *
 * ⚠️ 为什么单独一个文件：这三笔改动**横跨三个模块**
 * （`tools/doc-mark.js` / `core/handover.js` / `server/init-workspace.ts`），
 * 而变异测试的文件列表是手工维护的（`_m23/mutate-drill-fixes.mjs`），
 * 放一个文件里只要加一条，不会漏。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createMarkTool } from '../tools/doc-mark.js'
import { createNewTool, deriveId, isDerivedIdUsable } from '../tools/doc-new.js'
import { EVIDENCE_PATTERNS, hasEvidence, checkAcceptanceEvidence, hasSubstance } from '../core/handover.js'
import { initialIndexDoc } from '../server/init-workspace.ts'
import { fingerprintOf } from '../docs/fingerprint.js'
import { resolveConfig } from '../config.js'
import { decideGate } from '../core/gate.js'
import { denyMessage } from '../core/roles.js'
import { registerHandoverInIndex } from '../core/registerHandover.js'

// ---------------------------------------------------------------- 装配

/**
 * 一个够 `doc_mark` 用的最小工程：真文件 + 假注册表。
 *
 * ⚠️ 用**真文件**而不是全假 fs：`doc_mark` 会读 `entry.text` 改写 frontmatter，
 * 全假的话"写进去的东西对不对"就测不到了。
 */
function boot() {
  const root = mkdtempSync(join(tmpdir(), 'ddd-m28-'))
  const docs = join(root, 'docs')
  mkdirSync(docs, { recursive: true })
  const file = join(docs, 'spec-1.md')

  const docText = (marker) => [
    '---',
    'id: spec-1',
    'title: spec-1 标题',
    'role: spec',
    'order: 10',
    'status: draft',
    'summary: spec-1 摘要',
    'basis: 未验证',
    '---',
    '',
    '# spec-1',
    '',
    marker,
    '',
  ].join('\n')

  const state = { text: docText('原始'), selfWritten: false, basis: '未验证' }
  state.fingerprint = fingerprintOf(state.text)
  writeFileSync(file, state.text)

  const reads = new Map()
  /** `doc_mark` 有没有在标完之后把文档重新记成"读过"（M2.8 第 27 轮反馈）。 */
  const markReadCalls = []
  const meta = () => ({
    id: 'spec-1', title: 'spec-1 标题', role: 'spec', order: 10,
    status: 'draft', summary: 'spec-1 摘要',
    // ⚠️ `basis` 要**从 state 读**，不能写死。
    //    我第一版写死 `'未验证'`，于是"basis 已是实测时不许误报"那条测试
    //    永远测不到真行为（桩不跟着磁盘走，断言就废了）。
    basis: state.basis,
  })
  const entryOf = () => ({
    path: file, text: state.text, fingerprint: state.fingerprint, meta: meta(), hasError: false,
  })

  const registry = {
    state: 'ready',
    get entries() { return [entryOf()] },
    index: { required: [], forbidden: [], anomalies: [] },
    readSetFor: () => reads,
    readSet: reads,
    entryById: (id) => (id === 'spec-1' ? entryOf() : undefined),
    entryByPath: (path) => (path === file ? entryOf() : undefined),
    fingerprintOf: (id) => (id === 'spec-1' ? state.fingerprint : undefined),
    // ---- 被测的那根线：`isSelfWritten` ----
    isSelfWritten: (id) => state.selfWritten && id === 'spec-1',
    markRead: (absPath, _session, seq) => { markReadCalls.push({ absPath, seq }); return true },
    // ---- `rescan` 必须**重算指纹**（真注册表就是这样）----
    //
    // 我第一版写成 `async () => {}`，于是 `doc_mark` 改完 frontmatter 之后
    // 假注册表的 `state.fingerprint` 还是旧值 —— 而实现是按"rescan 之后的值"
    // 记 readSet 的，两者对不上，测试就测不到真行为。
    //
    // 现在让它读盘重算，与 `docs/fingerprint.js` 的口径一致。
    rescan: async () => {
      try {
        const disk = readFileSync(file, 'utf8')
        state.text = disk
        state.fingerprint = fingerprintOf(disk)
        const basisLine = /^basis:\s*(.+)$/m.exec(disk)
        if (basisLine !== null) state.basis = basisLine[1].trim()
      } catch { /* 盘上还没有就保持原值 */ }
    },
    layoutOf: () => ({ artifactsDir: '_artifacts' }),
  }

  const fs = {
    resolve: async (path) => ({ targetKey: path, displayPath: path }),
    writeText: async (target, content) => { writeFileSync(target.targetKey, content); return { operation: 'update' } },
    readText: async (target) => { try { return readFileSync(target.targetKey, 'utf8') } catch { return undefined } },
  }

  const tool = createMarkTool({
    config: { gateEnabled: true },
    registry: () => registry,
    fs,
    readRecordOf: (_session, id) => reads.get(id),
    projectRootOf: () => root,
    cwdOf: () => root,
    logger: { debug: () => {}, warn: () => {}, info: () => {} },
  })

  const session = { header: { cwd: root } }

  return {
    root, file, state, reads, tool, session, markReadCalls,
    /** 完整读一次（记进 readSet）。 */
    readFull() { reads.set('spec-1', { fingerprint: state.fingerprint, text: state.text }) },
    /** 模拟「本会话自己成功写」：磁盘变 + 指纹重算 + selfWritten。 */
    selfWrite(marker) {
      state.text = docText(marker)
      writeFileSync(file, state.text)
      state.fingerprint = fingerprintOf(state.text)
      state.selfWritten = true
    },
    /** 模拟「外部改动」：磁盘变 + 指纹重算，**不**记 selfWritten。 */
    externalWrite(marker) {
      state.text = docText(marker)
      writeFileSync(file, state.text)
      state.fingerprint = fingerprintOf(state.text)
      state.selfWritten = false
    },
    mark: () => tool.execute({ id: 'spec-1', status: 'authoritative' }, { agent: { session }, signal: undefined }),
    /** 任意参数地调 `doc_mark`（M2.8 §10 测 basis / order 边界用）。 */
    markWith: (args) => tool.execute({ id: 'spec-1', ...args }, { agent: { session }, signal: undefined }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

// ---------------------------------------------------------------- §1 doc_mark 认 selfWritten

test('M2.8 §1 前置：没读过 → doc_mark 必须被拒（否则后面全在测空气）', async () => {
  const app = boot()
  await assert.rejects(app.mark, /必须先读/, '门禁没在跑 —— 装配有问题，后面的断言不可信')
  app.cleanup()
})

test('M2.8 §1 完整读过 → doc_mark 放行（基线）', async () => {
  const app = boot()
  app.readFull()
  await assert.doesNotReject(app.mark)
  app.cleanup()
})

test('**M2.8 §1 自己 edit 过 → 不重读 → doc_mark 必须放行**（缺陷 #5 的修法）', async () => {
  const app = boot()
  app.readFull()
  // 模型自己改正文（成功）—— 这是交接收尾最常见的一步
  app.selfWrite('自己改过')
  // 不重读，直接标状态
  await assert.doesNotReject(
    app.mark,
    '自己写过的文档仍要求整份重读 —— 用户 2026-11-15 拍板「要认 selfWritten」没生效',
  )
  app.cleanup()
})

test('**M2.8 §1 外部改动 → 不重读 → doc_mark 必须仍被拒**（不许误放行）', async () => {
  const app = boot()
  app.readFull()
  // 别人/另一个会话/编辑器改的 —— 模型没看过新内容
  app.externalWrite('别人改的')
  await assert.rejects(
    app.mark,
    /旧版|必须先读/,
    '外部改动被 selfWritten 豁免掉了 —— 这是**危险方向**：模型会拿没看过的内容标状态',
  )
  app.cleanup()
})

test('**M2.8 §1 自己写过但从未读过 → 仍必须被拒**（selfWritten 不是"免读卡"）', async () => {
  const app = boot()
  // 刻意不 readFull：一次都没读过
  app.selfWrite('自己改过但没读')
  await assert.rejects(
    app.mark,
    /必须先读/,
    'selfWritten 不该跳过"必须先读"那条 —— 它只豁免**指纹比对**',
  )
  app.cleanup()
})

// ---------------------------------------------------------------- §2 H4 正则

test('**M2.8 §2 `7/7 段命中` 必须命中**（第 24 轮 seq 118 的现场，多花 3 步）', () => {
  const text = '本份交接的七段结构由 `doc_handover_check` 复检：7/7 段命中（H1–H7 无 error）。'
  assert.equal(hasEvidence(text).ok, true, '比值与结果词之间夹了量词就不认 —— 这逼人话迁就正则')
})

test('M2.8 §2 各种"比值 + 量词 + 结果词"都要命中', () => {
  for (const line of ['- 7/7 段命中', '- 3/3 条通过', '- 5/5 项全绿', '- 4/4 通过']) {
    assert.equal(hasEvidence(line).ok, true, `应当命中：${line}`)
  }
})

test('**M2.8 §2 第 25 轮两种真实写法都必须命中**（那一轮 4/4 条全挂，多花 4 步）', () => {
  // 这两句都是**完全通顺且事实为真**的验收条目，第 25 轮 `session-18b07bcb`
  // seq 107 判它们 4/4 条全不合格 → 它改成 `4/4 通过` 才过。
  //
  // AI 的反馈（seq 178 第 1 条）：
  // > 第一版我写的是「核对通过」，被判 4/4 条全不合格……改写成 `4/4 通过` 之后立刻过了。
  // > **校验器验证的是句子形状，而不是验证本身。**
  const real = [
    '- 建完两份文档后跑 `doc_health`，输出「文档健康度：5 项检查全过（3 份受管文档，1 份必读）」——5/5 全过。',
    '- `docs/spec-1.md` 读回确认：frontmatter `id: spec-1` / `role: spec` / `order: 10` / `basis: 实测`，正文第 13 行为 `1`，核对通过。',
  ]
  for (const line of real) {
    assert.equal(hasEvidence(line).ok, true, `应当命中（第 25 轮被误判的那两种）：${line.slice(0, 40)}…`)
  }
  // 单独钉一次「全过」这个词 —— 它是被漏掉的**结果词**本身
  assert.equal(hasEvidence('- 5/5 全过').ok, true, '「全过」必须被当成结果词')
  assert.equal(hasEvidence('- 核对通过').ok, true, '「核对通过」必须被认（它自带"核对"这个动作语义）')
})

test('**M2.8 §2 不许放宽过头**：只有分数 / 量词但无结果词 → 仍不算证据', () => {
  // 这些是 H4 被打回两次的老毛病，放宽到它们等于退化成"有数字就行"
  for (const line of ['- 3/3', '- 共 12/12 条', '- 跑了 3/3 次', '- 文件数: 4', '- 看起来没问题']) {
    assert.equal(hasEvidence(line).ok, false, `不该被认可：${line}`)
  }
})

test('M2.8 §2 报错文案里举的每一个例子都必须能过（文案与实现不许漂）', () => {
  // 判据必须认得自己文案里举的示例，否则 AI 照抄示例还被拒 —— 这是第 3 次同类事故的教训
  const examples = ['seq=42', 'session-abc123', 'sha256: a1b2c3d4', '722/722 全绿', '3/3 通过', '3/3 命中', 'tests 691 / pass 691']
  for (const example of examples) {
    assert.equal(hasEvidence(`- 结果：${example}`).ok, true, `文案举了但实现不认：${example}`)
  }
})

// ---------------------------------------------------------------- §3 init-workspace 的 basis

test('**M2.8 §3 初始化生成的 read-order 不许是 `basis: 未验证`**（否则每个新工作区必然报 H-5）', () => {
  const text = initialIndexDoc({ projectName: '演示项目' })
  assert.doesNotMatch(
    text,
    /^basis:\s*未验证$/m,
    'H-5 判据是「authoritative 但 basis 未验证」—— 生成器自己造一条必然报的 warn',
  )
  assert.match(text, /^basis:\s*(实测|推断)$/m, 'basis 必须是已声明过的值')
  // 它仍然是 authoritative：这份文档确实是项目的阅读入口
  assert.match(text, /^status:\s*authoritative$/m)
})

test('M2.8 §3 生成器造的 frontmatter 仍能被激活探测认出来（id/role/status 都在）', () => {
  const text = initialIndexDoc({ projectName: '演示项目' })
  assert.match(text, /^id:\s*read-order$/m)
  assert.match(text, /^role:\s*index$/m)
  assert.match(text, /^status:\s*authoritative$/m)
})

// ---------------------------------------------------------------- §4 「先打草稿」已删除
//
// 这两条**故意放在 `test/tools.test.js`**（而不是这里）：它们要用那个文件里的
// `fakeWorld` / `execOf` 装配。在这里重造一份，等于把"装配方式"也复制一遍 ——
// 以后装配改了，这里会静默测不到真东西（交接 §4.1「探针没激活」那个坑）。
//
// 这里只留一条**不依赖装配**的静态断言：源码里不许再出现那段提示原文。
test('**M2.8 §4 `doc-new.js` 里不许再叫人去 `_artifacts` 打草稿**（edit 已放开）', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'tools', 'doc-new.js'), 'utf8')
  // 只查**会被渲染出去**的字符串，不查注释（注释里留着历史是好事）
  assert.doesNotMatch(
    source,
    /'\*\*别在 `docs\/` 里反复重写交接\*\*：先把正文写到 '/,
    '还在渲染"先打草稿"那句 —— 那是 edit 交接被锁死时代的对策',
  )
})

test('**M2.8 §4 `doc_handover_check` 的修法提示里也不许叫人打草稿**', () => {
  // 这条更严重：那句提示出现在"交接已经建好、校验没过"的场景里，
  // 此时叫人回去打草稿再 doc_new，等于把已完成的事推倒重做。
  const source = readFileSync(join(import.meta.dirname, '..', 'tools', 'doc-handover-check.js'), 'utf8')
  assert.doesNotMatch(
    source,
    /'⚠️ 更省事的做法：\*\*先在 `_artifacts\/handover-draft\.md` 打草稿\*\*'/,
    '交接已建好还劝人打草稿 —— 与同一段里「直接 edit，不要重写整份」直接矛盾',
  )
})

// ---------------------------------------------------------------- §9 第 27 轮反馈

/**
 * 第 27 轮 `session-6bd267f1` 的三条反馈，每条都要有测试钉住。
 *
 * 这三条有个共同点：**变异跑了之后全部 SURVIVED** —— 因为行为改了但没有测试。
 * 而"改了没测"和"没改"在变异看来是一样的。补测试就是补这个缺口。
 */

test('**M2.8 §9 建交接改了索引，必须说出「清单条数从 N 变成 M」**', async () => {
  // 缺陷现场：AI 严格照顺序先定稿 read-order（清单写 3 条）→ doc_health 全过
  // → 才 doc_new 建交接 → 工具自动插成 4 条 → 交接正文里的「3 条」**当场过期**。
  // AI 原话：「这是**你核对过的状态在核对之后被工具改掉了**。」
  const indexText = [
    '## 必读清单', '',
    '按 `order` 升序：', '',
    '1. `spec-1`（order 10）—— 甲。',
    '2. `instruction-1`（order 20）—— 乙。',
    '3. `read-order`（order 0）—— 丙。',
  ].join('\n')
  const result = registerHandoverInIndex({ text: indexText, id: 'handover-1', order: -10 })

  assert.equal(result.changed, true)
  assert.equal(
    result.countBefore, 3,
    '没有回传"改之前有几条" —— 模型无法知道自己那句「3 条」已经过期',
  )
  assert.equal(
    result.countAfter, 4,
    '没有回传"改之后有几条" —— 同上',
  )
})

test('M2.8 §9 条数没变时（清单本来就空）也要如实回传', () => {
  const result = registerHandoverInIndex({ text: '## 必读清单\n\n- （还没有必读文档。往 `docs/` 里加一份。）\n', id: 'h', order: -10 })
  assert.equal(result.changed, true)
  assert.equal(typeof result.countBefore, 'number')
  assert.equal(typeof result.countAfter, 'number')
  assert.equal(result.countAfter, 1, '换掉占位符之后应当只有 1 条')
})

test('**M2.8 §9 H4 的完整词表必须写在工具描述里**（不许只能失败后才知道）', () => {
  // AI 原话：
  // > 问题在于**判据是个正则，而我是在盲猜它的词表**。…
  // > 它写挂的三条正是「`2/2 符合`」「`1/1 已读完`」「复检通过」——
  // > 形状全对，只是结果词不在闭集里。
  const source = readFileSync(join(import.meta.dirname, '..', 'tools', 'doc-handover-check.js'), 'utf8')
  const descStart = source.indexOf('const DESCRIPTION = [')
  // ⚠️ 这条测试**红过**，原因是边界找错了：
  //    我原来用 `source.indexOf("].join('')", descStart)` 找结尾，
  //    但 DESCRIPTION 内部现在有注释，注释里可能先出现 `].join('')` 之外的形态，
  //    于是切片提前结束、`符合` 落在切片外 → 误报"描述里没有"。
  //
  //    ⇒ 用 `\n].join('')`（顶格）作边界：DESCRIPTION 是模块顶层的常量，
  //      它的收尾一定在行首。
  const descEnd = source.indexOf('\n].join(\'\')', descStart)
  assert.ok(descEnd > descStart, '找不到 DESCRIPTION 的收尾 —— 源码结构变了，这条测试要跟着改')
  const desc = source.slice(descStart, descEnd)

  assert.match(desc, /通过/, '描述里没列出「通过」这个结果词')
  assert.match(desc, /命中/, '描述里没列出「命中」')
  assert.match(desc, /全绿/, '描述里没列出「全绿」')
  assert.match(
    desc, /符合/,
    '描述里没有"不认「符合」"这句 —— 而「符合」正是第 27 轮写挂的那个词',
  )
})

test('**M2.8 §9 标绿时 `basis` 还是「未验证」→ 回执必须当场说**', async () => {
  // 缺陷：`doc_new` 建出来 basis: 未验证，标绿时 doc_mark 一句话不说，
  // 等 doc_health 的 H-5 才报 —— 而那时刚标绿、再改又要重读。
  const app = boot() // boot 的 meta 里 basis 就是 '未验证'
  app.readFull()
  const value = await app.mark()

  assert.equal(
    value.basisPending, true,
    '标绿时没有标记 basis 仍未验证 —— 模型只能等 H-5 来才发现',
  )
  const rendered = app.tool.output.render({}, value)[0].text
  assert.match(rendered, /未验证/, '回执里没提 basis 的事')
  assert.match(rendered, /H-5/, '没说清后果（H-5 会报）')
  app.cleanup()
})

test('M2.8 §9 basis 已经是「实测」时不许误报', async () => {
  const app = boot()
  // 把磁盘和测试桩都改成「实测」—— 桩的 `meta().basis` 读的是 `state.basis`，
  // 所以这里要**同时**改磁盘与 state（真环境里 `rescan` 会做这件事）。
  app.state.text = app.state.text.replace('basis: 未验证', 'basis: 实测')
  writeFileSync(app.file, app.state.text)
  app.state.basis = '实测'
  app.state.fingerprint = fingerprintOf(app.state.text)
  app.readFull()

  const value = await app.mark()
  assert.equal(value.basisPending, false, 'basis 已经是实测，却仍报"未验证"')
  app.cleanup()
})

/**
 * 第 30 轮 `session-84b1e3ea`：**`doc_mark` 的成功回执自相矛盾**。
 *
 * ```
 * 已更新 `handover-1` 的 frontmatter：status、basis。
 * ⚠️ **它的 `basis` 还是「未验证」** —— doc_health 的 H-5 下一步就会报。
 * ```
 *
 * 同一段话里既说改了 basis，又说 basis 还是未验证。
 *
 * 根因：`basisPending` 读的是 `entry.meta.basis` —— **写盘前**的注册表缓存。
 * 而这次调用可能刚把 basis 改成「实测」（`basis` 参数），于是判据按旧值报。
 *
 * AI 的原话：
 * > 不管哪句是真的，这直接摧毁了「读工具输出即可确认」的前提，
 * > 逼我对每次标绿都回读验证。
 *
 * 它为此多读了 2 次文档（seq 87 / 103）。
 */
test('**M2.8 §15 同一次调用里改了 basis → 回执不许再说"还是未验证"**', async () => {
  const app = boot() // 初始 basis: 未验证
  app.readFull()

  const value = await app.markWith({ status: 'authoritative', basis: '实测' })

  assert.equal(
    value.basisPending, false,
    '这次调用已经把 basis 改成「实测」了，却仍报"还是未验证" —— 回执自相矛盾，'
      + '模型只能回读验证（第 30 轮为此外读了 2 次）',
  )
  const rendered = app.tool.output.render({}, value)[0].text
  assert.doesNotMatch(
    rendered, /还是「未验证」/,
    '回执里仍然说 basis 是未验证 —— 而同一段话刚说「已更新 basis」',
  )
  app.cleanup()
})

// ---------------------------------------------------------------- §10 basis 归 doc_mark 管

/**
 * 第 28 轮 `session-2bc68acd` 反馈：AI 把这条称为「分类错误」，我同意。
 *
 * > `doc_mark` 拒绝改 `basis` 我觉得是分类错误 ——
 * > `basis`（实测/推断/未验证）是**置信度**，和 `status` 是同一维度的东西，
 * > 不是结构字段。为了改它专门绕 `edit` + 重读，收益为零。
 *
 * 实际代价：`doc_new` 建出来 `basis: 未验证`，想标 `authoritative` 得**两次操作**：
 *   ① `edit` 改 basis → 指纹变 → 已读失效；
 *   ② `doc_mark` 标 status。
 *
 * ⇒ 现在 `doc_mark({id, status, basis})` 一次落盘，**H-5 从根上不会触发**。
 *
 * ⚠️ `order` 仍然**不**放开：它是结构字段，改了还要同步 `read-order` 正文
 * （"改阅读顺序是两件事"）。那一步必须被看见，不能顺手做掉。
 */
test('**M2.8 §10 `doc_mark` 能同时改 status 和 basis**（一次落盘，不触发 H-5）', async () => {
  const app = boot()
  app.readFull()
  const value = await app.markWith({ status: 'authoritative', basis: '实测' })

  assert.ok(
    value.changed.includes('basis'),
    `changed 里应当有 basis，实际：${JSON.stringify(value.changed)}`,
  )
  const disk = readFileSync(app.file, 'utf8')
  assert.match(disk, /^basis: 实测$/m, 'basis 没真的写进 frontmatter')
  assert.match(disk, /^status: authoritative$/m, 'status 没写进去')
  app.cleanup()
})

test('M2.8 §10 只给 basis（不给 status）也要能用', async () => {
  // 场景：文档已经 authoritative，只是 basis 还是未验证。
  // 旧实现会报「至少要给 status」—— 逼模型去 edit，多一次指纹失效。
  const app = boot()
  app.state.text = app.state.text.replace('status: draft', 'status: authoritative')
  writeFileSync(app.file, app.state.text)
  app.state.fingerprint = fingerprintOf(app.state.text)
  app.readFull()

  const value = await app.markWith({ basis: '推断' })
  assert.ok(value.changed.includes('basis'), '没改成 basis')
  assert.match(readFileSync(app.file, 'utf8'), /^basis: 推断$/m)
  app.cleanup()
})

test('M2.8 §10 basis 取值不合法要报错（不静默丢弃）', async () => {
  const app = boot()
  app.readFull()
  await assert.rejects(
    () => app.markWith({ status: 'authoritative', basis: '看起来没问题' }),
    /basis 不合法/,
    '非法 basis 被静默接受了',
  )
  app.cleanup()
})

test('M2.8 §10 `order` 仍然**不**让 doc_mark 改（结构字段的边界）', async () => {
  const app = boot()
  app.readFull()
  await assert.rejects(
    () => app.markWith({ status: 'authoritative', order: 5 }),
    /order/,
    '`order` 被放开了 —— 它必须走 edit，因为改了还要同步 read-order 正文',
  )
  app.cleanup()
})

// ---------------------------------------------------------------- §12 H4 比值必须合理

/**
 * 第 29 轮 `session-dd0e36b5` 反馈。AI 自己做了一件很值得记的事：
 * **它发现判据放过了它自己写的假证据，并如实报告。**
 *
 * > 值得警惕的一点：第一次 `doc_handover_check` 就返回了 **7/7 通过**，
 * > 把我那条假证据也放过了（H4 已降为 warn）。
 * > **校验通过 ≠ 内容为真**，这次是我自己发现并修的。
 *
 * 它写的那句是：
 *   `0/0 通过` 级别的无缺项结论（见落盘后复检）
 *
 * `0/0` 的含义恰恰是"**我一项都没验**"—— 它是 H4 想抓的那种情况的**极端形态**，
 * 却被判成合格证据。实测（`_m28/ev29.mjs`）确认三个漏洞：
 *   `0/0 通过` / `1/0 通过` / `999/1 通过` 全部 HIT。
 *
 * ⇒ 修法：形状判据之外，再查比值是否成立（分母 > 0 且 分子 ≤ 分母）。
 */
test('**M2.8 §12 `0/0 通过` 不许算证据**（零项被验证 = 什么都没验）', () => {
  const verdict = hasEvidence('- `0/0 通过` 级别的无缺项结论（见落盘后复检）')
  assert.equal(
    verdict.ok, false,
    '`0/0 通过` 被判成合格证据 —— 判据在奖励一句明显为假的话（第 29 轮 AI 自己发现了这点）',
  )
  assert.equal(verdict.ratioInvalid, true, '没有标记出比值不合理')
})

test('**M2.8 §12 分子大于分母的比值不算证据**（数学上不可能）', () => {
  for (const line of ['- 1/0 通过', '- 999/1 通过', '- 5/3 命中']) {
    assert.equal(
      hasEvidence(line).ok, false,
      `数学上不可能的比值被判成证据：${line}`,
    )
  }
})

test('M2.8 §12 **合理的比值照常通过**（别把好证据一起打死）', () => {
  for (const line of ['- 3/3 通过', '- 0/1 通过', '- 5/7 命中', '- 2/3 全绿']) {
    assert.equal(
      hasEvidence(line).ok, true,
      `合理比值被误杀：${line}`,
    )
  }
})

test('M2.8 §12 比值不合理时，**其它三类证据仍然有效**（不因一个坏比值全否）', () => {
  // 这一行同时有坏比值和合法 seq —— 该按 seq 通过。
  const verdict = hasEvidence('- 0/0 通过，另有 `seq=42` 为证')
  assert.equal(verdict.ok, true, 'seq 证据被一个坏比值连累掉了')
  assert.ok(verdict.hits.includes('seq'), `命中的应是 seq，实际：${JSON.stringify(verdict.hits)}`)
  assert.equal(verdict.ratioInvalid, true, '仍应标记比值不合理（供报错文案用）')
})

test('M2.8 §12 H4 的报错文案要能说清"比值不合理"（否则模型只会去改形状）', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'core', 'handover.js'), 'utf8')
  assert.match(
    source, /ratioInvalid/,
    '`hasEvidence` 没有把"比值不合理"这件事暴露出来 —— 模型会以为是自己形状写错了',
  )
})

// ---------------------------------------------------------------- §14 纯数字 id 派生

/**
 * 第 30 轮 `session-84b1e3ea` 现场：
 *
 * ```
 * seq 129  doc_new  role=handover, title="交接：全流程测试30"，**没传 id**
 *          → deriveId 把中文全丢掉，只剩数字 → id = "30"
 *          → ID_RE（^[a-z0-9]+...$）**接受纯数字** → 建出 docs/30.md
 * seq 135  AI 发现不对，又建了 handover-1（order -20）
 * seq 152  把 30 标 void
 * seq 157  再修 read-order 的清单
 * ```
 *
 * 多花：`doc_new` + `read` + `doc_mark` + 一次 `edit`。
 *
 * ---- 为什么纯数字 id 必须当派生失败 ----
 *
 * 1. 它一定是"从中文标题里捡到的数字"（年份 / 轮次 / 序号），不表达语义；
 * 2. YAML 会把 `30` 解析成数字而不是字符串（M2.7 已为 `id: 1` 加过 V1 校验）；
 * 3. `handover-1` 一看就知道是什么，`30` 谁也不知道。
 *
 * ⚠️ 只在**派生**这条路上收紧；显式传 `id: "30"` 仍然允许（那是明确要求）。
 */
test('**M2.8 §14 `deriveId` 只剩数字时不许当 id**（中文标题的唯一 ASCII 就是数字）', () => {
  // 这两个是第 30 轮的真实标题形态
  assert.equal(deriveId('交接：全流程测试30'), '30', '前置：派生结果确实是纯数字')
  assert.equal(
    isDerivedIdUsable('30'), false,
    '纯数字 id 被当成了合法派生 —— 会建出 docs/30.md 这种无意义的文档',
  )
  assert.equal(isDerivedIdUsable('2026'), false, '纯年份也不行')
  assert.equal(isDerivedIdUsable('第 30 轮交接'.replace(/\D/g, '')), false)
})

test('M2.8 §14 **有字母的派生结果照常可用**（别把正常的打死）', () => {
  for (const title of ['spec-1 标题', 'Handover 2026', 'DDD 全流程测试 30']) {
    const derived = deriveId(title)
    assert.equal(
      isDerivedIdUsable(derived), true,
      `正常标题被误杀：${title} → ${derived}`,
    )
  }
})

test('M2.8 §14 空串 / 非法 kebab 也不算可用', () => {
  assert.equal(isDerivedIdUsable(''), false)
  assert.equal(isDerivedIdUsable('---'), false)
  assert.equal(isDerivedIdUsable('a--b'), false)
  assert.equal(isDerivedIdUsable(undefined), false)
})

// ⚠️ 「不传 id 建交接必须报错」那条在 `tools.test.js` 里 ——
//    它要用 `fakeWorld` 装配，而这个文件是纯函数 + 假注册表。

// ---------------------------------------------------------------- §16 代码块内的行不算验收条目

/**
 * 2026-11-16 用户拍板决策 #8：「检查一下再做，得看看这解析器到底能不能修，修了会影响什么」
 *
 * ---- 检查结论 ----
 *
 * **能修，影响面很小。**
 * · `checkAcceptanceEvidence` 只在 `handover.js` 内部 3 处 + `handover.test.js` 用；
 * · `isListItem` / `isTableRow` 另有一处独立使用（`checkSectionContent` 第 505 行），
 *   所以**不能**把代码块感知塞进公共工具函数 —— 只改 `checkAcceptanceEvidence`。
 *
 * ---- 缺陷（长期被当成"使用限制"写进技能）----
 *
 * 实测（`_m28/codeblock.mjs`，修前）：
 *   · 代码块里 2 条列表项 → `total` 从 2 变 **4**，`missing` 塞进那 2 条命令示例；
 *   · 代码块里一张表格   → `total` 从 1 变 **2**，`missing` = `["| x | y |"]`。
 *
 * **方向反了**：技能一直在教"§5 别放代码块"——那是让用户迁就实现。
 * Markdown 里代码块**就是**"这段不是内容"的语法，解析器必须尊重它。
 */
test('**M2.8 §16 代码块里的列表项不算验收条目**（修前 total 从 2 变 4）', () => {
  const text = [
    '- 建文档：`2/2 通过`。',
    '',
    '```bash',
    '- 这不是验收条目，是命令示例',
    '- 这个也不是',
    '```',
    '',
    '- 索引：`4/4 通过`。',
  ].join('\n')

  const verdict = checkAcceptanceEvidence(text)
  assert.equal(verdict.total, 2, `代码块里的行被数进验收条目了（total=${verdict.total}）`)
  assert.deepEqual(verdict.missing, [], '代码块里的命令示例被当成"缺证据的验收"')
  assert.equal(verdict.ok, true, '整段被判不合格 —— 而它的两条真验收都有证据')
})

test('**M2.8 §16 代码块里的表格行不算验收条目**', () => {
  const text = [
    '- 建文档：`2/2 通过`。',
    '',
    '```',
    '| a | b |',
    '|---|---|',
    '| x | y |',
    '```',
  ].join('\n')

  const verdict = checkAcceptanceEvidence(text)
  assert.equal(verdict.total, 1, `代码块里的表格被数进去了（total=${verdict.total}）`)
  assert.deepEqual(verdict.missing, [], '代码块里的表格行被当成验收条目')
})

test('M2.8 §16 **带语言标记的围栏**（```js）也要认', () => {
  const text = ['- 甲：`2/2 通过`。', '```js', '- 代码里的列表', '```'].join('\n')
  assert.equal(checkAcceptanceEvidence(text).total, 1, '```js 这种围栏没被认出来')
})

test('M2.8 §16 `~~~` 围栏也要认', () => {
  const text = ['- 甲：`2/2 通过`。', '~~~', '- 代码里的列表', '~~~'].join('\n')
  assert.equal(checkAcceptanceEvidence(text).total, 1, '~~~ 围栏没被认出来')
})

test('**M2.8 §16 代码块外的真验收条目仍然要判**（别把判据整个关掉）', () => {
  const text = [
    '- 甲：`2/2 通过`。',
    '```',
    '- 代码里的列表',
    '```',
    '- 乙：这条没有证据形状，应当被判不合格。',
  ].join('\n')
  const verdict = checkAcceptanceEvidence(text)
  assert.equal(verdict.total, 2, '代码块外应当有 2 条')
  assert.equal(verdict.ok, false, '代码块外那条没证据的验收被放过了')
  assert.equal(verdict.missing.length, 1, `missing 应当只有 1 条，实际 ${JSON.stringify(verdict.missing)}`)
})

test('**M2.8 §16 未闭合的围栏**：一直吞到段末（不崩、不误判）', () => {
  // 真实里模型偶尔会漏写收尾围栏。那时从围栏到段末都算代码 ——
  // 这会让 §5 判"没有验收条目"，**那是可见的**（比静默误判好）。
  const text = ['- 甲：`2/2 通过`。', '```', '- 漏了收尾围栏'].join('\n')
  const verdict = checkAcceptanceEvidence(text)
  assert.equal(verdict.total, 1, '未闭合围栏之后的内容被当成验收条目了')
})

test('M2.8 §16 **代码块感知只属于 H4**，不能污染 `hasSubstance`', () => {
  // `hasSubstance` 用 `isListItem` / `isTableRow` 判"这一段有没有可枚举的行"。
  // 在那个语境里，代码块里的列表**也算内容**（一份交接的 §3 用代码块列步骤是合法的）。
  // ⇒ 代码块感知只改 `checkAcceptanceEvidence`，不能塞进公共工具函数。
  const withCodeBlockList = '步骤：\n\n```bash\n- 第一步\n- 第二步\n```'
  const verdict = hasSubstance(withCodeBlockList, { enumerable: true })
  assert.equal(
    verdict.ok, true,
    '`hasSubstance` 开始忽略代码块里的列表了 —— 那会让"§3 用代码块列步骤"被误判为空',
  )
})

// ---------------------------------------------------------------- §8 标绿不应让已读失效

/**
 * 缺陷现场（第 27 轮 `session-6bd267f1` seq 114 → 124 → 125 → 131）：
 *
 * ```
 * seq 114  doc_mark handover-1 → authoritative   ✅
 * seq 120  doc_health                            ✅
 * seq 124  模型自述：「The gate says handover-1 is unread. …
 *                     Actually let me read it to make sure gate is clean.」
 * seq 125  read handover-1 整份（73 行）          ← **纯浪费**
 * seq 131  edit handover-1（把「3 条」改成「4 条」）
 * ```
 *
 * 它只是把 `status: draft` 改成了 `authoritative`，**正文一个字节都没变**，
 * 却被要求整份重读 —— 而它接下来要编辑的正是正文，正文它明明刚读过。
 *
 * ⇒ `doc_mark` 成功之后必须把它**重新记成"读过"**（用写后的真实指纹）。
 *
 * ⚠️ 与 `edit` 的区别必须留住：`edit` 改正文 → 认知过时 → 必须失效；
 *    `doc_mark` 只改状态 → 正文认知没过时 → 不该失效。
 */
test('**M2.8 §8 `doc_mark` 成功之后必须把文档重新记成"读过"**（标绿不该导致整份重读）', async () => {
  const app = boot()
  app.readFull()
  await app.mark()

  assert.ok(
    app.markReadCalls.length > 0,
    '`doc_mark` 标完之后没有调用 `markRead` —— 模型会被要求整份重读，'
      + '而它改的只是一个 frontmatter 字段（第 27 轮 seq 125 就是这样白读 73 行）',
  )
  assert.equal(app.markReadCalls[0].absPath, app.file, '记错了文件')
  app.cleanup()
})

test('M2.8 §8 记成"读过"用的是**写后**的指纹（不是写前的）', async () => {
  const app = boot()
  app.readFull()
  const before = app.state.fingerprint

  await app.mark()

  assert.notEqual(
    app.state.fingerprint, before,
    '前置：标完指纹应当变化（否则这条测试在测空气）',
  )
  assert.ok(app.markReadCalls.length > 0, '没有 markRead 调用 —— 标完之后没记成读过')
  app.cleanup()
})

/**
 * 第 25 轮 `session-18b07bcb` seq 123 → 128 的现场：
 * ```
 * seq 123  edit ddd-25  ✅ 成功        ← 模型自己改的
 * seq 128  edit ddd-25  ❌ 你读过的是 v7203cc，磁盘已是 vddaac0
 * ```
 * 两次编辑同一个文件、同一轮、中间没有任何外部改动。
 *
 * M2.8 上一轮只把 `selfWritten` 接进了 `doc_mark`，**忘了接 `edit` 的门禁** ——
 * 同一个缺陷在 `edit` 上原样活着。这条测试钉死 `edit` 那条路径。
 */
test('**M2.8 §5 自己 edit 过 → 再 edit 同一份不必重读**（缺陷在 edit 上原样活着）', async () => {
  const verdict = decideGate({
    toolName: 'edit',
    args: { file_path: 'C:/proj/docs/a.md', old_string: 'x', new_string: 'y' },
    required: [{ meta: { id: 'a' } }],
    readSet: new Map([['a', { fingerprint: 'OLD999' }]]),
    currentFingerprint: () => 'NEW111',
    isSelfWritten: (id) => id === 'a',
    classify: () => 'doc',
    metaOf: () => ({ id: 'a', role: 'spec', status: 'authoritative' }),
    knownOf: () => true,
  })
  assert.equal(
    verdict.decision, 'allow',
    '自己刚写完再改仍被要求重读 —— `edit` 的门禁没接 selfWritten',
  )
})

test('**M2.8 §5 外部改动 → edit 必须仍被拒**（selfWritten 不许误放行）', () => {
  const verdict = decideGate({
    toolName: 'edit',
    args: { file_path: 'C:/proj/docs/a.md', old_string: 'x', new_string: 'y' },
    required: [{ meta: { id: 'a' } }],
    readSet: new Map([['a', { fingerprint: 'OLD999' }]]),
    currentFingerprint: () => 'NEW111',
    isSelfWritten: () => false, // 不是自己写的
    classify: () => 'doc',
    metaOf: () => ({ id: 'a', role: 'spec', status: 'authoritative' }),
    knownOf: () => true,
  })
  assert.equal(verdict.decision, 'deny', '外部改动被放行了 —— 模型会拿没看过的内容当依据')
  assert.match(verdict.reason, /重读/)
})

test('**M2.8 §5 selfWritten 不豁免「必须先读」**（写过 ≠ 读过）', () => {
  const verdict = decideGate({
    toolName: 'edit',
    args: { file_path: 'C:/proj/docs/a.md', old_string: 'x', new_string: 'y' },
    required: [{ meta: { id: 'a' } }],
    readSet: new Map(), // 一次都没读过
    currentFingerprint: () => 'NEW111',
    isSelfWritten: () => true, // 但写过
    classify: () => 'doc',
    metaOf: () => ({ id: 'a', role: 'spec', status: 'authoritative' }),
    knownOf: () => true,
  })
  assert.equal(verdict.decision, 'deny', 'selfWritten 把"必须先读"也豁免了 —— 这是危险方向')
})

// ---------------------------------------------------------------- §6 instruction 文案

test('**M2.8 §6 `instruction` 的拒绝文案不许再说「draft 就能写」**（它在说谎）', () => {
  // 真实规则是角色级无条件拒绝（`instruction: { write: DENY, edit: DENY }`），
  // 而旧文案让模型"先确认它是不是 draft"—— 给了个不存在的解法。
  // 第 25 轮 seq 66：`instruction-1` 的 status 就是 draft，照样被拒。
  const message = denyMessage({ id: 'instruction-1', role: 'instruction', action: 'edit' })
  assert.doesNotMatch(message, /只有 status: draft 时才能被写/, '又在暗示"改成 draft 就能写"')
  assert.doesNotMatch(message, /先确认它是不是 draft/, '又让模型去查一个与结论无关的条件')
  assert.match(message, /角色级/, '没说清这是角色级限制（模型会以为是权限/配置问题）')
  assert.match(message, /用户/, '没给出正当出路（模型只能自己瞎猜）')
})

// ---------------------------------------------------------------- §7 交接自动登记

test('**M2.8 §7 交接自动登记：插到必读清单第一条，并把原编号整体 +1**', () => {
  const text = [
    '---', 'id: read-order', 'role: index', '---', '',
    '# 入口索引', '',
    '## 必读清单', '',
    '按 `order` 升序：', '',
    '1. `spec-1`（order 10，spec）—— 唯一的 spec。',
    '2. `instruction-1`（order 20，instruction）—— 指令。',
    '',
    '## 下一步', '',
    '- 建交接。',
  ].join('\n')

  const result = registerHandoverInIndex({ text, id: 'handover-1', order: -10, summary: '本轮交接。' })
  assert.equal(result.changed, true)
  assert.match(result.text, /1\. `handover-1`/, '交接没排到第一条')
  assert.match(result.text, /2\. `spec-1`/, '原第一条没被 +1（源码里会出现两个 1.）')
  assert.match(result.text, /3\. `instruction-1`/, '原第二条没被 +1')
  // 其它小节一个字节都不许动
  assert.match(result.text, /## 下一步\n\n- 建交接。/)
})

test('M2.8 §7 已经提到这个 id → **不覆盖**（模型可能写得更好）', () => {
  const text = [
    '## 必读清单', '',
    '1. `handover-1`（order -10）—— 我自己写的说明，别动。',
  ].join('\n')
  const result = registerHandoverInIndex({ text, id: 'handover-1', order: -10, summary: 's' })
  assert.equal(result.changed, false)
  assert.equal(result.text, text, '不该改一个字')
})

test('M2.8 §7 初始化占位符 → 换成交接条目', () => {
  const text = [
    '## 必读清单', '',
    '<!-- 用列表列出必读文档。没有就先留空，别编。 -->', '',
    '- （还没有必读文档。往 `docs/` 里加一份，再在这里登记。）',
  ].join('\n')
  const result = registerHandoverInIndex({ text, id: 'handover-1', order: -10 })
  assert.equal(result.changed, true)
  assert.match(result.text, /`handover-1`/)
  assert.doesNotMatch(result.text, /还没有必读文档/, '占位符没被换掉')
})

test('M2.8 §7 没有「必读清单」小节 → **不猜结构，不改**', () => {
  const text = '# 我的索引\n\n随便写点什么。\n'
  const result = registerHandoverInIndex({ text, id: 'handover-1', order: -10 })
  assert.equal(result.changed, false)
  assert.match(result.reason, /必修清单|必读清单/)
})

test('M2.8 §7 坏输入一律不抛（空正文 / 空 id）', () => {
  assert.doesNotThrow(() => registerHandoverInIndex({ text: '', id: 'h', order: -10 }))
  assert.doesNotThrow(() => registerHandoverInIndex({ text: '## 必读清单\n', id: '', order: -10 }))
  assert.doesNotThrow(() => registerHandoverInIndex(undefined))
  assert.equal(registerHandoverInIndex({ text: '## 必读清单\n', id: '', order: -10 }).changed, false)
})

/**
 * 文档一致性的**机械检查**（M1.5 / §3.7）。
 *
 * ---- 为什么需要它 ----
 *
 * 「三份文档三个数」这一类毛病已经被抓过**三次**：
 *   1. M0 评审：「README 说四处、验收报告说三处」
 *   2. A4 独立评审（A4-10）：同类
 *   3. M1 评审的 C1/C2/C3：README 说「根因未查明」而另两份说「根因已定位」；
 *      README 标题「十处」而正文三处仍写「九处」；
 *      A4 记录写「删掉 `_m1-probe`」而磁盘上全在。
 *
 * **靠人眼查第四次是浪费。** 而且人眼这次查完了，下次改文档还会漂。
 *
 * ---- 这个文件检查什么（只查**可机械判定**的） ----
 *
 * 1. README 的「N 处订正」标题里的 N，必须等于该节下 `### ` 小节的实际条数；
 * 2. 同一份 README 里不许再出现**别的数字**的「某处订正」表述（「九处」「十处」残留）；
 * 3. `M1-14` 的状态描述在三份文档里必须是**同一个基准串**（`P8` 拍板：根因未定位）。
 *
 * ---- 这个文件**不**检查什么（说清边界，不假装它全知） ----
 *
 * - 语义是否一致（"这句话说得对不对"）—— 那只能人读；
 * - 数字是否**正确**（只能保证"三处写法自洽"，不能保证"这个数是对的"）；
 * - 磁盘与文档是否一致（除了 M1-14 的基准串，其余不做）。
 *
 * 所以它是**防漂移**，不是**防错误**。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, '..')
const WORKSPACE = join(BUNDLE, '..')

/**
 * 被检查的那份"里程碑 README"。
 *
 * ---- 2026-11-16 M2.9 发布 v1.0.0 时改了指向 ----
 *
 * 原来指向 `BUNDLE/README.md`。但 v1.0.0 把那份 54 KB 的里程碑流水账
 * （含「N 处订正」清单、M1-14 基准串等）**归档**成了
 * `README-M1切片-历史归档.md`，而 `README.md` 重写成了面向使用者的插件说明。
 *
 * **本文件守的是"里程碑文档内部自洽"**（标题数字 = 小节数、不许有旧数字残留、
 * M1-14 基准串一致）—— 这些约束的对象是**那份历史记录**，不是新 README。
 *
 * ⇒ 改指向归档文件，而不是删掉这三条测试：
 *   删掉 = 把"三份文档三个数"这条防漂移保证一起删了（它抓过三次真问题）。
 */
const README = join(BUNDLE, 'README-M1切片-历史归档.md')

/** 读一份文档；文件不存在时返回 undefined（让测试能跳过而不是炸）。 */
function readOrSkip(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * 这份测试跑在**发布包**里还是**开发工作区**里？
 *
 * ---- 为什么需要这个判断（2026-11-16 M2.9 发布 v1.0.0 时发现的）----
 *
 * 本文件有几条测试检查的是**开发过程产物**：
 *   · `_m1-probe/AGENTS.md`（M1-1~M1-13 的探针证据）
 *   · `_m1-drill/docs/02-handover.md`
 *   · `M0-验收报告.md` 等复核链文档
 *
 * 它们**故意不进发布包**（发布包只该有插件本体 + 手册 + 项目文档）。
 * 于是 `npm test` 在发布包里会红 2 条 —— 而那不是"代码坏了"，
 * 是"这些证据本来就不在这份拷贝里"。
 *
 * ⇒ 判据：**开发工作区的特征文件存在**才跑那几条；否则跳过。
 *   不能反过来"删掉那几条测试" —— 那会把「复核链不能凭空消失」这条保证一起删掉
 *   （M2.6 移动文件后它变红过一次，正是它的价值所在）。
 */
function inDevWorkspace() {
  return existsSync(join(WORKSPACE, '_m1-probe', 'AGENTS.md'))
}

/** 把中文数字（一到九十九）转成阿拉伯数字；不是中文数字返回 undefined。 */
function chineseToNumber(text) {
  const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  const value = String(text)
  if (value === '十') return 10
  if (value.length === 1) return digits[value]
  if (value.length === 2 && value[1] === '十') return digits[value[0]] * 10
  if (value.length === 2 && value[0] === '十') return 10 + digits[value[1]]
  if (value.length === 3 && value[1] === '十') return digits[value[0]] * 10 + digits[value[2]]
  return undefined
}

/**
 * 找出 README 里「N 处订正」那一节的标题、其声明的条数、以及实际 `### ` 小节数。
 *
 * @param {string} text
 * @returns {{declared: number, declaredText: string, actual: number, heading: string} | undefined}
 */
export function correctionSection(text) {
  const lines = String(text).split('\n')
  const headIndex = lines.findIndex((line) => /^##\s+.*处.*订正/.test(line))
  if (headIndex < 0) return undefined

  const heading = lines[headIndex]
  const match = /([一二三四五六七八九十]+|\d+)\s*处/.exec(heading)
  if (match === null) return undefined
  const declared = /^\d+$/.test(match[1]) ? Number(match[1]) : chineseToNumber(match[1])
  if (declared === undefined) return undefined

  // 找下一个 `## ` 级标题作为本节结束。
  let endIndex = lines.length
  for (let index = headIndex + 1; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index])) { endIndex = index; break }
  }

  const actual = lines
    .slice(headIndex + 1, endIndex)
    .filter((line) => /^###\s/.test(line))
    .length

  // 先把行号换算成**字符偏移**（`match.index` 是字符偏移，两者不能直接比）。
  const headOffset = lines.slice(0, headIndex).join('\n').length + (headIndex > 0 ? 1 : 0)

  return { declared, declaredText: match[1], actual, heading, headIndex, headOffset }
}

// ---------------------------------------------------------------- 1. 标题里的数字 = 实际条数

test('§3.7-1：README「N 处订正」的 N 必须等于该节下的 `###` 小节数', () => {
  const text = readOrSkip(README)
  if (text === undefined) return // README 不存在时不算失败（但正常仓库里它一定在）
  const section = correctionSection(text)
  assert.notEqual(section, undefined, 'README 里找不到「N 处订正」那一节')
  assert.equal(
    section.declared,
    section.actual,
    `标题写「${section.declaredText}处」（= ${section.declared}），`
      + `但该节下实际有 ${section.actual} 个 \`### \` 小节。`
      + '改条数时**同时**改标题，否则就是第四次「三份文档三个数」。',
  )
})

test('§3.7-1 自检：解析器真的能读出数字（防止断言空跑）', () => {
  const section = correctionSection('## 三处对 SPEC 的订正\n\n### 1. a\n\n### 2. b\n\n### 3. c\n\n## 下一节\n')
  assert.deepEqual(
    { declared: section.declared, actual: section.actual },
    { declared: 3, actual: 3 },
  )
  const arabic = correctionSection('## 11 处订正\n\n### 1. a\n')
  assert.equal(arabic.declared, 11)
  assert.equal(arabic.actual, 1)
})

test('§3.7-1 自检：中文数字转换正确（一到二十）', () => {
  const cases = [[ '一', 1 ], ['九', 9], ['十', 10], ['十一', 11], ['二十', 20]]
  for (const [text, expected] of cases) {
    assert.equal(chineseToNumber(text), expected, `${text} 应当是 ${expected}`)
  }
})

// ---------------------------------------------------------------- 2. 不许有别的数字残留

test('§3.7-2：README 里不许残留**M1 清单**的别的数字（M0 的「五处」是另一份，不算）', () => {
  const text = readOrSkip(README)
  if (text === undefined) return
  const section = correctionSection(text)
  if (section === undefined) return

  // ⚠️ 判据的边界要画准：README 里**有几份独立清单/段落**都在用「N 处」这个词 ——
  //   - 本节：「M1 + M1.5 的 N 处对 SPEC 的订正」（标题声明 N，我们要检查它）；
  //   - `## M0 的五处订正（历史记录，仍然有效）`（另一份清单，**合法**）；
  //   - `## M0 的订正原文`（M0 的历史原文，**合法**）；
  //   - `## 五处关键实现决定`（不是订正，**合法**）。
  //
  // README 自己写着「两份性质不同，**不要合并成一个数**」。
  // 所以判据是：**只在本节的区间内**检查（从本节标题到下一个 `## ` 为止）。
  // 第一版扫了全文 → 把 M0 的合法表述也抓了，那是**误报**。
  const m0Start = (() => {
    for (const marker of ['## M0 的五处订正', '## M0 的订正原文']) {
      const index = text.indexOf(marker)
      if (index >= 0) return index
    }
    return -1
  })()

  const mentions = [...text.matchAll(/([一二三四五六七八九十]+|\d+)\s*处\s*(?:对\s*SPEC\s*的\s*)?订正/g)]
    .map((match) => {
      const index = match.index ?? 0
      // 把匹配**前面** 8 个字符也带上，用来判它是不是在说 M0（「M0 的『五处订正』」）。
      const before = text.slice(Math.max(0, index - 12), index)
      return { raw: match[0], value: match[1], index, before }
    })

  const bad = mentions.filter((item) => {
    if (item.index < section.headOffset) return false
    if (m0Start >= 0 && item.index >= m0Start) return false
    // 「M0 的『五处订正』」是在**引用 M0 那一份**，不是 M1 清单的条数 —— 不算违规。
    if (/M0/.test(item.before)) return false
    const number = /^\d+$/.test(item.value) ? Number(item.value) : chineseToNumber(item.value)
    return number !== section.declared
  })

  assert.deepEqual(
    bad.map((item) => item.raw),
    [],
    `这些地方的「N 处订正」与标题的 ${section.declared} 不一致：`
      + bad.map((item) => item.raw).join('、'),
  )
})

test('§3.7-2 自检：M0 那一节的「五处」**不会**被误判（判据边界有效）', () => {
  const text = readOrSkip(README)
  if (text === undefined) return
  const section = correctionSection(text)
  const m0Start = text.indexOf('## M0 的订正原文')
  assert.ok(m0Start > 0, 'README 里应当有 M0 订正原文那一节')
  // M0 那一节里确实写着「五处」，且它**在** m0Start 之后 → 被排除
  const after = text.slice(m0Start)
  assert.ok(/五处/.test(after), 'M0 那一节应当含「五处」（否则这条自检是空跑）')
  assert.notEqual(section.declared, 5, 'M1 清单的条数不该恰好也是 5（否则分不清）')
})

// ---------------------------------------------------------------- 3. M1-14 的基准串

test('§3.7-3：M1-14 的状态描述在 README 里是**基准串**（`P8`：根因未定位）', () => {
  const text = readOrSkip(README)
  if (text === undefined) return

  // 基准串必须在。
  assert.match(text, /根因未定位/, 'README 里应当出现基准串「根因未定位」')

  // 旧说法**允许出现在引用里**（"原来写的是「根因未查明」"），但不允许**裸断言**。
  // 判据：出现位置必须离「订正 / 原来写 / 三处三个说法」这类说明词不远。
  for (const legacy of ['根因未查明', '根因已定位']) {
    for (const match of text.matchAll(new RegExp(legacy, 'g'))) {
      const index = match.index ?? 0
      const window = text.slice(Math.max(0, index - 260), index + 260)
      const quoted = /(原来写|原写|旧说法|订正|作废|不成立|三处三个说法|划掉)/.test(window)
      assert.equal(
        quoted,
        true,
        `README 里有一处裸的「${legacy}」，附近没有"订正/原来写/不成立"的说明：\n`
          + window.slice(0, 200),
      )
    }
  }
})

test('§3.7-3：交接文档里的「根因已定位」必须被明确划掉（不能裸着）', () => {
  const path = join(WORKSPACE, '交接-给下一位评审者-M1.md')
  const text = readOrSkip(path)
  if (text === undefined) return

  // 允许它出现（作为历史记录），但**每一次出现都要有"已作废/订正"的说明**。
  const occurrences = [...text.matchAll(/根因已定位/g)]
  if (occurrences.length === 0) return
  assert.match(
    text,
    /(已作废|订正|不成立)/,
    '交接文档里提到「根因已定位」但没有任何"已作废 / 订正 / 不成立"的说明 —— '
      + '那会让下一位施工者照着它去改 probe（评审实测说那是白改）',
  )
})

// ---------------------------------------------------------------- 4. 历史记录不许被篡改

test('§3.7-4：`M0-验收报告.md` 的 M0-13 历史记录**仍然保留**（不许被"顺手改对"）', () => {
  // M0-13 的原始输出在 **M0** 的验收报告里（不在 M1 的）。
  const path = join(WORKSPACE, 'M0-验收报告.md')
  const text = readOrSkip(path)
  if (text === undefined) return
  // 这是 M0 当时的真实验收输出，删掉/改写等于篡改证词。
  assert.match(text, /SUCCESS — not rejected/, 'M0-13 的原始输出被删掉了')
  assert.match(text, /判据已于 2026-11-12 修订/, 'M0-13 的修订说明没加')
})

test('§3.7-4：`_m1-probe` / `_m1-drill` 的证据文件**仍然在盘**（C3 的反向）', (t) => {
  // 发布包里没有这些开发产物 —— 见 `inDevWorkspace()` 的说明。
  if (!inDevWorkspace()) {
    t.skip('这是发布包，不含开发过程产物（_m1-probe 等）')
    return
  }
  for (const rel of ['_m1-probe/AGENTS.md', '_m1-probe/docs/handover-m1.md', '_m1-drill/docs/02-handover.md']) {
    assert.equal(
      existsSync(join(WORKSPACE, rel)),
      true,
      `${rel} 不见了 —— 那是 M1-1~M1-13 的证据，删了就无法复核`,
    )
  }
})

// ---------------------------------------------------------------- 5. 关键文档存在性

test('§3.7-5：M1.5 的关键文档都在（防止"只在会话里说过、没落盘"）', (t) => {
  // 发布包里没有 SPEC-M0/M1 与 `_reports/` `_history/` —— 见 `inDevWorkspace()`。
  if (!inDevWorkspace()) {
    t.skip('这是发布包，不含开发过程的复核链文档')
    return
  }
  // ⚠️ M2.6 整理仓库时，把旧交接移进了 `_history/`、把评审/验收报告移进了 `_reports/`。
  // 这条测试**跟着更新路径**，而不是删掉它 —— 它守的是「复核链的文档不能凭空消失」，
  // 与"文件放在哪个子目录"无关。删掉它 = 把这条保证一起删了。
  //
  // 顺带说明为什么这条测试**有价值**：M2.6 移动文件后它立刻变红，
  // 精确指出「M1-评审报告.md 与 交接-给M1.5施工者.md 不在原处了」——
  // 这正是它该做的事。
  const required = [
    join(BUNDLE, 'README.md'),
    join(WORKSPACE, '_reports', 'M1-评审报告.md'),
    join(WORKSPACE, '_history', '交接-给M1.5施工者.md'),
    join(WORKSPACE, 'SPEC-M0-文档驱动开发插件.md'),
    join(WORKSPACE, 'SPEC-M1-文档驱动开发插件.md'),
  ]
  const missing = required.filter((path) => readOrSkip(path) === undefined)
  assert.deepEqual(missing, [], '这些文档不见了（它们是复核链的一部分）')
})

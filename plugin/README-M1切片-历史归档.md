# @local/ddd · 文档驱动开发（DDD）引擎 · M1 切片

> **M0 回答了**：结构化索引 + 强制读取，能不能让 AI 真的按文档施工？
> **M1 回答下一个问题**：**上一个会话丢掉的东西，能不能被下一个会话无损接住？**
>
> **本切片仍然不含任何 UI**（右栏看板、图谱、交付网格全部属 M2），
> **工具数用满 Q13 上限 4 个，不多不少**。

---

## M1 新增了什么（一页看完）

| 能力 | 入口 | 一句话 |
|---|---|---|
| **交接可校验** | `doc_handover_check` | 七段结构 + 两条**语义**判据（下一刀要具体、验收要有证据） |
| **交接失败会被拒** | `doc_mark` | 把 `role: handover` 标成 `authoritative` 时**内部再校验一次**，不合格直接拒绝 |
| **文档健康度** | `doc_health` | 5 项检查（H-1–H-5），全是 warn，不阻塞施工 |
| **冷启动预算** | 索引块 `【预算】` 行 | `必读 N 份 ≈ Nk tokens（上限 Nk）`，超了带 ⚠️ |
| **新建文档** | `doc_new` | 自动生成合法 frontmatter、order 插值、id 派生；**建完就重扫索引** |
| **结构化改状态** | `doc_mark` | 只改 frontmatter，正文最多追加一个可追溯标记块 |

**4 个工具全部条件注册**（`register(def, { when })`）：只在「探测到 DDD 项目 + 非子代理」时可见。
理由见 `tools/when.js` 的文件头——`when` 抛错会让**整个会话卡死**（`TOOL_ACTIVATION_FAILED`）。

> ⚠️ **`when` 之外还有一道执行期的 `if`（`assertToolAllowed`）。**
> 实机验收发现：**子代理会话仍然能看到并成功执行这 4 个工具**，
> 也就是说「工具不可见」这条防线在子代理路径上**不可靠**。
> 所以 4 个工具的执行入口第一句都会再判一次，子代理调用直接抛错：
>
> ```
> DDD 工具在子代理会话里不可用（S2：子代理不参与文档施工）。
> 如果你需要改文档，请把结论交回父会话，由父会话来改。
> ```
>
> 这是与 M0 的 `guard` 同一条思路：**当「不注册」不是一个可选项时，就在回调内部判。**
> 判据也从「4 个工具都不可见」修订为「**4 个工具都不可用**」——后者是更强的保证：
> 不可见是体验，不可用才是约束。（README 订正清单第 10 条）

---

## 交接的七段（`doc_handover_check`）

| # | 段落（标题关键词） | 判据 | 级别 |
|---|---|---|---|
| §1 | 我的意图 / 为什么 | 非空，且不能只写「无」 | error |
| §2 | 现在到哪了 / 现状 | 非空 | error |
| §3 | 下一刀 / 下一步 / 接下来 | **≥1 条含具体路径 / 工具名 / 反引号命令** | error |
| §4 | 坑 / 不要重犯 | 非空，且**可逐条枚举**（表格行或列表项） | error |
| §5 | 验收 | **每一条**都要带证据（seq / 会话 id / 哈希 / 测试输出） | error |
| §6 | 刻意没做 / 负向范围 | 非空，且可逐条枚举 | error |
| §7 | 仍未决 / 需要拍板 | 可为空，但要显式写「无」 | warn |

外加三条 warn：**H6** 多份 authoritative 交接（点名）、**H7** order 不是最小、**H5** §7 只写了几个字。

> **H3 和 H4 是这套校验里唯一有语义的两条，也是最容易被写成「永远通过」的两条。**
> 反例（都有测试钉住）：
> - `继续做下一步` / `按照计划推进` → **H3 拒绝**
> - `- M1-3 的改动在 core/handover.js` → **H4 拒绝**（文件名不是证据）
> - `把 M1.2 的收尾工作推进完` → **H3 拒绝**（版本号不是路径）

---

## `doc_health` 的 5 项

| # | 检查 | 判据 |
|---|---|---|
| H-1 | `supersededBy` 未反填 | A 声明被 B 取代，但 B 的 `supersedes` 里没有 A |
| H-2 | `superseded` 链断/成环 | 顺 `supersededBy` 走，走不到非 superseded 的文档；或回到起点 |
| H-3 | **不可达**的权威文档 | `authoritative` 但不在必读清单、也没被任何 `role: index` 文档提到 |
| H-4 | 锚点漂移 | `verifiedDsh` / `verifiedBundle` / `verifiedCommit` 与当前环境不符 |
| H-5 | **`basis` 与 `status` 矛盾** | `basis: 未验证` 却标成 `authoritative` |

> **H-3 被打回过两次，现在是第三版**（见下文订正 3）。
>
> - **第一版**（SPEC 原文）：「authoritative 但不在必读清单」→ `buildIndex()` 把所有无 error 的
>   authoritative 都放进必读清单，所以这个条件**恒为假**。
> - **第二版**（我的重定义）：「不在必读清单，且没被 role:index 提到」→ **仍然恒为假**，
>   因为 `doc-health.js` 传进来的 `required` 就是 `buildIndex()` 的产物。
>   **我批评过「看起来严格但永远通过」，然后自己又写了一条一模一样的。**
>   单测当时手工传 `required` 才过 —— **测了实现，没测接线**。
> - **第三版**（A4 独立评审打回后）：「`authoritative` 且没有任何 `role: index` 文档提到它」。
>   不再依赖 `required`，走真实接线也能触发。没有索引文档时跳过（无法判定可达性）。
>
> **H-4 也被打回过一次**：判据没错，但 `index.js` 传的 `anchors.dsh` / `anchors.commit`
> **恒为 `undefined`**，那两个锚点在生产路径上**从未被检查过**（死分支）。
> 现在：能判的照判，**判不了的记进 `skipped` 并由工具如实展示** —— 静默跳过正是它被判死分支的原因。
>
> **H-5 是 M1 最该有的一条**：M0 的 `basis` 字段**只被解析、从未被使用**。
> 一个填了却没人看的字段，等于没填。

---

## 冷启动预算（M1-E）

索引块多一行：

```
【预算】必读 7 份 ≈ 51.9k tokens（上限 30k）⚠️ 超出上限
```

- **token 从哪来**：frontmatter 显式写了 `tokens` 就用它；没写就按 `Math.ceil(正文字符数 × 0.75)` 估算。
- **绝不写回 frontmatter**：写回会让每次读都改文件 → 指纹变 → 门禁要求重读 → 索引文本变 → 违反 M0-5。
- **这一行只由「必读集合 + 各文档 tokens」决定**，不含「已读几份」这类快变量。
- 上限可配：`coldStartBudgetTokens`（默认 30000）。

---

## 四个工具的用法

### `doc_new` —— 新建文档

```
doc_new({ role: 'spec', title: 'M2 施工图', summary: '右栏看板的设计' })
```

- `id` 不填则从 `title` 派生 kebab-case；**中文标题派生不出 id 时会报错要求显式给 id**（不猜、不编号）
- `order` 不填则取「当前最大 + 10」
- `status` 默认 `draft`，`basis` 默认 `未验证`
- **建完立刻 `rescan()`**，并把新文档记进本会话已读集合 → **紧接着可以直接 `doc_mark`**

### `doc_mark` —— 结构化改状态

```
doc_mark({ id: 'spec-m1', status: 'sealed', reason: '已被第 3 版推翻' })
doc_mark({ id: 'spec-m1', anchor: '#7', sectionStatus: 'authoritative', reason: '这一节已复核' })
```

- 改 `sealed` / `void` **必须给 `reason`**，会写进正文的 `<!-- ddd:mark … -->` 标记块
- 改 `superseded` 必须给 `supersededBy`
- **仍然要求先读过**（与 `write`/`edit` 同一条规则）——改状态就是改语义
- **`evidence` 类文档不能用它改状态**（证据只能新增，不能改写）
- **交接标 `authoritative` 时内部跑 H1–H4，不合格直接拒绝**

### `doc_handover_check` —— 交接预检（只读）

- 不填 `id` 时**优先取 `authoritative` 的那份**，没有再退回 order 最小
  （SPEC 原文只写「order 最小」，那样在 dogfood 里会选中一份 `superseded` 的旧交接）

### `doc_health` —— 健康度自检（只读）

- `scope: 'all'`（默认）返回全部；`scope: 'errors'` 只看 error（当前 5 项都是 warn，所以通常是空）

---

## 为什么**没有做**跨会话 `readSet`

SPEC §3.4 原计划把「已读指纹」写进 `_artifacts/ddd/read-state/<sessionId>.json`，
新会话启动时折回来。**M1 砍掉了它**，理由两条：

1. **它不解决「不知道读过什么」。** 恢复的只是门禁的放行凭据，模型上下文里**依然没有那些文档的内容**。
   真正解决上下文丢失的是 handover 文档——那才是 M1 的主体。
2. **它会让 M1-B 自欺。** 冷启动演练（M1-13）要验证的是「新会话真的去读了」。
   账本说「已读 7/7」，模型就没有理由读——**用这个功能唯一的净效果，是让新会话跳过 M1 自己想验证的那件事。**

代价：新会话要重读它想改的那一份（门禁按**单份**判，不是全部）。
**这条不影响正确性**——「改文档前必须读过」在每个会话里都是真的。

> 将来如果真觉得烦，M2 有 UI 了可以做成「**用户点一下确认继承**」：那时继承是用户的决定，不是插件的默认行为。

---

## 已知限制（**必读**）

### M0 留下的（L1–L16 保持不变，摘要）

| # | 限制 | 影响 / 处置 |
|---|---|---|
| **L1** | **门禁能被 `pwsh` / `bash` 绕过** | `pwsh -Command "Set-Content docs/x.md ..."` 不经过 `guard`。**不假装堵住了** |
| **L2** | **`apply_patch` 不拦** | 参数是补丁文本，抽不出单一路径。本机 `applyPatch: false` |
| **L3** | **`readSet` 不跨会话恢复** | M1 **有意保持**（见上节） |
| **L4** | frontmatter 不支持块式嵌套 | 报 `DOC_FM_UNSUPPORTED`，不静默忽略 |
| **L5** | `AGENTS.md` 可能被用户手改 | 只覆盖 `<!-- ddd:index ... -->` 标记块 |
| **L6** | watch 不可用时降级 | 退化为 touch 驱动，指纹可能短暂过期 |
| **L7** | 无 UI | 坟场归档、占用提醒、图谱全部 M2 |
| **L8** | 不校验文档内容质量 | 只校验元数据 |
| **L9** | `_artifacts/` 无限增长 | R4：永不自动删 |
| **L10** | 全局挂载 = 每个会话都要判定激活 | 判定结果缓存 |
| **L11** | 激活标记可能误判 | 普通仓库恰好有带 frontmatter 的 `docs/` 会被当成 DDD 项目 |
| **L12** | 子代理判定依赖 `origin` | 读不到时退化为 `delegationDepth > 0` |
| **L13** | PTC 的 `run_code` 可能看到坟场路径 | 过滤改的是 `content` 不是 `value` |
| **L14** | `#` 不当注释 | 本解析器不剥离 `#` 注释 |
| **L15** | 目录 watch 只报直接子项 | `docs/sub/new.md` 收不到；降级模式不受影响 |
| **L16** | touch 驱动每轮全量重扫 | 15 份 272 KB ≈ 2.5 ms/轮 |

### M1 新增的（L17–L25）

| # | 限制 | 影响 / 处置 |
|---|---|---|
| **L17**（= M1-L1） | **`doc_handover_check` 只校验结构，不校验语义** | 七段齐全 + §3 有路径，不代表交接内容对。**不假装它证明了正确性** |
| **L18**（= M1-L2） | **冷启动演练不能自动化** | 它是一份协议，靠真实会话执行 |
| **L19**（= M1-L3） | **跨会话 `readSet` 不做** | 删掉整个功能。新会话要重读它想改的那一份，**不影响正确性** |
| **L20**（= M1-L4） | **`doc_new` 只创建 `docs/`** | `ctx.fs` 没有 mkdir；`deliverables/`、`_artifacts/` 是空目录，不替你造（那要塞占位文件） |
| **L21**（= M1-L5） | **`doc_mark` 仍然要求先读过** | 刻意的。代价是「批量改 20 份状态」要读 20 份 |
| **L22**（= M1-L6） | **H-5 可能误报** | `basis: 未验证` + `authoritative` 有时是合理的（用户明确授权）。所以是 **warn 不是 error** |
| **L23**（= M1-L7） | **4 个工具 = 4 份 schema 的固定开销** | 用 `when` 对冲；探测不到项目根的会话仍要付一次同步求值 |
| **L24**（= M1-L8） | **`when` 条件抛错会中止整个步骤准备** | 所有 `when` 都自己 try/catch 并返回 false。**这是 M1 最危险的一处** |
| **L25**（= M1-L9） | **交接质量的上限是「可复述」** | 复述对了也可能做错。M1 只保证「信息没丢」，不保证「决策正确」 |

### M1 实施中新增的 3 条（写在这里，因为它们是**实机才暴露**的）

| # | 限制 | 说明 |
|---|---|---|
| **L26** | **七段标题接受 `##` 与 `###`，且不查顺序** | dogfood 唯一那份 authoritative 交接把「验收/刻意没做/仍未决」写在 `###` 级、且「验收」在 §4.5 的位置。按 SPEC 字面（二级标题 + 按顺序）它 7 段要挂 3 段 |
| **L27** | **H4 不认「文件名」当证据** | `- M1-3 的改动在 core/handover.js` 只说明改在哪，不说明验过。同一个东西不能既证明「我要做什么」（H3）又证明「我做成了」（H4） |
| **L28** | **`doc_mark` 改完一份文档后，它的指纹就变了** | 同一会话里要再改它必须**重新 `read`**。这是「改语义=改文档」的合理代价，`doc_mark` 的拒绝文案会明确说出来 |

### M1.5 新增的（L29–L36）

> 这一节的每一条都是**这轮实机/端到端验证暴露出来的**，不是设想出来的。
> 凡是"我选择不修"的，都写清了理由 —— **不假装它不存在**。

| # | 限制 | 说明 |
|---|---|---|
| **L29** | **`apply_patch` 子代理写 `docs/` 拦不住** | `pathArgOf` 抽不出单一路径（M0 起就这样，L2 已记）。本机 `applyPatch: false` → 生产路径不可达；**但一旦宿主启用 patches，N9 会在这里留一个洞**。`test/n9.test.js` 有一条测试**钉住这个事实**（不是假装堵住） |
| **L30** | **`lastWriter` 记不进 `_artifacts/` 时静默跳过** | 插件**从不创建目录**（L20）。所以新项目里 `_artifacts/` 不存在 → D3 一条都记不上。这是**设计**（与 `doc_new` 不建 `deliverables/` 一致），不是 bug；但要知道它可能"什么都没记" |
| **L31** | **`verifiedAt` 是可选字段，缺它不报 H8** | 若把「缺字段」也算 stale，所有现存文档会**一次性全变 warn**。M1.5 刻意不这么做（`P13` 的同理：迁移成本必须由 warn 期吸收）。所以 H8 只能抓"写了但过期"的，抓不到"根本没写"的 |
| **L32** | **H8 的「交接创建时间」用的是交接自己的 `verifiedAt`** | 交接 frontmatter 里**没有**创建时间字段，而且不该加（加它会改 schema；若由 `doc_new` 自动写时间，索引块 digest 会含时间戳 → **每轮渲染都变 → 违反 M0-5**）。所以用交接的 `verifiedAt` 当"本交接成立于哪一天"，**语义上是近似**。代价：交接没写 `verifiedAt` → H8 整段跳过 |
| **L33** | **H8 / H9 的编号曾被两个判据同时占用** | 交接文档里：§0.4 说「`handover` 多一条 **H8**」指 **N8**，而 §3.6 的 **D4** 也把 `verifiedAt` 判据叫 **H8**。M1.5 的处置：**H8 留给 D4、N8 那条改叫 H9**（理由：§3.6 的 H8 有完整定义，§0.4 只是一句顺口提）。**这条记在这里，下一位就不会再撞** |
| **L34** | **`doc_new` 的"自动取代旧交接"不检查新旧 order 是否合理** | 实机验证（`_m15/live-evidence.md` L6）发现：一份**显式传 `order: 999`** 的新交接，也会把正确的旧交接取代掉 —— 而它自己随后被 H7 判 `ok:false`。结果是**交接链断在一个不合格的节点上**。**M1.5 没改**（它是我修 D1 第②步时新引入的行为，改它会动 `doc-new.js` 的输出契约，而那个契约刚被 L5 验过）。**候选修法见下** |
| **L35** | **交接文档必须是 `docs/` 下的受管文档** | `P7 = A` 已拍板。项目根下的交接 md（如 `交接-给M1.5复核者.md` 本身）**过不了 `doc_handover_check`**（它不在 `docs/` 下、没有 frontmatter 时 `ok:false` 是**预期行为**）。**不要为它开特例** |
| **L36** | **N8 的 §1 内容判据（H9）仍可能被平凡输入绕过** | 写一句「本项目是 xxx」但项目实际是 yyy → 它**不给 warn**（判据只认字面/句式，不认语义）。这正是交接 §3.8.4 的 **A-2 触发条件**。M1.5 测了现存样本**没触发**，但**不等于永远不会** |

> **L34 的修法已拍板（用户 2026-11-12）：选 (c)。**
> 做法：**不改行为，但在 `doc_new` 的返回值里警告**「注意：新交接的 order 不是最小的，可能排错」。
> 实现在 `tools/doc-new.js` 的 `handoverOrderWarningOf()`（纯函数，可单测）。
> **为什么不是 (a)/(b)**：
> - (a) 留着"静默出错"的口子；
> - (b) 会挡住合法用法（"故意传 999 做测试"本身是合理的，M1.5 的实机验证就是这么干的），
>   而且把"裁决顺序"从 H7 挪到 `doc_new`，两处都管顺序反而打架。
>
> ⚠️ **这条警告只在"显式传了 order 且它 ≥ 现存最小 handover order"时出现**；
> 正常路径（不传 order，由 `doc_new` 算「最小 − 10」）**永远不警告** ——
> 否则警告就变成噪音，与 N2 的教训正好相反。`test/d5-l34.test.js` 有 **3 条** L34 反向断言
> （正常路径严格小于 min / 第一份交接 / 非交接）+ **2 条** D5 反向断言钉住它们。
>
> ⚠️ **这里原来写「7 条反向断言」，是错的**（实测 5 条：3 条 L34 + 2 条 D5）。
> 交接测试的第二个子代理逐条数出来。**"我写了个数字"和"我数过"是两件事。**

### M2.1 新增的（L37–L40）—— M2-E 归档/还原落地时才暴露的

> 编号接着往下排（SPEC §12 的要求：**不要另起一套 `M2-L*`**）。
> 这四条都是"我选了这条路，代价在这里"的诚实记账。

| # | 限制 | 说明 |
|---|---|---|
| **L37** | **归档走 `createIfAbsent` + `stat` 两步，不是原子 rename** | `ctx.fs` 没有 `rename`；`moveFile` 的语义是「发布目标 → 删源」两个独立效果，**本来就不是原子的**（README 原文：*a published destination with a retained source is a final outcome*）。所以这里刻意用 `writeText({kind:'createIfAbsent'})` 做**目标侧的原子存在性守卫**，再用 `deleteFile` 删源。**代价**：`stat` 与 `write` 之间如果有人抢先建了同名文件，会得到 `FS_EXISTS` 而整条失败 —— 那是**正确的失败**（不覆盖），不是 bug。**好处**：绝不覆盖坟场里的旧文件 |
| **L38** | **`server/` 拿不到会话的 `sandboxMode`，所以模式固定是 `workspace-write`** | HTTP 路由不是工具调用，没有 `exec.agent.session.header`。`tools/doc-new.js` 的 `sandboxPolicyOf(exec)` 在那里能读到真实模式，这里读不到。按 `tools/doc-new.js:101` 的同一条纪律，**读不到就退回 `workspace-write`，绝不退回 `danger-full-access`**（读不到 ≠ 可以放宽）。**代价**：若用户的会话是 `read-only`，归档仍会以 `workspace-write` 跑（比会话本身**宽**）—— 但归档是**用户主动点的按钮**，不是模型的动作，所以这个宽不构成提权 |
| **L39** | **归档元数据写在文件自己的 frontmatter 里，且不校验（无 schema 规则）** | `archivedFrom` / `archivedAt` 是本插件私有字段。`docs/schema.js` 的 V1–V12 **不检查未知字段**，所以这两个字段不会让文档进 `anomalies`；同时它们也**没有**校验（写坏了不会被发现）。**代价**：它们是"约定"而不是"判据"。**好处**：不建目录（L20/L30 的约束不用破）、随文件进 git、还原只读自己就够，且**还原时会被删掉**，所以归档→还原是可逆的 |
| **L40** | **坟场是平铺的，同名会撞** | `graveyardOf()` 只列 `docs/_graveyard/` 的直接子项（坟场本身不递归），所以归档目标只取**文件名**。`docs/a/x.md` 与 `docs/b/x.md` 归档后会撞名 —— 那时**显式拒绝**（不覆盖、不自动改名）。**代价**：同名文档不能同时归档（要先还原或手工改名）。**为什么不做递归坟场**：那会让 `classifyPath` 的 graveyard 判定、扫描器的 `DEFAULT_IGNORED_DIRS`、以及看板的坟场清单三处一起改，而收益只是"支持同名" |

> ⚠️ **L37 的一条实机判据**（别只看代码）：`_m21/probe-archive-live.mjs` 用**真 `node:fs`** 在真磁盘上跑一遍
> 归档→还原，21 项检查含 **CRLF 保留**、**中文/emoji 正文逐字不变**、**M0-4 回归（坟场路径仍判 graveyard）**。
> 单测里的 `fakeFs` 是内存实现，它只能证明"我理解中的宿主语义"自洽 —— 那种假绿 M2 这轮已经踩过 5 次。

---

## 十一处对 SPEC 的订正（**都记在这里**，不是偷偷改的）

> M0 的「五处订正」仍然有效（见下文），这里是 **M1 + M1.5 新增的十一处**。
> （第 11 条是 M1.5 补的 N3 字段名订正 —— 原清单只有 10 条，而 N3 的偏离**从未被记录过**。）

### 1. 工具数量：SPEC §1.3 与 §2.1 自相矛盾

§1.3 写「M1 最多用 **2 个**」，§2.1/§2.2 写「**4 个**，用满 Q13 上限」。**按 4 个执行**（§2.2 有完整论证）。

### 2. 跨会话 `readSet`：砍掉

见上文「为什么没有做跨会话 readSet」。SPEC §3.4 自己留了这个降级方案。

### 3. H-3 重定义为「不可达」

SPEC 原定义「`authoritative` 但不在必读清单」在本实现里**恒真不可达**：
`buildIndex()` 把所有无 error 的 authoritative 都放进必读清单，所以这条只可能命中「有 error」的文档，
而那时的归因是「元数据坏了」。**实测 dogfood 命中 0，且构造不出合法反例**——典型的「看起来严格但永远通过」。

新定义：`authoritative`，既不在必读清单、**也没被任何 `role: index` 的文档提到**。
可证伪、能造反例，而且问的是真问题：**这份权威文档，读者怎么知道它存在？**

### 4. 七段标题：接受 `###`，不查顺序

见 L26。

### 5. `doc_mark` 内置交接校验（M1-C 的硬落点）

SPEC 原设计里「交接失败会被拒绝」只体现在 `doc_handover_check` 的**返回值**上。
但返回值拦不住模型——它完全可以跳过检查直接 `doc_mark`。
所以加了一条**代码里的 `if`**：把 `role: handover` 标成 `authoritative` 时内部跑 H1–H4，不合格就拒绝。

> 这一条**刻意无视 `handoverCheckStrict` 配置**。那个开关的本意是「预检别太吵」，
> 接到这里等于**一个 YAML 配置就能关掉 M1-C**——那就退化成提示词约束了。
> **预检可以放宽，落盘不行。**

### 6. `doc_new` 不创建 `deliverables/` 与 `_artifacts/`

`ctx.fs` **没有 mkdir**（反编译 `dsh-fs-local` 确认：`writeText` 内部会 `mkdir -p` 父目录，但没法创建空目录）。
`docs/` 能靠 `writeText` 隐式建出来，另两个空目录只能靠写占位文件——那是往用户项目里塞垃圾。见 L20。

### 7. 交接流程：`doc_handover_check` 是**预检**，不是落盘门禁

SPEC §4.4 写「`doc_handover_check` 在**写之前**跑」，但它的参数是 `id`（查一份**已存在**的文档）——
没写的文档没法查。实际用法：

```
doc_new（建 draft）→ doc_handover_check（预检）→ doc_mark（落盘，内部再校验一次）
```

### 8. 预算行 **pinned，永不被 `fitBudget` 裁掉**

否则在长索引项目上，M1-1 的判据直接判不了。

### 9. 不填 `id` 时**优先 authoritative**

SPEC 写「order 最小的那份」，但 dogfood 里那样会选中一份 `superseded` 的旧交接（`order: 20`）。
### 10. M1-14 的判据：从「都不可见」改为「都不可用」

SPEC §10.3 原判据：「4 个工具**都不可见**（S2 + `when`）」。

**实机验收三次复现：子代理能看到并成功执行 4 个工具。**

| 已排除的假设 | 验证方式 | 结论 |
|---|---|---|
| `isSubagentSession()` 写错了 | 离线用真实 header 形态跑 | 排除：返回 `true` |
| 宿主没给子会话写 `origin` | 反编译 `dsh-subagent` | 排除：确实写了 `origin: "subagent"` |
| `when` 没被调用 | 加诊断日志 | 排除：被调用了，日志里有 `isSub: true` 的记录 |
| `when` 返回了 true | 读代码 | 排除：`isSub: true` → `shouldActivate` → false |

**根因未定位；兜底是唯一防线，且实测有效。**

> ⚠️ **M1.5 的订正（2026-11-12，对应评审的 C1 / `P8`）**：
> 这里原来写「根因未查明」，而另外两份文档写「根因已定位」，**三处三个说法**。
> 评审者（第三位）实测发现那个"根因"（`probe` 用 `header.cwd` 做缓存 key）**不成立**：
>
> ```
> 普通会话（非子代理），cwd 指向非 DDD 项目：
>   seq=16 的 request/header 里 tools = array(41)，doc_ 工具 4 个全在
>   而同一个会话的索引块：seq=16 没有 ddd:index
> ```
>
> **同一个 `probe()`，索引块判"未激活"、工具可见性判"激活"** —— 这不可能是缓存 key 的锅
> （如果是，两者会一起错）。真机制未知（很可能在宿主 `resolve()` 的调用时机 / `toolSet` 缓存里，
> 而插件没有宿主的可执行源码，**不猜**）。
>
> **所以统一成这一句**：「根因未定位；兜底是唯一防线，且实测有效」。
> 这也意味着：**不要花一轮去改 `probe`** —— 那大概率白改，还要动 M0 的核心路径。

**处置**：补一道执行期的 `if`（`tools/when.js` 的 `assertToolAllowed`），4 个工具的执行入口第一句都调它。

**为什么修订后更强**：不可见是**体验**（少 4 份 schema 开销），不可用才是**约束**。
即使宿主某天又把工具塞回子代理的 toolSet，执行期那道 `if` 仍然拦得住。

### 11. `verifiedAgainst` 拍平为 `verifiedDsh/verifiedBundle/verifiedCommit`，**两个名字都认**

> 这一条是 **M1.5 补的**（评审的 **N3 / C4**）。它原来根本**没有记录** —— 不是"忘了写订正"，
> 是**连偏离都没被承认过**：`grep verifiedAgainst README.md` 在 M1 交付时是 **0 命中**。

**SPEC / 架构评审（"以此为准"）的写法**：`verifiedAgainst: { dsh, bundle, commit }`（附录 B1、§6 Q5）。
**实现的实际写法**：三个平键 `verifiedDsh` / `verifiedBundle` / `verifiedCommit`。

**为什么当初要拍平**：本插件的解析器是自己手写的极小子集（≤120 行、可单测），
**不支持块式嵌套**——`verifiedAgainst:\n  dsh: ...` 会直接报 `DOC_FM_UNSUPPORTED`。
拍平能让解析器保持"一行一个 `key: value`"。

**偏离的后果（这才是缺陷）**：H-4 / V9 只认扁平名，于是**任何按架构评审写的文档，
锚点判据对它永远静默通过**。又一个"看起来严格但永远通过"——M1 已因此被打回两次（H-3、H-4）。

**M1.5 的修法**：**两个名字都认**，实现在 `core/anchors.js` 的 `declaredAnchorOf()`
（`docs/schema.js` 的 V9 与 `core/health.js` 的 H-4 共用同一份，避免"改一处漏一处"）。

⚠️ **一个必须说清的细节（这是跑出来的，不是读文档出来的）**：
嵌套只能写成**流式 JSON** `verifiedAgainst: {"dsh":"..."}`；
而解析器对 `{...}` **没有专门分支**，它落到"标量"分支，
所以 `meta.verifiedAgainst` 是**字符串**而不是对象。

实测（`_m15/probe-n3.mjs`）：
```
nested meta.verifiedAgainst = "{\"dsh\":\"0.0.1\",...}"   ← 是字符串
nested: H-4 命中 0 条                                       ← 修 N3 之前
flat:   H-4 命中 3 条
```
**只看文档会以为它是对象，只有跑一遍才知道它是字符串。** 所以 `declaredAnchorOf` 三种形态都接
（对象 / JSON 字符串 / 数字）。

**实机证据**（子代理实测）：

```
结果：B 被执行期兜底拒绝
Error: DDD 工具在子代理会话里不可用（S2：子代理不参与文档施工）
```

---

## M0 的五处订正（历史记录，仍然有效）

> 这一节是 **M0 那份 README 的原文**，保留在这里作为历史。
> M1 新增的**十一处**订正见上一节；两份性质不同，**不要合并成一个数**。


## 安装

```powershell
# 在 DSH 里用 plugin_manager：
#   action: install_bundle
#   target: <本 bundle 的绝对目录>
# 然后重启 DSH。
```

> **改 JS 之后必须重启 DSH**（模块代不会热替换）。
> HMR 有时能免重启，但**验收一律以重启后为准**。

## 让某个项目成为 DDD 项目

满足**任一**标记即可（SPEC §4.3）：

| # | 标记 | 判定 |
|---|---|---|
| **T1** | `docs/` 下至少有一份**合法 frontmatter** 的 `.md` | 能解析出 `id` + `role` + `status` |
| **T2** | `AGENTS.md` 里含 `<!-- ddd:index` | 字符串包含即可（插件自己会写） |

**两者都没有 → 整个插件对该项目 no-op**：不注入索引、不挂 guard、不挂 filter。

> 这是**防误伤**的关键：一个普通代码仓库里刚好有个 `docs/`（没有 frontmatter），
> 模型去改它不该被拦。M0-12 专门验这一条。

### 目录布局

```
<项目>/
  AGENTS.md                ← 慢变量索引（插件自动维护标记块）
  docs/                    ← 受管：有 frontmatter，进索引
    _graveyard/            ← 坟场：不扫描、不可读
  deliverables/            ← 交付成品（M0 只放行，不实现视图）
  _artifacts/              ← 过程产物（M0 只放行）
```

---

## frontmatter 格式（**只支持这个子集**）

```yaml
---
id: spec-tier2
title: 档 2 施工图
role: spec
order: 20
status: authoritative
summary: 档 2 的全部功能切片
basis: 实测
scope: ["tier2"]
sections: [{"anchor":"#7","status":"authoritative"}]
---
```

**支持五种形态**：标量、数字、流式 JSON、裸词列表 `[a, b]`、空值 `key:`。

**显式拒绝**（报 `DOC_FM_UNSUPPORTED`，**不静默忽略**）：
块式列表（`- item` 另起一行）、块式嵌套（缩进子键）、多行字符串（`|` / `>`）、锚点别名（`&` / `*`）。

> **为什么砍得这么狠**：bundle 解析不到任何第三方包（实测 `js-yaml` / `yaml` / `zod`
> 全部 `ERR_MODULE_NOT_FOUND`），只能手写解析器；把语法压到「一行一个 `key: value`」
> 才能把它压进 120 行代码并可单测。

### 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | kebab-case，**永不变** |
| `title` / `summary` | ✅ | `summary` ≤80 字，索引用 |
| `role` | ✅ | `index` / `spec` / `decision` / `evidence` / `log` / `handover` / `instruction` / `fact` |
| `order` | ✅ | 阅读顺序，建议 10/20/30 留插值 |
| `status` | ✅ | 见下表 |
| `basis` | ✅ | `实测` / `推断` / `未验证` |
| `scope` | `partial` 必填 | 适用切片 |
| `slice` | ❌ | **M1.5 / D5 新增（可选）**：当前切片名（如 `M1.5`）。索引块的 `【施工】` 行取它。<br>**只在 `role: index` 的文档上生效**；没有它就退到 `scope[0]`，再没有就**整行不显示**（不写占位）。<br>⚠️ **故意做成可选**：做成必填会让所有现存文档立刻变 error（那是方案 A 的代价，`P13` 已否决过同类做法） |
| `verifiedAt` | ❌ | **M1.5 / D4 新增（可选）**：上次被确认是对的时间，`YYYY-MM-DD`。格式坏只 **warn（V12）**，不 error。H8 用它判「本轮有没有重新确认过」 |
| `supersededBy` | `superseded` 必填 | 谁取代了我 |
| `verifiedDsh` / `verifiedBundle` / `verifiedCommit` | ❌ | 锚点漂移检测（只 warn） |

### status

| status | 含义 | 可执行 | 位置 |
|---|---|---|---|
| `authoritative` 🟢 | 当前有效 | ✅ | 工作区 |
| `partial` 🟡 | 只在 `scope` 内有效 | ✅（限 scope） | 工作区 |
| `superseded` ⚪ | 有明确取代者 | ❌ | 工作区（灰显） |
| `sealed` 🔴 | **原地封存**：有诱惑力但已被推翻，无替代者 | ❌ | **原地不动** |
| `void` ⚫ | 明确作废 | ❌ | 坟场 |
| `draft` 🔵 | 未定稿 | ❌ | 工作区 |

> **`superseded` ≠ `sealed`**：前者有替代品可直接跳过；后者**没有替代品，必须让读者知道"这里有个坑"**。
> 把 `sealed` 扔进坟场反而危险（可能被翻出来当有效文档）。

### 校验错误怎么处理

> **error 不阻塞读取，只阻塞"用它当依据"。**

文档写坏不该让整个插件瘫掉，但也不能让坏文档静默参与决策。所以：
读得到（模型能看见），**进不了必读清单**，并在索引块里出现一行 `【文档异常】`。

---

## 门禁规则

**只看目标路径，不看工具名**（R1）。

| 目标 | 行为 |
|---|---|
| `docs/**.md`（必读且未读） | **拒绝**，列出缺哪几份 id |
| `docs/**.md`（读过） | 放行 |
| `docs/**.md`（读过但磁盘变了） | **拒绝**：「你读的是 v3，磁盘已是 v5」 |
| `docs/**.md`（没有 frontmatter） | 拒绝：先补 frontmatter |
| `docs/_graveyard/**` | **连 read 也拒** |
| `src/` / `deliverables/` / `_artifacts/` | **放行** |

### 按 role 的写权限

| role | `write` | `edit` |
|---|---|---|
| `spec` / `log` / `index` / `fact` | 放行 | 放行 |
| `decision` | 拒绝 | **仅追加**（末尾 200 字符内且不删改原文） |
| `evidence` / `handover` | 拒绝 | 拒绝 |
| `instruction` | 拒绝（除非 `status: draft`） | 拒绝 |

---

## 配置

在 `cordis.patch.yml` 里给 `ddd-engine` 这一行写 `config`（本文件不导出 `Config`，
所以字段不做 schema 校验，非法值一律**静默回落默认值**）。

| 键 | 默认 | 说明 |
|---|---|---|
| `projectRoot` | `''` | 空 = 自动探测 |
| `docsDir` | `docs` | |
| `graveyardDir` | `docs/_graveyard` | |
| `maxIndexBlockChars` | `1200` | 索引块预算 |
| `maxWatchedDocs` | `100` | 超过则退化为 touch 驱动 |
| `agentsMdMinWriteMs` | `5000` | 写 `AGENTS.md` 的节流窗口 |
| `gateEnabled` | `true` | 一键关掉门禁（调试） |
| `graveyardFilterEnabled` | `true` | |
| `requireMarker` | `true` | **设 false = 只凭 `docs/` 就激活（危险，仅调试）** |
| `excludeSubagents` | `true` | **设 false 会让子代理也被门禁拦住（不建议）** |
| `markerProbeDepth` | `8` | 向上探测层数上限 |

---

## M0 的已知限制原文（L1–L16，M1 仍适用，总表见上文）

| # | 限制 | 影响 / 处置 |
|---|---|---|
| **L1** | **门禁能被 `pwsh` / `bash` 绕过** | `pwsh -Command "Set-Content docs/x.md ..."` 不经过 `guard`。**不假装堵住了** |
| **L2** | **`apply_patch` 不拦** | 参数是补丁文本，抽不出单一路径。本机 `applyPatch: false`，风险为 0；换部署会变 |
| **L3** | **`readSet` 不跨会话恢复** | M0 内存态。会话恢复后需重读 |
| **L4** | **frontmatter 不支持块式嵌套** | 报 `DOC_FM_UNSUPPORTED`，不静默忽略 |
| **L5** | **`AGENTS.md` 可能被用户手改** | 只覆盖 `<!-- ddd:index ... -->` 标记块；无标记时追加 |
| **L6** | **watch 不可用时降级** | 退化为 touch 驱动，指纹可能短暂过期。warn 一次 |
| **L7** | **无 UI** | 坟场归档、占用提醒、图谱全部 M2 |
| **L8** | **不校验文档内容质量** | 只校验元数据。写得烂的文档照样进索引 |
| **L9** | **`_artifacts/` 无限增长** | R4：永不自动删 |
| **L10** | **全局挂载 = 每个会话都要判定激活** | 判定结果缓存；无标记时只付一次探测成本 |
| **L11** | **激活标记可能误判** | 普通仓库若**恰好**有带 frontmatter 的 `docs/` 会被当成 DDD 项目。拒绝文案会说明这是 DDD 门禁 |
| **L12** | **子代理判定依赖 `origin`** | 读不到时退化为 `delegationDepth > 0` |
| **L13** | **PTC 的 `run_code` 可能看到坟场路径** | 坟场过滤改的是 `content` 不是 `value`（post-execute 不允许同时给两者），`value` 里的路径仍在 |
| **L14** | **`#` 不当注释** | 本解析器不剥离 `#` 注释。理由见下 |
| **L15** | **目录 watch 只报直接子项** | `docs/` 根目录一个 watcher 覆盖不了 `docs/sub/new.md`。降级模式下不受影响（touch 驱动是递归重扫） |
| **L16** | **touch 驱动每轮全量重扫** | 没有 watcher 时，每轮 `pre-step` 会 `listDir` + 读全文 + 解析。实测 dogfood 15 份 272 KB ≈ 2.5 ms/轮；超过 `maxWatchedDocs` 会跳过 |

### 关于 L14（= 第 5 处订正，完整说明见下文「五处对 SPEC 的订正」第 5 条）

一句话：SPEC §5.1 把「注释（`#`）」列进"显式不支持"，本实现**把 `#` 当普通字符，不剥离**。
理由见订正 5。

---

## M0 的订正原文（与上文 M1 的十一处是两份清单，别混）

> ⚠️ **这份清单原来少列了一处。** 评审指出：`README` 说「四处」、`M0-验收报告` 说「三处」、
> 而 L14（`#` 不剥离）另算一处 —— **三份文档三个数**。现在统一为**五处**，见下。

### 1. M0-5 的判据（原判据在当前 DSH 上不可达）

SPEC §6.1 / M0-5 原文：「连续 10 轮只有一条索引消息」。

**实测不成立。** `dsh-agent-loop` 的 `RuntimeContextProjection.project()` 是：

```js
const context = this.runtimeContext.project(joinContextSections(sections), sections)
if (context !== void 0) this.session.append("user/message", context, { surfaceOp: "append" })
```

**文本一变就 append 一条新消息，旧的不删、不 replace**（`agent-loop` 里唯一的
`surfaceOp: {op:'replace'}` 属于系统提示词，不属于 runtime-context）。
`dsh-system-prompt` README 说的"本快照取代上一份"是**语义**上的，不是**物理**上的。

**可复现的实证**（评审要求：原来的「264 会话」表没有产出脚本，不可复现，已替换）：

```powershell
node _ref/session-stats.mjs C:\Users\slimeball\.dsh\sessions
```

```
扫描 266 份日志，有效会话 262 个，坏帧合计 0
总步数 8712 ｜ runtime-context 总数 763 ｜ 占比 8.76%
surfaceOp: append=763 其它=0  ← 全部为 append 才支持"物理追加"结论
相邻文本完全重复 0 次        ← 为 0 才支持"文本不变则不 append"结论
```

| 分组 | 会话数 | 平均步数 | 平均 runtime-context 条数 | 只有 ≤1 条 |
|---|---:|---:|---:|---:|
| 全部会话 | 262 | 33.3 | 2.9 | 165/262 |
| 含 `coach:state`（每步都变） | 92 | 10.2 | **5.7** | 22/92 |
| 不含 `coach:state` | 170 | 45.7 | **1.4** | 143/170 |
| 步数 ≥ 10 | 123 | 66.0 | 4.4 | 60/123 |

> 两张关键证据比原来的表更硬：
> ① **`surfaceOp` 763/763 全是 `"append"`** —— 追加语义直接写在事件里，不用读源码；
> ② **相邻 runtime-context 文本完全重复 0 次** —— 文本不变时确实不 append。
>
> 教练模式有一个会话 **69 步出了 31 条**，触发源全是 `coach:state` 内的
> 「已完成 1/11 → 2/11」「核查结论：尚无结论 → 通过」——正是 SPEC §6.4 禁止的
> 「每轮都变」的内容。

**所以 M0-5 的判据改成三条可证伪的断言**：

1. **上界**：连续 10 轮无文档状态变化 → **恰好 1 条** runtime-context；
2. **不变量**：**重复 read 一份未变的文档 → 不产生新消息**（指纹相同 → 渲染相同 → 不 append）；
3. **总量**：整会话索引消息数 **≤ 1 + |必读清单|**，不随轮次线性增长。

实现上由 `core/render.js` 的红线保证：渲染文本**只由"文档集合与文档状态"决定**，
绝不包含时间戳 / 轮次 / 步号 / seq / 每次 read 都变的计数。
`test/render.test.js` 有对应的**反向断言**。

### 2. 大小写判定

SPEC §4.5 写「Windows 上 `docs` 与 `DOCS` 视为同一目录（`path.resolve` 后比较，
不额外小写化）」——**这两半自相矛盾**：`path.resolve` 只做规范化与绝对化，
**不碰大小写**，光靠它 `DOCS` 永远不等于 `docs`。

而这是**门禁漏洞**不只是整洁问题：Windows/NTFS 默认大小写不敏感，
模型写 `DOCS/x.md` 改的就是 `docs/x.md`；按大小写敏感比较会判成 `outside` 而**放行**。

本实现按平台判定（`docs/path.js` 的 `sameSegment`）：
`win32` / `darwin` 逐段**忽略大小写**，其余平台**保留大小写**。

### 3. watch 粒度

SPEC §6.3 写「每个受管文档一个监听」。本实现改为**`docs/` 根目录一个 watcher**：
`dsh-fs-local` 的目录 watch 只报**直接子项**（`depth: 0`），
一个目录 watcher 就能覆盖"文档新增/删除"，比每文档一个 watcher 稳得多，
且 10~50 份文档重扫很便宜。超过 `maxWatchedDocs` 时整体退化为 touch 驱动。

### 4. 指纹对账放在 `agent/pre-step`（M0-8 的落点）

`readSet` 存的是「我读的那一版的指纹」。如果只在 `tools/result` 里记账而从不重算，
那么「外部改动 → 模型再改」永远检测不到变化，M0-8 会**静默失效**。

本实现分两处：

1. **`tools/result`（同步）**：从 `read` 的返回信封里还原正文算指纹——
   那是模型真正看到的字节，且不用二次读盘。
   **必须同步**：模型常「read 完立刻 edit」，异步记账会让那一刻 `readSet` 还是空的，
   门禁就会**误拒**。
2. **`agent/pre-step`（异步）**：分两条路，**按有没有 watcher 决定**（SPEC §6.3）：
   - **有 watcher**：`refreshAllFingerprints()` 只兜「watcher 刚建好、还没收到事件」的边角；
   - **没有 watcher（降级）**：`rescanIfStale()` —— **重扫**，不是只重算指纹。
     因为 `refreshAllFingerprints()` 只更新**已在册**条目，**发现不了新文件**。

> ⚠️ **评审订正（原实现有误）**：修 D2 之前，这里**无条件**每轮调
> `refreshAllFingerprints()`（全文重读全部文档）。那与本节自己的说明、
> 与 SPEC §6.3 的「watch 优先，无 watch 则 touch 驱动」都矛盾。
> 实测 dogfood 15 份 272 KB ≈ **2.53 ms/步**、434 步累计读盘 **115 MB**。
> 现在按 `isWatching()` 分流，且降级路径改成**重扫**（既能发现新文件，又顺带完成指纹对账）。

> 窗口读取（`Showing lines … of N`）与截断输出（`Output capped`）**不采用**：
> 局部内容算不出全文指纹，会制造假失效。这类 read 退回用注册表里的旧指纹，
> 由 pre-step 的对账纠正。

### 5. `#` 不剥离（SPEC §5.1 把「注释」列进「显式不支持」）

SPEC §5.1 把「注释（`#`）」列进"显式不支持"。本实现的实际行为是：
**把 `#` 当普通字符，不剥离**。

理由：剥离会造成**静默数据丢失**——`summary: 用 # 号标记` 会被截成 `用`，
而那正是 SPEC 最反对的"静默忽略"。不剥离时 `anchor: "#7"` 自然正确，
`id: foo # 注释` 会原样留下（**可见的脏，不是隐藏的错**）——而且它随后会被
`id` 的 kebab-case 校验拦下、进 `anomalies`，不会静默通过。

> 评审裁定：**有条件接受**。理由成立，但这条**必须列进订正清单**
> （原来只写在 L14 一节里，不在「四处订正」中 —— 这就是「三份文档三个数」的来源）。

---

## M0 评审后的三处修复（D1 / D2 / D3）

> 来源：`M0-评审报告.md`。三条都不是「某个函数算错了」，而是**两个模块之间没人接线** ——
> 所以纯函数单测抓不到，`sequence.test.js` 也抓不到（它测「第一轮有没有索引」，
> 不测「后续变化有没有跟上」）。
>
> 复现与回归：`_ref/verify-d1d2d3.mjs`（修复前 4/5 失败 → 修复后 5/5 通过）
> ＋ `test/regressions.test.js`（9 条，**含反向断言**）。

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| **D1** | **`AGENTS.md` 首次扫描后永不重写** —— SPEC §6.5 的三个触发只接上第一个 | `rescan()` 从不通知 writer。活标本：`dogfood/AGENTS.md` 至今还列着已删除的 `m0-7-broken` | 注册表新增 `onIndexChanged` 订阅；`rescan()` 后按**清单摘要**（id/status/order/summary）去重再通知；writer 建好即订阅 |
| **D2** | **降级模式下新建文档永不被发现** | 只有 `read` 触发重扫；`refreshAllFingerprints()` 只更新已在册条目，**发现不了新文件** | ① `observe.js` 对 `write`/`edit` 命中 `docs/` 也触发重扫；② `prepareSession` 在无 watcher 时走 `rescanIfStale()`（**重扫**） |
| **D3** | **新建文档「读完立刻改」被误拒** —— 模型真读过，门禁说没读过 | `markRead` 对未入册条目返回 `false` 且**不补记** | 未入册时记进「待补记队列」（直接捕获目标 `readSet` 引用），`rescan()` 完成后补记 |

**D1 的一个设计细节**：`onIndexChanged` 通知前比较的是**清单摘要**，不是整份 `index`。
文档**正文**一改指纹就变，但正文变化**不该**触发 `AGENTS.md` 重写（慢变量只放清单，不放正文）。

**D2 的副作用检查**：改成每轮重扫后，索引文本必须仍然稳定 ——
`test/regressions.test.js` 有一条「连续 10 轮文档不变 → 索引文本完全一致」的断言钉住这一点
（否则 M0-5 会因为这些修复而回归）。

**D3 的反向保护**：修误伤不能把门禁拆了。两条反向断言：
「没读过的新文档仍然要拦」「读的是旧版（外部改过）仍然要拦」。

---

## 开发中撞到的、值得记住的四个坑

| # | 坑 | 表现 |
|---|---|---|
| 1 | **`this` 丢失** | `probeMarker({ readHead: fsAdapter.readHead })` 把方法拆出来传，方法内 `this.xxx` 就抛；抛错又被探测层 `catch` 吞成"没命中"→ **T1 永远探测不到且没有任何日志** |
| 2 | **`readSet` 没按会话隔离** | 会话 A 读过的文档，会话 B 也算读过 → 门禁形同虚设。改用 `WeakMap<session, Map>` |
| 3 | **`signal` 传 `undefined`** | `FileSystem.watch()` 第一行就是 `signal.throwIfAborted()`，传 undefined 抛 `TypeError`，被 catch 吞成"watch 被拒"→ **永远走降级路径**且看起来正常 |
| 4 | **`ctx.fs.writeText` 没有兜底** | 沙箱围栏拒绝写时抛异常，而调用方 `await` 在项目初始化链上 → **整个注册表初始化失败，索引与门禁一起消失** |

第 4 条尤其危险：写 `AGENTS.md` 只是附加价值，它失败绝不能连累门禁。
现在 `writeOnce` 整体包 try/catch，失败只记一条 warn。

---

## 两条保守规则（宁可漏管，不可误伤）

1. **注册表未就绪（扫描失败）→ 门禁放行**。
   扫描失败的原因可能是沙箱、权限、超大目录，都不是"模型没读文档"的错。
   把插件自身故障变成对模型的拒绝，比漏管一次严重得多。

2. **注册表里根本没有这份文档 → 放行**。
   典型场景：模型刚新建 `docs/new.md`，扫描还没覆盖到。
   判据由适配层注入的 `knownOf()` 提供——要区分
   「文件在注册表里但解析不出 id」（真没 frontmatter，**拒绝**）
   与「文件压根不在注册表里」（**放行**）。

---

## 开发

```powershell
$node='C:\Users\slimeball\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'

cd <this-bundle>
& $node --test --test-isolation=none      # 单测
& $node ..\_ref\smoke-ddd.mjs             # 装配冒烟（零宿主依赖）
```

> ⚠️ **不要用 `node --test test/`**：Node 24 会把目录当单个入口模块，
> 报 `ERR_UNSUPPORTED_DIR_IMPORT`。必须用 `--test-isolation=none` 让它自动发现。

### 分层（`test/decoupling.test.js` 强制）

```
index.js → adapters/ → docs/ + core/
                ↓
             core/  （不反向依赖任何东西）
```

- **整包禁止** `@deepseek-ai/*`（宿主包在 `app.asar` 里，解析不到）
- **整包禁止**任何第三方包（实测 `ERR_MODULE_NOT_FOUND`），只允许 `node:` 前缀
- **`core/` 额外禁止**：`node:*`、`Date`、`Math.random`、文件 IO
- **`core/` 的 import** 只允许 `./xxx.js`
- **`cordis.patch.yml` 不得出现预设行名**（S1 的静态检查）

---

## 文件地图

| 文件 | 职责 |
|---|---|
| `index.js` | `apply(ctx, config)`：装配 + 激活判定 + 生命周期 |
| `config.js` | `resolveConfig()`（手写归一化，**不导出 `Config`**） |
| `docs/frontmatter.js` | 零依赖 YAML 子集解析（≤120 行代码） |
| `docs/path.js` | `classifyPath()`：**全插件唯一的路径判定入口** |
| `docs/schema.js` | 字段表 + V1–V10 校验 |
| `docs/scan.js` | 扫描 + 读文件 + 建 metas |
| `docs/fingerprint.js` | 内容 hash（忽略 BOM 与换行差异） |
| `docs/marker.js` | 激活标记探测（T1 / T2 + 层数上限） |
| `core/scope.js` | `shouldActivate()`：**S1/S2 总闸门** |
| `core/index.js` | `buildIndex()`：required / forbidden / anomalies 划分 |
| `core/gate.js` | 门禁裁决（纯函数、同步） |
| `core/render.js` | 索引块渲染 + 按固定顺序裁剪 |
| `core/agentsMd.js` | 慢变量渲染 + 只覆盖标记块的合并 |
| `core/roles.js` | role 写策略 + 「仅追加」判定 |
| `adapters/registry.js` | 同步可读的内存注册表 + watch + 降级 + `onIndexChanged` 订阅（D1）+ 待补记读取（D3） |
| `adapters/probe.js` | 异步探测 / 同步 peek 的分离 |
| `adapters/guard.js` | `ctx.tools.guard()` |
| `adapters/observe.js` | `tools/result` 记账（read）+ 写后重扫（write/edit，D2） |
| `adapters/filter.js` | `tools/post-execute` 坟场过滤 |
| `adapters/inject.js` | `ctx.systemPrompt.context()` |
| `adapters/agentsmd-writer.js` | `AGENTS.md` 节流写入 |
| **`tools/define-tool.js`** | 属性表 DSL → 宿主可接受的原始 JSON Schema（**替代宿主的 `defineTool`**） |
| **`tools/when.js`** | 工具条件注册（`createToolGate`）+ **执行期 S2 兜底**（`assertToolAllowed`） |
| **`tools/doc-new.js`** | `doc_new`：建文档 + 记账 + rescan |
| **`tools/doc-mark.js`** | `doc_mark`：结构化改 frontmatter + **交接硬门禁** + 标记块 |
| **`tools/doc-handover-check.js`** | `doc_handover_check`：H1–H7 预检（只读） |
| **`tools/doc-health.js`** | `doc_health`：H-1–H-5（只读） |
| **`core/handover.js`** | 七段解析 + H1–H7（纯函数） |
| **`core/health.js`** | H-1–H-5 五项检查（纯函数） |
| **`core/budget.js`** | token 估算 + 【预算】行渲染（纯函数） |
| **`core/frontmatterEdit.js`** | 结构化改 frontmatter，**正文一个字节不动**（纯函数） |

> M1 新增的文件用**粗体**标出。`tools/` 与其它目录守同一条解耦纪律
> （`test/decoupling.test.js` 已扩展到覆盖 `tools/`）。

---

## 五处关键实现决定（都有实测依据，不是偏好）

1. **`interpolate: false`**：`dsh-system-prompt` 的 `renderPrompt` 对 `{{...}}` 做变量插值，
   **未知引用直接抛错**。索引块要渲染用户文档的 `summary`——`summary: 用 {{model}} 生成`
   这种完全可能存在。不关插值 = 某份文档让整个会话**每一轮都硬失败**。

2. **guard 内部判 `origin`，不是"不注册"**：`dsh-tools` 的 `checkGuards` 遍历
   `[guards.global, ...chainLayers(exec.agent)]`，`guard()` 注册的是**全局层**，
   子代理调用工具时照样会跑。**根本没有"不注册"这个选项**。

3. **坟场过滤改 `content` 不改 `value`**：`tools/post-execute` 的 accept 决策
   不能同时给 `content` 和 `value`（会 `TypeError`），且失败结果不能换 `value`。
   模型的文本来自 `content`，换它就够（`value` 残留见 L13）。

4. **写文件必须传 `sandboxPolicy`**（M1 实机踩到的）：`dsh-fs-sandbox` 的 `writeText` 是
   **按每次调用**围栏的。不传 policy 就用默认 workspace root（= 会话建立时的 cwd），
   于是「切进另一个 DDD 项目后 `doc_new`」会得到 `file access denied` —— 而那个路径**其实在工作区内**。
   宿主的 `write` 工具也是这么传的（`sandbox.resolvePolicy(...)` 后作为第 5 个参数）。

5. **`doc_new` 记账必须用注册表自己的路径**（M1 实机踩到的）：`registry.entryByPath()` 是
   **字符串全等**比较。自己拼的 `${root}/${rel.replaceAll('/','\\')}` 会得到
   `...\_m1-probe/docs\x.md`（**混用 `/` 与 `\`**），永远匹配不上扫描器给的全 `\` 路径 ——
   结果是 **`doc_new` 之后 `doc_mark` 永远报"没读过"，主流程完全走不通**。
   修法：用 `fs.resolve()` 的 `displayPath`，并在 `rescan` 之后**再用 `entryById` 的路径记一次**。

---

## 未实现（M1 之后）

**M1 已实现的**（下面这些不再是"未实现"）：
`doc_new` / `doc_mark` / `doc_handover_check` / `doc_health`、交接七段校验、
冷启动预算、结构化改状态、健康度自检。

**仍未实现**：

- **任何 UI**（右栏看板、图谱、交付网格、坟场归档动作）—— M2
- **交接触发的自动阈值**（占用 40%/55% 提醒）—— Q6 = C，M2
- **跨会话 `readSet`** —— **M1 有意不做**（理由见上文「为什么没有做跨会话 readSet」）
- **`doc_health` 的 UI 红点** —— M2
- **`amends` 字段** —— 没有任何验收能证伪它，加了只是字段膨胀
- **git 快照 / 回滚** —— Q8 = A，但 M1 不依赖它

> ⚠️ **不要因为"清单上还有"就顺手做。** 每一条都有它的归属切片或明确的"不做"理由。
# SPEC · 文档驱动开发插件 v1（M0 切片：索引与门禁）

> **状态**：**v1.1**，2026-11-11。**决策已全部拍板**（Q1–Q13 / R1–R5 / **S1–S2**），本文件是 M0 的施工图。
> **上游输入**：`文档驱动开发-架构评审与补充设计-v1.md`（v7）。本文件不重复论证，只写"要做什么、怎么验"。
> **切片边界**：M0 = 索引 + 门禁。**不做任何 UI**（client 半侧推迟到 M2）。
> **基线（本机实测，2026-11-11）**：DSH **`0.2.2-rc.1`**（不是旧文档写的 0.2.1）；Node **`24.21.0`**；工作区 `..\DDD插件施工\`（**尚未 git init**）。
> **参考实现**：两份都要看——
> - `...\Desktop\教练模式 插件\coach-mode-pack-v0.4.4\coach-mode-bundle`（**0.4.4**，171 单测全绿，代码最新；**已装回 profile，UI 里可用**）
> - `...\Documents\deepseek-harness\default-workspace\coach-mode-bundle`（**0.4.2**，149 单测 + 冒烟 ALL GOOD，**有冒烟脚本可参照**）
> 两者都是纯 host、零构建、零第三方依赖，可参照其**代码组织**；但**挂载方式不同**（见 §2.3 / §10）。

---

## 0. 一句话

**让模型在动 `docs/` 之前，必须先读过该读的文档；读没读由插件记账，不是提示词嘱咐。**

M0 结束时应该能回答一个问题：**"结构化索引 + 强制读取"能不能让 AI 真的按文档施工？**
如果这条不成立，后面所有 UI 都白做——所以先做这一条。

---

## 1. 目标与非目标

### 1.1 目标（六条，多一条都不要做）

| # | 目标 | 一句话验收 |
|---|---|---|
| M0-A | **目录布局落地** | `<项目>/{docs,deliverables,_artifacts}` + `docs/_graveyard/` 能被创建与识别，`projectRoot` 能自动探测 |
| M0-B | **frontmatter 可校验** | 缺字段 / 非法枚举 → 读取时明确报错，不静默通过 |
| M0-C | **索引进上下文** | 慢变量进 `AGENTS.md`，快变量进 `systemPrompt.context()`，**且不随轮次累积** |
| M0-D | **读取可记账** | 模型读一份 `docs/` 文档，插件记下 `{id, fingerprint, at}`，折叠成"已读集合" |
| M0-E | **门禁可拒绝** | 必读未读完就想改 `docs/` → 拒绝，理由列出缺哪几份 |
| M0-F | **坟场不可见** | `guard` 拦直读，`post-execute` 从 `glob`/`grep` 结果里剔除 |
| M0-G | **全局但按项目激活** | 挂载在 profile（**不是 preset**），所有模式的会话都能用；只在**带激活标记**的项目里生效；**子代理会话完全不加载** |

### 1.2 非目标（明确不做）

| 推迟项 | 归属 | 原因 |
|---|---|---|
| 任何 UI（右栏看板、图谱、交付物视图） | M2 | Q1 = B（约束器优先），client 半侧是换技术栈 |
| 坟场**归档动作**（用户勾选 / 移动 / 还原） | M2 | 需要 UI；M0 期手工建目录并放文件 |
| 交接（handover 模板、校验、演练） | M1 | 依赖索引与记账先跑通 |
| `doc_health()` 自检 | M1 | 同上 |
| 冷启动预算计算 | M1 | 同上 |
| 上下文占用提醒（40%/55%） | M2 | Q6 = C，纯客户端 |
| 交付物扫描与"未声明"标记 | M2 | 依赖 client |
| `doc_new` / `doc_mark` / `doc_handover_check` | M1 起 | Q13 = A，M0 一个新增工具都不加 |
| git 集成（快照、回滚） | 后续 | Q8 = A，但 M0 只需要用户自己在项目根 `git init` |
| 段落级 state 的写入工具 | M1 | frontmatter 里**可以手写** `sections`，M0 只读不写 |

### 1.3 判断标准

> 任何一条实现如果**不在上面六个目标里**，就属于范围蔓延，退回。

---

## 2. 决策台账（**冻结，不要重开**）

### 2.1 产品级（Q1–Q13）

| # | 决策 |
|---|---|
| **Q1 = B** | 定位是**施工约束器**，不是文档管理器。UI 只是看板 |
| **Q2 = A** | 复用 `dsh-agent-instructions`（L0 慢变量写成 `AGENTS.md`） |
| **Q3 = A** | 真源 = **frontmatter** |
| **Q4 = A** | 坟场在**同目录独立文件夹** + `guard` + `post-execute` 过滤（两个挂钩点缺一不可） |
| **Q5 = D** | 显式 `status` + 按 role 配置的 `verifiedAgainst` 锚点漂移检测。**无 TTL 自动降级** |
| **Q6 = C** | 交接触发是**纯 UI 提醒，不进模型上下文** |
| **Q7 = C** | UI 双注册（`sidebar.panellist` + `main`） |
| **Q8 = A** | 引入 git |
| **Q9 = B** | **保留 `write`/`edit`** + `guard` 拦截 + `tools/result` 记账。**不新增 `doc_update`** |
| **Q10 = A** | M0 验收用**教练模式项目做 dogfood** |
| **Q11 = C** | 项目根 + 四子目录（`docs/` + `docs/_graveyard/` + `deliverables/` + `_artifacts/`） |
| **Q12 = C** | 坟场：AI 只提议，UI 列出待归档，用户勾选后由插件移动 |
| **Q13 = A** | **只要能拦就不加工具**。独立工具上限 4 个（M0 用 0 个） |

### 2.2 落地细节（R1–R5）

| # | 决策 | 本 SPEC 的落点 |
|---|---|---|
| **R1** | 门禁**按路径拦**，不看工具名 | §7 |
| **R2** | `projectRoot` **自动探测为主，配置可覆盖** | §4.2 |
| **R3** | 索引**混用**：慢变量 `AGENTS.md` + 快变量 `context()` | §6 |
| **R4** | `_artifacts/` **永不自动删** | §13（M0 不实现清理，只写约束） |
| **R5** | 验收编号 **`M0-1` 起** | §12 |

### 2.3 形态与作用域（**S1 / S2，M0 新增拍板**）

> 这两条是 v1.1 新增的。**它们推翻了 v1.0 里"做成 preset"的隐含假设**——那是沿用教练模式形态、没充分论证。

| # | 决策 | 理由 |
|---|---|---|
| **S1** | **全局插件（profile 级 bundle），不做成 preset** | 插件管的对象是**项目**，不是**会话模式**。做成 preset 会把"项目属性"错绑到"会话属性"上，导致在标准/其它模式里完全失效——而文档驱动是跨模式的需求。**且 preset 形态的门禁可以被"切回标准模式"绕过**，那就退化成提示词 |
| **S2** | **子代理会话完全不加载** | 全局挂载会让 subagent 也生效：每个子代理都要付索引探测成本，还可能被门禁拦住而没法干活。判据见 §4.4 |

**为什么全局挂载的代价可以接受**：**M0 一个新增工具都不加**（Q13 = A）。
工具 schema 是每轮请求的固定 token 开销，也是全局挂载的主要成本。零工具 = 没有 schema 开销；
索引块在探测不到项目根时**返回空字符串**（§6.4）。**装载是全局的，生效是项目级的。**

> **M1 的连带要求**：一旦要加 `doc_new` 等工具，**必须**用 `ctx.tools.register(def, { when })`
> 做条件注册（`[实测]` dsh-tools README，附录 A17）——只在探测到项目根且非子代理的会话里可见。
> 否则工具会出现在所有人的所有会话里。

---

## 3. 已核实的机制事实（**不要重新论证**）

> 全部在本机 `app.asar` 提取源码/README + 实跑确认。标 `[实测]` 的是我亲自跑过的。

### 3.1 能用的

| 能力 | 落法 | 证据 |
|---|---|---|
| 每轮动态上下文 | `ctx.systemPrompt.context({ name, order, text: (c) => string })`；**text 必须同步** | `[实测]` coach-mode `inject.js:30` 在用；SPEC #3 明说异步 API 用不了 |
| 提示词段落（静态） | `ctx.systemPrompt.section({ name, order, text })` | `[实测]` 未用（会改系统提示词前缀） |
| 工具注册 | `ctx.tools.register(原始 ToolDefinition)`；**只校验 `output.schema`，完全不校验 `parameters`** | `[实测]` coach-mode R10 |
| 同步单调守卫 | `ctx.tools.guard((exec) => string \| undefined)`；返回字符串即拒绝，**后续监听器无法翻回允许** | `[实测]` coach-mode `guard.js` |
| 执行前拦截 | `tools/pre-execute`（waterfall，可允许/拒绝/询问）；**不允许改写参数** | `[实测]` dsh-tools README |
| 执行后改写 | `tools/post-execute`（可替换内容或值、附加上下文） | `[实测]` dsh-tools README |
| 结果观测 | `tools/result`（**仅观测**，冻结的最终结果） | `[实测]` dsh-tools README |
| 文件读 | `ctx.fs.resolve(path,{cwd})` → `ctx.fs.stat/listDir/readText(target)`；`stat` 不存在返回 `undefined` | `[实测]` coach-mode SPEC #4 |
| **文件监听** | `ctx.fs.watch(target, changed, signal)` → 返回异步关闭函数；**不支持监听的提供方直接拒绝，不轮询** | `[实测]` dsh-fs README:38 |
| **文件版本** | `FsVersion`（带品牌的不透明 id）；消费方**不得解析**，只有 `displayPath` 给模型/UI | `[实测]` dsh-fs README:83 |
| 文件移动 | `ctx.fs.moveFile`（锁两端，发布目标后删源） | `[实测]` dsh-fs README |
| 会话日志（同步） | `agent.session.snapshotEvents(from,to)`、`seq` | `[实测]` coach-mode SPEC #3 |
| 结构化落盘 | `output.presentationMeta(args,value)` → `tool/result.data.meta` | `[实测]` coach-mode D10 |
| 客户端可见投影 | `ctx.sessionProjections`；摘要键含 `contextPressure` | `[实测]` dsh-session-projection README |

### 3.2 不可用 / 会误导

| 坑 | 事实 |
|---|---|
| **第三方包一律解析不到** | `[实测]`（见 §3.3）→ **整包必须零第三方依赖** |
| profile 装的 bundle 不能 import 宿主包 | dsh 的包在 `app.asar` 内，不在 profile 任何祖先 `node_modules` 里 → **整行插件加载失败** |
| 服务可用 ≠ 模块可 import | `ctx.fs` 能调；`import '@deepseek-ai/dsh-tools'` 不行 |
| `tools/pre-execute` **不能改参数** | 有意为之（怕日志与执行失同步）。**"让 write 改道"是堵死的**，只能拒绝 |
| 一次 `read` 只有一份结果 | 记"读没读"用 `tools/result` 观测，不要指望 `read` 自己报文档 id |
| 宿主提示词变量随版本增删 | `{{cwd}}` 在 0.2.1 被删 → **每轮硬失败**。本包一个变量都不用 |

### 3.3 ⚠️ 零第三方依赖（本轮新增的硬约束）

**实测方法**：在一个模拟 bundle 真实位置（工作区外、无祖先 `node_modules`）的目录里 `import` 第三方包。

```
从 bundle 真实路径：  js-yaml → ERR_MODULE_NOT_FOUND
                     yaml    → ERR_MODULE_NOT_FOUND
                     zod     → ERR_MODULE_NOT_FOUND
从 profile 目录：      js-yaml → OK    yaml → OK    zod → OK
```

**根因**：ESM 从**真实路径**向上找 `node_modules`。bundle 若以 `link:` 装进 profile，真实路径在别处，沿途没有 `node_modules`；profile 自己的 `node_modules` 在**另一条路径**上，够不着。

**结论**：**运行时代码必须零第三方依赖**，只能用 Node 内置模块。
代价是：**frontmatter 得自己解析**（§5.1），不能 `import('js-yaml')`。

> **不要指望"装成 .tgz 就有依赖"**：那取决于安装形态（`link:` vs 复制进 `profile/node_modules`），
> 而 Q8/Q11 都倾向于用 `link:` 开发。**把正确性押在部署形态上是错的。**

---

## 4. 目录布局

### 4.1 磁盘结构（Q11 = C）

```
<workspace>/
  <项目>/                        ← 项目根（项目级，多会话共用）
    AGENTS.md                    ← 慢变量索引（M0-C 的产物之一）
    docs/                        ← 受管：有 frontmatter，进索引
      _graveyard/                ← 坟场：不扫描、不可读（§8）
    deliverables/                ← 交付成品（M0 只建目录，不实现视图）
    _artifacts/                  ← 过程产物（M0 只建目录）
```

**四条规则**：

| 目录 | 受管 | 进索引 | 可被 AI 写 | guard |
|---|---|---|---|---|
| `docs/` | ✅ | ✅ | ✅ | 按 role 查表（§7.3） |
| `docs/_graveyard/` | ❌ | ❌ | ❌ | **读也拒** |
| `deliverables/` | ❌ | ❌ | ✅ 直接产出 | 放行 |
| `_artifacts/` | ❌ | ❌ | ✅ | 放行 |

> **成品直接产出到 `deliverables/`，不要先产出再移动**——`present` 记录绝对路径，移动即失效。

### 4.2 `projectRoot` 探测（R2）

按顺序，**先命中者胜**：

1. 配置项 `projectRoot`（相对工作区的路径）——**显式指定优先**
2. 会话 cwd 及其祖先里，**带激活标记的最近目录**（标记定义见 §4.3）
3. 探不到 → **静默降级**：插件激活但所有功能 no-op（不报错、不弹窗、不影响正常工作）

> **注意：v1.0 这里写的是"含 `docs/` 的目录"，v1.1 改成了"带激活标记的目录"。**
> 理由见 §4.3——光有 `docs/` 太宽松，会误伤普通代码仓库。

**为什么是"静默降级"而不是"报错"**：这个插件会装在多个工作区。在没有 DDD 项目的目录里，
它不该有任何存在感——**报错会让用户以为坏了**。

### 4.3 激活标记（S1 的配套，**全局挂载的必需品**）

**问题**：全局挂载意味着 `guard` 作用于**所有会话**。如果只凭"有 `docs/` 目录"就启用，
那一个**普通代码仓库**里刚好有个 `docs/`（没有 frontmatter），模型去改它就会被拦——**不可接受的误伤**。

**标记定义**（满足任一即算 DDD 项目）：

| # | 标记 | 判定 |
|---|---|---|
| T1 | `<项目>/docs/` 下**至少有一份合法 frontmatter 的 `.md`** | 能解析出 `id` + `role` + `status` |
| T2 | `<项目>/AGENTS.md` 里含 `<!-- ddd:index` 标记 | 字符串包含即可 |

**判定时机**：插件激活时 + 每次会话 cwd 变化时 + `docs/` 目录有增删时（watch）。
**判定结果缓存**，失效时重算。

**没有任何标记 → 整个插件对该项目 no-op**：不注入索引、不挂 guard、不挂 filter。
**"装载全局、生效项目级"是这一节的全部要点。**

> **为什么不用"有个 `.ddd/` 空目录"当标记**：那需要用户手动创建，而 AGENTS.md 标记
> 是插件自己会写的（§6.5），`docs/` 下的合法 frontmatter 是用户填的。
> **两个标记都来自真实使用痕迹，不是"记得建个目录"的仪式。**

### 4.4 子代理排除（S2）

**判据**：`session.header.origin`（`[实测]` dsh-session README:32）

> `parentSession` 记录子代理的直接创建者；**历史普通 fork 可能仍在此字段保留来源，因此分类使用 `origin`**。

**规则**：

```
if (isSubagentSession(session)) → 整个插件对该会话 no-op
   不注入索引、不挂 guard、不挂 filter、不探测项目根
```

**为什么排除**：

1. **成本**：每个子代理都要付项目探测与索引扫描
2. **功能**：子代理通常只做一次局部任务，不需要"必读文档"纪律
3. **安全**：门禁会拦住子代理的正常写入，让它没法干活——**这是硬故障，不是体验问题**

**先例**：`dsh-workspace-changes` 就是"有工作目录且**不是子代理来源**的 Session 都会被记录；子代理 Session 不记录" `[实测]`。

> **待 M0 开工时复核**：`origin` 的确切取值（是 `'subagent'` 字符串还是结构化对象）以本机源码为准。
> 如果读不到 `origin`，**降级为"有 `parentSession` 且 `origin` 无法判定 → 视为子代理"**（保守排除，宁可少管）。

### 4.5 路径判定（唯一的判定函数）

所有逻辑都归到这一个函数，避免各处各写一套：

```
classifyPath(absPath) -> 
  | 'doc'          // <项目>/docs/**.md，不含 _graveyard
  | 'graveyard'    // <项目>/docs/_graveyard/**
  | 'deliverable'  // <项目>/deliverables/**
  | 'artifact'     // <项目>/_artifacts/**
  | 'agentsmd'     // <项目>/AGENTS.md
  | 'outside'      // 其它（含 src/、工作区外）
```

**实现要点**：
- 用 `path.relative(projectRoot, absPath)` 得出相对段，逐段比较，**不做字符串 `startsWith`**（否则 `docs-old/` 会被误判为 `docs/`）
- 路径分隔符统一成 `/` 再比较
- 大小写：Windows 上 `docs` 与 `DOCS` 视为同一目录（`path.resolve` 后比较，不额外小写化——避免制造新歧义）

---

## 5. 数据模型

### 5.1 frontmatter 最小子集（零依赖，自己解析）

**格式约束**：为了让解析器小到可以手写并单测，**只支持下面这些形态**。

```
---
id: spec-tier2
title: 档 2 施工图
role: spec
order: 20
status: authoritative
scope: ["tier2"]
supersedes: ["spec-tier1"]
summary: 档 2 的全部功能切片
basis: 实测
verifiedDsh: 0.2.1-rc.1
verifiedBundle: 0.4.2
sections: [{"anchor":"#7","status":"authoritative"},{"anchor":"#2","status":"superseded","supersededBy":"spec-tier1#13"}]
---
```

**语法规则**（这就是全部）：

| 形态 | 例子 | 解析方式 |
|---|---|---|
| 标量 | `title: 档 2 施工图` | 去引号，取字符串 |
| 数字 | `order: 20` | `Number()`，必须是有限数 |
| **流式 JSON** | `scope: ["tier2"]`、`sections: [{"anchor":"#7"}]` | `JSON.parse`（YAML flow 语法是 JSON 超集） |
| 裸词列表 | `scope: [tier2, tier1]` | JSON 失败时的兜底：按逗号切、去空白 |
| 空 / null | `note:` | `null` |

**显式不支持**（遇到就报 `DOC_FM_UNSUPPORTED`，不静默忽略）：

- 块式列表（`- item` 另起一行）
- 块式嵌套（缩进子键）
- 多行字符串（`|`、`>`）
- 锚点/别名（`&a`、`*a`）
- 注释（`#`）——**注意**：`anchor: "#7"` 里的 `#` 在引号内，不是注释。解析器只在**值的最外层**检查引号

> **为什么砍掉嵌套**：`verifiedAgainst` 拍平成 `verifiedDsh` / `verifiedBundle` / `verifiedCommit` 三个平键。
> 代价是字段名略啰嗦，收益是解析器从「需要缩进栈」降到「一行一个 `key: value`」——
> **在零依赖约束下，这个交换是划算的**。段落级状态 `sections` 用流式 JSON 表达，仍然可读。

**解析器规模预期**：≤ 120 行（含错误码）。必须有单测覆盖 §12 的 `M0-7`。

**序列化**：M0 只需要"读 + 校验"，**不需要回写 frontmatter**（那是 M1 的 `doc_mark`）。
但需要一个 `serializeFrontmatter(meta)` 给 `doc_new`/测试用——M0 可以先只做读，**在 README 里写明"回写未实现"**。

### 5.2 字段表

| 字段 | 类型 | 必填 | 谁写 | 说明 |
|---|---|---|---|---|
| `id` | string（kebab-case） | ✅ | 人/模型 | 全局唯一，**永不变** |
| `title` | string | ✅ | 人/模型 | |
| `role` | enum | ✅ | 人/模型 | 见 §5.3 |
| `order` | number | ✅ | 人/模型 | 阅读顺序，建议 10/20/30 留插值 |
| `status` | enum | ✅ | 人/模型 | 见 §5.3 |
| `summary` | string ≤80 字 | ✅ | 人/模型 | 索引渲染用 |
| `scope` | string[] | `partial` 必填 | 人/模型 | 适用切片 |
| `supersedes` | string[] | ❌ | 人/模型 | 我取代了谁 |
| `supersededBy` | string[] | `superseded` 必填 | 人/模型 | 谁取代了我 |
| `sections` | object[] | ❌ | 人/模型 | `[{anchor, status, supersededBy?}]` |
| `basis` | enum | ✅ | 人/模型 | `实测` / `推断` / `未验证` |
| `tokens` | number | ❌ | 人/模型 | 冷启动预算用（M1 消费） |
| `verifiedDsh` | string | ❌ | 人/模型 | 锚点：DSH 版本 |
| `verifiedBundle` | string | ❌ | 人/模型 | 锚点：插件版本 |
| `verifiedCommit` | string | ❌ | 人/模型 | 锚点：git commit 短 hash |
| `verifiedAt` | string（date） | ❌ | 人/模型 | 上次复核日期 |
| `fingerprint` | string（8 hex） | ❌ | **插件** | 内容 hash，自动维护（§6.3） |
| `lastWriter` | string（sessionId） | ❌ | **插件** | 自动维护 |

> **`lastWriter` / `fingerprint` 不写回文件**，只存在内存缓存与 `tool/result.data.meta` 里。
> 写回会让每次读都改文件，引发无谓的 mtime 抖动与 git dirty。

### 5.3 封闭枚举

**`role`（8 个）**：`index` / `spec` / `decision` / `evidence` / `log` / `handover` / `instruction` / `fact`

**`status`（6 个，互斥）**：

| status | 含义 | 可被 AI 执行 | 默认位置 |
|---|---|---|---|
| `authoritative` 🟢 | 当前有效 | ✅ | 工作区 |
| `partial` 🟡 | **只在 `scope` 内有效** | ✅（限 scope） | 工作区 |
| `superseded` ⚪ | 有明确取代者 | ❌ | 工作区（灰显） |
| `sealed` 🔴 | **原地封存**：有诱惑力但已被推翻，无替代者 | ❌ | **原地不动** |
| `void` ⚫ | 明确作废 | ❌ | 坟场 |
| `draft` 🔵 | 未定稿 | ❌ | 工作区 |

> **`superseded` ≠ `sealed`**：前者有替代品可直接跳过；后者**没有替代品，必须让读者知道"这里有个坑"**。
> 09/10/11 是 `sealed`——**扔进坟场反而危险**（可能被翻出来当有效文档）。

### 5.4 校验规则

| # | 规则 | 级别 |
|---|---|---|
| V1 | 必填字段缺失 | **error** |
| V2 | `role` / `status` / `basis` 不在枚举内 | **error** |
| V3 | `status: superseded` 但 `supersededBy` 为空 | **error** |
| V4 | `status: partial` 但 `scope` 为空 | **error** |
| V5 | `supersedes` / `supersededBy` 指向不存在的 `id` | **error** |
| V6 | `id` 重复 | **error** |
| V7 | `sections[].anchor` 在正文中找不到对应标题 | warn |
| V8 | `supersededBy` 未反填 | warn |
| V9 | `verifiedDsh`/`verifiedBundle`/`verifiedCommit` 与当前环境不符 | warn，**不自动改 `status`**（Q5） |
| V10 | `fingerprint` 与磁盘内容不符 | **不是错误**，插件自动重算 |

**error 的处理方式**（关键，别搞错）：

> **error 不阻塞读取，只阻塞"用它当依据"。**

理由：文档写坏了不应该让整个插件瘫掉；但也不能让坏的文档静默参与决策。
所以：读得到（模型能看见），进不了索引（不在必读清单里），并在索引块里出现一行
`【文档异常】decision-log: 缺少 role 字段`。

---

## 6. 索引（L0）—— 两条通道（R3）

### 6.1 分工

```
慢变量 → <项目>/AGENTS.md          （dsh-agent-instructions 自动注入，零代码）
  ├ 必读清单：id + 一句话 + status + tokens
  ├ 禁止清单：sealed 的 id + 原因
  └ 术语表

快变量 → ctx.systemPrompt.context()  （每请求重算，本快照取代上一份）
  ├ 当前切片 / 当前阶段
  ├ 已完成 / 剩余步数
  ├ 已读集合（读过哪几份、哪一版）
  └ 文档异常（V1–V6 的 error）
```

**判据**：**"这个月内会变吗？"不会 → `AGENTS.md`；会 → `context()`。**

**为什么必须分开**（`[实测]`）：`dsh-agent-instructions` 的注入是"持久 user 消息 + digest 变化才追加替换"。
索引一变就**多一条历史消息**，旧的在压缩前一直留着。把快变量放进去 = 每轮都在累积垃圾。

### 6.2 为什么慢变量不放 `persona.prefix`

教练模式把 8,400 字的静态人设放在 `persona.prefix`（系统提示词内，位置最优）。
**但文档驱动不能照抄**：

| | `persona.prefix` | `AGENTS.md` |
|---|---|---|
| 位置 | 系统提示词内 | 一条持久 user 消息 |
| 谁维护 | **插件作者**，随版本发 | **项目/用户**，运行时改 |
| 变化时 | 改前缀 → 缓存全失效 | 追加一条新消息 |

教练模式的慢变量是**作者写的、8400 字改了 84 次发版才动**；
文档驱动的必读清单是**项目自己的、加一份文档就变**。本质不同。

### 6.3 ⚠️ 同步约束与指纹缓存（本 SPEC 最容易被写错的一处）

**硬约束**：`systemPrompt.context()` 的 `text` 回调**必须同步**（`[实测]` coach-mode SPEC #3：
"systemPrompt 的 text 回调必须是同步的，异步 API 用不了"）。

**所以不能**在回调里 `await ctx.fs.stat()`。**必须在回调之外维护一份同步可读的缓存。**

```
[DocsRegistry]  ← 内存态，同步可读
  metas: Map<id, {meta, fingerprint, status, tokens, lastWriter}>
  readSet: Set<id>           // 本会话已读
  invalid: Map<id, string[]> // V1–V6 的 error

  数据来源（全部异步 / 事件驱动）：
  1. 首次激活：扫描 docs/**/*.md → 读文件 → 解析 frontmatter → 建 metas
  2. ctx.fs.watch(target, changed)  ← 每个受管文档一个监听；变化时重算该份的 fingerprint
  3. tools/result 事件           ← read/write/edit 命中 docs/ 时更新 readSet / fingerprint
  4. 定时兜底（可选）             ← watch 不可用时降级为"每次 tool/result 重扫受影响的文件"
```

**`ctx.fs.watch()` 是关键**（`[实测]` dsh-fs README:38）：

> `watch(target, changed, signal)` 报告单个文件或目录直接子项的失效通知。观察就绪后，
> 它返回调用方必须等待完成的异步关闭函数。**不支持监听的提供方直接拒绝，不使用轮询。**

**降级路径**：若 `watch` 被拒绝（提供方不支持），退化为"每次 `tools/result` 后重扫"——
`[实测]` 这正是 `dsh-agent-instructions` 的做法（"刷新由 touch 驱动，没有 watcher"）。
**两条路都要实现，watch 优先。**

> **更正我之前的一个说法**：我在评审文档里写过"不需要文件 watcher"。
> 那是在没确认 `systemPrompt.context()` 同步约束、也不知道 `ctx.fs.watch()` 存在时的判断。
> **现在改成：watch 优先，无 watch 则 touch 驱动。** 理由见上。

**监听数量**：`watch` 是**每个 target 一个**。文档量在 10~50 份量级，可以接受；
超过 `Config.maxWatchedDocs`（默认 100）时**停止 watch，整体退化为 touch 驱动**，并 warn 一次。

### 6.4 索引块渲染（快变量）

**纯函数，有单测**。目标长度 **≤ 800 字符**（比教练模式的 4000 小得多——它本质是清单）。

```
【文档驱动】切片：0.4.2 成本控制 ｜ 阶段：M0
【已读】spec-tier2(v3) handover-2.6(v1)              ← 3/5
【未读】decision-log  evidence-a15                   ← 必读但没读 → 门禁会拦
【文档异常】decision-log：缺少 role 字段
```

**渲染规则**：

1. **不出现时间戳、不出现本轮序号**——任何每轮都变的内容都不放（R3 的硬约束）
2. 「已读」只显示**本会话**读过的，跨会话不算
3. 版本号用 `fingerprint` 前 6 位，让模型能发现"我读的是旧版"
4. 没有计划/没探测到项目根时 **返回空字符串**（不注入任何东西）

**裁剪顺序**（超 `Config.maxIndexBlockChars`，默认 1200）：

| 顺序 | 裁什么 |
|---|---|
| 1 | 文档异常 → 只留条数 |
| 2 | 已读 → 只留 `3/5` |
| 3 | 未读 → 只留条数 |
| **永不裁** | 切片/阶段、**门禁状态**（"你还没读完，改 docs/ 会被拒绝"） |

### 6.5 `AGENTS.md` 的生成（慢变量）

**只在成员或状态变化时重写**，不是每次请求。触发：

- 插件激活后首次扫描完成
- 有文档新增 / 删除 / `status` 变化
- 用户在 UI 上手动"刷新索引"（M2）

**结构**（下面是写进 `AGENTS.md` 的**文件内容**，所以标题从 `##` 起——它不是本 SPEC 的章节）：

~~~markdown
<!-- ddd:index v1 · 自动生成，请勿手改 -->
## 本项目是文档驱动开发（DDD）项目

改 `docs/` 下的文档前，必须先读过它。

### 必读（施工前必须读完）
- `spec-tier2` · 档 2 施工图 · 🟢 ✅ · 12.4k tokens
- `handover-2.6` · 当前交接 · 🟢 ✅ · 6.1k

### 禁止执行（sealed：内容有诱惑力但已被推翻）
- `phase-1-spec` · 🔴 不要执行：它要求"只输出 SPEC.md"，而 SPEC 已存在

### 术语
- **切片** = 「档」；**阶段** = 一次性流程环节
<!-- ddd:index end -->
~~~

**两条硬要求**：

1. **只写慢变量**。任何随会话变化的内容都不能进来（否则违反 §6.1）
2. **文件头必须有 `<!-- ddd:index -->` 标记**，且**只覆盖这个标记块**——
   用户手写的其它内容（自己的 AGENTS.md 规则）**不能被冲掉**。
   实现：读现有 `AGENTS.md` → 用正则切出标记块 → 替换块内容 → 写回。没有标记块则**追加**到文件末尾。

> `dsh-agent-instructions` 自己是"内容变了就追加一条新消息"，所以**我们越少改这个文件越好**。
> 把"节流"写进实现：距上次写入 < `Config.agentsMdMinWriteMs`（默认 5000）时**合并**，不立即写。

---

## 7. 门禁（R1：按路径拦）

### 7.1 规则

**只看目标路径，不看工具名。**

```js
// 伪代码，最终实现是 guard.js
function gate(exec) {
  const path = firstPathArg(exec.arguments)   // 见 §7.2
  if (path === undefined) return undefined     // 没有路径参数 → 放行
  const kind = classifyPath(resolve(path))
  if (kind !== 'doc') return undefined         // 非 docs/ → 放行（R1 的核心）

  const id = idOf(path)
  if (id === undefined) return '这是一份没有 frontmatter 的 docs/ 文档，先补 frontmatter 再改'
  if (readSet.has(id)) return undefined        // 读过 → 放行

  return `改 \`${id}\` 之前必须先读它（用 read 工具）。` +
         `本会话还缺：${[...requiredNotRead()].join('、')}`
}
```

### 7.2 哪些工具会被拦 / 怎么取路径

| 工具 | 路径参数 | 是否拦 |
|---|---|---|
| `write` | `file_path` | ✅ 命中 `docs/` 则拦 |
| `edit` | `file_path` | ✅ |
| `str_replace_editor` | `path`（`command: view` 除外） | ✅ |
| `apply_patch` | 无单一路径（补丁文本） | ⚠️ 见下 |
| `read` | `file_path` | ❌ 永不拦（读是放行条件本身） |
| `pwsh` / `bash` | 无 | ❌ **拦不住**（§13 已知限制） |
| `present` | `files[].path` | ❌ 放行（交付物不在 docs/） |

**`apply_patch` 的特殊处理**：参数是补丁文本，需要从中抽出 `*** Update File:` / `*** Add File:` 等行。
M0 用**保守策略**：能抽出目标路径且全部命中 `docs/` 才拦；**抽不出或解析失败 → 放行并 warn 一次**。
（理由：误拦会阻断正常施工，误放只是漏一次门禁——而 §13 已承认门禁不是全覆盖。）

### 7.3 按 role 的写权限（M0 只做最小集）

| role | `write` | `edit` |
|---|---|---|
| `spec` | 放行（覆盖需先读） | 放行 |
| `decision` | **拒绝** | 放行（仅追加） |
| `evidence` | **拒绝** | **拒绝** |
| `handover` | **拒绝** | **拒绝** |
| `instruction` | 拒绝（除非 `status: draft`） | 拒绝 |
| `log` | 放行 | 放行 |
| `index` / `fact` | 放行 | 放行 |

> **"仅追加"的判定**（`decision`）：`edit` 的 `old_string` 必须匹配文件**末尾 200 字符内**，
> 且 `new_string` 中包含 `old_string`（即纯追加，不删改）。实现放在 `guard.js`，
> 用 `readSet` 里缓存的文本做检查——**不额外读盘**（避免在同步 guard 里做 IO）。
> 拿不到缓存文本时降级为放行并 warn。

### 7.4 拒绝文案的三条要求

1. **说清缺什么**：列出 `requiredNotRead()` 的 id，不只说"未读完"
2. **给出下一步**：明确"用 read 工具读它"
3. **不指责**：不写"你违反了规则"

---

## 8. 坟场隔离（Q4 = A）

**两个挂钩点，缺一不可。**

### 8.1 `guard`：拦直接读写

```
classifyPath(path) === 'graveyard'
  → 一律拒绝，包括 read
  → 文案：「_graveyard/ 是归档区，不参与施工。需要恢复请用 UI 的「还原」。」
```

**为什么连 `read` 也拒**：坟场里的文档是"已被判定失效"的。让模型读到它，
等于给了它一个**可能被误用的旧结论**——这正是示例里 09/10/11 的问题。
（用户自己要看，用文件管理器或 M2 的 UI。）

### 8.2 `tools/post-execute`：从枚举结果里剔除

`guard` 拦不住枚举——`glob docs/**/*.md` 的参数里没有坟场路径，**但结果里有**。

```
post-execute 监听 glob / grep / listDir 类结果：
  遍历结果里的每条路径 → classifyPath === 'graveyard' → 剔除
  全部被剔除时 → 返回 "（没有匹配的文件）" 而不是空数组
```

**结果形态的兼容**：`glob` 返回路径数组，`grep` 返回带 `path` 字段的条目。
实现要**两种都认**（有 `path` 字段用字段，否则把字符串当路径），并**保留原始形状**回写。

**拒绝不了的情形**（写进已知限制）：`pwsh` 里的 `Get-ChildItem` / `cat`。

---

## 9. 读取记账（M0-D）

### 9.1 采集

监听 `tools/result`：

```
if (event.name !== 'read') return
const p = event.arguments?.file_path
const kind = classifyPath(p)
if (kind !== 'doc') return                  // 只记 docs/，不记 graveyard/outside
if (event.isError) return                   // 失败不算读过

id = idOf(p)
readSet.set(id, { fingerprint: currentFingerprint(id), at: event.seq })
```

**关键点**：

1. **不用 `presentationMeta`**——那是给自己注册的工具用的；`read` 是宿主的，只能用事件观测。
2. **`isError` 要排除**：读失败（文件不存在、不是普通文件）不算"读过"。
3. **`at` 用 `seq`**，不用时间戳（与 coach-mode 一致，可回放）。

### 9.2 折叠与持久

`readSet` 是**内存态**（M0）。会话恢复后会被重置，模型需要重读——
**这是可接受的**，而且与 `fs-observation-policy` 的已知限制一致
（"会话恢复后不携带任何已观察状态，因此必须重新读取"）。

> **M1 可考虑**：从会话日志 `snapshotEvents()` 折叠出 `readSet`，实现跨恢复保持。
> M0 不做，因为它需要处理"读的是旧版"的失效逻辑，属于 M1 的交接语义。

### 9.3 「已读」的失效

`readSet` 里存的是 **`fingerprint`**，不是布尔值。判定"读过"时：

```
if (readSet.get(id)?.fingerprint !== currentFingerprint(id))
    → 视为未读，理由："你读过的是 v3，磁盘已是 v5"
```

这正是 `fs-observation-policy` 的 `FS_STALE_VERSION` 语义 `[实测]`，
只是把"版本"换成"指纹"，且**不依赖那个默认关闭的策略插件**。

---

## 10. 模块划分与挂载方式（S1）

### 10.0 怎么挂：**profile 级 bundle，不是 preset**

**`cordis.patch.yml` 只 insert 一行插件，不创建 preset。**

```yaml
# ddd-bundle/cordis.patch.yml —— 全局挂载（S1）
- insert:
    - id: ddd-engine
      name: '@local/ddd'
```

**对照教练模式**（它的 `cordis.patch.yml` 是 `insert → @deepseek-ai/dsh-agent-preset`，
在 `config.plugins` 里挂一堆工具行）。**我们不要那个结构。**

| | 教练模式（preset） | 本插件（全局） |
|---|---|---|
| 挂在哪 | preset 的 `plugins` 列表 | profile 的 bundle 层（`insert` 一行） |
| 谁会加载 | 只有选了「教练模式」的会话 | **所有会话** |
| 工具目录 | 由 preset 决定（可以裁） | 沿用该会话原本的 preset |
| 人设 | preset 的 persona 行 | **不提供**（M0 不需要） |
| 生效条件 | 选了模式就生效 | **探测到激活标记才生效**（§4.3） |

**为什么不做 preset**（S1 的完整理由）：

1. **管的对象是项目不是模式**。`docs/` 存不存在、必读清单是什么，与用户在用什么模式无关。
2. **覆盖会变小**。标准模式下的会话看不到它，等于日常干活时它不存在。
3. **门禁可被绕过**。切回标准模式就没了——**能靠换模式逃掉的约束，本质上还是提示词**。

**代价与对冲**：

| 代价 | 对冲 |
|---|---|
| guard 作用于所有会话 | §4.3 激活标记：没有标记 → no-op |
| 子代理也加载 | §4.4：`origin` 判定，子代理完全 no-op |
| 索引块每轮进请求 | §6.4：探测不到项目根时返回 `''`；≤800 字符 |
| M1 加工具会污染所有会话 | §2.3 末尾：必须用 `register(def, { when })` 条件注册 |

### 10.1 目录结构

```
ddd/
  package.json              "type":"module"；dsh.bundle.patch → cordis.patch.yml
  cordis.patch.yml          **insert 一行 @local/ddd**（不是 preset！）
  index.js                  apply(ctx, config)：装配所有适配层 + 激活判定
  config.js                 resolveConfig()（手写归一化，不导出 Config）

  docs/                     ★ 文档域（纯逻辑 + 少量 IO）
    frontmatter.js          零依赖解析/序列化（§5.1）
    schema.js              字段表 + V1–V10 校验（纯函数）
    path.js                 classifyPath（纯函数，唯一判定入口）
    scan.js                 扫描 + 读文件 + 建 metas（IO，异步）
    fingerprint.js          内容 hash（node:crypto）
    marker.js               激活标记探测（§4.3，纯逻辑 + IO）

  core/                     ★ 纯核心：零 IO / 零时间 / 零随机 / 零 Node 内置模块
    index.js                buildIndex(metas) → {required, forbidden, anomalies}
    gate.js                 decideGate({kind, id, readSet, metas}) → string|undefined
    render.js               renderIndexBlock(state) → string（§6.4）
    agentsMd.js             renderAgentsMd(index) → string（§6.5）
    roles.js                ROLE_WRITE_POLICY 表 + "仅追加"判定（纯函数）
    scope.js                shouldActivate({hasMarker, isSubagent}) → boolean（§4.3/§4.4）

  adapters/                 ★ 唯一允许接触 DSH 服务的地方
    registry.js             DocsRegistry：内存态 + watch + 降级（§6.3）
    guard.js                ctx.tools.guard（**未激活时直接 return undefined**）
    observe.js              tools/result 记账
    filter.js               tools/post-execute 坟场过滤（**未激活时直接放行**）
    agentsmd-writer.js      节流写 AGENTS.md
    inject.js               ctx.systemPrompt.context（**未激活时返回 ''**）

  test/                     零依赖单测
  README.md
```

> **`core/scope.js` 是 S1 的核心**：它把"要不要干活"收成一个纯函数，
> 所有 adapters 在入口处问它一次。**这样"全局挂载"不会变成"全局生效"。**

### 10.2 硬约束（`test/decoupling.test.js` 强制）

1. **整包禁止 `import '@deepseek-ai/*'`**（R9 的延续）
2. **整包禁止任何第三方包 import**（§3.3）——只允许 `node:` 前缀的内置模块
3. **`core/` 下额外禁止**：`node:*`、`Date`、`Math.random`、文件 IO
4. **`core/` 的 import 只允许 `./xxx.js`**
5. **`cordis.patch.yml` 里不得出现 `@deepseek-ai/dsh-agent-preset`**（S1 的静态检查——防止有人手滑改回 preset）

### 10.3 分层依赖方向

```
index.js → adapters/ → docs/ + core/
                ↓
             core/  （不反向依赖任何东西）
```

---

## 11. 配置

`config.js` 手写归一化（不导出 `Config`，避免 `schemastery` 依赖——coach-mode R11 的教训）：

| 键 | 默认 | 说明 |
|---|---|---|
| `projectRoot` | `''` | 空 = 自动探测（§4.2） |
| `docsDir` | `docs` | 相对项目根 |
| `graveyardDir` | `docs/_graveyard` | 相对项目根 |
| `deliverablesDir` | `deliverables` | 相对项目根 |
| `artifactsDir` | `_artifacts` | 相对项目根 |
| `agentsMdName` | `AGENTS.md` | |
| `maxIndexBlockChars` | `1200` | 快变量块预算 |
| `maxWatchedDocs` | `100` | 超过则整体退化为 touch 驱动 |
| `agentsMdMinWriteMs` | `5000` | 写 `AGENTS.md` 的节流窗口 |
| `gateEnabled` | `true` | 一键关掉门禁（调试用） |
| `graveyardFilterEnabled` | `true` | 一键关掉坟场过滤 |
| **`requireMarker`** | **`true`** | **S1 配套**：必须有激活标记才生效。设 `false` = 只凭 `docs/` 目录就激活（**危险，仅调试用**） |
| **`excludeSubagents`** | **`true`** | **S2 配套**：子代理会话不加载。设 `false` 会让子代理也被门禁拦住（**不建议**） |
| **`markerProbeDepth`** | `8` | 向上探测项目根的层数上限，防止在深目录里扫到盘根 |

**归一化规则**（全部静默回落默认值，不抛）：

- 非字符串 → 默认
- 负数 / 非有限数 → 默认
- 布尔非 `true`/`false` → 默认

---

## 12. 测试与验收

### 12.1 单测（零依赖，`node --test --test-isolation=none`）

| 文件 | 覆盖 |
|---|---|
| `frontmatter.test.js` | §5.1 的每种形态；不支持形态报 `DOC_FM_UNSUPPORTED`；`#` 在引号内不误判为注释；BOM 开头 |
| `schema.test.js` | V1–V10 每条正反例；V9 只 warn 不改 status |
| `path.test.js` | `docs-old/` 不误判；`DOCS/` 大小写；`docs/_graveyard/x.md` → graveyard；工作区外 → outside；`..` 逃逸 |
| `index.test.js` | buildIndex 的 required/forbidden/anomalies 划分 |
| `gate.test.js` | 无路径参数放行；非 docs 放行；未读拒绝且文案含缺项 id；读过放行；**指纹变了视为未读** |
| `render.test.js` | ≤800 字符；无时间戳/轮次；裁剪顺序；未探测到项目根返回 `''` |
| `agentsMd.test.js` | 只覆盖标记块；无标记块时追加；用户内容不被冲掉 |
| `roles.test.js` | 六个 role 的 write/edit 策略；"仅追加"判定的三种边界 |
| `scope.test.js` | **S1/S2**：`shouldActivate` 四象限（有/无标记 × 是/否子代理）；无标记 → false；子代理 → false 即使有标记 |
| `marker.test.js` | T1（合法 frontmatter）命中；T2（AGENTS.md 标记）命中；只有空 `docs/` → **不命中**；`markerProbeDepth` 上限 |
| `decoupling.test.js` | §10.2 五条硬约束（含"`cordis.patch.yml` 不得出现 `dsh-agent-preset`"） |

**预期规模**：约 70–85 条。

### 12.2 装配冒烟（`_ref\smoke-ddd.mjs`，零宿主依赖）

用假 `ctx` 装配一遍，验证不 import 宿主也能跑。

### 12.3 实机验收（`M0-1` ~ `M0-14`，R5 编号）

| # | 场景 | 判据 |
|---|---|---|
| **M0-1** | 新会话第一轮 | 索引块出现正确的必读清单（id + 状态 + 指纹）；`AGENTS.md` 里**没有快变量** |
| **M0-2** | 未读必读文档就改 `docs/x.md` | 被 `guard` 拒绝；理由**列出缺哪几份 id** |
| **M0-3** | 未读必读文档就改 `src/x.js` | **放行**（R1 的反向验证，证明没误伤） |
| **M0-4** | `glob docs/**/*.md` | 结果里**没有** `_graveyard/` 下的文件 |
| **M0-5** | 连续 10 轮对话 | 会话历史里**只有一条**索引消息，不随轮次累积 |
| **M0-6** | `read` 一份 `docs/` 文档后改它 | 放行，且 `tool/result` 里能查到记账 |

**补充用例（同样编号体系）**：

| # | 场景 | 判据 |
|---|---|---|
| **M0-7** | 造一份缺 `role` 的文档 | 读得到，但**不在必读清单**里；索引块出现【文档异常】 |
| **M0-8** | 改一份已读文档（外部编辑器改），再让模型改它 | 拒绝，理由指出"你读的是 v3，磁盘是 v5" |
| **M0-9** | 在没有 `docs/` 的工作区激活 | 插件加载成功，**不报错**，索引块为空 |
| **M0-10** | `status: sealed` 的文档 | 出现在**禁止清单**，不在必读清单；不在坟场 |
| **M0-11** | **在标准模式**（非 DDD preset）的新会话里打开 DDD 项目 | 索引块**照常出现**，门禁**照常生效**——这是 S1 的核心验收 |
| **M0-12** | 一个**普通代码仓库**（有 `docs/` 但全部无 frontmatter、无 `AGENTS.md` 标记） | **完全不生效**：改它的 `docs/` 文件**不被拦**，索引块为空（S1 的误伤防护） |
| **M0-13** | 让主会话派一个 **subagent** 去改 `docs/` | **2026-11-12 起判据已修订（M1.5 / N9，用户授权 `P14`）**：子代理会话**不注入索引、不记 readSet**，但**写 `docs/` 必须拒绝**（文案要求「交回父会话」）、**写 `src/` 等非 `docs/` 路径照常放行**；父会话照常。<br>**旧判据**（「子代理不拦写入」）已作废——见 `M0-验收报告.md` §M0-13 的修订说明 |
| **M0-14** | `cordis.patch.yml` 静态检查 | 全文不含 `@deepseek-ai/dsh-agent-preset`；`plugin_manager` 里本插件**不出现在任何 preset 的 plugins 列表** |

### 12.4 验收方式

- 每条附**会话 id + 事件 `seq`**，不接受"应该可以"
- 安装验收：`plugin_manager list_bundles` 可见；`application: applied`
- **不重启不算数**：改 JS 后必须重启 DSH 才加载新模块代

### 12.5 dogfood（Q10 = A）

用 `C:\Users\slimeball\Desktop\AI相关文档\文档驱动示例文档\` 的 15 份文档做一个 DDD 项目：

1. 复制进 `<项目>/docs/`，按 §5.1 补 frontmatter
2. **故意保留** 09/10/11 的 `sealed` 状态（这是最好的 sealed 测试集）
3. 跑 M0-1 ~ M0-10
4. 记录：15 份文档里几份通过校验、几份报错——**报错的是真实的文档质量问题，不是 bug**

---

## 13. 风险与已知限制（**要写进 README**）

| # | 限制 | 影响 / 处置 |
|---|---|---|
| L1 | **门禁能被 `pwsh` 绕过** | `pwsh -Command "Set-Content docs/x.md ..."` 不经过 `guard`。**不假装堵住了**——与 coach-mode 对 `pwsh` 的处置一致 |
| L2 | **`apply_patch` 只能保守拦截** | 解析失败就放行并 warn。§7.2 |
| L3 | **`readSet` 不跨会话恢复** | M0 内存态。会话恢复后需重读 |
| L4 | **frontmatter 不支持块式嵌套** | §5.1。报 `DOC_FM_UNSUPPORTED`，不静默忽略 |
| L5 | **`AGENTS.md` 可能被用户手改** | 只覆盖 `<!-- ddd:index -->` 标记块；无标记时追加 |
| L6 | **watch 不可用时降级** | 退化为 touch 驱动，指纹可能短暂过期。warn 一次 |
| L7 | **无 UI** | 坟场归档、占用提醒、图谱全部 M2 |
| L8 | **不校验文档内容质量** | 只校验元数据。写得烂的文档照样进索引 |
| L9 | **`_artifacts/` 无限增长** | R4：永不自动删。M0 不做清理 |
| L10 | **全局挂载 = 每个会话都要判定激活** | 判定结果缓存；无标记时只付一次探测成本，之后 no-op。**但如果 `requireMarker: false`（调试），影响面就是全部会话** |
| L11 | **激活标记可能误判** | 一个普通仓库如果**恰好**有带 frontmatter 的 `docs/`（比如引用别人的文档），会被当成 DDD 项目。处置：拒绝文案说明"这是 DDD 项目的门禁"，用户可加 `<!-- ddd:ignore -->` 否掉（M0 可先不做，记着） |
| L12 | **子代理判定依赖 `origin`** | 若 `origin` 读不到，保守按"有 `parentSession` 即子代理"处理——**可能误伤被 fork 的普通会话**（它们将失去门禁保护，但不影响正常干活） |

---

## 14. 交付物清单

- [ ] `package.json`（`dsh.bundle.patch` + `"type":"module"`，**无 BOM**）
- [ ] `cordis.patch.yml`（**insert 一行 `@local/ddd`，不是 preset**）
- [ ] `index.js` / `config.js`
- [ ] `docs/`：`frontmatter.js` / `schema.js` / `path.js` / `scan.js` / `fingerprint.js` / `marker.js`
- [ ] `core/`：`index.js` / `gate.js` / `render.js` / `agentsMd.js` / `roles.js` / `scope.js`
- [ ] `adapters/`：`registry.js` / `guard.js` / `observe.js` / `filter.js` / `agentsmd-writer.js` / `inject.js`
- [ ] `test/`：11 个文件，约 70–85 条
- [ ] `README.md`（含 §13 的已知限制 + **全局挂载说明 + 激活标记说明** + 零依赖说明 + 测试命令）
- [ ] `_ref\smoke-ddd.mjs`（装配冒烟）
- [ ] 验收报告：`M0-1` ~ `M0-14`，附会话 id + `seq`
- [ ] `_backup-m0-<日期>\`（动手前先备份）

---

## 15. 开工顺序（建议）

1. **先跑 coach-mode 的单测 + 冒烟**，确认基线绿（它是参考实现，环境坏了会误导）：
   ```powershell
   $node='C:\Users\slimeball\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
   # 0.4.2 那份（有冒烟脚本）
   cd C:\Users\slimeball\Documents\deepseek-harness\default-workspace\coach-mode-bundle
   & $node --test --test-isolation=none          # 期望 149/149
   & $node ..\_ref\smoke-coach.mjs               # 期望 ALL GOOD
   # 0.4.4 那份（代码更新）
   cd "C:\Users\slimeball\Desktop\教练模式 插件\coach-mode-pack-v0.4.4\coach-mode-bundle"
   & $node --test --test-isolation=none          # 期望 171/171
   ```
2. **`docs/frontmatter.js` + 单测**——零依赖解析是最大的不确定项，先啃它
3. `docs/path.js` + `docs/schema.js`（纯函数，迭代快）
4. **`core/scope.js` + 单测**——S1/S2 的判定，**先于任何 adapter**：它决定"要不要干活"，
   写反了会让整个插件在错误的地方生效
5. `core/` 其余五个文件 + 单测（纯函数，最舒服的一段）
6. `docs/marker.js` + 单测——激活标记探测（§4.3）
7. `adapters/registry.js`（watch + 降级，最复杂）
8. 其余 adapters（薄，几十行）
9. 冒烟 → 安装（**profile 级，不是 preset**）→ 重启 → M0-1 ~ M0-14

> **每个模块写完就跑单测。** `core/` 是纯函数，`--test-isolation=none` 迭代极快，别攒着。
>
> **`scope.js` 排第 4 步是刻意的**：它是"全局挂载但不全局生效"的闸门。
> 这个东西写错了，M0-12（普通仓库被误伤）和 M0-13（子代理被拦）会一起失败，
> 而且是在你以为是别的问题的时候。

---

## 16. 三条最容易犯的错（从 coach-mode 继承的教训）

1. **造出"只能干聊"的死角**。M0 没有状态机，所以没有这个风险——但如果将来加，
   先问："入口是什么？出口是什么？模型不配合会不会卡死？"
2. **把"强制"写成提示词**。门禁必须是 `guard` 里的 `if`，不是人设里的嘱咐。
3. **宿主工具定义里出现 `undefined`**。`coach_back` 曾漏写 `description`，导致
   `request/header` 写盘失败、整轮硬失败。**M0 虽然不加工具，但改 `cordis.patch.yml` 时同理**：
   改完跑 `node --check` **不够**，要跑单测 + 冒烟。

# DDD · 文档驱动开发插件（DeepSeek-Harness）

> **让 AI 在动手改项目文档之前，必须先读过该读的文档。**
> 「读没读」由插件**记账并强制**，不是靠提示词嘱咐。

**版本**：v1.1.0 ｜ **平台**：DeepSeek-Harness（桌面端 / Web 端）｜ **许可证**：MIT

---

## 这个插件解决什么问题

AI 做长任务时，上下文会衰减。传统做法是"让 AI 自己记住"，但它会忘。

这个插件的办法是：**把工程状态外置成文档，每轮只注入一个索引块，并用代码强制 AI 先读后改。**

### 为什么必须是代码，不能是提示词

上一代方案（纯提示词，同样是文档驱动开发）的实测数据：

> 第二轮共 5 个会话，工具调用总计 **5 次**，其中**真正核查用户机器的只有 1 次**。

⇒ **门禁必须是代码里的 `if`，不是提示词嘱咐。**

---

## 快速开始

### 1. 安装

把本仓库的 `plugin/` 目录链接（或复制）到 DSH 的 profile 插件目录：

```
<DSH_HOME>/profiles/<profile>/node_modules/@local/ddd  →  <本仓库>/plugin
```

Windows 上可以用 junction：

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@local\ddd" `
  -Target "<本仓库>\plugin"
```

然后在 profile 的 `cordis.yml` 里启用 `@local/ddd`，重启 DSH。

### 2. 安装技能手册（**必做**，否则 AI 不知道工序）

```
<DSH_HOME>/skills/ddd-workflow/SKILL.md  ←  本仓库的 skill/ddd-workflow/SKILL.md
```

⚠️ **手册不在插件目录里**，它是给 AI 看的"工作手册"。不装它，AI 会用猜的。

### 3. 把某个目录变成 DDD 工作区

插件是**全局挂载、按项目激活**的 —— 装了它不会让所有项目都被管。

在 DSH 的 DDD 面板里点「**初始化为 DDD 工作区**」按钮。它会建出：

```
<你的项目>/
├── docs/               ← 受管文档（必须有合法 frontmatter）
│   └── _graveyard/     ← 坟场（被作废的文档）
├── deliverables/       ← 交付成品
└── _artifacts/         ← 过程产物（门禁完全不拦）
```

没有这个标记，插件对那个目录**完全不生效**（no-op）。

### 4. 开始用

对 AI 说人话就行：

> 用 ddd 建一份 spec，里面写清楚这个模块要做什么

AI 会自己去读入口索引、建文档、维护阅读顺序。你不需要记任何工具名。

---

## 日常怎么用（四个动作）

| 你想做的事 | 对 AI 说 | 它实际做的 |
|---|---|---|
| 建一份文档 | 「建一份 spec / 决策 / 指令」 | `doc_new`（自动生成合法 frontmatter） |
| 定稿 / 作废 | 「把它标成权威 / 作废」 | `doc_mark`（只改 frontmatter 状态） |
| 归档 | 「把这个归档」 | `doc_mark` 标 `void`，**然后由你在界面「归档」页签点**才真正搬文件 |
| 交付 | 「交付这个」 | 复制文件到 `deliverables/`（没有"交付工具"，就是复制） |
| 改阅读顺序 | 「把这份文档提前读」 | `edit` 改 frontmatter 的 `order`；入口索引的「必读清单」成员**由插件自动同步**（M3） |
| 交接给下一个会话 | 「进行交接流程」 | 写七段交接文档 + 写索引的「为什么读 / 下一步 / 陷阱 / 依据」 |

### 界面上有什么

| 区域 | 内容 |
|---|---|
| **右栏底部** | AI 阅读顺序条：`0/3` 表示还有几份必读没读；✓ 表示 AI 已读完 |
| **主栏 · 图谱** | 文档之间的引用关系 |
| **主栏 · 交付** | `deliverables/` 里的成品 |
| **主栏 · 归档** | 待归档清单（AI 标了 `void` 的）+ 坟场（可还原） |

---

## 它怎么运作（四个环节）

```
① adapters/probe.js      判断这个目录是不是 DDD 项目（找激活标记）
② docs/scan.js + registry   扫描 docs/，建注册表（内存缓存）
③ adapters/inject.js     每轮往系统提示词里注入一个「索引块」
④ adapters/guard.js → ctx.tools.guard()   真正拦 write/edit 的 if
⑤ core/requiredList.js   按 frontmatter 自动重渲染入口索引的「必读清单」（M3）
```

「读没读」记在 `readSet`（**会话级、内存里的 WeakMap**），不落盘。
`edit` 成功 → 指纹变 → 该文档立刻变回"未读"。

### 四个工具（只有这四个）

| 工具 | 干什么 |
|---|---|
| `doc_new` | 新建受管文档，自动生成 frontmatter |
| `doc_mark` | 只改 frontmatter 状态（`status` / `basis` / 段落级） |
| `doc_handover_check` | 校验交接七段（H1–H7 + H11） |
| `doc_health` | 5 项健康度检查（H-1 ~ H-6） |

**改正文用 `edit` / `write`，不用 `doc_mark`。**

---

## 三条铁律

| # | 铁律 | 为什么 |
|---|---|---|
| **1** | 门禁必须是代码里的 `if`，不是提示词嘱咐 | 纯提示词方案实测失效（5 会话 1 次核查） |
| **2** | 插件全局挂载，但作用域是项目 | 装了插件不该让所有项目都被管 |
| **3** | 冻结决策要用户授权才能动 | 见 `docs/架构评审与补充设计-v1.md` §6 |

---

## 仓库结构

```
.
├── README.md                 ← 你正在读的这份（使用方式优先）
├── LICENSE
├── CHANGELOG.md
├── plugin/                   ← 插件本体（可安装的那部分）
│   ├── index.js              ← 插件入口：注入 + 门禁 + 记账 + 坟场过滤
│   ├── config.js             ← 配置解析
│   ├── cordis.patch.yml      ← bundle 声明
│   ├── package.json          ← v1.1.0
│   ├── core/                 ← 纯函数层（零 IO）
│   │   ├── gate.js           ← ★ decideGate()：门禁的唯一判决点
│   │   ├── roles.js          ← 按 role 的写权限表
│   │   ├── handover.js       ← ★ H1–H7 + H4 证据判据 + H11
│   │   ├── health.js         ← H-1 ~ H-5 健康度
│   │   ├── markSnapshot.js   ← 标绿快照（H-6 的数据源）
│   │   ├── index.js          ← buildIndex()：必读/禁止/异常三份清单
│   │   ├── render.js         ← 索引块渲染
│   │   ├── budget.js         ← 冷启动 token 预算
│   │   ├── registerHandover.js ← 交接自动登记进索引
│   │   ├── requiredList.js   ← ★ 必读清单自动块（M3：按 frontmatter 渲染）
│   │   ├── anchors.js        ← verifiedAgainst 锚点漂移
│   │   ├── scope.js          ← 激活范围判定
│   │   ├── agentsMd.js       ← AGENTS.md 索引块
│   │   ├── frontmatterEdit.js
│   │   └── pointers.js
│   ├── adapters/             ← 与宿主打交道的适配层
│   │   ├── probe.js          ← 项目根探测（找激活标记）
│   │   ├── registry.js       ← 注册表 + readSet + selfWritten
│   │   ├── guard.js          ← 门禁接线
│   │   ├── inject.js         ← 每轮索引块注入
│   │   ├── observe.js        ← tools/result 钩子（写后 rescan + 记账）
│   │   ├── filter.js         ← 坟场过滤
│   │   ├── last-writer.js
│   │   └── agentsmd-writer.js
│   ├── tools/                ← 四个工具
│   │   ├── doc-new.js
│   │   ├── doc-mark.js
│   │   ├── doc-handover-check.js
│   │   ├── doc-health.js
│   │   ├── define-tool.js    ← 工具 DSL（schema 编译）
│   │   └── when.js           ← 工具可见性
│   ├── docs/                 ← frontmatter 解析 / schema / 扫描
│   ├── server/               ← 宿主侧路由（快照、归档、交付、初始化）
│   ├── src/client/           ← 界面（React，构建到 lib/client.js）
│   ├── lib/client.js         ← 构建产物（界面实际加载这个）
│   └── test/                 ← 单测（1249 条）
├── skill/
│   └── ddd-workflow/
│       └── SKILL.md          ← ★ 给 AI 的工作手册（必装）
└── docs/                     ← 项目自身的权威文档
    ├── 文档驱动开发架构设想.md      ← 用户原始设想（25 行）
    └── 架构评审与补充设计-v1.md     ← 评审 + 补充设计（决策表 Q1–Q13 / R1–R5 / S1–S2）
```

---

## 开发

```powershell
cd plugin

# 单测（1249 条）
node --test --test-isolation=none

# 构建界面（改了 src/client/ 之后**必须**跑，否则界面还是旧的）
node node_modules/tsdown/dist/run.mjs

# 类型检查
npx tsc --noEmit
```

⚠️ **改了 `src/client/` 一定要重新构建** —— 界面加载的是 `lib/client.js`，不是源码。

⚠️ **打发布包前必须把 `plugin/server/*.ts` 编译成 `.js`。**
插件的 `index.js` 直接 `import './server/xxx.ts'`，这在**源码目录**里能跑
（DSH 的加载器处理 TS），但**装进 `node_modules` 后 Node 会拒绝**：

```
Stripping types is currently unsupported for files under node_modules
```

也就是说，用 `.ts` 打出来的包**一装就加载失败**。源码继续用 `.ts` 没问题，
打包时编译一次即可（注意只改后缀不行 —— 那些文件里有真的类型注解与 `interface`）。

---

## 已知限制

| 限制                      | 说明                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| **`pwsh` / `bash` 拦不住** | 门禁按路径判，而 shell 参数是任意字符串。`pwsh -Command "> docs/x.md"` 可以绕过。这是**已知漏洞**，不假装堵住了（要堵得写 shell 解析器） |
| **子代理不能写 `docs/`**      | 刻意的：子代理只干工程活，`docs/` 只有主 agent 能改                                                            |
| **「已读」不落盘**             | 存在会话内存里，宿主重启就清零。这是"这个会话读过什么"的语义，不是 bug                                                       |
| **归档不搬文件**              | 工具只标 `void`，搬进 `docs/_graveyard/` 是你在界面点的动作（否则 `present` 声明和 `supersededBy` 引用会悬空）           |

---

## 它适合 / 不适合什么

**适合**

- 长任务、跨多个会话的工程（靠文档交接对抗上下文衰减）
- 你希望 AI 别乱改文档、改之前先读懂现状
- 需要"为什么这么设计"可追溯的项目

**不适合**

- 一次性小任务（装插件的成本大于收益）
- 纯代码仓库（没有文档驱动需求）
- 你希望 AI 完全自由发挥（这个插件就是来约束它的）

---

## 许可证

MIT，见 [LICENSE](LICENSE)。

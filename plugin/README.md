# @local/ddd · 文档驱动开发（DDD）引擎

> **让 AI 在动手改项目文档之前，必须先读过该读的文档。**
> 「读没读」由插件记账并强制，不是靠提示词嘱咐。

**版本**：v1.0.0 ｜ **平台**：DeepSeek-Harness ｜ **工具数**：4（Q13 上限）

---

## 它是什么

一个 **DeepSeek-Harness 的 profile 级 bundle**（不是 preset）。

**它解决的具体问题**：AI 做长任务时上下文会衰减，"让 AI 自己记住"会失效。
本插件把工程状态外置成文档，每轮只注入一个索引块，并用**代码**强制"先读后改"。

上一代纯提示词方案（同为文档驱动开发）的实测：

> 第二轮共 5 个会话，工具调用总计 **5 次**，其中**真正核查用户机器的只有 1 次**。

⇒ **门禁必须是代码里的 `if`。** 这是本项目的铁律①。

---

## 四个环节

```
① adapters/probe.js            判断这个目录是不是 DDD 项目（找激活标记）
② docs/scan.js + registry.js   扫描 docs/，建注册表（内存缓存）
③ adapters/inject.js           每轮往系统提示词注入一个「索引块」
④ adapters/guard.js → ctx.tools.guard()   真正拦 write/edit 的 if
```

- **读没读**记在 `readSet`（会话级、内存 `WeakMap`），**不落盘**；
- `edit` 成功 → 指纹变 → 该文档**立刻变回"未读"**（铁律 7）；
- 例外：**本会话自己刚写过的**文档不再要求重读（`selfWritten`，M2.8 起）。

---

## 四个工具

| 工具 | 干什么 | 关键约束 |
|---|---|---|
| `doc_new` | 新建受管文档 | 自动生成合法 frontmatter；`order` 插值；建完重扫索引；建交接时**自动登记进入口索引** |
| `doc_mark` | 只改 frontmatter 状态 | 不改 `order`/`role`/`title`/`summary`；**`basis` 可以改** |
| `doc_handover_check` | 校验交接 | H1–H7 + H4 证据形状 + **H11 会过期的当前事实** |
| `doc_health` | 5 项健康度 | H-1 ~ H-6，全是 warn，不阻塞施工 |

**改正文用 `edit` / `write`，不用 `doc_mark`。**
**4 个工具全部条件注册**（`register(def, { when })`）：只在「探测到 DDD 项目 + 非子代理」时可见。
`when` 之外还有一道执行期 `if`（`assertToolAllowed`）—— 实机验收发现子代理路径上"不可见"不可靠。

---

## 目录

```
ddd-bundle/
├── index.js              ← 插件入口：注入 + 门禁 + 记账 + 坟场过滤
├── config.js             ← 配置解析
├── cordis.patch.yml      ← bundle 声明
├── core/                 ← 纯函数层（零 IO）
│   ├── gate.js           ← ★ decideGate()：门禁的唯一判决点
│   ├── roles.js          ← 按 role 的写权限表
│   ├── handover.js       ← ★ H1–H7 / H4 证据判据 / H11
│   ├── health.js         ← H-1 ~ H-5
│   ├── markSnapshot.js   ← 标绿快照（H-6 的数据源）
│   ├── index.js          ← buildIndex()：必读 / 禁止 / 异常三份清单
│   ├── render.js         ← 索引块渲染
│   ├── budget.js         ← 冷启动 token 预算
│   ├── registerHandover.js ← 交接自动登记进索引
│   ├── anchors.js        ← verifiedAgainst 锚点漂移
│   ├── scope.js          ← 激活范围判定
│   └── agentsMd.js       ← AGENTS.md 索引块
├── adapters/             ← 与宿主打交道
│   ├── probe.js / registry.js / guard.js / inject.js
│   ├── observe.js        ← tools/result 钩子（写后 rescan + 记账）
│   └── filter.js / last-writer.js / agentsmd-writer.js
├── tools/                ← 四个工具 + define-tool.js（schema DSL）
├── docs/                 ← frontmatter 解析 / schema / 扫描 / marker
├── server/               ← 宿主侧路由（快照 / 归档 / 交付 / 初始化）
├── src/client/           ← 界面（React，构建到 lib/client.js）
├── lib/client.js         ← 构建产物（界面实际加载这个）
└── test/                 ← 单测
```

---

## 质量基线（v1.0.0）

| 项 | 结果 |
|---|---|
| 单测 | **1231 / 1231 通过** |
| 锚点（源码与变异锚点） | **157 / 157 可用** |
| 变异检验 | **80 / 80 命中，0 存活** |
| 17 项基线（含 5 个变异套件） | **17 / 17 通过** |

### 怎么跑

```powershell
# 单测
node --test --test-isolation=none

# 构建界面（改了 src/client/ **必须**跑）
node node_modules/tsdown/dist/run.mjs

# 类型检查
npx tsc --noEmit
```

⚠️ **改了 `src/client/` 一定要重新构建** —— 界面加载的是 `lib/client.js`，不是源码。
（M2.9 踩过：改了源码没构建，用户看到的是两天前的界面。）

⚠️ **打发布包时，`server/*.ts` 必须先编译成 `.js`。**
本目录的 `index.js` 直接 `import './server/xxx.ts'`，`server/` 内部也互相引 `.ts`。
这在**源码目录**里能跑（DSH 的加载器处理 TS），但插件**装进 `node_modules` 后
Node 会拒绝**：

```
Stripping types is currently unsupported for files under node_modules
```

⇒ 用 `.ts` 打出来的包**一装就加载失败**（M2.9 发布 v1.0.0 时实测撞到）。
源码保持 `.ts` 没问题，**打包时编译一次**即可：

```powershell
# 6 个文件 → tsc 编译 → 改 index.js 的 4 处导入
node _m28/transpile-server.mjs <目标插件目录>
```

⚠️ **只改后缀不行** —— 这些文件里有真的 TS 语法（`export interface`、
`(error as Error)`、`Promise<boolean>`、返回类型注解），必须真转译。

---

## 门禁裁决顺序

`core/gate.js` 的 `decideGate()` 是**唯一判决点**，顺序如下（每条都能在 SPEC 找到出处）：

1. 没有路径参数 → 放行
2. 坟场 → 拒绝，**连 `read` 也拒**
3. 不是 `docs/` 下的文档 → 放行（按路径拦，不按工具名）
4. 文档有 `error` → 允许读、拒绝写（但允许"只改 frontmatter"的 `edit`）
5. 按 `role` 查写权限（`core/roles.js`）
6. 必读未读完 → 拒绝，理由列出缺哪几份
7. 指纹变了 = 读的是旧版 → 拒绝（`selfWritten` 豁免此条）

---

## 已知限制（**不假装堵住了**）

| 限制 | 说明 |
|---|---|
| **`pwsh` / `bash` 拦不住** | 门禁按路径判，shell 参数是任意字符串。`pwsh -Command "> docs/x.md"` 可绕过。要堵得写 shell 解析器，**明确不做**（与教练模式一致） |
| **子代理不能写 `docs/`** | 刻意：子代理只干工程活，`docs/` 只有主 agent 能改 |
| **「已读」不落盘** | 宿主重启清零。这是"这个会话读过什么"的语义 |
| **归档不搬文件** | 工具只标 `void`，搬进 `docs/_graveyard/` 是用户在界面点的动作（否则 `present` 声明与 `supersededBy` 引用会悬空） |
| **§5 的证据本质是自评** | H4 只能验"形状"，验不了"那个数字是不是真的"。**结构性天花板**，要真解需"证据台账"（新机制，未做） |

---

## 历史

本 README 在 v1.0.0 重写过。M0–M2.8 的里程碑流水账（54 KB，含 10 条订正清单、
每一条的实测证据与决策经过）保留在 **`README-M1切片-历史归档.md`**。

那份文档不适合当"插件说明"，但它是**为什么这么设计**的唯一记录 —— 遇到
"这条判据为什么长这样"的疑问，去那里找。

---

## 相关文档

| 文档 | 讲什么 |
|---|---|
| `skill/ddd-workflow/SKILL.md`（仓库根） | **给 AI 的工作手册**，必装 |
| `docs/文档驱动开发架构设想.md`（仓库根） | 用户原始设想（25 行） |
| `docs/架构评审与补充设计-v1.md`（仓库根） | 六个结构性缺口 + 决策表 Q1–Q13 / R1–R5 / S1–S2 |

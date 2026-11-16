# SPEC · 文档驱动开发插件 v1（M2 切片：UI）

> **项目是什么**（只读本文件的人也必须知道）：这是一个 **DSH 插件**，叫「文档驱动开发」（DDD，**不是**领域驱动设计）。
> 它让 **AI 在改项目文档之前必须先读过该读的文档**，「读没读」由插件记账并在 `guard` 里用 `if` 强制，不是靠提示词。
> 插件**全局挂载**（profile 级 bundle，不做 preset），但**只在带激活标记的项目里生效**——没有标记 → 整个插件 no-op。
> 切片：**M0 = 索引+门禁（已验收）｜M1 = 交接（已验收）｜M1.5 = 修 M1 的 9 条缺陷（已复核，有条件通过）｜M2 = UI（本文件）**。
> **完整的项目背景、术语表、三条铁律**见 `交接-给M2施工者.md` §0。

> **状态**：**v1.0 草案**，2026-11-12。**决策已拍板**（M2-Q1–M2-Q6），本文件是 M2 的施工图。
> **上游输入**：`文档驱动开发-架构评审与补充设计-v1.md` §5「M2 · UI」+ §3.11/3.12/3.13/3.14 + §6 的 Q6/Q7/Q12；`M1.5-复核报告.md`。
> **前置**：M1.5 **有条件通过**（`M1.5-复核报告.md` §九）：三个放行条件（D-1/D-2/D-3-D-5）**必须在 M2 开工前修完**。
> **切片边界**：M2 = **只做 UI**，外加 D-9。**不动 host 的门禁判据**。
> **基线（本机实测，2026-11-12）**：DSH **`0.2.2-rc.1`**；Node **`24.21.0`**；`@local/ddd@0.1.0` 已装；**722 单测全绿**。

---

## 0. 一句话

> **让「文档状态」从「只能问 AI」变成「一眼看得见」。**

M0 证明了「AI 会先读文档」。M1 证明了「交接接得住」。M1.5 证明了「插件不会把项目弄坏」。
M2 要证明的是**最后一件**：

> **人能不能自己看见这个约束器在干什么，而不是只能问 AI「我现在能改哪份文档？」**

**这是一个换技术栈的切片，不是加功能。** M2 之前插件是**纯 host**（零构建，`index.js` **637 行** + `core/` 11 个 + `adapters/` 8 个 = **19 个文件**，合计约 **5 500 行**）；
M2 之后是 **host + client 双半侧**（`dsh.client` 声明 + 浏览器 bundle + React）。

---

## 1. 目标与非目标

### 1.1 目标（七条，多一条都不要做）

| # | 目标 | 一句话验收 |
|---|---|---|
| **M2-A** | **施工看板可见** | 右栏面板显示：当前切片 / 必读进度 / 下一步 / 依据文档 / 待归档数，且**与实际状态同步**（改一份文档后看板变化） |
| **M2-B** | **点开文档能看全文** | 点图谱或看板里的文档 → 右栏打开**全文预览**，含渲染后的 frontmatter，**不自己写渲染器** |
| **M2-C** | **图谱可导航** | 主栏全屏页：**纵向缩进树**（不是横向树），按 role 分组、按 order 排序，点节点开预览 |
| **M2-D** | **交付成品网格** | 主栏网格显示 `deliverables/` 内容；**未被 `present` 的标「未声明」** |
| **M2-E** | **坟场可归档可还原** | 待归档清单（`status: void` 的文档）→ 用户勾选 → 点归档 → 插件**物理移动**到 `docs/_graveyard/`；可还原 |
| **M2-F** | **上下文占用提醒** | 到达 40% / 55% 两档各提醒**一次**，之后静默；**纯客户端，host 零代码** |
| **M2-G** | **预算超限给出路（D-9）** | 必读超预算时，索引块的 `【门禁】` 行与 `【未读】` 标明**先读哪几份**，而不是只报「超限」 |

### 1.2 非目标（明确不做）

| 推迟项 | 为什么 |
|---|---|
| **改任何 host 门禁判据**（`core/gate.js` / `core/scope.js` / `core/handover.js` 的判据） | M2 只做 UI + D-9 的渲染层。**动判据就要重跑 M0/M1/M1.5 的全部实机判据**，那是另一个切片 |
| **新增第 5 个工具** | Q13 = A 的上限是 4 个，M1 已用满。看板数据走 **HTTP 路由**，不走工具 |
| **横向树状图** | §3.11 实测：右栏默认约 400px，横向树要滚动且每层节点宽度受限 |
| **自动置信度推断** | 需要先有 supersedes 图与证据，否则是猜（§3.11「不建议现在做」） |
| **跨项目共享** | 先证明单项目有用 |
| **`_artifacts/` 的独立 UI 入口** | 它不是给人读的，文件树能翻到就够（§3.11 末） |
| **文档编辑器** | §3.12：复用 `documentpreview` 做预览；**写**仍由 AI 走 `edit`/`write` + 门禁。UI 不做编辑 |
| **JSON-RPC / WebSocket 双向通道** | M2 只需只读拉取。HTTP 单向 GET 够用，选了双向会引入连接生命周期问题 |

### 1.3 判断标准

> 任何一条实现如果**不在上面七个目标里**，就属于范围蔓延，退回。
> **尤其：不要因为"顺手"去动 host 的门禁。** M1.5 刚刚证明了「改 host 就要重跑全部实机判据」。

---

## 2. 决策台账（**冻结，不要重开**）

### 2.1 M2 新增决策（M2-Q1–M2-Q6）

> **全部由用户 2026-11-12 拍板。** 每条都给了理由，理由比结论重要。

| # | 问题 | 拍板 | 理由 |
|---|---|---|---|
| **M2-Q1** | **能不能进 M2？** | **先把 M1.5 的三个放行条件修完再进** | M2 换技术栈，如果 host 侧还留着一批"看起来有测试守着其实没有"的判据，M2 的 UI 会把**错误的信任**可视化出来。先修完再进 |
| **M2-Q2** | **M2 范围** | **全部 6 项 + D-9，共 7 项** | 用户判断：拆成两轮会让"看板/图谱/交付/坟场"之间的一致性反复返工。一次做完，代价是工期 |
| **M2-Q3** | **host ↔ client 数据通道** | **host 注册 HTTP 路由，client 用 `fetch` 取** | 已验证先例（skill-explorer 有完整 `http.d.ts` + 自建路由）。理由：① 稳定、可缓存；② **不污染模型上下文**（走工具就会进上下文）；③ 与 Q6「纯客户端提醒」的取向一致 |
| **M2-Q4** | **D-9 纳入 M2** | **纳入，作为第 7 项** | 它的修法本来就是渲染层（`【门禁】` / `【未读】` 行），与 UI 同属"让人看见"。单独立项会两次改同一个渲染器 |
| **M2-Q5** | **技术栈** | **上构建链：TypeScript + tsdown** | 用户判断：M2 会长期演进，一开始上 TS 比后期迁移便宜。**代价：722 条单测的运行方式要保住**（见 §8.3） |
| **M2-Q6** | **坟场归档的权限分工** | **AI 只标 `status: void`（不移动）；UI 出待归档清单；用户勾选后由 host 走 `ctx.fs` 物理移动** | 这条**不是新增决策，是确认 §3.3 的原文**：AI **永远不能移动文件**，移动是 host 拿着 `ctx.fs` 做的（不是模型调工具）。所以「归档要改 host 权限逻辑」是误读——**host 早已有写权限，只是不给模型** |

### 2.2 继承的冻结决策（**不要重开**）

| # | 决策 | 对 M2 的约束 |
|---|---|---|
| **Q6** | 交接触发 = **纯 UI 提醒**，40%/55% 各一次，之后静默，**不进模型上下文** | M2-F 的实现方式：**不许**往索引块写占用百分比 |
| **Q7** | UI 落点 = **双注册**（`sidebar.panellist` 入口行 + `main` 整页） | 照抄 skill-explorer 模式，**不要**只做其中一半 |
| **Q12** | 坟场 = **AI 只提议，UI 列清单，用户勾选，插件移动** | M2-E，见 M2-Q6 |
| **Q13** | 工具上限 4 个 | M2 **一个工具都不加** |
| **S1** | 全局挂载、项目级生效 | client 半侧**继承同一激活判定**：非 DDD 项目 → 面板不出现 |
| **S2 / P14** | 子代理不参与文档施工 | **client 半侧也要遵守**：子代理会话不显示面板（它们没有索引块，看了也没有数据） |
| **M0-5** | **红线**：索引块不得含快变量 | **M2 只读不写索引块**（除 M2-G 的静态优先级标注）。**任何"当前时间/百分比"都不许进索引块** |

---

## 3. 已核实的机制事实（**不要重新论证**）

> 这一节全是本机实测过的。**M2 的施工者不要重新调研**，直接用。

### 3.1 client 半侧的声明方式（**已核实，有一个可用范例**）

```
dsh-plugin/package.json 里：
  "exports": { "./client": "./client.js" },
  "dsh": {
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
    }
  }
```

**`client.js` 的形式**（`@local/dsh-plugin` 的真实源码，1710 字节，**零构建**）：

```js
window.__ModuleLoader__.load({
  id: '@local/dsh-plugin',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    function Indicator() { /* ... */ }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'dsh-plugin-indicator',
          order: 20,
          label: 'DSH Plugin indicator',
        }, Indicator))
      },
    }
  },
})
```

> **注意**：`factory(require)` 里 **不能** import 本地文件，只能 `require` 白名单里的包
> （`dsh.client.inject` + `PLATFORM_MODULES`）。所以 M2 用 TS 构建时，
> **产物必须是单文件 `client.js`**（tsdown 的 `bundle` 模式）。

### 3.2 双注册的 slot 名（**已核实，来自 skill-explorer 的 `lib/client.js`**）

```js
// 入口行（右栏 tab 里的一行）
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
  name: 'sidebar.panellist',
  id: PANEL_ID,
  order: PANEL_ORDER,
  label: () => tt('entry.label'),
}, IconComponent))

// 整页（点入口行之后打开的主栏页）
ctx.slots.inject('main', () => ctx.slots.register({
  name: 'main',
  key: PANEL_ID,
  inject: () => ({ controller, api }),
}, PageComponent))
```

**两条都要注册**（Q7 = 双注册）。`key` / `id` 必须同一个常量，否则点入口行打不开页。

#### ⚠️ 订正（2026-11-13，交接测试抓出）：`main` 还是 `pane.tab`？**我第一版给了两套答案**

| 位置 | 我写的是 |
|---|---|
| §3.2（本节） | `ctx.slots.inject('main', ...)` |
| §6.1（M2-A 施工看板） | 「入口行（`sidebar.panellist`）+ 面板正文（**`sidebar.right.pane.tab`**，`key` 同 `id`）」 |

**这两条不是一回事，照 §6.1 做会正好踩中 Q7 警告的"点了没反应"。**

**核实到的事实**：
- skill-explorer 的 `lib/client.js` 用 `sidebar.panellist` + **`main`**（`pane.tab` 出现 **0 次**）；
- `sidebar.right.pane.tab` 是**右栏 tab 的正文席位**，要配 `ctx.sidebarRightTabs.register({ id, kind, patterns, priority, title })` 声明 tab 类型，
  再 `ctx.sidebarRight.openTab(kind)` 打开——**四件套**，SPEC 全文原来一个字都没提；
- `main` 的官方 contract 是「Central panel selected by sidebar entry id」。

**M2 的裁定（推荐，也是 §3.11 的取向）**：

| 用途 | 落点 | 理由 |
|---|---|---|
| **施工看板**（M2-A） | **`sidebar.panellist` + `main`**（二件套） | 它就是"插件自己的一个页"，照 skill-explorer 抄，最简单 |
| **图谱 / 交付 / 归档**（M2-C/D/E） | **`main` 里用 tab 切区** | §3.3 已定：三区塞不进右栏 |
| 文档全文预览（M2-B） | **不经自己注册**，直接 `ctx.sidebarRight.openResource(address)` | **复用 documentpreview 的 tab 类型**，我们不注册 tab 类型 |

> **所以 M2-A 不需要 `sidebarRightTabs`。** 那四件套只在"我们要自己提供一种 tab 类型"时才需要——
> M2 没有这个需求。**第一版 §6.1 把它写进 M2-A 是错的，已改。**

### 3.3 右栏的硬约束（**§3.11 实测，会决定布局**）

| 事实 | 对 M2 的影响 |
|---|---|
| 每会话一个停靠面，**没有会话就没有面板** | 面板必须能处理"没有 session" |
| 最多 **2 个分栏**，分隔条 20%~80% | **三区塞不进 2 格** → 交付/坟场放主栏 |
| 窗口 < 768px 打开右栏**自动全屏** | 窄屏布局要能用 |
| 布局存 localStorage，**按 sessionId 键控** | 换会话不共享布局 |
| 面板**没有标题行**，tab 条就是上边 | 顶部空间很紧 |

**结论**（§3.11 的建议布局，M2 照此做）：

| 设想 | M2 的做法 |
|---|---|
| 工作区：从左往右的树 | **主栏全屏页放图谱**（纵向缩进），右栏只放「当前文档 + 相邻 3 份」 |
| 三区并列 | 主栏里用 **tab 切区**（图谱 / 交付 / 归档），右栏只放**施工看板** |
| 交付成品：90° 网格 | 主栏网格 |
| 坟场：上方散落 | 主栏「归档」tab，时间线列表 |

### 3.4 文档预览**零成本**（复用，但**地址格式我第一版写错了**）

右栏已有 `dsh-client-ui-sidebar-documentpreview`：
- 支持 Markdown / 代码 / 图片 / PDF / Office / HTML
- **渲染 frontmatter 为键值列表**
- 有目录树、行号、自动刷新

#### ⚠️ 订正（2026-11-13，交接测试抓出）：地址**不是** `dsh-resource://file/<absPath>`

**我第一版写的是**：
```js
ctx.sidebarRight.openResource('dsh-resource://file/<path>')   // ❌ 错
```

**为什么错**（核实来源：`dsh-client-ui-sidebar-documentpreview/README.zh.md` 第 44 行 + `parseFileAddress` 的 scope 约束）：

| 事实 | 后果 |
|---|---|
| `parseFileAddress` 只认 **`session`** 与 **`absolute`** 两个 scope | 裸绝对路径不是合法地址 |
| documentpreview 的 `canOpen` 是 **`scope === "session"`** | 它**只接 Session 地址** |
| `absolute` 段会被 `liveshare` 的 `patterns: ["dsh-resource://file/**"]` + `priority: "builtin"` **抢走** | 正文只渲染 `unavailable` |

**症状特别坏：不报错**。右栏只是"打不开/无法查看"，很容易被误判成"工作区外"（我自己就在 R-3 里埋了这个混淆）。

**正确写法**（README 第 44 行原话：「tab 使用 `fileAddressFor` 构造的 **Session 地址**」）：

```js
// host 侧（client 拿不到 fileAddressFor 的入参，必须由快照带过来）
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
const address = fileAddressFor(sessionId, cwd, relativePath)
// → dsh-resource://file/session/<sessionId>/<相对路径>
```

**所以 M2-B 的代价不是零**：必须先有一条 `sessionId + cwd → 地址` 的管道。
**这条管道是 M2-B 的第一个产出，不是顺手的事。** 见 §13 第 6 步。

> ⚠️ **`sessionId` 从哪来**：快照里目前**没有**它（§4.2 的 `?cwd=` 只有项目根）。
> 这是 §4.2 必须补的字段之一，与 M2-A 的 `gate.read` 是同一个缺失（见 §4.2 的订正）。

### 3.5 host 侧 HTTP 路由（✅ **订正：这是第一方公开服务，不是我原以为的"私有约定"**）

#### ⚠️ 订正（2026-11-13，交接测试抓出）：我把 R-1 的风险估高了一个量级

**我第一版写的**：
> 「skill-explorer 有完整实现，但**那是第三方包，用的是 `dsh-web` 的私有约定**。」

**这是错的。** 核实到的证据：

| 证据 | 内容 |
|---|---|
| `@linxin666/dsh-client-ui-skill-explorer/lib/index.js:2000` | `const disposers = routes.map((route) => ctx.webServer.register(route))` |
| 同文件 `:1947-1948` | 插件级 `inject: ["webServer", …]` |
| `lib/types/routes.d.ts` | `import { WebRoute } from '@deepseek-ai/dsh-host-webserver'` |
| 该包 README 自述 | 「rides official NPM SDK packages — no dsh source changes」 |
| DSH service catalog | `key: 'webServer'`，签名 `register(route): () => void`，并明说重复 `(kind, path)` 会 throw |

**结论**：`ctx.webServer.register` 是**第一方公开服务**。R-1 **不是"生死点"**，
正确做法是**插件级 `inject` + `ctx.webServer.register`**，与 `tools/` 的注册同形。

**所以**：
- §13 第 2 步的「半天内必须给出结论」→ **改成 10 分钟验证**（照 skill-explorer 的写法试一次）；
- **不要**去反编译 `app.asar`（那是我在 R-1 里给的一条不划算的建议，`_ref/asar` 里只有 29 个包的 README/JSON、没有源码）。

**M2 施工者要做的**：
1. 在插件上声明 `inject: ['webServer']`（Cordis 插件级，不是 client 的 `dsh.client.inject`）；
2. `ctx.effect(() => routes.map((route) => ctx.webServer.register(route)))`——**照 skill-explorer 抄**；
3. 注册 `GET /api/ddd/index?cwd=<项目根>&sessionId=<会话>`，返回注册表的**只读快照**（见 §5）；
4. client 用 `fetch` 取，失败要有降级 UI（**不许白屏**）；
5. **注册必须 try/catch**，拿不到 `webServer` 只 warn 不抛（同 §5.3-1）。

> ⚠️ **关于 `http.d.ts`**：它确实存在（`lib/types/http.d.ts`，59 行），但**只是 `.d.ts`**，
> 包的 `exports` 也没暴露它——**运行时拿不到，"共享复用"不可行**。要自己写 JSON 读写。
>
> ⚠️ **不要在 host 侧用 `fetch` 去调自己的路由**（同源绕路没必要，且 `dsh-http-proxy` 会替换 `undici`）。

---

## 4. UI 的数据模型

### 4.1 数据从哪来（**单向只读**）

```
注册表（host 内存）  ──HTTP GET──▶  client 状态  ──▶  React 组件
      ▲                                                      │
      └──────────── 用户点「刷新」 / 轮询（可选）◀────────────┘
```

**规则**：
- client **只读**，**永远不写**注册表（写只能由 AI 走 `edit`/`write` + 门禁）；
- **唯一例外**是 M2-E 的归档/还原——那是 **host 收到 POST 后自己走 `ctx.fs` 移动**，
  **不是** client 直接改文件，也**不是** AI 调工具；
- 数据快照必须带 `fingerprint`（前端好判断"变了没"）。

### 4.2 快照的形状（`GET /api/ddd/index?cwd=<根>&sessionId=<会话>`）

> ⚠️ **订正（2026-11-13，交接测试抓出三处）**：
> 1. **`budget` 的字段名是 `over`，不是 `overflow`** —— 见 `core/budget.js:97`（`over: tokens > limit`），
>    渲染在 `:143`。**照我第一版写会读到一个永远 `undefined` 的字段**（看板永远不报警）。
> 2. **缺 `sessionId`** —— 没有它，`gate.read` 算不出来（`readSet` 是**会话级**，`adapters/registry.js:78` `readSetFor(session)`），
>    `fileAddressFor` 也生成不出预览地址。**这是路由必须带的参数，不是可选项。**
> 3. **缺 `nextStep` / `basisDoc`** —— §4.3 的看板要显示「下一步」「依据文档」，但快照里没这两个字段。

```jsonc
{
  "ok": true,
  "projectRoot": "C:\\...\\proj",
  "sessionId": "session-2dd5116a-…",      // ⚠️ 必需：readSet 与 fileAddressFor 都依赖它
  "generatedAt": 1794490792206,           // ⚠️ 只给 UI 判新鲜度，**不进索引块**
  "gate": { "read": 2, "required": 3, "ready": false },   // read 来自该 session 的 readSet
  "project": "档 2 的入口索引：先读哪一份…",   // = 【项目】行
  "slice": "M2",                              // = 【施工】行（拿不到就空串，不写占位）
  "nextStep": "改 src/xlsx.js 的 writeRows",   // ⚠️ 新增：从交接 §3 取第一行；取不到就空串
  "basisDoc": { "id": "handover-m2", "section": "§3.1", "fingerprint": "f679e4" },  // ⚠️ 新增
  "budget": { "required": 7, "tokens": 51900, "limit": 30000, "over": true, "overBy": 21900 },  // ⚠️ over，不是 overflow
  "required": [
    { "id": "read-order", "role": "index", "order": 10, "status": "authoritative",
      "summary": "…", "fingerprint": "f679e4", "read": true, "verifiedAt": "2026-11-12" }
  ],
  "forbidden": [ { "id": "trap-csv", "summary": "🔴 不要执行：…" } ],
  "anomalies": [ { "id": "broken-role", "message": "role 不在枚举内：bogus-role" } ],
  "deliverables": [
    { "path": "deliverables/report.xlsx", "presented": true, "size": 10240, "mtime": 1794490792 }
  ],
  "graveyardCandidates": [ { "id": "old-plan", "summary": "已作废：…", "status": "void" } ],
  "graveyard": [ { "path": "docs/_graveyard/old-plan.md", "archivedAt": 1794490792 } ]
}
```

> **`generatedAt` 是 UI 的字段，不是索引块的字段**。M0-5 的红线管的是**注入给模型的索引块**，
> 不管 HTTP 响应。**但快照绝对不能进 `context()`。**

### 4.3 施工看板的内容（M2-A，右栏第一格）

§3.13 给的形态，M2 照此做：

```
当前切片: M2
当前阶段: 施工中          ← ⚠️ 见下方「一个问题」
必读进度: 2/3（还缺 spec-live）
下一步:   …（从交接 §3 取第一行）
依据文档: 交接-给M2施工者 §3.1（vf679e4）
待归档:   1 份（old-plan）
```

> ⚠️ **「当前阶段」是个陷阱**：`【施工】` 行只显示**切片名**（D5 = B 的拍板，因为"阶段"是快变量）。
> **看板可以显示阶段**（它走 HTTP，不是索引块），**但数据必须有真源**。
> 施工者**不要自己编一个阶段推断器**——见 §11 R-4。

---

## 5. host 侧要加的东西（**最少**）

> ⚠️ **这一节是 M2 唯一允许动 host 的地方。** 加的东西必须**只读**，且**不得影响现有 722 条单测**。

### 5.1 新增文件

| 文件 | 内容 |
|---|---|
| `server/routes.ts` | 三个 HTTP 路由的注册与处理（`GET /api/ddd/index`、`POST /api/ddd/archive`、`POST /api/ddd/restore`） |
| `server/snapshot.ts` | 把注册表折成 §4.2 的快照（**纯函数**，好单测） |
| `server/write-engine.ts` | 归档/还原的**物理移动**（走注入的 `fs`，不直接碰 `node:fs`） |

### 5.2 改动**最小化**的文件

| 文件 | 改什么 | 风险 |
|---|---|---|
| `index.js` | 注册路由（找不到 `webServer` 就**静默跳过**，不能抛） | ⚠️ **中**：注册失败不能影响 host 启动 |
| `package.json` | 加 `"./client": "./lib/client.js"` export + `dsh.client` 声明 | 低 |
| `cordis.patch.yml` | **不改**（`dsh.client` 从 package.json 读） | 无 |

### 5.3 硬约束

1. **路由注册必须 try/catch**：拿不到 `webServer` / 端口冲突 / 任何异常 → **只 warn，不抛**。
   理由与 M1-L8 同源：**插件故障不能变成宿主故障**。
2. **`server/snapshot.ts` 必须是纯函数**（input: entries + index + config → output: 快照对象），
   这样它能进 `node --test`，不需要起 HTTP。
3. **`server/` 不得 import `node:` 内置模块**，除非通过注入口。
   现有的 `decoupling.test.js` 会检查 `core/`，**M2 要把它扩展到 `server/`**。
4. **归档/还原必须走 `ctx.fs` + 沙箱 policy**（照抄 `tools/doc-new.js` 的 `sandboxPolicyOf`），
   否则会撞 `file access denied`（那是 M1 踩过的真 bug）。

---

## 6. 七项实现要点

### 6.1 M2-A 施工看板（**`sidebar.panellist` + `main`**，二件套）

> ⚠️ **订正（2026-11-13）**：原来这里写的是 `sidebar.right.pane.tab`，**错了**——
> 那是"自定义一种右栏 tab 类型"才要的席位，需要 `sidebarRightTabs.register` + `openTab` 四件套。
> **M2-A 只是一个插件自己的页，用 `main` 就够**（与 skill-explorer 同形）。详见 §3.2 的订正。

- 入口行（`sidebar.panellist`，`id` 与页同常量）+ 整页正文（`main`，`key` 同 `id`）；
- 数据：`GET /api/ddd/index`，**首屏必须有 loading 态**，失败要有错误态 + 重试按钮；
- **必读进度条**要能点：点未读的文档 → 直接开预览（用户读完，AI 那边……**注意：UI 读不算 AI 读**，
  见 §11 R-5）；
- **`【文档异常】` 要在看板上高亮**（那是唯一"必须马上处理"的状态）。

### 6.2 M2-B 文档预览（复用 `documentpreview`）

> ⚠️ **订正（2026-11-13）**：地址**不是** `dsh-resource://file/<absPath>`，必须用 `fileAddressFor` 生成 Session 地址
> （`dsh-resource://file/session/<sessionId>/<相对路径>`）。详见 §3.4 的订正。

- 调用 `ctx.sidebarRight.openResource(address)`，`address` 由 host 侧 `fileAddressFor(sessionId, cwd, relPath)` 生成；
- **不要**自己实现 Markdown 渲染 / frontmatter 渲染；
- **要处理"打不开"**：地址不被认领时（如 `.md` 之外的类型）要给出可见说明，不能静默；
- **第一份产出必须包含 `sessionId` 管道**（见 §3.4 末与 §4.2 的订正）。

### 6.3 M2-C 图谱（主栏 `main`）

- **纵向缩进树**，不是横向；
- 分组：先按 `role`（index → handover → spec → decision → evidence → log → …），组内按 `order` 升序；
- 每个节点显示：`id` + `summary` + `status` 徽标 + 指纹前 6 位；
- **`sealed` 节点要灰掉并标 🔴**（它们是【禁止执行】）；
- **`anomalies` 要显示在最上面**，不藏在组里——它们是"现在就有问题"。

### 6.4 M2-D 交付成品网格

- 扫 `deliverables/` 目录；
- **`presented` 判定**：查会话里有没有 `present` 过这个路径（§5.1 的 `dsh-deliverable-file-references` 可能能帮忙，**需确认**）；
- **未被 `present` 的标「未声明」**——这是 §2.6 的明确要求，**不是可选项**。

### 6.5 M2-E 坟场归档/还原（**权限分工是这一项的关键**）

**照架构评审的 §3.3 原文执行（`文档驱动开发-架构评审与补充设计-v1.md:560`），不要发明新分工**：

| 谁 | 能做什么 |
|---|---|
| **AI** | 标 `status: void` + 写理由。**永远不能移动文件** |
| **UI（client）** | 列出「待归档」清单；用户勾选；POST 到 host。**client 自己不碰文件** |
| **用户** | 勾选 + 点「归档」/「还原」 |
| **插件（host）** | 收到 POST 后走 `ctx.fs` **物理移动**，保留原路径元数据 |

**为什么这个分工不需要改 host 权限逻辑**（回应 M2-Q6 的误解）：
- host **本来就**有写权限（它一直在用 `ctx.fs.writeText` 建文档）；
- 缺的从来不是"权限"，是**"AI 不能移动"这条纪律**——而它已经由 Q12 钉死了：
  **AI 没有任何工具能移动文件**，所以它不可能移动；
- 所以 M2 只是**新增两个 HTTP 路由**，让"用户的手"能触发一个 host 本来就会做的写操作。
  **门禁不需要动一行。**

**两个必须做对的细节**：
1. **保留原路径元数据**（还原时要能放回原处）——写到文件 frontmatter 或 `_artifacts/` 索引都行，**但要想清楚**（见 §11 R-6）；
2. **归档不是删除**，`docs/_graveyard/` 里的文件仍占磁盘、仍进 git。

### 6.6 M2-F 上下文占用提醒（**纯客户端**）

- 40% / 55% 两档，**各提醒一次**，之后静默（Q6）；
- 数据来源：client 侧能拿到 token 用量（**需确认**：能拿到就用，拿不到就砍掉这项，见 §11 R-7）；
- **绝对不许**把这个百分比写进索引块（Q6 原文：「不进模型上下文」）。

### 6.7 M2-G 预算超限给出路（D-9）

**这是唯一改索引块渲染的一项**，也是最容易做错的一项。

**现状**（`_m15/live-proj` 与 `dogfood` 实测）：
```
【门禁】0/7 ｜ 未读完必读清单，改 docs/ 会被拒绝
【预算】必读 7 份 ≈ 51.9k tokens（上限 30k）⚠️ 超出上限
【未读】
- `coach-prompt-spec` · …  ← 7 份全列，模型读不完
```

**要改成**（D-9 选项 c）：
```
【门禁】0/7 ｜ 未读完必读清单，改 docs/ 会被拒绝
【预算】必读 7 份 ≈ 51.9k tokens（上限 30k）⚠️ 超出上限 —— 建议先读 `read-order`、`handover-to-tier26` 两份
【未读】
- `handover-to-tier26` · … · 🟢 · ★先读
- `read-order` · … · 🟢 · ★先读
- `coach-prompt-spec` · … · 🟢
```

**判据（必须可证伪）**：
1. 超限时，`【预算】` 行**给出具体的 id 列表**（不是"建议读关键文档"这种空话）；
2. 优先级规则**固定且可测**：`role: handover` 与 `role: index` 优先，其余按 order；
3. **不超限时，这两行一个字符都不许变**（否则就是噪音，与 L34 的教训同源）；
4. 推荐的 id 数量**有上限**（建议 2–3 份），否则又变成长清单。

> ⚠️ **不要把"已读/未读"塞进优先级**——那是状态，状态会变，变了就会改索引块（M0-5）。

---

## 7. 模块划分

### 7.1 client 侧（新增）

```
src/client/
├── index.ts          # __ModuleLoader__.load 入口（tsdown bundle 成 lib/client.js）
├── api.ts            # fetch /api/ddd/index，含超时与降级
├── panel.tsx         # sidebar.panellist 入口行
├── dashboard.tsx     # 施工看板（右栏）
├── graph.tsx         # 图谱（主栏）
├── deliverables.tsx  # 交付网格（主栏）
├── graveyard.tsx     # 归档（主栏）
└── locale/{zh,en}.json
```

### 7.2 host 侧（新增，**只读优先**）

```
server/
├── routes.ts         # 注册三个路由
├── snapshot.ts       # 纯函数：注册表 → 快照
└── write-engine.ts   # 归档/还原的物理移动
```

### 7.3 构建（M2-Q5 = TS + tsdown）

```jsonc
"scripts": {
  "build": "tsdown",              // 产出 lib/client.js（单文件 bundle）+ lib/index.js
  "test": "node --test --test-isolation=none",   // ⚠️ 见 §8.3
  "typecheck": "tsc --noEmit"
}
```

**关键**：`tsdown` 必须配成 **`dts: false` + 单文件 bundle**，因为 `__ModuleLoader__` 只认一个 `client.js`。

---

## 8. 测试与验收

### 8.1 单测（**不许回退**）

| 项 | 要求 |
|---|---|
| 现有 722 条 | **一条都不许红**（三个放行条件已修完，基线从 691 升到 722） |
| 新增：`server/snapshot.ts` | 纯函数，≥ 10 条（空注册表 / 坏文档 / 超预算 / 有交付物 / 有无坟场候选 / 指纹正确） |
| 新增：`server/write-engine.ts` | ≥ 6 条（移动 / 还原 / 目标已存在 / 源不存在 / 失败不抛 / 保留元数据） |
| 新增：`client/api.ts` | ≥ 5 条（200 / 404 / 超时 / 坏 JSON / 降级） |
| **`decoupling.test.js` 扩展** | `server/` 也要过"不 import `node:`"这条（见 §5.3 第 3 条） |

### 8.2 装配冒烟（扩展 `_ref/smoke-ddd.mjs`）

新增至少 4 条：
1. `package.json` 有 `dsh.client` 声明且 `platform: 'web'`；
2. `exports['./client']` 指向真实存在的文件；
3. `lib/client.js` 里有 `__ModuleLoader__.load` 且 `id` 与 package name 一致；
4. host 路由注册函数在**没有 webServer 时不抛**。

### 8.3 ⚠️ TypeScript 不能破坏现有测试的运行方式

**这是 M2-Q5 的最大代价，必须显式处理**：

- 现有 722 条测试是 `node --test --test-isolation=none` 直接跑 `.js`；
- 上 TS 之后，**测试仍然跑 `.js`**（测试文件不改成 TS），被测代码要么：
  - **(a)** 编译后跑 `lib/*.js`（但那样测试的是产物，不是源码）；
  - **(b)（推荐）** Node 的 `--experimental-strip-types` 只剥类型；
  - **(c)** tsdown 输出到原地（`dist/` 与源码同构），测试 import `dist/`。

> **施工者必须选一条并写进报告。** 不许"跑了就算"——**722 条必须能在一条命令下跑完**。

### 8.4 实机验收（`M2-1` ~ `M2-10`）

> ⚠️ **订正（2026-11-13，交接测试抓出）：原来只有 7 条，M2-C / M2-D / M2-F 三个目标根本没有验收。**
> 而 §1.1 说「七条，多一条都不要做」——**有目标没判据，等于这三个目标可以"做了但没法验收"**。
> 补了 M2-8 / M2-9 / M2-10。

**判据形态必须是「工具/UI 返回原文 + 会话 id」**（M1.5 的教训：不能只写"成功了"）。

| # | 判据 | 通过标准 | 反作弊要求（⚠️ 新增） |
|---|---|---|---|
| **M2-1** | 面板出现 | **左侧栏**（`sidebar.panellist`）看到「文档驱动开发」入口行；点它在**主栏**打开看板 | **必须贴 console 无 slot 报错**；否则"崩了"与"没注册"在 UI 上同形 |
| **M2-2** | 看板数据正确 | 看板的必读进度 = 索引块的 `【门禁】N/M` | **必须在一个 `N>0` 的会话里验**（`dogfood` 是 `0/7`，写死 0 也能过）；**且读过 1 份后两处仍一致** |
| **M2-3** | 点开文档能预览 | 点图谱节点 → 右栏出现全文 + **渲染后的 frontmatter 键值列表** | 地址必须是 `session` scope；**打不开时要看到可见说明**（不许静默） |
| **M2-4** | 非 DDD 项目不出现 | 在普通仓库里，**左侧栏没有**入口行 | **必须与 M2-1 同版本对照**；否则"缺 bundle 崩了"与"正确不激活"不可区分 |
| **M2-5** | 归档闭环 | 勾选待归档 → 归档 → 文件真的在 `docs/_graveyard/`；还原能放回原处 | **必须证明 client 没碰文件**（client 无 fs 权限）；**归档后读 `_graveyard` 仍被拦**（M0-4 回归） |
| **M2-5b** | **AI 主动提议归档（这是 M2-5 的起点）** | 收工时，施工者应**主动标出**本轮产生的废弃文档：`doc_mark{status:'void', reason:'...'}`，并在汇报里说「这 N 份建议归档」。**不要求它移动**（Q12：AI 永远不能移动文件） | **反作弊**：只标 `superseded` 就结束 → **不合格**。`superseded` ≠ 建议归档（见下方说明） |
| **M2-5c** | **UI 能列出 AI 的提议** | 坟场 tab 里能看到「待归档」清单，且**每一条带 AI 写的 reason** | **必须有 reason**：没有理由的提议等于没提议（Q12 原文：AI 必须给理由） |
| **M2-6** | 看板随状态变化 | `doc_mark` 改一份文档的 status → 看板**刷新后**能看到变化 | **必须写清"刷新"怎么触发**（点按钮 / 重开面板 / 轮询哪一种）；**且要看到 fingerprint 变了**，不能只是每次 render 重新 fetch |
| **M2-7** | 预算超限给出路（D-9） | 在 `dogfood` 上 `【预算】` 行含具体「先读」id 列表；**不超限的项目里零变化** | 判据 3 需要**golden 文件**做逐字节对比（"零变化"必须有基线） |
| **M2-8** | **图谱可导航（M2-C）** | 主栏纵向缩进树：`role` 分组、组内 `order` 升序、`sealed` 灰显带 🔴、`anomalies` 置顶 | **必须贴截图 + 与快照 JSON 对得上**（节点数 = `required + forbidden + anomalies`） |
| **M2-9** | **交付网格标「未声明」（M2-D）** | `deliverables/` 里**构造一个没被 `present` 过的文件** → 网格显示「未声明」 | **必须真的有那个文件**，不能只验"已 present 的显示正常" |
| **M2-10** | **占用提醒（M2-F）** | 跨过 40% / 55% 各提醒**一次** | **跨过阈值后连续 3 轮零提醒**（证明"之后静默"）；**拿不到 token 数据则记录"砍掉"，不算失败** |

> ⚠️ **M2-2 的额外要求（这条最容易被糊弄）**：
> `gate.read` 来自**会话级** `readSet`，而路由必须带 `sessionId` 才拿得到它。
> **如果不带 `sessionId`，看板要么报错、要么退化到"共享值"，两种都不是"M2-2 通过"。**

> ⚠️ **M2-5b / M2-5c 的来源（2026-11-13，无 UI 全流程演练抓出）**：
> 演练里第一个会话因为 H4 校验不过、而交接文档**拒绝 `edit`**（设计如此：改交接=改历史），
> 被迫**连建 4 份交接**才凑出一份合规的。前 3 份的状态都变成了 `superseded`（`doc_new` 自动做的），
> **但全程没有一次 `void`，也没有一句「这 3 份建议归档」。**
>
> | 状态 | 含义 | 谁来定 |
> |---|---|---|
> | `superseded` | 被更新的交接**取代**了 | `doc_new` **自动** |
> | `void` | 内容**作废、建议扔坟场** | **AI 主动标 + 写 reason** |
>
> **两者不能互相替代**：一个是"有更新的版本了"，一个是"这份别再用了"。
> 4 份全 `superseded`、零 `void`，说明**"提议归档"这个动作从来没发生过**。
> 而 §3.3 / Q12 明确把它划给 AI（AI 只能提议，不能移动）——**这是 AI 的职责，不是 UI 的**。

### 8.5 零回归判据

| 项 | 要求 |
|---|---|
| M0 的 14 条 | 全部仍通过（尤其 **M0-12 不误伤普通仓库**、**M0-13 子代理边界**） |
| M1 的 14 条 | 全部仍通过 |
| M1.5 的 L1–L9 | **L1–L7、L9 必须仍全过**；L8 见 §11 R-8 |
| 工具数 | **仍是 4 个**（`smoke-ddd.mjs` 有断言钉住） |

---

## 9. 配置（新增 3 项）

| 键 | 默认 | 说明 |
|---|---|---|
| `uiEnabled` | `true` | 关掉就不注册 client bundle（调试用） |
| `uiRefreshMs` | `0` | 0 = 不轮询，只在用户操作时刷新；> 0 = 轮询间隔 |
| `uiBudgetHintCount` | `3` | M2-G 推荐的「先读」份数上限 |

---

## 9.5 ⚠️ **M2 开工前必修：H4 的正则漏掉了中文「通过 / 全绿」**

> **来源**：2026-11-13 的无 UI 全流程演练（`session-c03fc8c8-4bb3-4ce6-916a-d832228e0d99`）。
> 那一次施工为了写一份"H4 能认"的交接，**连续建了 4 份才成功**（`handover-001` → `004`），
> 中途还去读了 `ddd-bundle` 的源码才搞明白规则。**根因不是模型笨，是判据有个真 bug。**

### 9.5.1 缺陷

`core/handover.js` 的 `EVIDENCE_PATTERNS` 里，`test` 这一条：

```js
// 现状（有 bug）
re: /\b\d+\s*\/\s*\d+\s*(?:全绿|通过|passed?|tests?)\b|\bALL\s+GOOD\b|\bALL\s+PASS\b|node\s+--test|\b\d+\s+passed\b|单测\s*\d+\s*\/\s*\d+/i
```

**末尾那个 `\b` 要求「单词边界」**，而 `\b` 只在 `\w`（`[A-Za-z0-9_]`）与非 `\w` 之间成立。
**「通」「过」「全」「绿」都不是 `\w`**，所以：

| 写法 | 现在的结果 | 应当 |
|---|---|---|
| `3/3 通过` | **MISS** ❌ | OK |
| `12/12 全绿` | **MISS** ❌ | OK |
| `691/691 全绿` | **MISS** ❌ | OK |
| `3/3 passed` | OK ✅ | OK |

**实测证据**（`_rv/rehearse-flow.mjs` 的预演也撞了同一条）：
```
$ node -e "...EVIDENCE_PATTERNS.find(p=>p.key==='test').re.test('3/3 通过')"
→ false
$ 去掉末尾 \b 后
→ true
```

### 9.5.2 为什么这是「高」而不是「低」

**判据要求的是中文证据，但判据自己认不出中文证据。**后果：

1. 用中文写交接的人（**这个项目的全部文档都是中文**）会被反复拒绝；
2. 每次拒绝的文案**没有指出"你写的"通过"两个字我认不出"**，只说"没有证据形式"；
3. 于是模型会去**读源码猜规则**——演练里它就是这么干的（`seq=228–248`），
   **而且它猜出来的写法（`sha256:` 小写、`3/3 通过`）恰恰是被这个 bug 影响的**，
   所以它试了 4 次才蒙对。
4. **更糟**：模型最终学会的是"绕过判据"（研究正则 + 凑格式），而不是"写清楚证据"。
   **判据的本意是逼它写具体，结果逼它去逆向工程正则。**

### 9.5.3 修法（**M2 开工前做，改动 1 行**）

```js
// 修正：去掉末尾的 \b
re: /\b\d+\s*\/\s*\d+\s*(?:全绿|通过|passed?|tests?)|ALL\s+GOOD|ALL\s+PASS|node\s+--test|\b\d+\s+passed\b|单测\s*\d+\s*\/\s*\d+/i
```

> **这段修法我已经实跑验证过（7/7 全过）**，用的就是下面这张表。
> 验证脚本：`_rv/probe-h4fix.mjs`（可重跑）。

**验收（必须可证伪）**：
| 用例 | 期望 | 实测 |
|---|---|---|
| `3/3 通过` | **命中** | ✅ true |
| `12/12 全绿` | **命中** | ✅ true |
| `691/691 全绿` | **命中** | ✅ true |
| `3/3 passed` | 命中（不能破坏英文） | ✅ true |
| `ALL PASS（5/5）` | 命中（不能破坏现有） | ✅ true |
| `见第 5 节` | **不命中**（不能放宽到"任何数字"） | ✅ false |
| `已经改好了` | **不命中**（不能因为含"过"就放行） | ✅ false |

> ⚠️ **最后两条是关键**：M1.5 复核抓过 5 条"永远通过"的废测试，
> **修这个正则时最容易犯的错就是把它放宽到什么都认**。**必须先写这 7 条测试，再改正则。**

### 9.5.4 顺带要改的：拒绝文案

现在的文案是：
> 「§5 验收：有 1/2 条没有证据形式。每条都要能核对（会话 id + seq / 哈希 / 测试输出 / 可复现的命令）。」

**建议补一句**：「可用的写法示例：`seq=42`、`session-abc123`、`sha256: a1b2c3d4`、`3/3 通过`、`tests 691 / pass 691`。」

**理由**：演练里的模型被拒 3 次都不知道自己差在哪 —— **那是因为文案没给具体样例**。
给了样例，它就不必去读源码。

---

## 10. 三条最容易犯的错（M2 版）

1. **为了"看板更完整"往索引块里塞快变量**。看板走 HTTP，索引块走 `context()`——
   **两条完全不同的通道**。把 `generatedAt` / 占用百分比 / "当前阶段"塞进索引块，
   就是重造 M0-5 的坑（索引块每轮变 → 每轮 append 一条历史消息）。
2. **以为"UI 读了"等于"AI 读了"**。用户在看板上点开一份必读文档，**门禁不会解锁**
   ——`readSet` 是**会话级**的，UI 的读不记进去。**这是设计，不是 bug**（见 §11 R-5）。
3. **在 client 里直接读写文件**。client 跑在浏览器里，**没有文件系统**。
   所有文件操作必须 POST 回 host，由 host 用 `ctx.fs` 做。试图在 client 用 `fetch('file://...')`
   或 `dsh-resource://` 做**写**，一定失败。

---

## 11. 风险与已知限制（**要写进 README**）

| # | 风险 | 影响 / 处置 |
|---|---|---|
| **R-1** | ~~host 侧路由注册的入口未验证~~ ✅ **已订正（2026-11-13）** | **`ctx.webServer.register` 是第一方公开服务**，不是"第三方私有约定"（证据：skill-explorer `lib/index.js:2000`、`lib/types/routes.d.ts` 的 `WebRoute` 来自 `@deepseek-ai/dsh-host-webserver`、DSH service catalog 的 `key:webServer`）。<br>**风险降级**：不是"生死点"，是"10 分钟照抄验证"。<br>**不要**去反编译 `app.asar`（`_ref/asar` 只有 29 个包的 README/JSON，没源码）。<br>**备选方案保留**（若 Cordis 版本不兼容）：快照写成 `_artifacts/snapshot.json`，client 用 Session 地址读 |
| **R-2** | **TS 构建可能破坏 722 条测试的运行方式** | §8.3 给了三条路。**必须选一条并证明"一条命令跑完 722+"** |
| **R-3** | ~~工作区外路径的认领~~ ⚠️ **定位错了，真问题是 scope 语法** | **换成**：`documentpreview` 只认 **`scope === "session"`** 的地址（`dsh-resource://file/session/<sessionId>/<相对路径>`）。裸绝对路径会被 liveshare 抢走渲染成 `unavailable`。<br>**所以 R-3 不是"工作区外"的问题，是"地址格式必须带 sessionId"的问题**——见 §3.4 的订正 |
| **R-4** | **看板的「当前阶段」没有真源** | `【施工】` 行只有切片名（D5=B 的拍板）。**不许自己写阶段推断器**——<br>先只显示「切片 + 必读进度 + 下一步」，**「阶段」留空**，等有了真源再填 |
| **R-5** | **UI 的"读"不解锁门禁** | `readSet` 是会话级的。用户看板读了文档，AI 那边仍显示未读。<br>**这是设计**（不变量是"改文档的人必须读过"，指的是 **AI**）。README 要写清，否则会被当成 bug |
| **R-6** | **归档的原路径元数据存哪没定** | 存 frontmatter（改 schema）还是 `_artifacts/`（插件从不建目录，见 L20/L30）？<br>**两个都有代价，施工者必须先给出方案再动手** |
| **R-7** | **client 侧能不能拿到 token 用量未确认** | 拿不到就**砍掉 M2-F**（它本来就是舒适性功能，Q6 说的是"提醒"，不是"必须"） |
| **R-8** | **L8（`【施工】` 行）在真实项目里不显示** | 因为真实项目的 `role: index` 没有 `slice` 字段。<br>**M2 不做修补**（那是"要不要把 `slice` 变成推荐字段"的决策，见 `M1.5-复核报告.md` §5.2）。<br>~~但看板可以显示 slice（走 HTTP，不受这个限制）~~ ❌ **这句是错的**：快照的 slice 仍来自同一份 `role: index` frontmatter，**换通道不会让缺失的字段出现**。<br>看板能显示的仍然只有「切片行拿不到就不显示」这个事实 |
| **R-9** | **注册必须成对/成套** | ⚠️ 见 §3.2 的订正：**M2-A 走 `sidebar.panellist` + `main`（二件套）**，不注册 `sidebar.right.pane.tab`（那是"自己提供一种 tab 类型"才要的四件套）。<br>`smoke` 断言 `panellist` + `main` 成对 |
| **R-10** | **M2-D 的 `present` 判定链是空的** | 「这个文件被 `present` 过」**没有**落成 host 可查的事实：`present` 工具存在、`dsh-deliverable-file-references` 包存在，但**两者之间的桥没有**。<br>§6.4 只写了"可能能帮忙，需确认"。**这是 M2-D 的前置未解决**，与 R-7 同等：<br>**如果查不通，M2-D 就要降级**（比如"所有文件都标未声明"），**但那是数据错误，不是 UI 问题**——必须先告诉用户 |
| **R-11** | **忘了 `build` 会让插件整体加载失败** | 宿主对 `dsh.client` 声明的处理是：**缺 `lib/client.js` 时 loudly fails activation**，不是"面板静默消失"。<br>**所以"忘了 build"会把局部故障升级成插件整体哑火**——那时连 host 的门禁也不工作了。<br>**处置**：把 `build` 写进 `test` 脚本前置，或在 `cordis.patch.yml` 里先不声明 `dsh.client`（分两轮上） |

---

## 12. 交付物清单

- [ ] `src/client/` 7 个 ts/tsx + 2 个 locale json（tsdown 构建成 `lib/client.js` 单文件）
- [ ] `server/` 3 个文件（`routes.ts` / `snapshot.ts` / `write-engine.ts`）
- [ ] `package.json`：`dsh.client` 声明 + `exports['./client']` + build 脚本
- [ ] `index.js`：路由注册（**try/catch，失败静默**）
- [ ] `core/render.js`：M2-G 的预算优先级标注（**唯一改索引块的地方**）
- [ ] **`core/handover.js`：修 H4 的 `test` 正则**（§9.5，去掉末尾 `\b`）+ 7 条测试 + 拒绝文案补样例
- [ ] `config.js`：3 个新配置
- [ ] `test/`：3 个新文件 + `decoupling.test.js` 扩展，**722 条不许红**
- [ ] `_ref/smoke-ddd.mjs` 扩展（≥ 4 条）
- [ ] `README.md`：**新增 M2 的已知限制**，编号接着现有的 L36 往后排（L37…），**不要另起一套 `M2-L*`**（第一版这里是错的，`M2-L1–L9` 全库只出现过一次且从未定义）
- [ ] 验收报告：`M2-1` ~ `M2-10`（含 M2-5b/5c），附 **UI 截图路径 + 会话 id + seq**
- [ ] **H4 正则修复的验证**（§9.5 的 7 条用例全过 + 原有 722 条不红）

---

## 13. 开工顺序（⚠️ 订正过：R-1 降级、M2-G 前移）

> **订正（2026-11-13，交接测试抓出两处顺序问题）**：
> ① R-1 不是"生死点"（`ctx.webServer.register` 是第一方公开服务），把它当半天风险会挤掉真正该先做的事；
> ② M2-G 改的是 `core/render.js`，若放在第 8 步，前 7 步的 UI 验收全跑在一个**即将被改的渲染器**上。

1. ✅ **M1.5 的三个放行条件已由复核者修完**（测试 691→722，变异 SURVIVED 5→0）。**已完成，不必重做**；
1.5. ⚠️ **必修 9.5 的 H4 正则 bug**（去掉末尾 `\b`，+ 7 条测试 + 文案补样例）。
   **在写任何 UI 之前做**——理由：M2 的施工者**每写一份交接都会撞上它**（演练里连建 4 份才过），
   而它只改 `core/handover.js` 一行正则，**属于 M1.5 的判据缺陷，不是 M2 的功能**；
2. **验 R-1（10 分钟，不是半天）**：照 skill-explorer 的写法试 `inject: ['webServer']` + `ctx.webServer.register`。
   这一步现在是"照抄验证"，**不是"探险"**（见 §3.5 的订正）；
3. **`server/snapshot.ts` + 单测**——纯函数，最快出成果，**不依赖 R-1**（只依赖数据形状）；
4. **M2-G（预算优先级）**——前移到这里的理由：
   - 它是**纯 host**、可单测、不依赖浏览器；
   - 它改 `core/render.js`，**改完必须重跑 L1–L9**——这时候还没写 UI，重跑成本最低；
   - 放在最后会让前 7 步的 UI 验收跑在一个即将被改的渲染器上；
5. **`server/routes.ts` + 一个最小 `client.js`**（只注册空面板）——**先证明 `panellist`+`main` 能跑通**，
   这比先做 UI 重要（Q7 的两个 slot 少一个就白做）；
6. **`sessionId` 管道 + 预览地址**（M2-B 的第一个产出）——`fileAddressFor(sessionId, cwd, relPath)`，
   **没有它 M2-B 会静默失败**（§3.4 的订正）；
7. **`dashboard`**（M2-A）——验收 M2-1 / M2-2 / M2-6；
8. **`graph` / `deliverables` / `graveyard`**（M2-C / D / E）——主栏三块，验收 M2-8 / M2-9 / M2-5；
9. **M2-F**（如果 R-7 确认能拿到数据），验收 M2-10；
10. **重启 DSH → 跑 M2-1 ~ M2-10**。

> ⚠️ **第 5–9 步每一步都要走完整验证链**：`build` → 重启 DSH → **浏览器硬刷新** → 验（见 §14）。
> 这个串行瓶颈才是工期的真实分母——**不要攒到最后一次性验**。

> **第 2 步和第 5 步是刻意的**：R-1 决定数据通道走哪条路，`panellist`+`main` 决定 UI 能不能被打开。
> 这两件事错了，后面的 UI 全是白写，而且**症状都很奇怪**（前者是看板永远空，后者是点了没反应）。

---

## 14. 一条新增的铁律：**改 client 也要重启**

M1.5 反复栽在「单测全绿，但运行中的插件是旧代码」上（记录了 3 次）。
M2 **更严重**：client bundle 有**两层缓存**——

1. host 侧的 bundle 组合（`/plugins` 路由）；
2. **浏览器侧的模块加载器与 HTTP 缓存**（`rev=` 内容哈希）。

所以 M2 的验证流程是：
**改代码 → `pnpm build` → 重启 DSH → 浏览器硬刷新（Ctrl+Shift+R）→ 再验**。

> **一个廉价的"新代码在跑吗"探针**：在面板上显示一个**只有新代码才有的版本号**（如 `v2.0.1`），
> 与 `package.json` 的 `version` 对齐。看不到它，就说明你看到的还是旧 bundle。

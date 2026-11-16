---
id: m2-r1-and-m2a-data
title: M2 施工：R-1 通过 + M2-A 数据源实机验证
role: evidence
order: 20
status: authoritative
summary: R-1 已真机验通（4 路由注册 + HTTP 200）；dogfood 快照与索引块逐字段一致（0/7→1/7 同步变化）。
basis: 实测
---

# M2 施工：R-1 通过 + M2-A 数据源实机验证

> 这份文档记录 SPEC §13 第 2、3 步的**实机结论**。全部可重跑，命令附在每节末尾。
> **前置**：DSH 已于 2026-11-13 18:05 重启（`inject` 声明必须重启才生效，
> 见 `M2-施工记录-宿主重载真相.md`）。

## 一、R-1：`ctx.webServer.register` **已验通**（不再是"10 分钟照抄"里的未知项）

### 1.1 判据与结果

插件里写了一个**自证探针**（`index.js`，只在启动时写一次，见 §四），重启后读出：

```jsonc
{
  "at": 1794562626446,
  "pid": 2168,                  // 真实宿主进程（不是测试进程 —— 这条是 §四教训的产物）
  "inject": ["tools","systemPrompt","fs","webServer"],
  "registered": true,           // ← 4 条路由全部注册成功
  "routes": ["exact /api/ddd/ping", "exact /api/ddd/index",
              "exact /api/ddd/archive", "exact /api/ddd/restore"],
  "hasWebServer": true,         // ← 注入生效
  "viaGet": "object",           // ← ctx.get('webServer') 也拿得到
  "inOperator": true
}
```

外部 HTTP（**这是 SPEC §3.1 要求的那一下**）：

| 路径 | 状态 | 响应 |
|---|---|---|
| `GET /api/ddd/ping` | **200** | `{"ok":true,"pong":true,"version":1}` |
| `GET /api/ddd/index` | **200** | 结构完整的快照 JSON |
| `GET /api/ddd/nonexistent-xyz` | 401 | 未注册路径走认证分支（**对照组**） |

### 1.2 根因：`inject` 必须声明，且**必须重启**

| 事实 | 证据 |
|---|---|
| `ctx.get('webServer')` 在**没声明 inject 时**拿不到 | 探针早期输出 `hasWebServer: false` |
| 声明 `inject: ['webServer']` 后两条路都通 | 探针 `hasWebServer: true` / `viaGet: "object"` |
| `inject` **只在 `apply()` 执行时生效一次** | 改完 `inject` 不重启 → 探针仍是 `false`；重启后 → `true` |
| `plugin_manager` 停用/启用**不重跑 `apply()`** | 删掉探针文件 → 停用 → 启用 → 文件**没有被重建** |

> ⚠️ **不要把 `webServer` 只放进硬依赖就完事**：headless / SDK 组合没有 HTTP 层，
> 那样整个插件都不激活，**连门禁也会失效**。所以 `registerRoutes` 保留
> 两条取法 + 全 try/catch，缺服务时只 warn（SPEC §5.3-1）。

### 1.3 为什么外部探测曾经"验不了"（留作教训）

宿主的认证发生在**路由匹配之前**，所以一个不存在的 `/api/ddd/xxx` 与一个存在的路由
**都返回 401** —— 从外部无法区分。这条只能靠"重启后直接拿到 200"来判定。

## 二、M2-A 数据源：快照与索引块**逐字段一致**（M2-2 的判据）

### 2.1 环境

- 项目：`dogfood`（15 份 md，7 份必读，3 份 `sealed`）
- 会话：`session-3ecd5e49-7a0e-4d79-959a-7fe6de0ab99b`（cwd 切到 `dogfood`）

### 2.2 第一次读数（**读任何文档之前**）

索引块（宿主注入）：
```
【门禁】0/7 ｜ 未读完必读清单，改 docs/ 会被拒绝
【项目】档 2 的入口索引：先读哪一份、哪些是陷阱、哪些已过期
【预算】必读 7 份 ≈ 51.9k tokens（上限 30k）⚠️ 超出上限
```

接口 `GET /api/ddd/index?cwd=<dogfood>&sessionId=<上面那个>`：
```jsonc
{
  "gate": { "read": 0, "required": 7, "ready": false },
  "budget": { "required": 7, "tokens": 51924, "limit": 30000, "over": true, "overBy": 21924 },
  "project": "档 2 的入口索引：先读哪一份、哪些是陷阱、哪些已过期",
  "slice": "",
  "required": [ 7 条，全部 read:false ],
  "forbidden": [ 3 条，均带 "🔴 不要执行：…" ],
  "anomalies": [],
  "all": 15
}
```

**逐字段核对**：

| 索引块 | 快照 | 一致 |
|---|---|---|
| `【门禁】0/7` | `gate.read=0, gate.required=7` | ✅ |
| `≈ 51.9k tokens（上限 30k）⚠️ 超出` | `tokens:51924, limit:30000, over:true` | ✅ |
| `【项目】档 2 的入口索引…` | `project: "档 2 的入口索引…"` | ✅ |
| `【禁止执行】` 3 条 | `forbidden.length = 3` | ✅ |
| （无异常段） | `anomalies: []` | ✅ |

> **`over` 字段名验证**：这是 SPEC §4.2 订正 1 的点。若照第一版写成 `overflow`，
> 看板会永远读到 `undefined` —— **不报错、也不报警**。

> **`slice` 为空是对的**：`dogfood` 的 `role: index` 没有 `slice` 字段，
> 按「拿不到就留空，不写占位」处理（R-8 的已知限制）。

### 2.3 第二次读数（**读完 `read-order` 之后**）

我实际 `read` 了 `dogfood/docs/00. 阅读顺序.md`（id = `read-order`），索引块随即变成：

```
【门禁】1/7 ｜ 未读完必读清单，改 docs/ 会被拒绝
【已读】
- `read-order` · … · 🟢 · v8c6246
```

接口同参数再查：
```jsonc
{
  "gate": { "read": 1, "required": 7, "ready": false },
  "required": [ "read-order:true", 其余 6 条 "false" ]
}
```

**两处同时从 0/7 变成 1/7，且变的恰好是 `read-order` 那一份。**
这满足 SPEC §8.4 对 M2-2 的额外要求：
> 「**必须在一个 `N>0` 的会话里验**；**且读过 1 份后两处仍一致**」

### 2.4 为什么这不是"写死也能过"

`gate.read` 来自**会话级** `readSet`（`registry.readSetFor(session)`），判据是
「记录存在 **且 指纹相同**」。三条反证：

1. 换成**另一个会话 id** 查，`read` 回到 0 —— 说明它真的按会话算，不是全局值；
2. 单元测试里有一条「指纹变了 = 未读」：readSet 记的是旧指纹时 `read` 必须是 0；
3. 一次同源一致性测试用**同一个注册表**同时算索引块与快照，比对 `N/M`（见 `test/snapshot.test.js`）。

## 三、这轮修掉的两个真问题

### 3.1 `prober.peek` → `prober.ensure`（**看板永远显示 0** 的根因）

第一版 `snapshotOf` 用 `prober.peek(cwd)`。而 `peek` 是**同步、只读缓存、绝不读盘**的
（`adapters/probe.js:140`），探测只在会话的 `agent/pre-step` 触发。

**后果**：一个从没被任何会话打开过的目录，缓存里什么都没有 → `projectRoot: undefined`
→ 快照返回 `{gate:{read:0, required:0}, ...}`。

**症状特别坏**：HTTP **200** + 结构合法 + **全是 0**。看起来像"这个项目没有必读文档"，
而不像"探测没跑"。实测 `dogfood` 有 15 份 md 却返回 `required: 0`。

**修法**：`await prober.ensure(cwd)`（异步读盘，撞上了就现探一次，之后走缓存）。

**验证**：用真实 `resolveConfig({})` 跑 `createProber().ensure(dogfood)` →
`{"hasMarker":true,"projectRoot":"…\\dogfood","via":"marker"}`。

> ⚠️ 这条修复在 `apply()` 里，**必须重启才生效**（§1.2 的同一条规律）。

### 3.2 `_rv/orig` 存的是修复前的代码（**变异测试测了旧代码**）

`_rv/mutate.mjs` 的机制是「改坏 → 跑测试 → 从事先存好的 `_rv/orig/` 恢复」。
但 `_rv/orig/core/handover.js` 是 **H4 修复之前**存下来的。

**后果**：改 `core/handover.js` 之后跑变异，跑完会把**旧版**恢复进 `_rv/ddd-bundle`，
下一次变异就测在旧代码上 —— 而我当时报告的「CAUGHT 29 / SURVIVED 0」正是那一轮。

**修法**：把修复版同步进 `_rv/ddd-bundle` **和** `_rv/orig`，重跑变异仍是 `CAUGHT 29 / SURVIVED 0`，
并确认跑完后 `ddd-bundle/core/handover.js` **仍带修复**。

## 四、给下一个人的警告：**三次「假绿」，同一根病因**

| # | 假象 | 真相 | 怎么发现的 |
|---|---|---|---|
| 1 | H4 新测试 14 条全绿 | 其中 2 条在**有 bug 的代码上也是绿的**（被别的正则分支命中） | 把修复**回退**，看测试是否变红 → 6 条变红才发现 |
| 2 | 「停用/启用 bundle 能重载插件」 | 探针是**测试进程**写的，不是宿主 | **删掉**探针文件 + 加 `pid` → 文件没被重建 |
| 3 | 变异 `CAUGHT 29 / SURVIVED 0` | `_rv/orig` 是修复前的，测的是**旧代码** | 跑完后检查 live 是否仍带修复 → 发现已被冲掉 |

**共同点**：都是拿「一个看起来对的观测」当结论，**没有回头验它的前提**。
这三种都和交接 §2 里那张「5 个曾存活变异」表的病因一模一样 ——
**只不过前三次发生在别人身上，这三次发生在我身上。**

**可复用的三条自检**（本切片已经用它们抓到三次）：
1. 测试变绿之后，**把修复回退掉**再跑一遍，看它是否变红；
2. 观测到"文件/状态变了"之后，**先问它是谁写的**（加 `pid`、加时间戳、删掉看会不会重建）；
3. 变异/回归跑绿之后，**回头确认被测的还是新代码**（检查 `_rv/orig` 与 `_rv/ddd-bundle` 的哈希）。

## 五、可重跑命令

```powershell
$node='C:\Users\slimeball\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'

# R-1：路由活着
Invoke-WebRequest http://127.0.0.1:<当前GUI端口>/api/ddd/ping

# M2-A：dogfood 快照
# 注意：端口每次重启都变，从 runtime context 里取
Invoke-WebRequest "http://127.0.0.1:<端口>/api/ddd/index?cwd=C%3A%5CUsers%5Cslimeball%5CDocuments%5Cdeepseek-harness%5CDDD%E6%8F%92%E4%BB%B6%E6%96%BD%E5%B7%A5%5Cdogfood"

# 单测 / 冒烟 / 变异
cd ddd-bundle; & $node --test --test-isolation=none
cd ..;       & $node _ref\smoke-ddd.mjs
cd ..;       & $node _rv\mutate.mjs
```

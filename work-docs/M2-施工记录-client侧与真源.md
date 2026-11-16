---
id: m2-client-side
title: M2 施工：client 半侧（技术栈切换）+ M2-D/E 真源
role: evidence
order: 30
status: authoritative
summary: TS+tsdown 构建链落地（32KB 单文件 bundle）；M2-A~E 代码完成；828 单测全绿；两套变异 8/8 与 29/0 全抓。
basis: 实测
---

# M2 施工：client 半侧（技术栈切换）+ M2-D/E 真源

> 覆盖 SPEC §13 第 5–9 步的**代码部分**。
> 实机验收（M2-1 ~ M2-10）需要重启 DSH 之后才能跑，见 §六。

## 一、技术栈切换（M2-Q5）：已完成，且**边界比 SPEC 窄**

### 1.1 边界（这是刻意的，也是 M2-W4 的答案）

| 目录 | 语言 | 为什么 |
|---|---|---|
| `server/` | **TypeScript** | 新代码，M2 才出现 |
| `src/client/` | **TypeScript** | 同上 |
| `core/` / `adapters/` / `tools/` / `docs/` / `index.js` | **保持 `.js`** | 5 500 行已验证代码，迁一次要重跑 M0/M1/M1.5 全部实机判据 |

**722 条既有单测的运行方式一个字符都没改**：`node --test --test-isolation=none`。
新代码用 `.ts`，`.js` 测试直接 `import '../server/snapshot.ts'` ——
**Node 24 原生剥离类型，不需要任何 flag**（实测，见 §1.3）。

### 1.2 构建链

```
tsdown 0.23.7 + typescript 7.0.2（装在 ddd-bundle 的 devDependencies）
入口 src/client/boot.tsx → 产物 lib/client.js（单文件，32 050 B）
```

三条硬配置（每一条错了都白做）：

| 配置 | 值 | 错了会怎样 |
|---|---|---|
| `format` | **`cjs`** | 用 `iife` 会把 `react` 变成 `window.React` 全局引用，宿主不提供 → 整个 bundle 抛错 → **面板不出现**（与"没注册"同形） |
| `deps.neverBundle` | `['react','react-dom','react/jsx-runtime']` | 打进来一份自己的 React → hooks 崩（Invalid hook call） |
| `outExtensions` | `js: '.js'` | cjs 默认输出 `.cjs`，而 `exports['./client']` 指向 `lib/client.js` → **文件不存在 → 插件整体加载失败（R-11）** |

产物的头尾（与真实可运行的 `dsh-cuigengji-plugin/lib/client.js` 同形）：

```js
window.__ModuleLoader__.load({id:"@local/ddd",factory:(require)=>{var module={exports:{}};
  … CJS 产物，require('react') 原样保留 …
return module.exports.default !== undefined ? module.exports.default : module.exports;}});
```

### 1.3 M2-W4 的答案：**(b) `--experimental-strip-types` 都不需要**

Node 24.21 **默认**就能 `import './x.ts'`。实测：

```powershell
node -e "import('./mod.ts').then(m => console.log(m.double(21)))"   # → 42
```

所以 SPEC §8.3 的三条路里，(b) 的成本是**零**——连 flag 都不用加。
一条命令仍然跑完 828 条：`node --test --test-isolation=none`。

## 二、M2-A ~ M2-E 的实现落点

| 目标 | 文件 | 关键决定 |
|---|---|---|
| **M2-A** 施工看板 | `src/client/dashboard.tsx` | 异常**置顶**；loading / error+重试 / empty 三态齐全（不许白屏）；**不猜**：`slice`/`nextStep`/`basisDoc` 取不到就整行不显示 |
| **M2-B** 文档预览 | `src/client/api.ts` 的 `previewAddressOf` | 复用 `ctx.sidebarRight.openResource`，**不写渲染器**；地址必须是 `session` scope |
| **M2-C** 图谱 | `src/client/main-page.tsx` 的 `GraphTab` | **纵向缩进树**（不是横向）；按 role 分组、组内按 order；`sealed` 灰显 + 🔴；`anomalies` 置顶 |
| **M2-D** 交付网格 | `src/client/main-page.tsx` 的 `DeliverablesTab` + `server/deliverables.ts` | **未 `present` 的标「未声明」**（不是可选） |
| **M2-E** 归档 | `src/client/main-page.tsx` 的 `GraveyardTab` | 只列清单 + 勾选；**client 不碰文件**；每条**必须带 reason**（没有就显式标「⚠️ 没有理由」） |

**双注册**（Q7）：`src/client/index.tsx` 的 `registerPanel`
—— `sidebar.panellist` 的 `id` 与 `main` 的 `key` 都是 `PANEL_ID` 常量，两处都包在 `slots.inject` 里。

## 三、R-10 那座桥找到了：**它在会话事件流里**

SPEC §11 R-10 说「`present` 判定链是空的」。我核到的真相：

| 位置 | 内容 |
|---|---|
| `dsh-tool-present/lib/index.js:119` | `session.append('deliverables/presented', { turn, callId, files })` |
| `dsh-client-ui-deliverables` README | 客户端就是折叠这个事件来渲染交付卡片的 |

所以桥**存在**，只是**没有文档化的 host API**。`server/deliverables.ts` 就是那座桥：

```ts
presentedPathsOf(session.ownEvents())   // → Set<归一化绝对路径>
```

⚠️ **两处"照实现反推契约"的地方**（都在本切片）：
1. 预览地址格式（`dsh-resource://file/session/<sid>/<相对路径>`）；
2. `deliverables/presented` 事件名与载荷。

**它们都不会在改动时报警**，只会静默失效（预览打不开 / 全都显示「未声明」）。
所以 M2-3 与 M2-9 的验收**必须真的点开、真的构造一个没 present 的文件**，不能只看代码。

### 3.1 三种状态必须分清

| 事实 | 快照 | UI |
|---|---|---|
| 事件里有这个路径 | `presented: true` | 已声明交付 |
| 事件里没有 | `presented: false, presentedKnown: true` | 未声明 |
| **拿不到会话事件** | `presented: false, presentedKnown: false` | 未声明（但知道"不知道"） |

第三行是关键：**不许把"不知道"谎称成"确定没声明"**。

## 四、测试与变异

| 套件 | 结果 |
|---|---|
| 全量单测 | **828 / 828 全绿**（722 原有 + 106 新增） |
| 装配冒烟 | **ALL GOOD**（含 SPEC §8.2 的 4 条 + 2 条 M2 补充） |
| M1.5 变异（31 个） | **CAUGHT 29 / SURVIVED 0 / BAD-ANCHOR 2** |
| **M2 变异（8 个，新增）** | **CAUGHT 8 / SURVIVED 0 / BAD-ANCHOR 0** |

新增测试分布：

| 文件 | 条数 | 守什么 |
|---|---|---|
| `test/h4-chinese-evidence.test.js` | 14 | H4 认中文证据，且**不放宽** |
| `test/snapshot.test.js` | 25 | 快照纯函数 + **M2-2 同源一致性** |
| `test/routes.test.js` | 18 | 路由 + **注册绝不抛** |
| `test/budget-hint.test.js` | 14 | M2-G 四条判据 |
| `test/client-api.test.js` | 15 | 取数层 200/401/404/500/超时/坏 JSON |
| `test/deliverables.test.js` | 17 | 交付/坟场真源 |
| `test/decoupling.test.js` | +2 | `server/` 不许 `node:` |
| `test/assembly.test.js` | +1 | 路由 warn 不连累门禁 |

### 4.1 M2 变异执行器为什么要单独写一个脚本

我第一版用 PowerShell 的 `Get-Content` / `Set-Content -NoNewline` 做字符串替换 ——
**把一份 151 行的 `.ts` 压成了一行**（`-NoNewline` 吃掉行尾），Node 报
`SyntaxError: Expression expected`。

那次改的是临时副本，活动副本没坏。但**"用 shell 改代码"这件事本身不可靠**：
换行、编码、引号转义三处都可能悄悄改坏文件，而症状会伪装成"代码有 bug"。

所以改成 `_rv/mutate-m2d.mjs`：读原文 → 精确替换 → **校验只改了预期处** → 跑测试 → **无论结果如何立刻还原** →
最后**校验工作副本已还原**。它还会先跑一次基线，基线不全绿就拒绝判"抓住"。

## 五、三次「假绿」的完整记账（本切片共 5 次）

| # | 假象 | 真相 | 怎么发现的 |
|---|---|---|---|
| 1 | H4 新测试 14 条全绿 | 其中 2 条在**有 bug 的代码上也是绿的** | 回退修复，看是否变红 |
| 2 | 「停用/启用 bundle 能重载插件」 | 探针是**测试进程**写的 | 删掉文件 + 加 `pid` |
| 3 | 变异 CAUGHT 29/0 | `_rv/orig` 是修复前的 | 跑完检查 live 是否仍带修复 |
| 4 | M2-G「量词」测试 | 断言先命中行首「必读 1 份」 | 实机输出写「两份」却列 3 个 id |
| 5 | 「零依赖」检查失败 | 注释里的示例 import 被当真 | 给检查加剥注释（`decoupling.test.js` 早就有，smoke 没同步） |

**共同点**：拿「一个看起来对的观测」当结论，**没回头验前提**。

**可复用的四条自检**（本切片用它们抓到 5 次）：
1. 测试变绿后，**把修复回退**再跑，看它是否变红；
2. 观测到"文件/状态变了"后，**先问它是谁写的**（`pid` + 时间戳 + 删掉看会不会重建）；
3. 变异/回归跑绿后，**回头确认被测的还是新代码**（`_rv/orig` 与 `_rv/ddd-bundle` 哈希）；
4. **断言必须锚定作用域**（`includes('1 份')` 会命中行首的「必读 1 份」）。

## 六、需要重启才能验的清单（**代码已就绪**）

`dsh.client` 声明与 `lib/client.js` 都是**宿主在 Loader 层读**的，
而 `apply()` 的改动只在重启后生效（见 `M2-施工记录-宿主重载真相.md`）。所以下面这些**必须重启后验**：

| 判据 | 怎么验 | 现在能确定的部分 |
|---|---|---|
| **M2-1** 面板出现 | 左栏看到入口行 → 点它主栏打开看板 | smoke 断言了双注册成对 + bundle 形态正确 |
| **M2-2** 看板数据正确 | 与索引块 `【门禁】N/M` 比对 | **已验**（`M2-施工记录-R1与M2A数据源.md` §二，0/7→1/7 同步变化） |
| **M2-3** 点开文档能预览 | 点图谱节点 → 右栏出全文 + frontmatter 键值表 | 地址格式已核对文档，但**必须实点** |
| **M2-4** 非 DDD 项目不出现 | 在普通仓库里看左栏 | `EmptyView` 已实现；需与 M2-1 同版本对照 |
| **M2-5** 归档闭环 | 勾选 → 归档 → 文件真的进 `docs/_graveyard/` | **未实现**：`/api/ddd/archive` 的 `archive` 依赖仍返回 501（见 §七） |
| **M2-6** 看板随状态变化 | `doc_mark` 改 status → 刷新后看到变化 | 刷新策略：**用户操作触发**（不轮询，`uiRefreshMs=0`） |
| **M2-8** 图谱可导航 | 纵向缩进树、role 分组、sealed 灰显、anomalies 置顶 | 代码已实现 |
| **M2-9** 交付网格标「未声明」 | 构造一个没 present 的文件 | 真源已接通 |
| **M2-10** 占用提醒（M2-F） | — | **未做**：R-7 未确认，见 §七 |

## 七、这一步**刻意没做**（诚实清单）

| 没做 | 为什么 | 影响 |
|---|---|---|
| **M2-E 的物理移动**（`/api/ddd/archive` 真正实现） | 它要写盘（`ctx.fs` + 沙箱 policy），而这一轮先把"只读 + 数据源"做扎实。SPEC §5.3-4 要求照抄 `sandboxPolicyOf`，那是另一件事 | **M2-5 不能验收**；路由目前返回 501「归档未装配」——这是**显式失败**，不是静默 |
| **M2-F 占用提醒** | R-7 未确认：client 侧拿不到 token 用量（host 有 `tokenMeter` 服务，但那是 host 面） | M2-10 记为「砍掉」，按 SPEC「拿不到就砍」 |
| **`nextStep` / `basisDoc` 的真源** | 要从交接文档 §3 抠「第一行」与「依据文档」。那是**文本解析**，属于判据，不该由 UI 猜 | 看板这两行**不显示**（不猜、不写占位） |
| **M2-G 的实机可见** | `inject.js` 的渲染闭包要重启才换（HMR 只换模块，不换已注册的闭包） | 代码与单测已验；实机待重启 |
| **`uiEnabled` 关掉 client bundle** | **做不到**：`dsh.client` 是宿主读 `package.json` 决定的，插件 config 到不了那层 | 已改注释说清：它只关 host 路由 |

> ⚠️ 最后一条是我**改掉的错误注释**：原注释写「关掉就不注册 client bundle」，
> 而实际改成 false 后**面板照样出现、只是永远显示没有数据** —— 那个症状会被误诊成
> "client bundle 有问题"。这类"注释承诺了代码做不到的事"比没注释更糟。

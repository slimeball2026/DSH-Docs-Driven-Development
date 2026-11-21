window.__ModuleLoader__.load({id:"@local/ddd",factory:(require)=>{var module={exports:{}};var exports=module.exports;
// \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") {
		for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
			key = keys[i];
			if (!__hasOwnProp.call(to, key) && key !== except) {
				__defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
		}
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

let react = require("react");
react = __toESM(react, 1);

// src/client/api.ts
/**
* M2-A/B/C/D/E 的数据契约与取数层（**纯前端，零文件系统**）。
*
* ---- 三条硬约束 ----
*
* 1. **client 跑在浏览器里，没有文件系统**（SPEC §10 第 3 条）。
*    所有文件操作都必须 POST 回 host；这里只有 `fetch`。
* 2. **首屏必须有 loading 态，失败必须有错误态 + 重试**（SPEC §6.1）。
*    **不许白屏** —— 白屏比报错更难查，用户会以为是插件没装。
* 3. **`sessionId` 是请求的必需参数**（SPEC §4.2 订正 2）。
*    缺了它 `gate.read` 会退化成"全都未读"，而且**不报错**。
*/
/** 路由路径（与 `server/routes.ts` 的 `ROUTES` 逐字一致；两边都有断言）。 */
const ROUTES = {
	index: "/api/ddd/index",
	archive: "/api/ddd/archive",
	restore: "/api/ddd/restore",
	ping: "/api/ddd/ping",
	/** 已知项目根列表（M2.2）。**cwd 由用户显式选，不由 client 猜。** */
	projects: "/api/ddd/projects",
	/** 让 host 清掉某目录的探测缓存并重新探测（M2.2）。 */
	recheck: "/api/ddd/recheck",
	/** 一键把目录初始化成 DDD 工作区（M2.2）。 */
	init: "/api/ddd/init"
};
/**
* 拼查询串。
*
* `cwd` 与 `sessionId` 都**必须**带：前者决定看哪个项目，后者决定 `gate.read`。
*
* @param cwd 项目工作目录（绝对路径）
* @param sessionId 会话 id
*/
function indexUrl(cwd, sessionId) {
	const params = new URLSearchParams();
	if (cwd !== "") params.set("cwd", cwd);
	if (sessionId !== "") params.set("sessionId", sessionId);
	return `${ROUTES.index}?${params.toString()}`;
}
/**
* 取快照。
*
* ⚠️ **超时是自己实现的**（`AbortController`）：一个卡住的请求会让看板永远停在
* loading，而那看起来和"正在加载"一模一样。
*
* @param cwd
* @param sessionId
* @param timeoutMs 默认 8 秒
*/
async function fetchSnapshot(cwd, sessionId, timeoutMs = 8e3) {
	const controller = typeof AbortController === "function" ? new AbortController() : void 0;
	const timer = controller === void 0 ? void 0 : setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(indexUrl(cwd, sessionId), {
			method: "GET",
			headers: { accept: "application/json" },
			signal: controller?.signal
		});
		if (!response.ok) return {
			kind: "error",
			message: `HTTP ${response.status}${await statusHintOf(response.status)}`
		};
		const text = await response.text();
		if (text.trim() === "") return {
			kind: "error",
			message: "host 返回了空响应（路由注册了但处理失败？）"
		};
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			return {
				kind: "error",
				message: `host 返回的不是 JSON：${text.slice(0, 120)}`
			};
		}
		const snapshot = parsed;
		if (snapshot === null || typeof snapshot !== "object" || snapshot.ok !== true) return {
			kind: "error",
			message: "host 返回的快照形状不对（缺 ok:true）"
		};
		return {
			kind: "ok",
			data: snapshot
		};
	} catch (error) {
		if (error?.name === "AbortError") return {
			kind: "error",
			message: `请求超时（>${timeoutMs}ms）。host 可能卡住了，点重试。`
		};
		return {
			kind: "error",
			message: `请求失败：${error?.message ?? String(error)}`
		};
	} finally {
		if (timer !== void 0) clearTimeout(timer);
	}
}
/**
* 取已知项目根列表（M2.2）。
*
* ---- 为什么这个请求没有参数 ----
*
* 它问的是"这台机器上**有哪些**项目"，不是"当前是哪个"。
* 后者 client 不可能知道（宿主不给 root-scope 面板会话绑定），
* 所以列表必须由 host 出、由用户选。
*
* 失败时返回 `[]` 而不是抛：项目选择器为空只意味着"没法选"，
* 不该让整个面板炸掉。
*
* @param timeoutMs 默认 8 秒
*/
async function fetchProjects(timeoutMs = 8e3) {
	const controller = typeof AbortController === "function" ? new AbortController() : void 0;
	const timer = controller === void 0 ? void 0 : setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(ROUTES.projects, {
			method: "GET",
			headers: { accept: "application/json" },
			signal: controller?.signal
		});
		if (!response.ok) return [];
		const parsed = await response.json();
		if (parsed?.ok !== true || !Array.isArray(parsed.projects)) return [];
		return parsed.projects.filter((item) => item !== null && typeof item === "object" && typeof item.cwd === "string" && item.cwd !== "");
	} catch {
		return [];
	} finally {
		if (timer !== void 0) clearTimeout(timer);
	}
}
/**
* 让 host 重新探测某个目录（M2.2）。
*
* ⚠️ **这个函数存在的理由**：host 的探测有 TTL 缓存（`PROBE_TTL_MS`）。
* 用户在目录里新建 `docs/` 之后点"刷新"，如果只重取快照，
* 探测结果仍命中旧缓存 → 面板一直说"这不是 DDD 项目"。
*
* @param cwd 要重新探测的目录
*/
async function postRecheck(cwd, timeoutMs = 15e3) {
	try {
		const response = await fetch(ROUTES.recheck, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json"
			},
			body: JSON.stringify({ cwd }),
			signal: typeof AbortController === "function" ? AbortSignal.timeout(timeoutMs) : void 0
		});
		if (!response.ok) return { ok: false };
		return await response.json();
	} catch {
		return { ok: false };
	}
}
/**
* 把一份"坏结果"补齐成 `GraveyardResult` 形状。
*
* 三条路径都会用到（网络失败 / 非 2xx / JSON 解析失败），抽出来是为了
* **形状只有一处定义** —— 三处各写一遍就会有一处漏掉某个数组。
*
* @param error 给用户看的一句话
* @returns 形状合法的失败结果
*/
function graveyardFailure(error) {
	return {
		ok: false,
		error,
		moved: [],
		failed: []
	};
}
/**
* 把 host 返回的任意对象**规范化**成 `GraveyardResult`。
*
* 为什么不在 UI 里直接读 `parsed.moved.length`：host 的两处早退
* （"不是 DDD 项目" / "路由未装配"）历史上曾经**不带数组**，
* 直接读会白屏。规范化放在这一层，UI 就永远拿到安全形状。
*
* @param parsed host 返回的 JSON
* @returns 规范化结果
*/
function normalizeGraveyardResult(parsed) {
	const data = parsed !== null && typeof parsed === "object" ? parsed : {};
	return {
		ok: data.ok === true,
		error: typeof data.error === "string" ? data.error : void 0,
		moved: Array.isArray(data.moved) ? data.moved : [],
		failed: Array.isArray(data.failed) ? data.failed : []
	};
}
/**
* 归档：把若干份 `status: void` 的文档物理移到 `docs/_graveyard/`（M2-E）。
*
* ---- 为什么 client 只发 id，不发路径 ----
*
* 这是 M2-Q6 的权限分工：**client 永远不碰文件**，它只 POST 一组 id；
* 路径解析、移动、元数据写入全部在 host 侧（`server/write-engine.ts`）。
* 所以这里连 `cwd` 都不用传 —— host 从 `sessionId` 定位项目。
*
* @param ids 要归档的文档 id
* @param options.sessionId 当前会话 id（host 用它定位项目与 readSet）
* @param options.cwd 项目根（**兜底**：root 面板没有 sessionId 时用）
* @returns 规范化结果（**绝不抛**）
*/
async function postArchive(ids, options = {}) {
	return postGraveyardAction(ROUTES.archive, ids, options);
}
/**
* 还原：把坟场里的文档放回原处（M2-E）。
*
* ⚠️ 参数是**坟场里的相对路径**（`docs/_graveyard/xxx.md`），不是 id ——
* 因为坟场里的文件已经不在注册表里了，没有 id 可查。
* 这一点与 `postArchive` 不同，别为了"对称"把两者写成一样。
*
* @param paths 坟场里的相对路径
* @param options 同 `postArchive`
* @returns 规范化结果（**绝不抛**）
*/
async function postRestore(paths, options = {}) {
	return postGraveyardAction(ROUTES.restore, paths, options);
}
/**
* 归档 / 还原的**共用请求体**。
*
* 两者 host 侧都接受 `ids` 或 `paths`，所以这里两个键都带上 ——
* 少带一个会让 host 认为"没有要处理的条目"而返回成功空数组，
* 那种"成功但什么都没做"比报错更难查。
*
* @param route 路由
* @param items id 或路径
* @param options 选项
* @returns 规范化结果
*/
async function postGraveyardAction(route, items, options = {}) {
	const list = Array.isArray(items) ? items.filter((item) => typeof item === "string" && item !== "") : [];
	if (list.length === 0) return graveyardFailure("没有选中任何条目");
	const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 2e4;
	try {
		const response = await fetch(route, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json"
			},
			body: JSON.stringify({
				ids: [...list],
				paths: [...list],
				sessionId: options.sessionId ?? "",
				cwd: options.cwd ?? ""
			}),
			signal: typeof AbortController === "function" ? AbortSignal.timeout(timeoutMs) : void 0
		});
		if (!response.ok) return graveyardFailure(`请求失败（HTTP ${response.status}）${statusHintOf(response.status)}`);
		return normalizeGraveyardResult(await response.json());
	} catch (error) {
		return graveyardFailure(`请求失败：${error?.message ?? String(error)}`);
	}
}
/**
* 一键把目录初始化成 DDD 工作区（M2.2）。
*
* 目标已存在时 host 会**跳过而不覆盖**，并在 `skipped` 里说清 ——
* 这个函数只是把那个结果原样带回来，不做任何判断。
*/
async function postInit(cwd, timeoutMs = 2e4) {
	try {
		const parsed = await (await fetch(ROUTES.init, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json"
			},
			body: JSON.stringify({ cwd }),
			signal: typeof AbortController === "function" ? AbortSignal.timeout(timeoutMs) : void 0
		})).json();
		return {
			ok: parsed?.ok === true,
			error: typeof parsed?.error === "string" ? parsed.error : void 0,
			created: Array.isArray(parsed?.created) ? parsed.created : [],
			skipped: Array.isArray(parsed?.skipped) ? parsed.skipped : [],
			failed: Array.isArray(parsed?.failed) ? parsed.failed : [],
			isDdd: parsed?.isDdd === true
		};
	} catch (error) {
		return {
			ok: false,
			error: `初始化请求失败：${error?.message ?? String(error)}`,
			created: [],
			skipped: [],
			failed: []
		};
	}
}
/** 给常见状态码补一句人话（401 最常见：那是宿主的认证，不是我们的 bug）。 */
function statusHintOf(status) {
	if (status === 401) return " —— 未通过宿主认证（这个路由要在 DSH 自己的界面里访问）";
	if (status === 404) return " —— 路由不存在（host 侧没注册成功？）";
	if (status === 405) return " —— 方法不对";
	if (status >= 500) return " —— host 侧处理失败";
	return "";
}
/**
* 预览地址（M2-B）。
*
* ---- 地址格式（照 `dsh-util-workspace-path` 的真实实现抄，不再靠文档猜）----
*
* `src/file-address.ts` 的 `sessionFileAddress(sessionId, path)` 产出：
*
* ```
* dsh-resource://file/session/<encodeSegment(sessionId)>/<encodePath(path)>
* ```
*
* 其中 `encodeSegment` 是 `encodeURIComponent` **再把 `%3A` 还原成 `:`**
* （让盘符 `C:` 读起来是原样）。`encodePath` 是逐段编码、保留 `/`。
*
* ---- ⚠️ 2026-11-13 实机事故：sessionId 为空串时**必然打不开** ----
*
* `parseFileAddress` 里有一句 `if (id === undefined || id === '' || segments.length === 0) return undefined`。
* 也就是说 **sessionId 是空串时，地址直接无效**，`openResource` 拿到的就是一个解析不了的东西
* —— 用户看到的是「鼠标变手势但点击没反应」。
*
* 所以：**拿不到 sessionId 时，宁可用 `absolute` scope，也不拼一个空 session 的地址**。
* `absolute` scope 不带会话（`dsh-resource://file/absolute/<去掉前导斜杠的绝对路径>`），
* 只要路径是绝对的就能打开。
*
* @param sessionId 会话 id（空串 = 不知道，退到 absolute scope）
* @param relativePath 相对项目根的路径，`docs/x.md` 这种
* @param projectRoot 项目根绝对路径（absolute scope 需要它）
*/
function previewAddressOf(sessionId, relativePath, projectRoot = "") {
	const normalize = (text) => text.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
	/** 与官方 `encodeSegment` 一致：编码后把 `%3A` 还原成 `:`。 */
	const encodeSegment = (segment) => encodeURIComponent(segment).replace(/%3A/gi, ":");
	/** 逐段编码，保留 `/`。 */
	const encodePath = (path) => path.split("/").map(encodeSegment).join("/");
	const path = normalize(relativePath);
	if (typeof sessionId === "string" && sessionId !== "") return `dsh-resource://file/session/${encodeSegment(sessionId)}/${encodePath(path)}`;
	if (typeof projectRoot === "string" && projectRoot !== "") {
		const absolute = normalize(`${projectRoot.replace(/[/\\]+$/, "")}/${path}`);
		const unc = absolute.startsWith("//");
		const trimmed = absolute.replace(/^\/+/, "");
		return `dsh-resource://file/absolute/${unc ? "/" : ""}${encodePath(trimmed)}`;
	}
	return `dsh-resource://file/session/${encodeSegment("")}/${encodePath(path)}`;
}
/**
* 预览地址是否**可解析**（与宿主 `parseFileAddress` 同一条判据）。
*
* 用于在点开之前就判断"这个地址打不开"，而不是让用户点了没反应。
*
* @param address `previewAddressOf` 的产物
*/
function isOpenableAddress(address) {
	if (!address.startsWith("dsh-resource://file/")) return false;
	const end = address.search(/[?#]/);
	const [scope, ...rest] = address.slice(20, end === -1 ? void 0 : end).split("/");
	if (scope === "session") {
		const [id, ...segments] = rest;
		return id !== void 0 && id !== "" && segments.length > 0;
	}
	if (scope === "absolute") {
		const segments = rest[0] === "" && rest.length > 1 ? rest.slice(1) : rest;
		return segments.length > 0 && segments[0] !== "";
	}
	return false;
}

// src/client/dashboard.tsx
/**
* 施工看板（M2-A，右栏第一格）。
*
* ---- 这一屏要回答的三个问题 ----
*
* 1. **我现在能改哪份文档？** → 必读进度 + 已读/未读清单
* 2. **哪份文档坏了？** → `【文档异常】` 高亮置顶（唯一"必须马上处理"的状态）
* 3. **预算够不够？** → 超限时给"先读哪几份"
*
* ---- 三条纪律 ----
*
* - **UI 的"读"不解锁门禁**（R-5）。用户在这里点开一份文档，**AI 那边仍然显示未读**。
*   这是设计：不变量是「**改文档的人**（AI）必须读过」。所以看板上要写清楚，
*   否则会被当成 bug 反复报。
* - **不许白屏**：loading / error（带重试）/ empty 三种态都要有。
* - **不猜**：`slice` / `nextStep` / `basisDoc` 拿不到就**不显示那一行**，
*   不写「（未知）」。
*
* ⚠️ 这个文件**不 import 任何外部包**（tsdown 只把它编译成调用 `require('react')` 的代码）。
*/
const h$4 = react.createElement;
/** 精简路径：只留 `docs/` 之后的部分（看板宽度有限）。 */
function shortPath(path) {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? path : path.slice(slash + 1);
}
const styles$4 = {
	root: {
		padding: "12px 14px",
		font: "13px/1.55 system-ui, -apple-system, \"Segoe UI\", sans-serif",
		color: "var(--dsw-alias-label-primary, #e6e6e6)",
		overflowY: "auto",
		height: "100%"
	},
	section: { marginBottom: "14px" },
	label: {
		fontSize: "11px",
		letterSpacing: "0.04em",
		textTransform: "uppercase",
		opacity: .55,
		marginBottom: "4px"
	},
	big: {
		fontSize: "15px",
		fontWeight: 600
	},
	bar: {
		height: "6px",
		borderRadius: "3px",
		background: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.22))",
		overflow: "hidden",
		margin: "6px 0"
	},
	barFill: (ratio, ready) => ({
		width: `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`,
		height: "100%",
		background: ready ? "var(--dsw-alias-state-success-primary, #3fb950)" : "var(--dsw-alias-state-warn-primary, #d29922)",
		transition: "width 160ms ease"
	}),
	docRow: {
		display: "flex",
		gap: "6px",
		alignItems: "baseline",
		padding: "3px 0",
		cursor: "pointer",
		borderBottom: "1px solid transparent"
	},
	docId: {
		fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
		fontSize: "12px"
	},
	dim: { opacity: .66 },
	anomaly: {
		border: "1px solid var(--dsw-alias-state-error-primary, #f85149)",
		borderRadius: "6px",
		padding: "8px 10px",
		marginBottom: "12px",
		background: "var(--dsw-alias-bg-overlay, rgba(248,81,73,0.08))"
	},
	budgetOver: { color: "var(--dsw-alias-state-warn-primary, #d29922)" },
	hint: {
		fontSize: "12px",
		opacity: .8,
		marginTop: "4px"
	},
	button: {
		font: "inherit",
		padding: "4px 10px",
		borderRadius: "6px",
		border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.4))",
		background: "transparent",
		color: "inherit",
		cursor: "pointer"
	},
	note: {
		fontSize: "11px",
		opacity: .5,
		marginTop: "10px",
		lineHeight: 1.5
	}
};
/** loading 态：**必须有**，否则首屏是一片空白（看起来像插件坏了）。 */
function LoadingView() {
	return h$4("div", { style: {
		...styles$4.root,
		...styles$4.dim
	} }, "正在读取文档状态…");
}
/** 错误态：**必须带重试**，而且要说清是哪一类错（401 与 500 的处置完全不同）。 */
function ErrorView({ message, onRetry }) {
	return h$4("div", { style: styles$4.root }, h$4("div", { style: styles$4.anomaly }, h$4("div", { style: {
		fontWeight: 600,
		marginBottom: "4px"
	} }, "读不到文档状态"), h$4("div", { style: { fontSize: "12px" } }, message)), h$4("button", {
		style: styles$4.button,
		onClick: onRetry,
		type: "button"
	}, "重试"), h$4("div", { style: styles$4.note }, "如果反复失败：这个面板只在 DDD 项目里显示；普通仓库里没有数据是正常的。"));
}
/** 空态：不是 DDD 项目，或者项目里还没有受管文档。 */
function EmptyView({ projectRoot }) {
	return h$4("div", { style: styles$4.root }, h$4("div", { style: styles$4.label }, "文档驱动开发"), h$4("div", { style: styles$4.big }, "当前项目没有启用 DDD"), h$4("div", { style: {
		...styles$4.dim,
		fontSize: "12px",
		marginTop: "6px"
	} }, projectRoot === "" ? "没有探测到项目根。" : `项目根：${projectRoot}`), h$4("div", { style: styles$4.note }, "启用方式：在项目里建 docs/ 并放一份带合法 frontmatter 的 .md，或在 AGENTS.md 里加 `<!-- ddd:index -->` 标记。"));
}
/** 交付网格里的一格（M2-D）。 */
function DeliverableCell({ item, onOpen, previewDisabled = false }) {
	const clickable = !previewDisabled && onOpen !== void 0;
	return h$4("div", {
		style: {
			border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35))",
			borderRadius: "8px",
			padding: "10px 12px",
			cursor: clickable ? "pointer" : "default",
			minWidth: 0
		},
		...clickable ? { onClick: () => onOpen(item.path) } : {},
		title: clickable ? item.path : `${item.path}（预览需在会话页打开）`
	}, h$4("div", { style: {
		fontSize: "13px",
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	} }, shortPath(item.path)), h$4("div", { style: {
		fontSize: "11px",
		opacity: .7,
		marginTop: "4px"
	} }, item.presented ? "已声明交付" : "未声明", item.size > 0 ? ` · ${Math.max(1, Math.round(item.size / 1024))} KB` : ""));
}

// src/client/main-page.tsx
/**
* 主栏整页（M2-C 图谱 / M2-D 交付 / M2-E 归档，三块用 tab 切区）。
*
* ---- 为什么三块塞在主栏而不是右栏 ----
*
* SPEC §3.3：右栏**最多 2 个分栏**、窗口 < 768px 自动全屏、**面板没有标题行**。
* 三块塞进右栏必然要滚动且每层节点宽度受限。所以按 §3.11 的建议：
* **右栏只放施工看板，图谱/交付/归档放主栏，用 tab 切区。**
*/
const h$3 = react.createElement;
/** role 的分组顺序（与 `core/roles.js` 的枚举一致，与 host 侧 `snapshot.ts` 同序）。 */
const ROLE_ORDER = [
	"index",
	"handover",
	"spec",
	"decision",
	"evidence",
	"instruction",
	"log",
	"fact"
];
const ROLE_LABEL = {
	index: "入口索引",
	handover: "交接",
	spec: "施工图",
	decision: "决策",
	evidence: "证据",
	instruction: "指令",
	log: "日志",
	fact: "事实"
};
function statusMark(status) {
	switch (status) {
		case "authoritative": return "🟢";
		case "partial": return "🟡";
		case "draft": return "⚪";
		case "superseded": return "🔵";
		case "sealed": return "🔴";
		case "void": return "🟠";
		default: return "❔";
	}
}
const styles$3 = {
	root: {
		padding: "16px 20px",
		font: "13px/1.6 system-ui, -apple-system, \"Segoe UI\", sans-serif",
		color: "var(--dsw-alias-label-primary, #e6e6e6)",
		height: "100%",
		overflowY: "auto",
		boxSizing: "border-box"
	},
	tabs: {
		display: "flex",
		gap: "4px",
		marginBottom: "14px",
		borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))"
	},
	tab: (active) => ({
		font: "inherit",
		padding: "6px 12px",
		border: "none",
		background: "transparent",
		color: "inherit",
		cursor: "pointer",
		opacity: active ? 1 : .55,
		borderBottom: `2px solid ${active ? "var(--dsw-alias-brand-primary, #58a6ff)" : "transparent"}`
	}),
	sectionTitle: {
		fontSize: "12px",
		opacity: .55,
		marginBottom: "6px",
		letterSpacing: "0.04em"
	},
	anomaly: {
		border: "1px solid var(--dsw-alias-state-error-primary, #f85149)",
		borderRadius: "6px",
		padding: "10px 12px",
		marginBottom: "14px",
		background: "var(--dsw-alias-bg-overlay, rgba(248,81,73,0.08))"
	},
	group: { marginBottom: "16px" },
	groupHead: {
		fontSize: "12px",
		fontWeight: 600,
		opacity: .75,
		marginBottom: "6px"
	},
	node: (depth, sealed) => ({
		marginLeft: `${depth * 16}px`,
		padding: "4px 8px",
		borderRadius: "5px",
		cursor: "pointer",
		display: "flex",
		gap: "8px",
		alignItems: "baseline",
		opacity: sealed ? .5 : 1
	}),
	/**
	* 不可点击的节点（预览在本面板里不可能时用）。
	*
	* 与 `node` 的唯一区别是 **`cursor: 'default'`** —— 没有可点击手势，
	* 用户就不会去点一个注定没反应的东西。
	*/
	nodeStatic: (depth, sealed) => ({
		marginLeft: `${depth * 16}px`,
		padding: "4px 8px",
		borderRadius: "5px",
		cursor: "default",
		display: "flex",
		gap: "8px",
		alignItems: "baseline",
		opacity: sealed ? .4 : .85
	}),
	id: {
		fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
		fontSize: "12px"
	},
	fingerprint: {
		fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
		fontSize: "11px",
		opacity: .5
	},
	grid: {
		display: "grid",
		gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
		gap: "10px"
	},
	button: {
		font: "inherit",
		padding: "4px 10px",
		borderRadius: "6px",
		border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.4))",
		background: "transparent",
		color: "inherit",
		cursor: "pointer"
	},
	note: {
		fontSize: "11px",
		opacity: .55,
		marginTop: "10px",
		lineHeight: 1.5
	},
	empty: {
		opacity: .6,
		fontSize: "12px"
	}
};
/** 图谱（M2-C）：纵向缩进树，按 role 分组、组内按 order。 */
function GraphTab({ snapshot, onOpenDoc, previewDisabled = false }) {
	const groups = /* @__PURE__ */ new Map();
	for (const doc of snapshot.all) {
		const role = ROLE_ORDER.includes(doc.role) ? doc.role : "other";
		if (!groups.has(role)) groups.set(role, []);
		groups.get(role).push(doc);
	}
	const orderedRoles = [...ROLE_ORDER.filter((role) => groups.has(role)), ...groups.has("other") ? ["other"] : []];
	return h$3("div", null, snapshot.anomalies.length > 0 ? h$3("div", { style: styles$3.anomaly }, h$3("div", { style: {
		fontWeight: 600,
		marginBottom: "4px"
	} }, `⚠️ 文档异常（${snapshot.anomalies.length}）—— 这些文档现在就有问题`), snapshot.anomalies.map((item) => h$3("div", {
		key: item.id,
		style: { fontSize: "12px" }
	}, `- ${item.id || "(无 id)"}：${item.message}`))) : null, orderedRoles.length === 0 ? h$3("div", { style: styles$3.empty }, "这个项目还没有受管文档。") : orderedRoles.map((role) => h$3("div", {
		key: role,
		style: styles$3.group
	}, h$3("div", { style: styles$3.groupHead }, `${ROLE_LABEL[role] ?? "其它"}（${groups.get(role).length}）`), groups.get(role).map((doc) => {
		const sealed = doc.status === "sealed";
		const clickable = !previewDisabled && onOpenDoc !== void 0;
		return h$3("div", {
			key: doc.id,
			style: clickable ? styles$3.node(1, sealed) : styles$3.nodeStatic(1, sealed),
			...clickable ? { onClick: () => onOpenDoc(doc) } : {},
			title: clickable ? doc.summary : `${doc.summary}（预览需在会话页打开）`
		}, h$3("span", null, statusMark(doc.status)), h$3("span", { style: styles$3.id }, doc.id), sealed ? h$3("span", {
			style: { fontSize: "11px" },
			title: "内容有诱惑力但已被推翻"
		}, "🔴 禁止执行") : null, h$3("span", { style: {
			flex: 1,
			fontSize: "12px",
			opacity: .7
		} }, doc.summary), doc.fingerprint !== "" ? h$3("span", { style: styles$3.fingerprint }, doc.fingerprint.slice(0, 6)) : null);
	}))));
}
/** 交付网格（M2-D）。 */
function DeliverablesTab({ snapshot, onOpenFile, previewDisabled = false }) {
	const items = snapshot.deliverables;
	const undeclared = items.filter((item) => item.presented !== true).length;
	if (items.length === 0) return h$3("div", { style: styles$3.empty }, "deliverables/ 里还没有文件。（这个目录是「交付成品」，不是工作区根）");
	return h$3("div", null, h$3("div", { style: styles$3.sectionTitle }, `共 ${items.length} 个文件${undeclared > 0 ? ` · ${undeclared} 个未声明` : ""}`), h$3("div", { style: styles$3.grid }, items.map((item) => h$3(DeliverableCell, {
		key: item.path,
		item,
		onOpen: onOpenFile,
		previewDisabled
	}))), previewDisabled ? h$3("div", { style: styles$3.note }, "这些文件在项目的 `deliverables/` 目录下。本面板（主栏）没有会话上下文，点不开预览 —— 要打开它们，请到**会话页右侧栏**的 DDD 页签里点同一份文件。") : null, undeclared > 0 ? h$3("div", { style: styles$3.note }, "「未声明」= 文件存在，但 AI 从没调用 `present` 声明它是交付物。你可能不知道有它，它也可能只是中间产物。") : null);
}
/** 归档（M2-E）：待归档清单 + 勾选 + 归档；坟场里的可还原。 */
function GraveyardTab({ snapshot, onArchive, onRestore, pending }) {
	const [picked, setPicked] = react.useState([]);
	const toggle = (id) => {
		setPicked((current) => current.includes(id) ? current.filter((each) => each !== id) : [...current, id]);
	};
	const candidates = snapshot.graveyardCandidates;
	return h$3("div", null, h$3("div", { style: styles$3.sectionTitle }, `待归档（${candidates.length}）`), candidates.length === 0 ? h$3("div", { style: styles$3.empty }, "没有待归档的文档。（AI 会标 `status: void` 表示\"这份别再用了\"，然后出现在这里）") : h$3("div", null, candidates.map((item) => h$3("label", {
		key: item.id,
		style: {
			display: "flex",
			gap: "8px",
			alignItems: "baseline",
			padding: "4px 0",
			cursor: "pointer"
		}
	}, h$3("input", {
		type: "checkbox",
		checked: picked.includes(item.id),
		onChange: () => toggle(item.id),
		style: { flex: "0 0 auto" }
	}), h$3("span", {
		style: {
			...styles$3.id,
			flex: "0 0 auto",
			maxWidth: "22ch",
			overflow: "hidden",
			textOverflow: "ellipsis",
			whiteSpace: "nowrap"
		},
		title: item.id
	}, item.id), h$3("span", {
		style: {
			fontSize: "12px",
			opacity: .75,
			flex: "1 1 0%",
			minWidth: "0",
			overflow: "hidden",
			textOverflow: "ellipsis",
			whiteSpace: "nowrap"
		},
		title: item.summary
	}, item.summary), item.reason === void 0 || item.reason === "" ? h$3("span", { style: {
		fontSize: "11px",
		color: "var(--dsw-alias-state-warn-primary, #d29922)",
		flex: "0 0 auto"
	} }, "⚠️ 没有理由") : h$3("span", {
		style: {
			fontSize: "11px",
			opacity: .6,
			flex: "0 1 34ch",
			maxWidth: "34ch",
			minWidth: "0",
			overflow: "hidden",
			textOverflow: "ellipsis",
			whiteSpace: "nowrap"
		},
		title: item.reason
	}, item.reason))), h$3("div", { style: {
		marginTop: "10px",
		display: "flex",
		gap: "8px"
	} }, h$3("button", {
		style: styles$3.button,
		type: "button",
		disabled: picked.length === 0 || pending === true,
		onClick: () => onArchive?.(picked)
	}, pending === true ? "归档中…" : `归档选中的 ${picked.length} 份`)), h$3("div", { style: styles$3.note }, "归档 = 物理移动到 docs/_graveyard/，**不是删除**（文件仍占磁盘、仍进 git）。AI 只能标 `void`，移动由插件做 —— 这是 M2-Q6 的权限分工。")), snapshot.graveyard.length > 0 ? h$3("div", { style: { marginTop: "20px" } }, h$3("div", { style: styles$3.sectionTitle }, `已在坟场（${snapshot.graveyard.length}）`), snapshot.graveyard.map((item) => h$3("div", {
		key: item.path,
		style: {
			display: "flex",
			gap: "8px",
			alignItems: "baseline",
			fontSize: "12px",
			opacity: .7,
			padding: "2px 0"
		}
	}, h$3("span", { style: {
		flex: 1,
		wordBreak: "break-all"
	} }, item.path), h$3("button", {
		type: "button",
		style: styles$3.button,
		disabled: pending === true,
		title: "放回归档前的原路径（原位已有文件会被拒绝，绝不覆盖）",
		onClick: () => onRestore?.([item.path])
	}, "还原")))) : null);
}
/** 主栏整页：三个 tab 切区。 */
function MainPage({ snapshot, onOpenDoc, onOpenFile, onArchive, onRestore, archiving, previewDisabled = false }) {
	const [tab, setTab] = react.useState("graph");
	return h$3("div", { style: styles$3.root }, h$3("div", { style: styles$3.tabs }, h$3("button", {
		style: styles$3.tab(tab === "graph"),
		onClick: () => setTab("graph"),
		type: "button"
	}, `图谱（${snapshot.all.length}）`), h$3("button", {
		style: styles$3.tab(tab === "deliverables"),
		onClick: () => setTab("deliverables"),
		type: "button"
	}, `交付（${snapshot.deliverables.length}）`), h$3("button", {
		style: styles$3.tab(tab === "graveyard"),
		onClick: () => setTab("graveyard"),
		type: "button"
	}, `归档（${snapshot.graveyardCandidates.length}）`)), tab === "graph" ? h$3(GraphTab, {
		snapshot,
		onOpenDoc,
		previewDisabled
	}) : null, tab === "deliverables" ? h$3(DeliverablesTab, {
		snapshot,
		onOpenFile,
		previewDisabled
	}) : null, tab === "graveyard" ? h$3(GraveyardTab, {
		snapshot,
		onArchive,
		onRestore,
		pending: archiving
	}) : null);
}

// src/client/read-order.ts
/**
* 把快照的 `required` 变成条上的 chip 列表。
*
* **保持给定顺序**（见文件头：顺序的真源在 host）。坏输入一律返回空数组，不抛。
*
* @param required `GET /api/ddd/index` 的 `required`
* @returns chip 列表；没有必读文档时是空数组
*/
/**
* 把快照的 `required` 变成条上的 chip 列表。
*
* **保持给定顺序**（见文件头：顺序的真源在 host）。坏输入一律返回空数组，不抛。
*
* ---- 2026-11-14 演练复盘 D4（**用户第二次澄清**）：`✓` 不该被工作撤销 ----
*
* 用户的原话：
*
* > 「ai 在编辑文档后，文档的勾会失效，但按照阅读顺序阅读文档并画勾
* > 是**一开始被交接时**应该做完的，它大概不应该因为工作就被取消掉。
* > ai 自己工作时新加的文档大概也应该默认画勾。」
*
* 这条澄清把语义定死了：**条上的 `✓` = "接手时该读的，读过了"**，
* 是一个**完成的收尾状态**，不是"此刻能不能改"的实时读数。
*
* 两件事因此分开：
*
* | 通道 | 语义 | 变不变 |
* |---|---|---|
* | **门禁（`gate.read`）** | 此刻能不能改这份文档 | **必须实时**（改了就要重读，不变量） |
* | **本条的 `✓`** | 接手时的阅读是否已完成 | **只增不减**（记住"曾经读过"） |
*
* 实现：客户端用一份**本地记忆**（`localStorage`）记住"这个会话里勾过的 id"，
* 一旦勾上就不再撤销。它是**纯展示状态**，**绝不回传 host、绝不影响门禁**。
*
* @param required `GET /api/ddd/index` 的 `required`
* @param remembered 之前勾过的 id 集合（可选）；给了就把它们也算作已读
* @returns chip 列表；没有必读文档时是空数组
*/
function readOrderOf(required, remembered) {
	if (!Array.isArray(required)) return [];
	const everRead = remembered === void 0 ? void 0 : new Set(Array.isArray(remembered) ? remembered : [...remembered]);
	const items = [];
	for (const doc of required) {
		if (doc === null || typeof doc !== "object") continue;
		const id = typeof doc.id === "string" ? doc.id : "";
		items.push({
			seq: items.length + 1,
			id,
			role: typeof doc.role === "string" ? doc.role : "",
			status: typeof doc.status === "string" ? doc.status : "",
			read: doc.read === true || id !== "" && everRead?.has(id) === true,
			hasError: doc.hasError === true,
			summary: typeof doc.summary === "string" ? doc.summary : ""
		});
	}
	return items;
}
/**
* 收集"现在该记进本地记忆"的 id（**只增不减**）。
*
* 规则：
*   - 当前 `required` 里 `read === true` 的 → 记住（AI 真的读过）；
*   - **已经记住的保持**（哪怕它现在 `read === false`）；
*   - 已经不在 `required` 里的（比如被 supersede 了）**保留** ——
*     历史不该因为文档状态变了就消失；渲染时自然会因为不在清单里而不显示。
*
* ⚠️ 为什么不"用当前 required 覆盖"：那等于每次刷新都重新学一遍，
* 改一份文档就会丢一个勾 —— 正是用户报告的那个现象。
*
* @param items 本次渲染用的 chip 列表
* @param previous 之前的记忆
* @returns 新的记忆集合（可直接序列化）
*/
function rememberReadOf(items, previous = []) {
	const next = new Set(Array.isArray(previous) ? previous : [...previous]);
	for (const item of items) {
		if (item === null || typeof item !== "object") continue;
		if (item.id === "") continue;
		if (item.read === true) next.add(item.id);
	}
	return next;
}
/**
* 汇总进度。
*
* @param items `readOrderOf` 的产物
*/
function readOrderProgressOf(items) {
	const total = Array.isArray(items) ? items.length : 0;
	const read = Array.isArray(items) ? items.filter((item) => item.read === true).length : 0;
	return {
		total,
		read,
		ready: total > 0 && read >= total
	};
}
/** 收起状态的存储键。改它等于让所有用户的偏好归零，别轻易改。 */
const READ_ORDER_STORAGE_KEY = "ddd.readOrder.collapsed";
/**
* 「曾经勾过」的本地记忆存储键**前缀**（M2.3 演练 D4 第二次澄清）。
*
* ---- ⚠️ 2026-11-14 用户抓到的真缺陷：记忆必须**按会话隔离** ----
*
* 用户原话：
*
* > 「阅读顺序的勾应该在换一个会话（也就是下一个交接会话）时被清空，
* > 因为 ai 还没读过它们。」
*
* 完全正确。第一版我把所有会话的记忆写进**同一个**键
* `ddd.readOrder.everRead`，于是：
*
*   会话 A（工作者）读了 3 份 → 存了 3 个 id
*   会话 B（接手者）打开面板 → **读到 A 的记忆** → 3 个勾全是假的
*
* 实测症状（用户截图）：API 返回 `gate=0/3`（全未读），
* 但条上 3 个 chip **全打了勾** —— 那就是 A 的记忆渗到 B 了。
*
* 所以键必须带**会话标识**：`ddd.readOrder.everRead.<scope>`。
*
* ---- 但 `sessionId` 在 root 面板里是空串 ----
*
* 主栏整页是 `root` scope，宿主**不给它会话绑定**（这正是 M2.2/M2.3 反复撞的那件事）。
* 拿不到 sessionId 时用 `__root__` 这个**独立命名空间**：
* 它自己的勾不跨会话、也不污染任何会话 —— 与"拿不到就留空"同一条纪律。
*
* ⚠️ 改这个前缀 = 所有用户已画过的勾全部作废。别轻易改。
* ⚠️ 这是**纯展示记忆**，不进索引块、不回传 host、不影响门禁。
*/
const READ_ORDER_MEMORY_PREFIX = "ddd.readOrder.everRead";
/** `sessionId` 为空（root 面板）时用的命名空间。 */
const READ_ORDER_ROOT_SCOPE = "__root__";
/**
* 把存储键拼成「按会话隔离」的形式。
*
* @param sessionId 当前会话 id（空串 = root 面板）
* @returns 完整的 localStorage 键
*/
function memoryKeyOf(sessionId) {
	return `${READ_ORDER_MEMORY_PREFIX}.${typeof sessionId === "string" && sessionId !== "" ? sessionId : READ_ORDER_ROOT_SCOPE}`;
}
/**
* 读"曾经勾过"的 id 列表（**只读某一个会话的**）。
*
* 存储格式刻意用**逗号分隔的字符串**而不是 JSON：
* 它极小（几个 id），解析失败也只退化成空集，不会让整个面板炸。
*
* @param storage `defaultStorage()` 的产物
* @param sessionId 当前会话 id（空串 = root 面板，用独立命名空间）
* @returns id 列表；读不到 / 损坏时返回空数组
*/
function readMemoryOf(storage, sessionId = "") {
	if (storage === void 0) return [];
	try {
		const raw = storage.getItem(memoryKeyOf(sessionId));
		if (typeof raw !== "string" || raw === "") return [];
		return raw.split(",").map((item) => item.trim()).filter((item) => item !== "");
	} catch {
		return [];
	}
}
/**
* 写"曾经勾过"的 id 列表（**只写某一个会话的**）。
*
* **绝不抛**：存不进去只是下次不记得，不该影响这次显示。
*
* @param storage `defaultStorage()` 的产物
* @param sessionId 当前会话 id（空串 = root 面板）
* @param ids id 列表
*/
function writeMemoryTo(storage, sessionId, ids) {
	if (storage === void 0) return;
	try {
		storage.setItem(memoryKeyOf(sessionId), Array.from(ids).join(","));
	} catch {}
}
/**
* 取**当前会话**该用的记忆 id 列表。
*
* - 记忆属于当前会话 → 直接用它；
* - 记忆属于**别的**会话（刚切过来）→ 现读一份当前会话的，**绝不沿用别人的**。
*
* ⚠️ 这一步是**纯读**，不写盘、不改 state —— 所以可以在渲染期调用。
*
* @param storage `defaultStorage()` 的产物
* @param memory 手上的记忆（可能属于别的会话）
* @param sessionId 当前会话 id
* @returns 当前会话的 id 列表（读不到就是空数组）
*/
function memoryIdsOf(storage, memory, sessionId) {
	const current = typeof sessionId === "string" ? sessionId : "";
	if (memory === void 0 || memory === null) return readMemoryOf(storage, current);
	if (memory.sessionId !== current) return readMemoryOf(storage, current);
	return Array.isArray(memory.ids) ? memory.ids : [];
}
/**
* 这份记忆**是否属于**当前会话 —— 只有属于才允许写盘。
*
* 拆成独立函数是为了让"什么时候可以写"这条不变量**能被单测与变异直接钉住**，
* 而不是埋在组件的一个 `if` 里（组件是 `.tsx`，Node 的单测 import 不了）。
*
* @param memory 手上的记忆
* @param sessionId 当前会话 id
* @returns 可以写盘时为 true
*/
function canPersistMemory(memory, sessionId) {
	if (memory === void 0 || memory === null) return false;
	return memory.sessionId === (typeof sessionId === "string" ? sessionId : "");
}
/**
* 取一个可用的 storage。
*
* `localStorage` 在三种情况下会**抛**（不是返回 null）：
* 隐私模式、`file://` 下的某些配置、被策略禁用。
* 所以这里整体包 try/catch，拿不到就返回 `undefined` ——
* 调用方据此退化成"不持久化"，而不是让整个面板炸掉。
*
* @returns storage，或 undefined
*/
function defaultStorage() {
	try {
		const storage = globalThis.localStorage;
		if (storage === void 0 || storage === null) return void 0;
		if (typeof storage.getItem !== "function" || typeof storage.setItem !== "function") return void 0;
		return storage;
	} catch {
		return;
	}
}
/**
* 读"是否收起"。
*
* **默认展开**：一个默认藏起来的控件等于没有（用户不会去找它）。
* 只有明确存过 `1` 才认为收起；其它一切值（包括损坏的、空串）都当展开。
*
* @param storage `defaultStorage()` 的产物
* @returns 是否收起
*/
function readCollapsedOf(storage) {
	if (storage === void 0) return false;
	try {
		return storage.getItem(READ_ORDER_STORAGE_KEY) === "1";
	} catch {
		return false;
	}
}
/**
* 写"是否收起"。
*
* **绝不抛**：存不进去只是下次不记得，不该影响这次操作。
*
* @param storage `defaultStorage()` 的产物
* @param collapsed 是否收起
*/
function writeCollapsedTo(storage, collapsed) {
	if (storage === void 0) return;
	try {
		storage.setItem(READ_ORDER_STORAGE_KEY, collapsed ? "1" : "0");
	} catch {}
}
/**
* 状态徽标。
*
* 与 `dashboard.tsx` 的 `statusMark` **同一套语义**，但这里放纯逻辑层，
* 好让"顺序 + 状态"这一对能在单测里一起断言。
*
* @param status frontmatter 的 status
* @returns 一个字符的徽标
*/
function statusMarkOf(status) {
	switch (status) {
		case "authoritative": return "🟢";
		case "partial": return "🟡";
		case "draft": return "⚪";
		case "superseded": return "🔵";
		case "sealed": return "🔴";
		case "void": return "🟠";
		default: return "❔";
	}
}

// src/client/read-order-bar.tsx
/**
* 「AI 阅读顺序」条（M2.3 · 需求 2）。
*
* ---- 它要回答的问题 ----
*
* 用户最初的设想里最核心的一句是「**AI 现在读到第几篇**」。
* 索引块把这件事写进了模型上下文，但**人看不见**。
* 这条就是把同一份数据搬到屏幕上：`GET /api/ddd/index` 的 `required`。
*
* ---- 三条纪律 ----
*
* 1. **顺序不许自己排**：`required` 已经是 host 按 `order` 排好的真源
*    （见 `read-order.ts` 文件头）。client 再排一次就会造出第二套顺序。
* 2. **点击不改变已读**（R-5）：条上的**已读标记**记的是 **AI 的读取**。
*    用户点 chip 只开预览，**不会**让它变"已读" —— 这句话必须写在条上，
*    否则会被反复当成 bug 报（看板已经栽过一次）。
*
* ---- ⚠️ 2026-11-14 用户指出的歧义：**一个 chip 上有两个圆** ----
*
* 用户原话：「绿点指的应该是高置信度，右侧空着的白点才应该是 ai 读过的标识。」
*
* 完全正确。旧版每个 chip 是 `1 🟢 read-order ○`：
*   - **`🟢` = 置信度**（`statusMarkOf(status)`，`authoritative` 就是绿）；
*   - **后面的圆点 = AI 读没读**。
*
* 而旧文案写的是「绿点 = AI 读过」—— 那句话把**置信度**说成了**已读**。
* 更糟的是：已读时我画的是**实心绿点**，于是已读的 chip 会变成 `🟢 … 🟢`
* 两个绿圆，用户根本分不清哪个是哪个。
*
* 修法（三件事一起做，只改文案不够）：
*   1. 已读**不再用绿色**，改用「✓」这个**形状**；
*   2. 未读用**空心圆**（没有颜色，只有轮廓）；
*   3. 文案改成「🟢 置信度 ｜ ✓ = AI 读过」——**明确把两者分开说**。
* 3. **绝不假装**：没数据时整条不渲染（由 `BodyWith` 保证只在有快照时挂载）；
*    收起状态存在 `localStorage`，存不进去就退化成"本次有效"。
*
* ---- 为什么 chip 默认不可点 ----
*
* 与 `main-page.tsx` 的图谱同一个理由：本面板是 `root` scope，**没有会话**，
* 右栏不存在 → `openResource` 必抛（`sidebar-right` 的 `require()`）。
* 所以这里也走 `previewDisabled`：没有 pointer 手势，`title` 里说清为什么。
*/
const h$2 = react.createElement;
/**
* 阅读顺序条。
*
* @param props.snapshot 已取到的快照（`required` 就是顺序的真源）
* @param props.onOpenDoc 点 chip 时开预览（本面板里通常禁用，见文件头）
* @param props.previewDisabled 预览是否**根本不可能**（root 面板 = true）
*
* ⚠️ `onOpenDoc` 收到的是 `ReadOrderItem`，**不是** `SnapshotDoc`。
* 不要为了让签名对上去伪造一个 `SnapshotDoc`（填 `title: ''` 之类）——
* 那会把"我手上没有这个字段"伪装成"这个字段是空的"，正是本项目最忌讳的事。
* 调用方若需要完整字段，应当拿 `id` 回快照里查。
*/
function ReadOrderBar({ snapshot, onOpenDoc, previewDisabled = false, sessionId = "" }) {
	const storage = react.useMemo(() => defaultStorage(), []);
	const [memory, setMemory] = react.useState(() => ({
		sessionId,
		ids: readMemoryOf(storage, sessionId)
	}));
	react.useEffect(() => {
		setMemory((current) => current.sessionId === sessionId ? current : {
			sessionId,
			ids: readMemoryOf(storage, sessionId)
		});
	}, [storage, sessionId]);
	/**
	* 本次渲染可用的记忆。
	*
	* **渲染期只读**：手上的记忆属于别的会话时，现读当前会话的那份，
	* 绝不把上一个会话的勾当成这个会话的。
	*/
	const remembered = react.useMemo(() => memoryIdsOf(storage, memory, sessionId), [
		storage,
		memory,
		sessionId
	]);
	const items = react.useMemo(() => readOrderOf(snapshot.required, remembered), [snapshot.required, remembered]);
	const progress = react.useMemo(() => readOrderProgressOf(items), [items]);
	react.useEffect(() => {
		if (!canPersistMemory(memory, sessionId)) return;
		const next = rememberReadOf(items, memory.ids);
		if (next.size === memory.ids.length) return;
		const list = [...next];
		setMemory({
			sessionId,
			ids: list
		});
		writeMemoryTo(storage, sessionId, list);
	}, [
		items,
		memory,
		storage,
		sessionId
	]);
	const [collapsed, setCollapsed] = react.useState(() => readCollapsedOf(storage));
	const toggle = () => {
		setCollapsed((current) => {
			const next = !current;
			writeCollapsedTo(storage, next);
			return next;
		});
	};
	if (items.length === 0) return null;
	if (collapsed) return h$2("button", {
		type: "button",
		onClick: toggle,
		style: styles$2.fab,
		title: `展开 AI 阅读顺序（${progress.read}/${progress.total} 已读）`,
		"aria-label": "展开 AI 阅读顺序"
	}, `${progress.read}/${progress.total}`);
	return h$2("div", { style: styles$2.bar }, h$2("div", { style: styles$2.head }, h$2("span", { style: styles$2.title }, "AI 阅读顺序"), h$2("span", { style: styles$2.progress }, `${progress.read}/${progress.total}`, progress.ready ? " ✅ 已读完" : " ⏳ 还没读完"), h$2("span", {
		style: styles$2.hint,
		title: LEGEND_SUB
	}, LEGEND_MAIN), h$2("span", {
		style: styles$2.restartHint,
		title: "已读记录保存在会话内存里。宿主重启后会话是新的，已读会从零开始 —— 这不是 bug，是\"这个会话读过什么\"的语义。"
	}, "重启会清空"), h$2("button", {
		type: "button",
		onClick: toggle,
		style: styles$2.collapseButton,
		title: "收起到右下角"
	}, "收起")), h$2("div", { style: styles$2.track }, items.map((item) => {
		const clickable = !previewDisabled && onOpenDoc !== void 0;
		return h$2("div", {
			key: `${item.seq}:${item.id}`,
			style: clickable ? styles$2.chip : styles$2.chipStatic,
			...clickable ? { onClick: () => onOpenDoc(item) } : {},
			title: clickable ? `${item.summary === "" ? item.id : item.summary}` : `${item.summary === "" ? item.id : item.summary}（预览需在会话页打开）`
		}, h$2("span", { style: styles$2.seq }, String(item.seq)), h$2("span", { title: `置信度：${item.status}` }, statusMarkOf(item.status)), h$2("span", { style: styles$2.chipId }, item.id === "" ? "(无 id)" : item.id), h$2("span", {
			style: item.read ? styles$2.readMark : styles$2.unreadMark,
			title: item.read ? "AI 已读过（指纹一致）" : "AI 还没读",
			"aria-label": item.read ? "已读" : "未读"
		}, item.read ? "✓" : ""));
	})));
}
/**
* 图例文案。
*
* ---- 2026-11-14 演练复盘 D4：两轮澄清后的最终措辞 ----
*
* 第一轮用户说：「阅读顺序应该是个适用于被交接者初次接手项目的显示指标，
* 它不应该在工作中发生变动。」
*
* 我当时只改了文案，但**没改行为** —— 所以第二轮他又说：
* 「ai 在编辑文档后，文档的勾会失效，但按阅读顺序阅读并画勾
* 是**一开始被交接时**应该做完的，它大概不应该因为工作就被取消掉。」
*
* 这才是真需求。现在的实现（`read-order.ts` 的本地记忆）：
* **勾只增不减**，改文档不会撤销它。门禁（能不能改）另有一套，两者独立。
*
* 措辞要说清三件事：
*   1. 这是**接手清单**（语义定位）；
*   2. `✓` 是**接手时读完**的记录，**不会因为改文档而消失**；
*   3. 你点开**不算** AI 已读（R-5，防止当 bug 报）。
*/
const LEGEND_MAIN = "接手清单 ｜ 🟢 置信度 ｜ ✓ = AI 已读完";
const LEGEND_SUB = "（✓ 只增不减：改文档不会撤销它。你点开不算 AI 已读）";
/**
* 那几行的样式。
*
* ⚠️ **必须用 `--dsw-alias-*` token**（`client-theme-tokens.test.js` 钉着）：
* 硬编码色在浅色主题下会看不清，而这类 bug 不会自己暴露。
*/
const styles$2 = {
	bar: {
		flexShrink: 0,
		borderTop: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))",
		background: "var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.06))",
		padding: "6px 20px 8px",
		font: "12px/1.5 system-ui, -apple-system, \"Segoe UI\", sans-serif",
		color: "var(--dsw-alias-label-primary, #e6e6e6)"
	},
	head: {
		display: "flex",
		alignItems: "baseline",
		gap: "8px",
		marginBottom: "5px",
		minWidth: "0"
	},
	title: {
		fontSize: "11px",
		letterSpacing: "0.04em",
		opacity: .6,
		textTransform: "uppercase",
		flexShrink: 0,
		whiteSpace: "nowrap"
	},
	progress: {
		fontSize: "12px",
		fontWeight: 600,
		flexShrink: 0,
		whiteSpace: "nowrap"
	},
	/**
	* 图例文字（`接手清单 ｜ 🟢 置信度 ｜ ✓ = AI 已读完`）。
	*
	* ---- 2026-11-16 M2.9：窄窗口下它会被排成**一列**（用户报的 UI 问题）----
	*
	* 现象：右栏很窄时，这句话变成
	* ```
	* 接
	* 手
	* 清
	* 单
	* ｜
	* ```
	*
	* 根因不是缩得太小，是**允许换行**：
	*   · `flex: 1` 的 basis 是 0，所以它会被压到很小；
	*   · 但它**没有 `whiteSpace: nowrap`** —— 中文与 `｜` 之间都能断行，
	*     于是每压窄一档就多折一行，最终一字一行。
	*   · 少了 `minWidth: 0`，flex 子项还会卡在 min-content（= 一个汉字宽）。
	*
	* ⇒ 与归档列表那次同一个处方：**不换行 + 省略号 + minWidth: 0**。
	*   窄到放不下就显示「接手清单 ｜ …」，完整文字在 `title` 悬停里。
	*   这比"一字一列"好得多 —— 后者会把整条顶高，把正文挤下去。
	*/
	hint: {
		fontSize: "11px",
		opacity: .45,
		flex: "1 1 0%",
		minWidth: "0",
		whiteSpace: "nowrap",
		overflow: "hidden",
		textOverflow: "ellipsis"
	},
	/**
	* 「重启会清空」提示（方案 C）。
	*
	* 用 `title` 承载完整解释，这里只放 4 个字的标签 ——
	* 条本身已经很窄（右栏尤其），长句子会把正文挤掉。
	*/
	restartHint: {
		fontSize: "10px",
		opacity: .4,
		flexShrink: 0,
		marginRight: "8px",
		whiteSpace: "nowrap",
		cursor: "help"
	},
	collapseButton: {
		font: "inherit",
		fontSize: "11px",
		padding: "2px 8px",
		color: "var(--dsw-alias-label-secondary, #9a9a9a)",
		background: "transparent",
		border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))",
		borderRadius: "4px",
		cursor: "pointer",
		flexShrink: 0
	},
	track: {
		display: "flex",
		gap: "6px",
		overflowX: "auto",
		paddingBottom: "2px"
	},
	chip: {
		display: "flex",
		alignItems: "center",
		gap: "5px",
		padding: "3px 9px",
		borderRadius: "999px",
		border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35))",
		background: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.1))",
		cursor: "pointer",
		flexShrink: 0,
		whiteSpace: "nowrap"
	},
	/**
	* 不可点的 chip。
	*
	* 与 `chip` 的唯一区别是 **`cursor: 'default'`** 与略降的不透明度 ——
	* 没有可点击手势，用户就不会去点一个注定没反应的东西（需求 1 的教训）。
	*/
	chipStatic: {
		display: "flex",
		alignItems: "center",
		gap: "5px",
		padding: "3px 9px",
		borderRadius: "999px",
		border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35))",
		background: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.1))",
		cursor: "default",
		flexShrink: 0,
		whiteSpace: "nowrap",
		opacity: .85
	},
	seq: {
		fontSize: "10px",
		opacity: .55,
		fontVariantNumeric: "tabular-nums",
		minWidth: "10px"
	},
	chipId: {
		fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
		fontSize: "11px"
	},
	/**
	* 已读标记（**形状，不是颜色**）。
	*
	* 为什么不用绿色：chip 上已经有一个绿圆表示**置信度**（`statusMarkOf`）。
	* 两个绿圆放一起，用户没法分辨哪个是哪个 —— 2026-11-14 用户就是这么被误导的。
	*
	* 所以：绿色**专属于置信度**；已读用「✓」这个语义直白的形状，
	* 未读用空心圆。三者互不占用同一个视觉通道。
	*/
	readMark: {
		width: "13px",
		height: "13px",
		lineHeight: "13px",
		borderRadius: "50%",
		textAlign: "center",
		fontSize: "10px",
		fontWeight: 700,
		color: "var(--dsw-alias-label-primary, #e6e6e6)",
		background: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.18))",
		flexShrink: 0
	},
	/** 未读：**空心圆**（只有轮廓，没有填充，也不带颜色）。 */
	unreadMark: {
		width: "13px",
		height: "13px",
		lineHeight: "13px",
		borderRadius: "50%",
		border: "1px solid var(--dsw-alias-label-secondary, #9a9a9a)",
		background: "transparent",
		flexShrink: 0,
		boxSizing: "border-box"
	},
	fab: {
		position: "fixed",
		right: "16px",
		bottom: "16px",
		zIndex: 10,
		font: "inherit",
		fontSize: "11px",
		padding: "6px 12px",
		borderRadius: "999px",
		border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.5))",
		background: "var(--dsw-alias-bg-overlay, #1e1e1e)",
		color: "var(--dsw-alias-label-primary, #e6e6e6)",
		cursor: "pointer",
		boxShadow: "0 2px 8px rgba(0,0,0,0.25)"
	}
};

// src/client/visibility.ts
/**
* 订阅「窗口重新可见」时刷新一次。
*
* @param controller 要刷新的 controller（只需 `refresh`）
* @param documentObj 注入的 document（不传就用全局；单测可传假对象）
* @returns 退订函数（**绝不抛**）
*/
function watchVisibility(controller, documentObj = globalThis?.document) {
	try {
		if (documentObj === void 0 || documentObj === null) return () => {};
		if (typeof documentObj.addEventListener !== "function") return () => {};
		const onVisibilityChange = () => {
			if (documentObj.visibilityState !== "visible") return;
			try {
				controller.refresh();
			} catch {}
		};
		documentObj.addEventListener("visibilitychange", onVisibilityChange);
		return () => {
			try {
				documentObj.removeEventListener?.("visibilitychange", onVisibilityChange);
			} catch {}
		};
	} catch {
		return () => {};
	}
}
/**
* 面板可见时的**低频轮询**（M2.3 演练复盘 D3 第二轮）。
*
* ---- 它解决什么（2026-11-14 用户实测）----
*
* 用户原话：「右侧栏的阅读顺序的勾没有实时刷新，但就在截完图之后它很快就变成 2/3 了。」
*
* "截完图就变了"是因为截图让窗口失焦再回来 → 触发了 `watchVisibility` 的刷新。
* 也就是说：**`visibilitychange` 只能覆盖"切走再切回"，覆盖不了"一直盯着看"**。
*
* 而 `gate.read` 变化的主要原因是 **AI 在另一个进程里读了文档** ——
* 纯 HTTP 拉取架构下，客户端**根本无从知道**。所以要么推送，要么轮询。
*
* ---- 为什么不推翻"不轮询"的原设计 ----
*
* `createController` 的注释说「轮询会让 host 每秒被叫一次，而这个面板大部分时间没人看」。
* 那个理由**成立**，所以这里做了三件事来守住它：
*
*   1. **间隔长**（默认 5 秒，不是每秒）；
*   2. **只在页面可见时轮询**（`document.hidden` 时跳过 —— 后台标签页零请求）；
*   3. **单次请求很轻**（一个 GET，返回几百字节）。
*
* 代价换算：看板显示时 5 秒一次 ≈ 每分钟 12 次；不看时 **0 次**。
* 比"每秒一次、永不停"低两个数量级。
*
* ⚠️ 它**仍然不是实时**（最坏延迟 = 一个间隔）。所以 UI 上不该暗示"实时"。
*
* @param controller 要刷新的 controller
* @param intervalMs 轮询间隔（毫秒）；传 0 表示关闭
* @param documentObj 注入的 document（便于单测）
* @param setIntervalFn / clearIntervalFn 注入的定时器（便于单测，不必真等 5 秒）
* @returns 停止函数（**绝不抛**）
*/
function watchPolling(controller, intervalMs, documentObj = globalThis?.document, setIntervalFn = (fn, ms) => setInterval(fn, ms), clearIntervalFn = (handle) => clearInterval(handle)) {
	try {
		if (!(typeof intervalMs === "number" && intervalMs > 0)) return () => {};
		if (typeof setIntervalFn !== "function") return () => {};
		const tick = () => {
			if (documentObj !== void 0 && documentObj !== null && documentObj.visibilityState === "hidden") return;
			try {
				controller.refresh();
			} catch {}
		};
		const handle = setIntervalFn(tick, intervalMs);
		return () => {
			try {
				if (typeof clearIntervalFn === "function") clearIntervalFn(handle);
			} catch {}
		};
	} catch {
		return () => {};
	}
}
/** 面板轮询的默认间隔（毫秒）。0 = 关闭。 */
const DEFAULT_POLL_INTERVAL_MS = 5e3;

// src/client/entry-logic.ts
/**
* 从 cordis 上下文里**软取**一个可选服务。
*
* ⚠️ **这是本切片最贵的一个坑（2026-11-13 实测）**：
* cordis 的 `ctx` 是 Proxy。访问一个**没有写进插件 `inject` 的服务**时，
* 它**不会**返回 `undefined`，而是**直接抛**：
*
* ```
* Error: cannot get property "sidebarRight" without inject
* ```
*
* `?.` 救不了它 —— 抛错发生在**属性读取**那一刻，不是后续调用。
* 唯一正确的软取法是 `ctx.get('<service>')`，它在服务缺席时返回 `undefined`。
*
* @param ctx client 根上下文
* @param name 服务名
* @returns 服务实例，缺席时 undefined
*/
function softService(ctx, name) {
	try {
		if (ctx === void 0 || ctx === null) return void 0;
		if (typeof ctx.get !== "function") return void 0;
		return ctx.get(name);
	} catch {
		return;
	}
}
/**
* 取当前会话的 cwd / sessionId。
*
* ---- ⚠️ 2026-11-13 实机教训：这两个都没有"自动"来源 ----
*
* 原实现从三处取值，**三处都错**（都只是 SPEC 里的想象，从没在真宿主上验过）：
*
* | 原写法 | 宿主真实情况 |
* |---|---|
* | `ctx.workingDirectory.get()` | **host 侧**服务，`get(session)` 需要 `Session` 对象，浏览器拿不到 |
* | `ctx.layout.panelInfo()` | `layout` 有 `panelInfo`，但 `PanelInfo` **只有 `activePanelId`**，不含 sessionId |
* | `ctx.sessions.active()` | `sessions` **没有 `active()`**，只有 `list` / `retain` / `binding`… |
*
* 更根本的一条：宿主**设计上**不给 root-scope 的 `main` 席位任何会话绑定
* （`dsh-client-ui-layout` 注释原文：「other keys receive no Session binding」）。
*
* 所以 cwd **必须由用户显式选**（见 `projects.ts` 的选择器），
* sessionId 拿不到就**留空**并在界面上说清 —— 绝不猜一个，
* 因为显示错项目的门禁比不显示更糟（会把错误的信任可视化）。
*
* @param ctx client 根上下文
* @param chosenCwd 用户显式选定的项目根（空串 = 还没选）
*/
function sessionInfoOf(ctx, chosenCwd = "") {
	const cwdOf = () => {
		if (typeof chosenCwd === "string" && chosenCwd !== "") return chosenCwd;
		return "";
	};
	const sessionIdOf = () => {
		try {
			const list = softService(ctx, "sessions")?.list;
			if (list !== void 0 && typeof list.getSnapshot === "function") {
				const state = list.getSnapshot();
				const ids = Array.isArray(state?.ids) ? state.ids : [];
				if (ids.length === 1 && typeof ids[0] === "string" && ids[0] !== "") return ids[0];
			}
		} catch {}
		return "";
	};
	return {
		cwdOf,
		sessionIdOf
	};
}
async function pickProjectDirectory(ctx) {
	const uiWorkspace = softService(ctx, "uiWorkspace");
	if (uiWorkspace === void 0 || typeof uiWorkspace?.pickDirectory !== "function") return {
		kind: "unavailable",
		reason: "宿主没有提供 uiWorkspace.pickDirectory，只能从已知项目里选。"
	};
	try {
		const picked = await uiWorkspace.pickDirectory();
		if (picked === null || picked === void 0) return { kind: "cancelled" };
		if (typeof picked !== "string" || picked === "") return { kind: "cancelled" };
		return {
			kind: "picked",
			cwd: picked.replace(/[\\/]+$/, "")
		};
	} catch (error) {
		return {
			kind: "unavailable",
			reason: `目录选择器打不开：${error?.message ?? String(error)}`
		};
	}
}
/**
* 接线预览通道（M2-B）。
*
* ---- ⚠️ 2026-11-13 实机事故：`ctx.get('sidebarRight')` **永远拿不到** ----
*
* `sidebarRight` 由 `dsh-client-ui-sidebar-right` 用 `ctx.reflect.provide('sidebarRight', …)`
* 提供 —— 它**不在 client 的 Service 目录里**（`cordis_inspect` 的 `Service.listService`
* 查不到它）。所以 `ctx.get('sidebarRight')` **恒定返回 undefined**。
*
* 症状（用户实测）：「鼠标放上去会变手势，但点击没有反应，打不开文档」——
* 因为 `wirePreviewOf` 一直走降级分支，`openPreview` 只打一条 warn。
*
* **唯一正确的取法**：把 `sidebarRight` 写进**插件级 `inject`**，然后直接 `ctx.sidebarRight`。
* 这与官方包完全一致（`ui-chat` / `ui-plan` / `ui-reference` 都这么做，
* 例如 `dsh-client-ui-reference/src/client/index.ts` 的
* `export const inject = [..., 'sidebarRight', ...]`）。
*
* ⚠️ 代价：写进 `inject` 后它是**硬依赖** —— 宿主没这个服务时插件不会激活。
* 但 `ui-sidebar-right` 是官方基础包、profile 里常驻，所以这个代价可接受
* （`ui-reference` 等官方包也做了同样的选择）。
*
* @param ctx client 根上下文（其 `inject` 必须包含 `sidebarRight`）
*/
function wirePreviewOf(ctx) {
	let sidebarRight;
	try {
		sidebarRight = ctx === void 0 || ctx === null ? void 0 : ctx.sidebarRight;
	} catch {
		sidebarRight = void 0;
	}
	if (sidebarRight === void 0) sidebarRight = softService(ctx, "sidebarRight");
	if (sidebarRight === void 0 || typeof sidebarRight?.openResource !== "function") return {
		kind: "unavailable",
		warning: "[ddd] 没有 sidebarRight 服务，文档预览不可用（M2-B 会显示\"打不开\"）",
		open: () => {
			throw new Error("sidebarRight 不可用");
		}
	};
	return {
		kind: "ok",
		open: (address) => sidebarRight.openResource(address)
	};
}

// src/client/session-tab.ts
/**
* 这个 tab 实现的**唯一身份**。
*
* 它同时是三处的键（官方 `documentpreview` 用的是包名，照抄这个惯例）：
*   - `ctx.sidebarRightTabs.register({ id })`
*   - `slots.register({ name: 'sidebar.right.pane.tab', key: id })`
*   - `slots.register({ name: 'sidebar.right.pane.tab.title', key: id })`
*
* ⚠️ 三处**必须逐字一致**，否则正文会渲染在"没有类型认领"的空面板里
* （症状是"点开页签一片空白"，而且不报错）。
*/
const DDD_TAB_ID = "@local/ddd";
/**
* tab 的**类型判别符**（`kind`）。
*
* 与 `id` 不是一回事：`id` 是"这个实现"，`kind` 是"这类页签"。
* `openTab(kind)` 用的是它；`title` / 正文注册用的是 `id`。
*/
const DDD_TAB_KIND = "ddd-board";
/** guide 胶囊的稳定 id（同一个 provider 内唯一）。 */
const DDD_GUIDE_ENTRY_ID = "construction-board";
/** guide 胶囊的排序位（排在官方胶囊之后，不抢位）。 */
const DDD_GUIDE_ORDER = 60;
/** 胶囊标题（**每次调用都读**，所以语言切换不需要重新注册）。 */
function dddGuideTitle() {
	return "文档驱动开发";
}
/** 胶囊下面那行说明。 */
function dddGuideDescription() {
	return "看板 + AI 阅读顺序 + 文档预览（仅 DDD 项目）";
}
/**
* 页签标题（`definition.title(address)` 的产物会被捕获进页签记录）。
*
* ⚠️ **必须声明 `address` 参数**，即使不用它：
* `SidebarRightTabDefinition.title` 的签名是 `(address: string) => string`。
* 写成 `() => string`（thunk）在类型上不兼容，而且 `fn.length` 会变成 0 ——
* `test/client-session-tab.test.js` 用 arity 钉住了这一点
* （因为 thunk 与正常函数在运行期"都能返回字符串"，光看返回值分不出来）。
*
* @param _address 页签记录的地址（页面类型是 `sidebar://<kind>`），本类型不用它
* @returns 页签 chip 上的文字
*/
function dddTabTitle(_address) {
	return "文档驱动开发";
}
/**
* 构造 tab 类型定义（stage one：这个类型**是什么**）。
*
* 关键决定与理由：
*
* - **`priority: 'extension'`**：这是"来自产品之外的类型"所在的最高档
*   （`tab-registry.ts` 的注释原文：*a type from outside the product, and the highest*）。
*   我们的页签由 `kind` 打开（`openTab`），**不声明 `patterns`** ——
*   它不认领任何 `dsh-resource://` 地址，所以**不会抢** `documentpreview` 的文件。
*   （若声明了 patterns 又占 extension 档，我们就会把**所有**匹配的文件抢走，
*   那是严重回归。`test/client-session-tab.test.js` 钉着"不许有 patterns"。）
* - **`title` 不用 thunk**：`SidebarRightTabDefinition.title` 的签名是
*   `(address: string) => string`，**不是** `() => string`（与 `guide[].title` 不同，
*   后者才是 thunk）。写错会拿到 address 当标题。
*
* @returns 可以直接喂给 `ctx.sidebarRightTabs.register()` 的定义
*/
function dddTabDefinition() {
	return {
		id: DDD_TAB_ID,
		kind: DDD_TAB_KIND,
		priority: "extension",
		title: dddTabTitle,
		guide: [{
			id: DDD_GUIDE_ENTRY_ID,
			order: 60,
			title: dddGuideTitle,
			description: dddGuideDescription
		}]
	};
}
/**
* 取某个会话的 cwd（**纯快照读，不是 hook**）。
*
* 官方 `ui-reference` 就是这么用的（`src/client/index.ts` L65 / L168）：
* ```js
* sessions.list.getSnapshot().byId[sessionId]?.cwd
* ```
*
* ---- ⚠️ 2026-11-14 实机事故：**为什么不用 `useSessions` hook** ----
*
* 框架确实把 `useSessions`（`SnapshotSelectorHook`）作为 standard prop 注入了
* `sidebar.right.pane.tab`，看起来"更正统"。但第一版把它放进 `React.useMemo`
* 的回调里调，结果：**切到新会话时右栏整棵渲染树被卸载，连切回原会话也不恢复**。
*
* 原因是 hook 被有条件地调用（`useMemo` 回调在渲染期跑，且不同分支走不同路径），
* React 抛 `Rendered more hooks than during the previous render` → 错误边界卸载子树。
*
* 所以这里刻意用**纯读**：`getSnapshot()` 是同步取值，没有 hook 顺序问题。
* 代价是不会自动订阅会话元数据的变化 —— 可接受：
* cwd 在建会话时就定了，之后极少变；真要变，重开页签即可。
*
* ⚠️ 拿不到时返回**空串**，由调用方显示"拿不到项目目录"。
* 绝不退回 `process.cwd()` 或任何猜测 —— 那会显示别的项目的门禁读数。
*
* @param ctx client 根上下文
* @param sessionId 框架注入的会话 id（可能是空串）
* @returns cwd（已去掉尾部分隔符），拿不到时为空串
*/
function cwdOfSession(ctx, sessionId) {
	if (typeof sessionId !== "string" || sessionId === "") return "";
	try {
		const list = softService(ctx, "sessions")?.list;
		if (list === void 0 || list === null || typeof list.getSnapshot !== "function") return "";
		const byId = list.getSnapshot()?.byId;
		if (byId === void 0 || byId === null || typeof byId !== "object") return "";
		const cwd = byId[sessionId]?.cwd;
		if (typeof cwd !== "string" || cwd === "") return "";
		return cwd.replace(/[\\/]+$/, "");
	} catch {
		return "";
	}
}
/**
* 取 cwd 的**生产入口**：只走纯快照读。
*
* ⚠️ 2026-11-14 之后这里**不再尝试 `useSessions` hook**。
* 那个 hook 只能在组件顶层无条件调用；而本函数是"普通函数"，
* 任何调用点都可能处在渲染期，把 hook 藏在这里就是一个陷阱。
*
* 如果将来确实需要订阅会话元数据变化，做法是：在组件顶层
* `const row = useSessions(state => state.byId[sessionId])` 无条件调一次，
* 然后把 `row.cwd` 传进来 —— **不是**把 hook 塞进这个函数。
*
* @param ctx client 根上下文
* @param sessionId 当前会话 id
* @returns cwd，拿不到时为空串
*/
function resolveCwd(ctx, sessionId) {
	return cwdOfSession(ctx, sessionId);
}

// src/client/session-tab.tsx
/**
* 会话右栏的 DDD 页签正文（M2.3 · 需求 3）。
*
* ---- 与主栏整页（`BoardPage`）的三处关键差异 ----
*
* | | 主栏整页 | 本页签 |
* |---|---|---|
* | scope | `root` | **`session`** |
* | 项目根 | 用户手选（宿主不给 root 席位会话绑定） | **自动**从会话的 cwd 来 |
* | 预览 | 注定打不开 → 禁用点击 | **能打开** → 保留点击 |
*
* ---- ⚠️ 2026-11-14 实机事故：**这里曾经在 `useMemo` 里调 hook，把整个右栏炸空** ----
*
* 症状（用户实测）：
*   1. 在**已经开始工作**的会话里点开页签 → 正常；
*   2. 切到一个**还没发过任何话**的新会话 → 右栏**纯空页**；
*   3. 再切回原来那个正常的会话 → **它也变空了**。
*
* 第 3 句是决定性的：数据取不到只会让**这一格**显示"没有数据"，
* 不可能让**已经渲染好的另一格**变空。能让整棵子树消失的只有一件事：
* **React 在渲染期抛错 → 错误边界卸载整棵树**。
*
* 真因：`useSessions` 是框架注入的 **hook**（`SnapshotSelectorHook`），
* 而我把 `wiring.cwdOf(useSessions, sessionId)` 放进了 `React.useMemo` 的回调里。
* `useMemo` 回调在**渲染期**执行，于是 hook 被"有条件地"调用：
* 新会话 cwd 为空时走的路径与有 cwd 时不同 → hook 调用序列变了 →
* React 抛 `Rendered more hooks than during the previous render` → 右栏整棵卸载。
*
* **现在的做法（记住这条纪律）**：
* > **组件里一个框架 hook 都不调**。cwd 走 `cwdOfSession(ctx, sessionId)` ——
* > 那是纯快照读（`sessions.list.getSnapshot()`），官方 `ui-reference` L65/L168 就这么用。
* >
* > 理由不只是"这次修 bug"：页签是**窄栏、按会话切换**的，
* > 任何"有时调、有时不调"的 hook 都会在切换会话时炸；纯读没有这个风险。
*
* ---- 拿不到 cwd 时怎么办 ----
*
* 明说拿不到，并给一个"回主栏手选"的出口。**绝不猜目录**：
* 猜错会显示别的项目的门禁读数，比不显示更糟（把错误的信任可视化）。
*/
const h$1 = react.createElement;
/**
* 页签内部的**错误边界**。
*
* ---- 为什么必须有这一层（2026-11-14 事故的直接教训）----
*
* 那次事故里，我的组件在渲染期抛错，结果是**整个右栏变空**，
* 而且切到别的会话也回不来（错误边界卸载了整棵子树）。
*
* 本项目有一条更根本的纪律：**插件故障不能变成宿主故障**
* （`adapters/guard.js` 的注释、`server/routes.ts` 的 `registerRoutes` 都写着）。
* 右栏是宿主的 UI，我的页签只是其中一格 —— 我抛错不该让别人的页签一起消失。
*
* 有了这层：我的页签最多显示一句"这个页签出错了"，**其余右栏不受影响**。
*/
var TabErrorBoundary = class extends react.Component {
	constructor(props) {
		super(props);
		this.state = { message: void 0 };
	}
	static getDerivedStateFromError(error) {
		return { message: error?.message ?? String(error) };
	}
	componentDidCatch(error) {
		console.error("[ddd] 会话右栏页签渲染失败（其余右栏不受影响）：", error);
	}
	render() {
		if (this.state.message !== void 0) return h$1("div", { style: styles$1.note }, h$1("div", { style: styles$1.noteTitle }, "这个页签出错了"), h$1("div", { style: styles$1.mono }, this.state.message), h$1("div", { style: {
			marginTop: "8px",
			opacity: .7
		} }, "其余右栏不受影响。刷新页面可重试；若反复出现请把上面这句报给插件作者。"));
		return this.props.children;
	}
};
/**
* 页签正文（**带错误边界的外壳**）。
*
* ⚠️ 所有 hook 都在 `SessionTabInner` 里，而外壳本身**没有 hook**
* （class 组件的 `state` 不参与 hook 序列），所以抛错不会打乱 hook 顺序。
*/
function SessionTab(props) {
	return h$1(TabErrorBoundary, null, h$1(SessionTabInner, props));
}
/**
* 真正的正文。
*
* 数据流：`sessionId`（框架给）→ `cwd`（会话元数据快照）→ `GET /api/ddd/index`。
* 三者任一缺失都**显式说明缺哪一环**，不留白、不猜。
*
* ⚠️ **本组件的所有 hook 都在顶层无条件调用**（`useMemo` / `useState` / `useEffect`），
* 早退分支只决定"渲染什么"，不决定"调不调 hook"。这是修 2026-11-14 事故的核心纪律。
*/
function SessionTabInner({ sessionId = "", wiring }) {
	const cwd = react.useMemo(() => wiring === void 0 ? "" : wiring.cwdOf(sessionId), [wiring, sessionId]);
	const controller = react.useMemo(() => {
		if (wiring === void 0 || cwd === "") return void 0;
		return wiring.makeController({
			cwdOf: () => cwd,
			sessionIdOf: () => sessionId
		});
	}, [
		wiring,
		cwd,
		sessionId
	]);
	const [, force] = react.useState(0);
	react.useEffect(() => {
		if (controller === void 0) return void 0;
		return controller.subscribe(() => force((n) => n + 1));
	}, [controller]);
	react.useEffect(() => {
		if (controller === void 0) return void 0;
		return watchVisibility(controller);
	}, [controller]);
	react.useEffect(() => {
		if (controller === void 0) return void 0;
		return watchPolling(controller, DEFAULT_POLL_INTERVAL_MS);
	}, [controller]);
	if (wiring === void 0) return h$1("div", { style: styles$1.note }, "页签没有接上数据源（装配缺失，这是插件的问题）。");
	if (sessionId === "") return h$1("div", { style: styles$1.note }, "拿不到会话 id：这个页签只能在会话页的右栏里用。");
	if (cwd === "") return h$1("div", { style: styles$1.note }, h$1("div", { style: styles$1.noteTitle }, "拿不到这个会话的项目目录"), h$1("div", null, "DDD 需要知道项目根才能读门禁。会话元数据里暂时没有 cwd —— 等宿主回填后重开这个页签，或到主栏「文档驱动开发」里手动选一个目录。"));
	if (controller === void 0) return h$1(LoadingView);
	const snapshot = controller.getSnapshot();
	const error = controller.getError();
	const loading = controller.isLoading();
	if (error !== void 0) return h$1(ErrorView, {
		message: error,
		onRetry: controller.refresh
	});
	if (snapshot === void 0) return loading ? h$1(LoadingView) : h$1(ErrorView, {
		message: "没有拿到数据（这不应当发生）",
		onRetry: controller.refresh
	});
	if (snapshot.projectRoot === "") return h$1("div", null, h$1(EmptyView, { projectRoot: snapshot.projectRoot }), h$1("div", { style: styles$1.note }, `会话目录：${cwd}`));
	/** 会话作用域里**能**开预览 —— 这是需求 3 最大的红利。 */
	const onOpenDoc = (doc) => {
		const address = wiring.addressOf(sessionId, `docs/${doc.id}.md`, snapshot.projectRoot);
		try {
			wiring.openDoc(address);
		} catch (openError) {
			console.warn(`[ddd] 打开预览失败：${openError?.message ?? openError}`);
		}
	};
	/**
	* 交付区点文件 → 开预览（M2.6）。
	*
	* ---- 为什么这里能开、主栏不能 ----
	*
	* 右栏页签是 **session scope**，`openResource` 内部的 `this.mounted.getSnapshot()`
	* 能拿到"屏幕上挂载的会话" → 不抛。
	* 而主栏是 **root scope**，没有会话 → 必抛 `no session surface is mounted`。
	*
	* ---- 2026-11-14 用户第二次报同一个症状 ----
	*
	* 用户：「我去右侧侧边栏打开 ddd 的交付页面，我的鼠标移上去连手势都没变，
	*       也不能在右侧跳转出新窗口」。
	*
	* 我上一轮只修了主栏（`index.tsx` 的 `BoardPage`），**漏了这个页签**。
	* `session-tab.tsx` 挂 `MainPage` 时既没传 `onOpenFile`（→ 不可点）
	* 也没传那个禁用预览的 prop（→ 连提示语都没有），于是表现就是
	* "没手势、点了没反应、也不告诉你为什么"——**三样全占**。
	*
	* ⚠️ 教训：`MainPage` 有**两个**调用点（主栏 + 右栏页签），
	* 改一处不传递 = 只修一半。`_m23/verify-built-deliverables.mjs` 现在两处都查。
	*/
	const onOpenFile = (path) => {
		const address = wiring.addressOf(sessionId, path, snapshot.projectRoot);
		try {
			wiring.openDoc(address);
		} catch (openError) {
			console.warn(`[ddd] 打开交付文件失败：${openError?.message ?? openError}`);
		}
	};
	return h$1("div", { style: styles$1.page }, h$1("div", { style: styles$1.meta }, `会话目录：${cwd}`, h$1("span", { style: styles$1.metaDim }, "（自动，无需手选）")), snapshot.nextStep !== "" ? h$1("div", {
		style: styles$1.nextStep,
		title: "交接文档 §3「下一刀」的第一条"
	}, h$1("span", { style: styles$1.nextStepLabel }, "下一步"), h$1("span", null, snapshot.nextStep)) : null, h$1("div", { style: styles$1.bodyFill }, h$1(MainPage, {
		snapshot,
		onOpenDoc,
		onOpenFile,
		onArchive: (ids) => {
			controller.archive?.(ids);
		},
		onRestore: (paths) => {
			controller.restore?.(paths);
		},
		archiving: controller.isBusy?.() === true
	})), h$1(ReadOrderBar, {
		snapshot,
		onOpenDoc,
		sessionId
	}));
}
const styles$1 = {
	page: {
		height: "100%",
		display: "flex",
		flexDirection: "column",
		minHeight: 0
	},
	meta: {
		flexShrink: 0,
		padding: "6px 12px",
		fontSize: "11px",
		opacity: .65,
		borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))",
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	metaDim: { opacity: .6 },
	/** `下一步` 那一行（M2.3 演练复盘 §5）：交接 §3 的第一条。 */
	nextStep: {
		flexShrink: 0,
		padding: "6px 12px",
		fontSize: "12px",
		lineHeight: 1.5,
		borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))",
		background: "var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.06))"
	},
	nextStepLabel: {
		fontSize: "10px",
		letterSpacing: "0.04em",
		textTransform: "uppercase",
		opacity: .55,
		marginRight: "6px"
	},
	bodyFill: {
		flex: "1 1 auto",
		minHeight: 0,
		overflow: "auto"
	},
	note: {
		padding: "14px 16px",
		fontSize: "12px",
		lineHeight: 1.7,
		opacity: .8
	},
	noteTitle: {
		fontSize: "13px",
		fontWeight: 600,
		marginBottom: "6px",
		opacity: 1
	},
	/** 错误边界里显示原始错误文本（等宽，方便用户照抄给我）。 */
	mono: {
		fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
		fontSize: "11px",
		opacity: .85,
		wordBreak: "break-word"
	}
};

// src/client/index.tsx
/**
* client 半侧入口（M2-A/B/C/D/E）。
*
* ---- 这个文件的形式为什么是 `__ModuleLoader__.load({...})` ----
*
* SPEC §3.1：client bundle 的入口就是它。`factory(require)` 里
* **只能 `require` 白名单里的包**（`dsh.client.inject` + `PLATFORM_MODULES`），
* **不能 import 本地文件** —— 所以 tsdown 必须打成**单文件** `lib/client.js`。
*
* ---- 双注册（Q7 = C：少一个就白做）----
*
* | 用途 | 席位 | 关键字段 |
* |---|---|---|
* | 左栏入口行 | `sidebar.panellist` | `id` |
* | 主栏整页 | `main` | `key`（**必须等于上面的 id**） |
*
* 少注册 `main` 的症状是「点入口行没反应」——
* 而它与「bundle 崩了」在 UI 上**看起来一样**（都是没反应），所以 `smoke` 里有一条断言钉住成对注册。
*
* ---- S1 / S2：非 DDD 项目不显示 ----
*
* 面板**在客户端也要判断激活**：`/api/ddd/index` 返回 `projectRoot: ''` 时说明
* 这不是 DDD 项目（或没有激活标记）→ 显示「当前项目没有启用 DDD」，而不是显示 0/0
* （那会被误读成"没有必读文档"）。
*
* ⚠️ 注意：client 侧**不能**自己判断"是不是子代理会话"（拿不到那个事实）。
* S2 的硬约束在 host 侧（`tools/when.js` 的 fail-closed + 4 个工具的执行期兜底），
* 面板显示与否只是体验问题。
*/
const h = react.createElement;
/** 面板 id：`sidebar.panellist` 的 `id` 与 `main` 的 `key` **必须是同一个常量**。 */
const PANEL_ID = "ddd-construction-board";
/** 入口行的排序位（排在内置项之后，避免抢位）。 */
const PANEL_ORDER = 40;
/**
* 图标。`sidebar.panellist` 的 ownerProps 是 `{ size, active }`。
*
* 用内联 SVG 而不是 emoji：emoji 在不同字体下宽度不一致，会把入口行撑歪。
*/
function PanelIcon({ size = 20, active = false }) {
	return h("svg", {
		width: size,
		height: size,
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: active ? 2 : 1.6,
		strokeLinecap: "round",
		strokeLinejoin: "round",
		opacity: active ? 1 : .8,
		"aria-hidden": true
	}, h("path", { d: "M7 3h7l4 4v14H7z" }), h("path", { d: "M14 3v4h4" }), h("path", { d: "M4 7v14h10" }));
}
/**
* 造一个 controller。
*
* ⚠️ **不做轮询**（除非 `refreshMs > 0`）：M2-6 要求"刷新怎么触发"必须写清。
* 默认策略是**用户操作触发** + **打开面板时取一次**。理由：
* 轮询会让 host 每秒被叫一次，而这个面板大部分时间没人看。
*
* @param options.cwdOf 取当前 cwd（会话级）
* @param options.sessionIdOf 取当前会话 id（`gate.read` 依赖它）
* @param options.refreshMs 0 = 不轮询
*/
function createController(options) {
	let snapshot;
	let error;
	let loading = false;
	let inflight = 0;
	/** 用户显式选定的项目根。空串 = 还没选（**不猜**）。 */
	let chosenCwd = options.cwdOf();
	/** 项目候选列表 + 它的加载状态。 */
	let projects = [];
	let projectsLoading = false;
	let projectsLoaded = false;
	const listeners = /* @__PURE__ */ new Set();
	const notify = () => {
		for (const listener of listeners) listener();
	};
	let busy = false;
	/**
	* 归档 / 还原的共用执行器。
	*
	* 三件事必须一起做，少一件就会留下"看起来没生效"的症状：
	*   1. 置忙 → 禁按钮，防止用户连点（第二次点会因"坟场已有同名"失败）；
	*   2. **真的发请求**（`postArchive` / `postRestore`）；
	*   3. 不论成败都**重新取数** —— 部分成功时界面必须反映"哪几份动了"。
	*
	* ⚠️ 第 3 条是重点：归档是**部分成功**语义（host 返回 `moved` + `failed`）。
	* 只刷"全部成功"的情况会让"3 份里成功 2 份"看起来像完全没动。
	*/
	const runGraveyardAction = async (action, items) => {
		if (busy) return {
			ok: false,
			error: "上一次归档/还原还没结束",
			moved: [],
			failed: []
		};
		busy = true;
		notify();
		let result;
		try {
			result = await action(items, {
				sessionId: options.sessionIdOf(),
				cwd: chosenCwd
			});
		} finally {
			busy = false;
		}
		await load();
		notify();
		return result;
	};
	/** 拉项目候选列表（只在第一次需要时拉，之后靠 refreshProjects 手动刷）。 */
	const loadProjects = async () => {
		if (options.projectsOf === void 0) return;
		projectsLoading = true;
		notify();
		try {
			projects = await options.projectsOf();
		} catch {
			projects = [];
		}
		projectsLoading = false;
		projectsLoaded = true;
		notify();
	};
	const load = async () => {
		const ticket = ++inflight;
		loading = true;
		error = void 0;
		notify();
		const result = await fetchSnapshot(chosenCwd, options.sessionIdOf());
		if (ticket !== inflight) return;
		loading = false;
		if (result.kind === "ok") {
			snapshot = result.data;
			error = void 0;
		} else error = result.message;
		notify();
	};
	/**
	* 用户选了项目根。
	*
	* ⚠️ **必须真的重新取数**：只改一个局部变量而不 reload，
	* 会让面板显示"上一个项目"的数据 + "新项目"的标题 ——
	* 那正是本项目最怕的症状（把错误的信任可视化）。
	*
	* @param cwd 选中的绝对路径；空串表示"取消选择"
	*/
	const selectProject = (cwd) => {
		chosenCwd = typeof cwd === "string" ? cwd : "";
		snapshot = void 0;
		error = void 0;
		notify();
		if (chosenCwd === "") return;
		load();
	};
	/**
	* 打开原生目录选择器并选中结果。
	*
	* 选到就把该目录加进候选（标记为"未探测"，`isDdd` 先按 false 显示），
	* 然后走 `selectProject` 真的取数 —— 取数会顺便让 host 探测它是不是 DDD 项目。
	*/
	const pickProject = async () => {
		if (options.pickDirectoryOf === void 0) return {
			kind: "unavailable",
			reason: "当前没有接上目录选择器。"
		};
		const result = await options.pickDirectoryOf();
		if (result.kind === "picked") {
			if (!projects.some((project) => project.cwd === result.cwd)) projects = [{
				cwd: result.cwd,
				projectRoot: "",
				isDdd: false
			}, ...projects];
			projectsLoaded = true;
			selectProject(result.cwd);
		}
		notify();
		return result;
	};
	/**
	* 真的重新检查：先让 host 清探测缓存，再重新取数。
	*
	* ⚠️ **顺序不能反**：如果先取数再清缓存，取到的仍是旧结果。
	*/
	const recheck = async () => {
		const cwd = chosenCwd;
		if (cwd !== "" && options.recheckOf !== void 0) {
			try {
				await options.recheckOf(cwd);
			} catch {}
			try {
				const refreshed = await options.projectsOf?.();
				if (Array.isArray(refreshed)) {
					projects = refreshed;
					projectsLoaded = true;
				}
			} catch {}
		}
		await load();
	};
	/**
	* 一键初始化当前目录。
	*
	* 成功后**必须重新探测 + 重新取数**，否则面板还是"这不是 DDD 项目"。
	*/
	const initializeProject = async () => {
		if (options.initOf === void 0) return {
			ok: false,
			error: "当前没有接上初始化功能。",
			created: [],
			skipped: [],
			failed: []
		};
		const cwd = chosenCwd;
		if (cwd === "") return {
			ok: false,
			error: "请先选择或浏览一个目录。",
			created: [],
			skipped: [],
			failed: []
		};
		const result = await options.initOf(cwd);
		if (result.ok || result.created.length > 0) await recheck();
		notify();
		return result;
	};
	load();
	const base = {
		getSnapshot: () => snapshot,
		getError: () => error,
		isLoading: () => loading,
		refresh: () => {
			load();
		},
		getChosenCwd: () => chosenCwd,
		getSessionId: () => options.sessionIdOf(),
		getProjects: () => projects,
		isProjectsLoading: () => projectsLoading,
		areProjectsLoaded: () => projectsLoaded,
		refreshProjects: () => {
			loadProjects();
		},
		selectProject,
		pickProject,
		recheck,
		initializeProject,
		archive: (ids) => runGraveyardAction(postArchive, ids),
		restore: (paths) => runGraveyardAction(postRestore, paths),
		isBusy: () => busy,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
	};
	if ((options.refreshMs ?? 0) > 0) {
		const timer = setInterval(() => {
			load();
		}, options.refreshMs);
		return {
			...base,
			subscribe: (listener) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
					if (listeners.size === 0) clearInterval(timer);
				};
			}
		};
	}
	return base;
}
/**
* 订阅 controller 的小 hook（不引入 react-dom，只用 react）。
*
* @param controller 要订阅的 controller
* @returns 当前快照 / 错误 / 加载态
*/
function useControllerState(controller) {
	const [, force] = react.useState(0);
	react.useEffect(() => {
		return controller.subscribe(() => force((n) => n + 1));
	}, [controller]);
	return {
		snapshot: controller.getSnapshot(),
		error: controller.getError(),
		loading: controller.isLoading()
	};
}
/**
* 数据态三选一（loading / error / empty / 正常）—— **绝不留白**。
*
* @param props.footer 拿到**真快照**后渲染在底部的附加区（M2.3 的阅读顺序条）。
*
* 为什么把 footer 挂在这一层而不是 `BoardPage`：这里才知道"快照到底有没有到手"。
* 挂在外面会让条在「还没选项目根」时也出现 —— 那会显示一个**假的 0/0 进度**，
* 正是本项目最怕的症状。
*/
function BodyWith({ controller, render, footer }) {
	const { snapshot, error, loading } = useControllerState(controller);
	react.useEffect(() => watchVisibility(controller), [controller]);
	react.useEffect(() => watchPolling(controller, DEFAULT_POLL_INTERVAL_MS), [controller]);
	if (controller.getChosenCwd() === "" && snapshot === void 0 && !loading) return h("div", { style: styles.pageEmpty }, h("div", { style: styles.pageEmptyTitle }, "请先选择项目根"), h("div", { style: styles.pageEmptyBody }, "宿主不会告诉面板\"当前是哪个项目\"，所以需要你在上面的下拉里选一个。"), h("div", { style: styles.pageEmptyBody }, "选完会立刻读取该项目的门禁与文档清单。"));
	if (error !== void 0) return h(ErrorView, {
		message: error,
		onRetry: controller.refresh
	});
	if (snapshot === void 0) return loading ? h(LoadingView) : h(ErrorView, {
		message: "没有拿到数据（这不应当发生）",
		onRetry: controller.refresh
	});
	if (snapshot.projectRoot === "") return h(EmptyView, { projectRoot: snapshot.projectRoot });
	const body = render(snapshot);
	const bottom = footer === void 0 ? null : footer(snapshot);
	if (bottom === null) return body;
	return h("div", { style: styles.bodyColumn }, h("div", { style: styles.bodyFill }, body), bottom);
}
/** 左栏入口行（图标）。 */
function EntryIcon(props) {
	return h(PanelIcon, props);
}
/**
* 项目根选择器（M2.2）。
*
* ---- 为什么必须有这个控件（而不是自动判断）----
*
* 宿主**设计上**不给 root-scope 的 `main` 席位任何会话绑定
* （`dsh-client-ui-layout` 注释原文：「other keys receive no Session binding」），
* 而 client 侧也没有任何服务暴露"用户当前选中了哪个会话"。
*
* 所以面板**不可能**自己知道该查哪个项目。硬猜的后果是：
* 显示**另一个项目**的门禁读数 —— 那比不显示更糟（把错误的信任可视化）。
*
* 因此这里让用户**显式选**，候选由 host 的 `/api/ddd/projects` 提供
* （只有 host 能读会话目录、判断有没有 `docs/`）。
*/
function ProjectPicker({ controller }) {
	useControllerState(controller);
	const chosen = controller.getChosenCwd();
	const projects = controller.getProjects();
	const loading = controller.isProjectsLoading();
	const loaded = controller.areProjectsLoaded();
	const [pickNote, setPickNote] = react.useState(void 0);
	const [picking, setPicking] = react.useState(false);
	const [busy, setBusy] = react.useState(void 0);
	const [initNote, setInitNote] = react.useState(void 0);
	const previewNote = usePreviewError();
	react.useEffect(() => {
		if (!loaded && !loading) controller.refreshProjects();
	}, [
		controller,
		loaded,
		loading
	]);
	const options = [h("option", {
		key: "",
		value: "",
		style: styles.option
	}, chosen === "" ? "— 请选择项目根 —" : "— 取消选择 —"), ...projects.map((project) => h("option", {
		key: project.cwd,
		value: project.cwd,
		style: styles.option
	}, `${project.isDdd ? "● " : "○ "}${project.cwd}`))];
	/** 点"浏览…"：走宿主原生目录选择器，可指定任意目录。 */
	const onBrowse = async () => {
		if (picking) return;
		setPicking(true);
		setPickNote(void 0);
		try {
			const result = await controller.pickProject();
			if (result.kind === "unavailable") setPickNote(result.reason);
		} finally {
			setPicking(false);
		}
	};
	/**
	* 点 ⟳：**真的**重新探测（不只是重取快照）。
	*
	* 旧实现只调 `refreshProjects()` + `refresh()`，而 host 的探测有 TTL 缓存，
	* 所以「刚建好 docs/ 点刷新」永远看不到变化（用户 2026-11-13 实测）。
	*/
	const onRecheck = async () => {
		if (busy !== void 0) return;
		setBusy("recheck");
		setInitNote(void 0);
		try {
			await controller.recheck();
			setInitNote("已重新探测。");
		} finally {
			setBusy(void 0);
		}
	};
	/** 点「初始化为 DDD 工作区」：建 docs/ + 写入口索引，然后立刻重新探测。 */
	const onInit = async () => {
		if (busy !== void 0) return;
		setBusy("init");
		setInitNote(void 0);
		try {
			const result = await controller.initializeProject();
			if (result.ok) {
				const made = result.created.length > 0 ? `已创建：${result.created.join("、")}` : "没有新建任何东西";
				const skipped = result.skipped.length > 0 ? `；已跳过：${result.skipped.join("、")}` : "";
				setInitNote(`${made}${skipped}`);
			} else if (result.failed.length > 0) setInitNote(`失败：${result.failed.map((item) => `${item.path}（${item.error}）`).join("；")}`);
			else setInitNote(`失败：${result.error ?? "未知原因"}`);
		} finally {
			setBusy(void 0);
		}
	};
	const hasChosen = chosen !== "";
	return h("div", { style: styles.pickerWrap }, h("div", { style: styles.picker }, h("label", {
		style: styles.pickerLabel,
		htmlFor: "ddd-project-picker"
	}, "项目根"), h("select", {
		id: "ddd-project-picker",
		style: styles.select,
		value: chosen,
		disabled: loading,
		onChange: (event) => {
			controller.selectProject(event.target.value);
		}
	}, options), h("button", {
		type: "button",
		style: styles.actionButton,
		onClick: () => {
			onBrowse();
		},
		disabled: picking,
		title: "选择一个还没出现在列表里的目录"
	}, picking ? "选择中…" : "浏览…"), h("button", {
		type: "button",
		style: styles.actionButton,
		onClick: () => {
			onRecheck();
		},
		disabled: busy !== void 0,
		title: "重新探测当前目录（新建了 docs/ 之后点这个）"
	}, busy === "recheck" ? "探测中…" : "⟳"), h("button", {
		type: "button",
		style: hasChosen ? styles.primaryButton : styles.actionButtonDisabled,
		onClick: () => {
			onInit();
		},
		disabled: busy !== void 0 || !hasChosen,
		title: "在这个目录里建 docs/ 并写一份入口索引"
	}, busy === "init" ? "初始化中…" : "初始化为 DDD 工作区")), h("div", { style: styles.pickerMeta }, loading ? "正在读取已知项目…（宿主可能还在加载会话，稍后点 ⟳ 会更全）" : `● 已启用 DDD ｜ ○ 尚未启用 ｜ 共 ${projects.length} 个已知目录`, pickNote === void 0 ? null : h("span", { style: styles.pickerWarn }, ` ｜ ${pickNote}`), initNote === void 0 ? null : h("span", { style: styles.pickerNote }, ` ｜ ${initNote}`), previewNote === void 0 ? null : h("span", { style: styles.pickerWarn }, ` ｜ 预览：${previewNote}`)), h("div", { style: styles.pickerBoundary }, PREVIEW_BOUNDARY_NOTE));
}
/** 主栏整页。 */
function BoardPage({ controller }) {
	return h("div", { style: styles.page }, h(ProjectPicker, { controller }), h(BodyWith, {
		controller,
		render: (snapshot) => h(MainPage, {
			snapshot,
			previewDisabled: true,
			onOpenDoc: (doc) => openDoc(controller, snapshot, doc),
			onArchive: (ids) => {
				controller.archive(ids);
			},
			onRestore: (paths) => {
				controller.restore(paths);
			},
			archiving: controller.isBusy()
		}),
		footer: (snapshot) => h(ReadOrderBar, {
			snapshot,
			previewDisabled: true,
			sessionId: controller.getSessionId(),
			onOpenDoc: (item) => {
				const doc = snapshot.required.find((each) => each.id === item.id);
				if (doc !== void 0) openDoc(controller, snapshot, doc);
			}
		})
	}));
}
/**
* 打开一份文档的预览。
*
* ---- 为什么要把这段抽出来（2026-11-13 用户实测）----
*
* 用户：「鼠标放上去会变手势，但点击没有反应，打不开文档」。
*
* 两个原因叠在一起：
*   1. `sidebarRight` 从来没被拿到（`ctx.get` 对它无效，必须写进 `inject`）；
*   2. 就算拿到了，地址里的 `sessionId` 是空串时 `parseFileAddress` **直接返回 undefined**
*      —— 那是一个"看起来有地址、实际解析不了"的字符串。
*
* 所以这里做三件事：**取真 sessionId → 拼可解析地址 → 打不开就明说**，
* 而不是让用户点了没反应。
*/
function openDoc(controller, snapshot, doc) {
	const sessionId = controller.getSessionId() || snapshot.sessionId;
	const address = previewAddressOf(sessionId, `docs/${doc.id}.md`, snapshot.projectRoot);
	if (!isOpenableAddress(address)) {
		console.warn(`[ddd] 预览地址不可解析（sessionId='${sessionId}'）：${address}`);
		setPreviewError("拿不到会话 id，预览打不开。");
		return;
	}
	setPreviewError(void 0);
	openPreview(address);
}
/**
* 预览在本面板里是否**根本不可能**（设计边界，不是临时故障）。
*
* 判据来自源码：右栏席位全是 `scope:'session'`，而 `main` 面板是 `scope:'root'`。
* root 面板上没有会话挂载 → `sidebarRight.openResource` 必抛
* `no session surface is mounted`。
*
* ⚠️ 所以这里返回 `true` 时，**文档行不该显示可点击手势** ——
* 否则就是"看起来能点、点了没反应"，那是本项目最忌讳的症状。
*/
const PREVIEW_UNAVAILABLE_IN_ROOT_PANEL = true;
/**
* 这条提示要一直显示（不是错误，是边界说明）。
*
* ---- 2026-11-14 M2.6：改成用户能照做的说法 ----
*
* 旧文案：「预览只能在会话页打开：本面板没有会话上下文（右栏是会话作用域的）。」
* 那是**给开发者看的**。用户读完仍然不知道"会话页在哪、我该点什么"。
*
* 新文案要回答三个问题：**为什么点不开**、**文件在哪**、**去哪儿点能打开**。
*
* ⚠️ 这是硬边界，不是能修的 bug（已核实 `_ref/asar` 里 sidebar-right 的源码）：
*    `openResource(address)` 第一行 `this.require()` 里 `this.mounted.getSnapshot()`
*    取的是**屏幕上挂载的会话**；root 面板没有会话 → 必然抛
*    `sidebarRight: no session surface is mounted`。
*    换 scope 拼地址也没用 —— 那是服务内部的前置条件。
*/
const PREVIEW_BOUNDARY_NOTE = "文件在项目的 `docs/` 与 `deliverables/` 目录下。本面板（主栏）没有会话上下文，点不开预览 —— 要打开文件，请到**会话页右侧栏**的 DDD 页签里点同一份。";
/**
* 预览为什么在这个面板里打不开（**设计边界，不是 bug**）。
*
* ---- 2026-11-13 用户实测 + 源码核实 ----
*
* 用户：「鼠标放上去会变手势，但点击没有反应，打不开文档」。
*
* 核实结论（`dsh-client-ui-sidebar-right/src/client/service.ts` L854-864）：
*
* ```js
* private require() {
*   const sessionId = this.mounted.getSnapshot()   // ← 屏幕上的会话
*   const actions = sessionId === undefined ? undefined : this.actionsFor(sessionId)
*   if (sessionId === undefined || actions === undefined) {
*     throw new Error('sidebarRight: no session surface is mounted')
*   }
*   ...
* }
* ```
*
* 而右栏的所有席位（`sidebar.right.pane.tab` 等）都是 **`scope: 'session'`**。
*
* DDD 的主栏面板是 **root scope**（`main` 席位的 `scope: 'root'`），
* 它上面**没有会话在屏幕上** —— 所以：
*
*   * 右栏不存在；
*   * `openResource` 一调就**抛** `no session surface is mounted`。
*
* ⇒ **在这个面板里永远打不开预览。** 不是拼错了地址，也不是没拿到 sidebarRight。
*
* ---- 那正确的出路是什么 ----
*
* **在会话页右侧栏注册一个 DDD 页签**（需求 3）。那里是 session scope，
* 有 `sessionId`、有右栏、`openResource` 能用 —— 而且**不需要用户手选项目根**。
* 详见交接文档的「需求 3」。
*/
/**
* 最近一次"打不开"的原因（M2.2）。
*
* 用一个模块级订阅点把它暴露给 `ProjectPicker` 下方的提示行 ——
* "点了没反应"是最难查的症状，所以失败必须**在界面上留痕**，不能只打 console。
*/
let previewError;
const previewErrorListeners = /* @__PURE__ */ new Set();
function setPreviewError(message) {
	previewError = message;
	for (const listener of previewErrorListeners) listener();
}
/** 订阅预览错误（供 `ProjectPicker` 用）。 */
function usePreviewError() {
	const [, force] = react.useState(0);
	react.useEffect(() => {
		const listener = () => force((n) => n + 1);
		previewErrorListeners.add(listener);
		return () => {
			previewErrorListeners.delete(listener);
		};
	}, []);
	return previewError;
}
/** 选择器那几行的样式（与 main-page 一致地走主题变量，不写死颜色）。 */
const styles = {
	page: {
		height: "100%",
		display: "flex",
		flexDirection: "column",
		minHeight: 0
	},
	/**
	* `BodyWith` 带 footer 时的列容器（M2.3 需求 2）。
	*
	* `minHeight: 0` 是关键：flex 子项默认 `min-height: auto`，
	* 不写它的话内容撑高后**底部那条会被挤出可视区**，
	* 用户会以为"没有这个功能"。
	*/
	bodyColumn: {
		flex: "1 1 auto",
		minHeight: 0,
		display: "flex",
		flexDirection: "column"
	},
	/** 正文区：吃掉剩余高度，允许内部滚动（底条因此不会被顶出去）。 */
	bodyFill: {
		flex: "1 1 auto",
		minHeight: 0,
		overflow: "hidden"
	},
	pickerWrap: {
		flexShrink: 0,
		borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))"
	},
	picker: {
		display: "flex",
		alignItems: "center",
		gap: "8px",
		padding: "10px 20px 4px",
		flexShrink: 0
	},
	pickerMeta: {
		padding: "0 20px 8px",
		fontSize: "11px",
		opacity: .5
	},
	pickerWarn: {
		color: "var(--dsw-alias-state-warn-primary, #d29922)",
		opacity: 1
	},
	pickerNote: {
		color: "var(--dsw-alias-label-secondary, #9a9a9a)",
		opacity: 1
	},
	pickerBoundary: {
		padding: "0 20px 8px",
		fontSize: "11px",
		color: "var(--dsw-alias-label-secondary, #9a9a9a)",
		opacity: .8
	},
	pickerLabel: {
		fontSize: "12px",
		opacity: .65,
		flexShrink: 0
	},
	select: {
		flex: "1 1 auto",
		minWidth: 0,
		font: "inherit",
		fontSize: "12px",
		padding: "4px 6px",
		color: "var(--dsw-alias-label-primary, #e6e6e6)",
		background: "var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.08))",
		border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))",
		borderRadius: "4px"
	},
	option: {
		color: "var(--dsw-alias-label-primary, #e6e6e6)",
		background: "var(--dsw-alias-bg-overlay, #1e1e1e)"
	},
	pickerHint: {
		fontSize: "11px",
		opacity: .5,
		flexShrink: 0
	},
	actionButton: {
		font: "inherit",
		fontSize: "12px",
		padding: "3px 8px",
		color: "var(--dsw-alias-label-primary, #e6e6e6)",
		background: "transparent",
		border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))",
		borderRadius: "4px",
		cursor: "pointer",
		flexShrink: 0
	},
	actionButtonDisabled: {
		font: "inherit",
		fontSize: "12px",
		padding: "3px 8px",
		color: "var(--dsw-alias-label-secondary, #9a9a9a)",
		background: "transparent",
		border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))",
		borderRadius: "4px",
		cursor: "not-allowed",
		opacity: .5,
		flexShrink: 0
	},
	primaryButton: {
		font: "inherit",
		fontSize: "12px",
		padding: "3px 10px",
		color: "var(--dsw-alias-bg-base, #1e1e1e)",
		background: "var(--dsw-alias-brand-primary, #58a6ff)",
		border: "1px solid var(--dsw-alias-brand-primary, #58a6ff)",
		borderRadius: "4px",
		cursor: "pointer",
		flexShrink: 0,
		fontWeight: 600
	},
	pageEmpty: {
		flex: "1 1 auto",
		padding: "28px 24px",
		font: "13px/1.7 system-ui, -apple-system, \"Segoe UI\", sans-serif",
		color: "var(--dsw-alias-label-primary, #e6e6e6)",
		maxWidth: "560px"
	},
	pageEmptyTitle: {
		fontSize: "15px",
		fontWeight: 600,
		marginBottom: "10px"
	},
	pageEmptyBody: {
		opacity: .72,
		marginBottom: "8px"
	}
};
/**
* 开预览（M2-B）。
*
* 走 `ctx.sidebarRight.openResource(address)` —— **不自己写渲染器**（SPEC §3.12）。
* 但 `ctx` 不在这个模块作用域里，所以由 `apply` 时把 opener 注进来。
*/
let previewOpener;
/** 由 `apply()` 注入真正的 opener。 */
function setPreviewOpener(opener) {
	previewOpener = opener;
}
/** 内部：调 opener。拿不到时**不静默**——打一条 warn（不然"点了没反应"没法查）。 */
function openPreview(address) {
	if (previewOpener === void 0) {
		console.warn(`[ddd] 预览通道不可用（sidebarRight 未注入），地址是：${address}`);
		return;
	}
	try {
		previewOpener(address);
	} catch (error) {
		console.warn(`[ddd] 打开预览失败：${error?.message ?? error}`);
	}
}
/**
* 注册两个席位（Q7 双注册）。
*
* ⚠️ **每个注册都包在 `slots.inject` 里**（照 skill-explorer）：
* 席位由我们不依赖的 shell 插件声明，`inject` 的回调只在它声明之后才跑。
* 一个从未声明该席位的 shell 会让面板**简单地不存在**，而不是启动失败。
*
* @returns disposer（两个注册一起释放）
*/
function registerPanel(ctx, controller) {
	let slots;
	try {
		slots = typeof ctx?.get === "function" ? ctx.get("slots") : void 0;
	} catch {
		slots = void 0;
	}
	if (slots === void 0 || typeof slots.inject !== "function") {
		console.warn("[ddd] 没有 slots 服务，面板未注册");
		return () => {};
	}
	const disposers = [];
	disposers.push(slots.inject("sidebar.panellist", () => slots.register({
		name: "sidebar.panellist",
		id: PANEL_ID,
		order: 40,
		label: () => "文档驱动开发"
	}, EntryIcon)));
	disposers.push(slots.inject("main", () => slots.register({
		name: "main",
		key: PANEL_ID,
		inject: () => ({ controller })
	}, BoardPage)));
	return () => {
		for (const dispose of disposers.splice(0)) try {
			dispose();
		} catch {}
	};
}
/**
* 注册**会话右栏页签**（M2.3 · 需求 3）。
*
* ---- 两段式注册（照官方 `ui-sidebar-documentpreview`）----
*
* | 阶段 | 去哪 | 键 |
* |---|---|---|
* | ① 类型 | `ctx.sidebarRightTabs.register(definition)` | `definition.id` |
* | ② 正文 | keyed `sidebar.right.pane.tab` | `definition.id` |
*
* ⚠️ **两段的键必须逐字一致**（都是 `DDD_TAB_ID`）。不一致的症状是
* "点开页签一片空白"，而且**不报错** —— 因为宿主的判据是
* "没有类型认领这个 kind → 渲染 owner 的 'nothing can view this' 提示"。
*
* ---- 与 `registerPanel` 的分工 ----
*
* `registerPanel` 管的是 **root scope** 的两个席位（左栏入口 + 主栏整页），
* 本函数管的是 **session scope** 的右栏页签。两者**互不影响**：
* root 面板里预览永远打不开（事实没变），右栏页签里能打开。
*
* @param ctx client 根上下文（`inject` 必须含 `sidebarRightTabs` 与 `slots`）
* @param wiring 交给组件的取数/开预览能力
* @returns disposer（三个注册一起释放）
*/
function registerSessionTab(ctx, wiring) {
	const disposers = [];
	let tabs;
	try {
		tabs = ctx?.sidebarRightTabs;
	} catch {
		tabs = void 0;
	}
	if (tabs === void 0) try {
		tabs = typeof ctx?.get === "function" ? ctx.get("sidebarRightTabs") : void 0;
	} catch {
		tabs = void 0;
	}
	if (tabs === void 0 || typeof tabs.register !== "function") {
		console.warn("[ddd] 没有 sidebarRightTabs 服务，会话右栏页签未注册（主栏不受影响）");
		return () => {};
	}
	const definition = dddTabDefinition();
	try {
		disposers.push(tabs.register(definition));
	} catch (error) {
		console.warn(`[ddd] 注册 tab 类型失败：${error?.message ?? error}`);
		return () => {};
	}
	let slots;
	try {
		slots = typeof ctx?.get === "function" ? ctx.get("slots") : void 0;
	} catch {
		slots = void 0;
	}
	if (slots === void 0 || typeof slots.inject !== "function") {
		console.warn("[ddd] 没有 slots 服务，会话右栏页签正文未注册");
		for (const dispose of disposers.splice(0)) try {
			dispose();
		} catch {}
		return () => {};
	}
	disposers.push(slots.inject("sidebar.right.pane.tab", () => slots.register({
		name: "sidebar.right.pane.tab",
		key: DDD_TAB_ID,
		inject: () => ({ wiring })
	}, SessionTab)));
	disposers.push(slots.inject("sidebar.right.pane.tab.title", () => slots.register({
		name: "sidebar.right.pane.tab.title",
		key: DDD_TAB_ID
	}, DddTabTitle)));
	return () => {
		for (const dispose of disposers.splice(0)) try {
			dispose();
		} catch {}
	};
}
/** 页签标题（chip 上显示的字）。 */
function DddTabTitle() {
	return h("span", null, "文档驱动开发");
}

// src/client/entry.tsx
/**
* client bundle 的**入口**（tsdown 打成单文件 `lib/client.js`）。
*
* ---- 为什么要这一层薄壳 ----
*
* `__ModuleLoader__.load({ id, factory })` 的 `factory(require)` 里
* **只能 `require` 白名单里的包**，**不能 import 本地文件**
* （SPEC §3.1 + `@local/dsh-plugin` 的真实源码）。
*
* 所以：**所有本地模块必须被 tsdown 打进同一个文件**，
* 而 `react` 等白名单包必须保持 `require(...)` 的形态、**不许被打包进去**。
*
* ---- `id` 必须与 package 名一致 ----
*
* `smoke-ddd.mjs` 有一条断言钉住它（SPEC §8.2 第 3 条）：
* `lib/client.js` 里有 `__ModuleLoader__.load` 且 `id` 与 package name 一致。
*
* ---- ⚠️ 2026-11-13 的实机事故（**别再犯**）----
*
* 这个文件里曾经直接写 `const sidebarRight = ctx?.sidebarRight`。
* cordis 的 `ctx` 是 **Proxy**：读一个**没写进 `inject` 的服务会直接抛**
* `cannot get property "sidebarRight" without inject`，`?.` 拦不住。
* 结果 `apply()` 在第一行就死 → 双注册永不执行 → **面板不出现**，
* 而 entry 仍是 active、factory 仍已注册、**且不写 crash 日志**。
*
* 现在所有可选服务一律走 `entry-logic.ts` 的 `softService`（即 `ctx.get(...)`）。
* 那个文件的逻辑有 `test/client-entry.test.js` 钉着。
*
* ⚠️ **纯逻辑不要写在这个 `.tsx` 里**：Node 的类型剥离不处理 JSX，
* `.tsx` 无法被单测 import（`ERR_UNKNOWN_FILE_EXTENSION`）。
* 想被测到 → 放 `entry-logic.ts`。
*/
/**
* 在会话作用域里开预览。
*
* 与 `wirePreview` 的区别：那条是"把 opener 装进槽位给 root 面板用"（可能降级），
* 这条是**当场调用**（页签里点文档时）。两者共用同一个 `ctx.sidebarRight`。
*
* 拿不到 `sidebarRight` 时**抛**，由调用方 warn —— 页签里点了没反应比抛更难查。
*/
function openPreviewVia(ctx, address) {
	const sidebarRight = ctx?.sidebarRight;
	if (sidebarRight === void 0 || typeof sidebarRight?.openResource !== "function") throw new Error("sidebarRight 不可用");
	sidebarRight.openResource(address);
}
/**
* 注入预览通道（M2-B）。
*
* 真实现与"拿不到时怎么降级"都在 `entry-logic.ts` 的 `wirePreviewOf` 里，
* 这里只负责把结果装进 `index.tsx` 的 opener 槽位。
*/
function wirePreview(ctx) {
	const wire = wirePreviewOf(ctx);
	if (wire.kind === "unavailable") console.warn(wire.warning);
	setPreviewOpener(wire.open);
}
/**
* Cordis 客户端插件入口。
*
* ---- `inject` 里为什么有 `sidebarRight` / `sidebarRightTabs` ----
*
* 这两个都是 `dsh-client-ui-sidebar-right` 用 `ctx.reflect.provide` 提供的。
* `provide()` 写的与 `get()` 读的是**同一个 store**，所以 `ctx.get` 并非"永远拿不到"
* —— 但 `get(name, strict = true)` 在**提供方 fiber 还没 active** 时返回 `undefined`，
* 那是时序问题。写进 `inject` 后由 cordis 负责等它 active，才是正路
* （官方 `ui-reference` / `ui-chat` / `ui-plan` / `ui-sidebar-documentpreview` 都这么做）。
*
* 不写 `sidebarRight` 的后果（2026-11-13 用户实测）：「鼠标放上去会变手势，但点击没有反应」。
* 不写 `sidebarRightTabs` 的后果（M2.3）：会话右栏的 DDD 页签**不出现**。
*
* ⚠️ 其余可选服务（`layout` / `sessions` / `uiWorkspace`）仍然走 `ctx.get(...)` 软取，
* 保持「缺服务只降级，不让插件消失」的纪律。
*/
var entry_default = {
	inject: [
		"slots",
		"sidebarRight",
		"sidebarRightTabs"
	],
	apply(ctx) {
		wirePreview(ctx);
		const { cwdOf, sessionIdOf } = sessionInfoOf(ctx, "");
		const controller = createController({
			cwdOf,
			sessionIdOf,
			projectsOf: fetchProjects,
			pickDirectoryOf: () => pickProjectDirectory(ctx),
			recheckOf: postRecheck,
			initOf: postInit
		});
		const disposePanel = registerPanel(ctx, controller);
		let disposeTab = () => {};
		try {
			disposeTab = registerSessionTab(ctx, {
				cwdOf: (sessionId) => resolveCwd(ctx, sessionId),
				fetchSnapshot,
				makeController: (options) => createController(options),
				openDoc: (address) => {
					try {
						openPreviewVia(ctx, address);
					} catch (error) {
						console.warn(`[ddd] 页签内打开预览失败：${error?.message ?? error}`);
					}
				},
				addressOf: previewAddressOf
			});
		} catch (error) {
			console.warn(`[ddd] 会话右栏页签注册失败（主栏不受影响）：${error?.message ?? error}`);
		}
		return () => {
			try {
				disposeTab();
			} catch {}
			try {
				disposePanel();
			} catch {}
		};
	}
};

// src/client/boot.tsx
/**
* client bundle 的构建入口（tsdown 打成单文件 `lib/client.js`）。
*
* ---- 这个文件**不写** `window.__ModuleLoader__.load` ----
*
* 那个外壳由 `tsdown.config.ts` 的 `banner` / `footer` 包：
* ```js
* window.__ModuleLoader__.load({id:"@local/ddd",factory:(require)=>{var module={exports:{}};
*   ... 本文件的 CJS 产物 ...
* return module.exports.default ... ;}});
* ```
*
* **为什么不在这个文件里手写外壳**：那样 `require('react')` 会变成**模块顶层的
* 自由变量引用**，打包后指向全局 `require`（宿主的 `factory` 参数作用域外），
* 运行时 `require is not defined`。外壳必须由打包器在**最外层**加上，
* 这样 CJS 的 `require(...)` 才落在 `factory(require)` 的参数作用域里。
*
* （真实可运行的范例：`dsh-cuigengji-plugin/lib/client.js` 的头尾。）
*
* ---- `factory(require)` 里能用什么 ----
*
* 只能 `require` 白名单里的包（`dsh.client.inject` + `PLATFORM_MODULES`），
* **不能 import 本地文件** —— 所以本文件及其依赖必须被**打进同一个文件**。
*/
var boot_default = entry_default;

module.exports = boot_default;
return module.exports.default !== undefined ? module.exports.default : module.exports;}});
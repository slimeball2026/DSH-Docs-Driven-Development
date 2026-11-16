/**
 * 索引的划分逻辑（SPEC §6.1 的慢变量侧）。
 *
 * 输入是注册表里的文档元数据，输出三份清单：
 * - `required`  必读清单（施工前必须读完）
 * - `forbidden` 禁止清单（`sealed`：内容有诱惑力但已被推翻）
 * - `anomalies` 文档异常（V1–V6 的 error）
 *
 * **纯函数，零 IO / 零时间 / 零随机。**
 *
 * 三条划分规则（都能在 SPEC 里找到出处）：
 * 1. **有 error 的文档一律进 anomalies，不进 required** ——
 *    §5.4：「error 不阻塞读取，只阻塞"用它当依据"」。
 * 2. **`sealed` 进 forbidden，不进 required，也**不进坟场** ——
 *    §5.3：它是"原地封存、就地警告"；扔进坟场反而危险（可能被翻出来当有效文档）。
 * 3. `superseded` / `void` / `draft` 都不进 required（不可执行），但也**不报异常**。
 */

/** status 是否可被 AI 执行（SPEC §5.3 的「可被 AI 执行」列）。 */
export function isExecutable(status) {
  return status === 'authoritative' || status === 'partial'
}

/** 排序：先按 order 升序，再按 id 字典序，保证渲染稳定（不影响 KV 缓存）。 */
function byOrderThenId(a, b) {
  const ao = typeof a.meta.order === 'number' ? a.meta.order : Number.MAX_SAFE_INTEGER
  const bo = typeof b.meta.order === 'number' ? b.meta.order : Number.MAX_SAFE_INTEGER
  if (ao !== bo) return ao - bo
  return String(a.meta.id ?? '').localeCompare(String(b.meta.id ?? ''))
}

/**
 * 把注册表的文档划分成三份清单。
 *
 * @param {Array<{meta: object|null, issues: Array<{rule: string, level: string, message: string}>,
 *                hasError: boolean, path: string}>} entries
 * @returns {{required: Array<object>, forbidden: Array<object>, anomalies: Array<object>,
 *            byId: Map<string, object>}}
 */
export function buildIndex(entries) {
  const list = Array.isArray(entries) ? entries : []
  const required = []
  const forbidden = []
  const anomalies = []
  const byId = new Map()

  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    const meta = entry.meta
    const id = meta?.id

    if (typeof id === 'string' && id !== '') byId.set(id, entry)

    // 完全没有 frontmatter 的文件（`unmanaged`）不进任何清单，也不报异常。
    // 理由：docs/ 下放一份纯 Markdown（比如设计草图）不该被判成"文档写坏了"；
    // 它只是"不受管"。门禁会在模型试图写它时按"没有 frontmatter"拒绝（gate.js）。
    if (entry.unmanaged === true) continue

    // 规则 1：有 error 就只进 anomalies。
    if (entry.hasError === true || meta === null || meta === undefined) {
      anomalies.push(entry)
      continue
    }

    // 规则 2：sealed 进禁止清单。
    if (meta.status === 'sealed') {
      forbidden.push(entry)
      continue
    }

    // 规则 3：只有可执行的 status 才进必读清单。
    if (isExecutable(meta.status)) {
      required.push(entry)
      continue
    }

    // superseded / void / draft：不可执行，只进 byId，不进任何清单。
  }

  required.sort(byOrderThenId)
  forbidden.sort(byOrderThenId)
  anomalies.sort((a, b) => String(a.meta?.id ?? a.path ?? '').localeCompare(String(b.meta?.id ?? b.path ?? '')))

  return { required, forbidden, anomalies, byId }
}

/**
 * 必读清单里还没读过的（门禁拒绝文案要用）。
 *
 * @param {Array<object>} required buildIndex 的 required
 * @param {Map<string, {fingerprint: string}>|object} readSet 本会话已读集合
 * @param {(id: string) => string} [currentFingerprint] 取磁盘当前指纹
 * @returns {Array<object>} 缺的条目（保持 required 的顺序）
 */
export function requiredNotRead(required, readSet, currentFingerprint) {
  const read = readSet !== null && typeof readSet === 'object' ? readSet : new Map()
  const lookup = (id) => (typeof read.get === 'function' ? read.get(id) : read[id])

  return (Array.isArray(required) ? required : []).filter((entry) => {
    const id = entry?.meta?.id
    if (typeof id !== 'string' || id === '') return false
    const record = lookup(id)
    if (record === undefined || record === null) return true
    // 指纹不同 = 读的是旧版，视为未读（SPEC §9.3）。
    if (typeof currentFingerprint === 'function') {
      return record.fingerprint !== currentFingerprint(id)
    }
    return false
  })
}

/**
 * 把异常折成一行渲染文本（SPEC §5.4 的 `【文档异常】decision-log: 缺少 role 字段`）。
 *
 * 只取**第一条** error 用于展示：一个坏文档可能有五条问题，
 * 全列出来会把 800 字符的预算吃光（见 render.js 的裁剪顺序）。
 *
 * ⚠️ **M1.5 / N4：兜底的路径必须是「相对项目根」的，不能是绝对路径。**
 *
 * 修之前 `name` 在拿不到 id 时直接用 `entry.path`（绝对路径），实测输出：
 * ```
 * 【文档异常】
 * - `bad-role-doc`：role 不在枚举内：bogus-role（...）
 * - `C:\Users\slimeball\...\_review\proj-a\docs\spec-anchored.md`：不支持块式嵌套...
 * ```
 * 两个问题：
 *   1. **吃预算**：一条绝对路径 ~90 字符，而 `fitBudget` 里 anomaly 是**最先被裁**的
 *      （`render.js` 裁剪顺序第 1 步）。路径越长，越可能把整段异常挤掉 ——
 *      恰好把"文档写坏了"这个最该看到的信号挤掉。
 *   2. **模型按 id 找文档**，绝对路径对它没用（它得自己拼相对路径）。
 *
 * 现在：能解析出 id 的一律用 id；没有 id 时用**相对项目根**的路径（`docs/xxx.md`）。
 * 只有连项目根都拿不到时才退回原样（**不猜、不做字符串截断** ——
 * `C:\...\docs\x.md` 截成 `x.md` 会与别的项目同名文件混淆）。
 *
 * @param {object} entry
 * @param {string} [projectRoot] 项目根（给了才能算相对路径）
 * @returns {string}
 */
export function anomalyLine(entry, projectRoot) {
  const id = entry?.meta?.id
  // 兜底顺序（**向后兼容**）：
  //   1. 有 id → 用 id（首选：模型按 id 找文档）；
  //   2. 没有 id、但给了 projectRoot 且能算出相对路径 → 用相对路径（N4 的修法）；
  //   3. 都没有 → 退回原来的 `entry.path`（**保持 M0 的行为**，不把"没给参数"当成"路径不该显示"）。
  const relative = relativeTo(entry?.path, projectRoot)
  const name = typeof id === 'string' && id !== ''
    ? id
    : (relative ?? (typeof entry?.path === 'string' && entry.path !== '' ? entry.path : '(未知文档)'))
  const issues = Array.isArray(entry?.issues) ? entry.issues : []
  const first = issues.find((item) => item?.level === 'error') ?? issues[0]
  const detail = typeof first?.message === 'string' && first.message !== ''
    ? first.message
    : '元数据不合法'
  return `${name}: ${detail}`
}

/**
 * 把绝对路径折成相对项目根的路径（`docs/xxx.md`）。
 *
 * **纯函数、不做 IO**：只用字符串运算处理分隔符。
 * 为什么不 import `path` 模块：`core/` 禁止内置模块（`test/decoupling.test.js`）。
 *
 * 处理 Windows 盘符与混合分隔符；路径不在项目根下时返回 `undefined`（**不猜**）。
 *
 * @param {string} absPath
 * @param {string} [projectRoot]
 * @returns {string | undefined}
 */
function relativeTo(absPath, projectRoot) {
  if (typeof absPath !== 'string' || absPath === '') return undefined
  if (typeof projectRoot !== 'string' || projectRoot === '') return undefined

  const normalize = (value) => value.replaceAll('\\', '/').replace(/\/+$/, '')
  const root = normalize(projectRoot)
  const path = normalize(absPath)

  // 大小写不敏感比较：Windows 上 `C:\Proj` 与 `c:\proj` 是同一处。
  if (path.toLowerCase() === root.toLowerCase()) return undefined
  if (!path.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return undefined
  return path.slice(root.length + 1)
}

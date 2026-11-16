/**
 * 主栏整页（M2-C 图谱 / M2-D 交付 / M2-E 归档，三块用 tab 切区）。
 *
 * ---- 为什么三块塞在主栏而不是右栏 ----
 *
 * SPEC §3.3：右栏**最多 2 个分栏**、窗口 < 768px 自动全屏、**面板没有标题行**。
 * 三块塞进右栏必然要滚动且每层节点宽度受限。所以按 §3.11 的建议：
 * **右栏只放施工看板，图谱/交付/归档放主栏，用 tab 切区。**
 */

import * as React from 'react'

import type { Snapshot, SnapshotDoc } from './api.ts'
import { DeliverableCell } from './dashboard.tsx'

const h = React.createElement

/** role 的分组顺序（与 `core/roles.js` 的枚举一致，与 host 侧 `snapshot.ts` 同序）。 */
const ROLE_ORDER = ['index', 'handover', 'spec', 'decision', 'evidence', 'instruction', 'log', 'fact'] as const

const ROLE_LABEL: Record<string, string> = {
  index: '入口索引',
  handover: '交接',
  spec: '施工图',
  decision: '决策',
  evidence: '证据',
  instruction: '指令',
  log: '日志',
  fact: '事实',
}

function statusMark(status: string): string {
  switch (status) {
    case 'authoritative': return '🟢'
    case 'partial': return '🟡'
    case 'draft': return '⚪'
    case 'superseded': return '🔵'
    case 'sealed': return '🔴'
    case 'void': return '🟠'
    default: return '❔'
  }
}

const styles = {
  root: {
    padding: '16px 20px',
    font: '13px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif',
    color: 'var(--dsw-alias-label-primary, #e6e6e6)',
    height: '100%',
    overflowY: 'auto' as const,
    boxSizing: 'border-box' as const,
  },
  tabs: { display: 'flex', gap: '4px', marginBottom: '14px', borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))' },
  tab: (active: boolean) => ({
    font: 'inherit',
    padding: '6px 12px',
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    opacity: active ? 1 : 0.55,
    borderBottom: `2px solid ${active ? 'var(--dsw-alias-brand-primary, #58a6ff)' : 'transparent'}`,
  }),
  sectionTitle: { fontSize: '12px', opacity: 0.55, marginBottom: '6px', letterSpacing: '0.04em' },
  anomaly: {
    border: '1px solid var(--dsw-alias-state-error-primary, #f85149)',
    borderRadius: '6px',
    padding: '10px 12px',
    marginBottom: '14px',
    background: 'var(--dsw-alias-bg-overlay, rgba(248,81,73,0.08))',
  },
  group: { marginBottom: '16px' },
  groupHead: { fontSize: '12px', fontWeight: 600 as const, opacity: 0.75, marginBottom: '6px' },
  node: (depth: number, sealed: boolean) => ({
    // **纵向缩进树**（SPEC §6.3 明确要纵向，不是横向）。
    marginLeft: `${depth * 16}px`,
    padding: '4px 8px',
    borderRadius: '5px',
    cursor: 'pointer',
    display: 'flex',
    gap: '8px',
    alignItems: 'baseline',
    opacity: sealed ? 0.5 : 1,
  }),
  /**
   * 不可点击的节点（预览在本面板里不可能时用）。
   *
   * 与 `node` 的唯一区别是 **`cursor: 'default'`** —— 没有可点击手势，
   * 用户就不会去点一个注定没反应的东西。
   */
  nodeStatic: (depth: number, sealed: boolean) => ({
    marginLeft: `${depth * 16}px`,
    padding: '4px 8px',
    borderRadius: '5px',
    cursor: 'default',
    display: 'flex',
    gap: '8px',
    alignItems: 'baseline',
    opacity: sealed ? 0.4 : 0.85,
  }),
  id: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' },
  fingerprint: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px', opacity: 0.5 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '10px' },
  button: {
    font: 'inherit',
    padding: '4px 10px',
    borderRadius: '6px',
    border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.4))',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
  note: { fontSize: '11px', opacity: 0.55, marginTop: '10px', lineHeight: 1.5 },
  empty: { opacity: 0.6, fontSize: '12px' },
}

/** 图谱（M2-C）：纵向缩进树，按 role 分组、组内按 order。 */
export function GraphTab({
  snapshot,
  onOpenDoc,
  /**
   * 预览是否**根本不可能**（M2.2 实测）。
   *
   * `true` 时不显示可点击手势 —— 否则就是"看起来能点、点了没反应"，
   * 那是本项目最忌讳的症状（右栏是 session 作用域的，root 面板里没有会话）。
   */
  previewDisabled = false,
}: {
  snapshot: Snapshot
  onOpenDoc?: (doc: SnapshotDoc) => void
  previewDisabled?: boolean
}): React.ReactElement {
  // 分组：未知 role 归到「其它」，不丢。
  const groups = new Map<string, SnapshotDoc[]>()
  for (const doc of snapshot.all) {
    const role = (ROLE_ORDER as readonly string[]).includes(doc.role) ? doc.role : 'other'
    if (!groups.has(role)) groups.set(role, [])
    groups.get(role)!.push(doc)
  }
  const orderedRoles = [
    ...ROLE_ORDER.filter((role) => groups.has(role)),
    ...(groups.has('other') ? ['other'] : []),
  ]

  return h('div', null,
    // anomalies 置顶（SPEC §6.3：它们是"现在就有问题"，不藏在组里）
    snapshot.anomalies.length > 0
      ? h('div', { style: styles.anomaly },
        h('div', { style: { fontWeight: 600, marginBottom: '4px' } },
          `⚠️ 文档异常（${snapshot.anomalies.length}）—— 这些文档现在就有问题`),
        snapshot.anomalies.map((item) => h('div', { key: item.id, style: { fontSize: '12px' } },
          `- ${item.id || '(无 id)'}：${item.message}`)))
      : null,

    orderedRoles.length === 0
      ? h('div', { style: styles.empty }, '这个项目还没有受管文档。')
      : orderedRoles.map((role) => h('div', { key: role, style: styles.group },
        h('div', { style: styles.groupHead },
          `${ROLE_LABEL[role] ?? '其它'}（${groups.get(role)!.length}）`),
        groups.get(role)!.map((doc) => {
          const sealed = doc.status === 'sealed'
          // ⚠️ 预览不可能时**不给 onClick、不给 pointer 手势** ——
          // 让"看起来能点"和"点了会怎样"一致（否则就是静默失败）。
          const clickable = !previewDisabled && onOpenDoc !== undefined
          return h('div', {
            key: doc.id,
            style: clickable ? styles.node(1, sealed) : styles.nodeStatic(1, sealed),
            ...(clickable ? { onClick: () => onOpenDoc(doc) } : {}),
            title: clickable ? doc.summary : `${doc.summary}（预览需在会话页打开）`,
          },
            h('span', null, statusMark(doc.status)),
            h('span', { style: styles.id }, doc.id),
            sealed ? h('span', { style: { fontSize: '11px' }, title: '内容有诱惑力但已被推翻' }, '🔴 禁止执行') : null,
            h('span', { style: { flex: 1, fontSize: '12px', opacity: 0.7 } }, doc.summary),
            doc.fingerprint !== ''
              ? h('span', { style: styles.fingerprint }, doc.fingerprint.slice(0, 6))
              : null,
          )
        }))),
  )
}

/** 交付网格（M2-D）。 */
export function DeliverablesTab({
  snapshot,
  onOpenFile,
  previewDisabled = false,
}: {
  snapshot: Snapshot
  onOpenFile?: (path: string) => void
  previewDisabled?: boolean
}): React.ReactElement {
  const items = snapshot.deliverables
  const undeclared = items.filter((item) => item.presented !== true).length

  if (items.length === 0) {
    return h('div', { style: styles.empty },
      'deliverables/ 里还没有文件。（这个目录是「交付成品」，不是工作区根）')
  }

  return h('div', null,
    h('div', { style: styles.sectionTitle },
      `共 ${items.length} 个文件`
      + `${undeclared > 0 ? ` · ${undeclared} 个未声明` : ''}`),
    h('div', { style: styles.grid },
      items.map((item) => h(DeliverableCell, {
        key: item.path,
        item,
        onOpen: onOpenFile,
        previewDisabled,
      }))),
    // 预览不可能时**明说**，而不是让用户去点一个没反应的卡片。
    //
    // ---- 2026-11-14 M2.6：用户实测"鼠标放上去连手势都没有，点了没反应" ----
    //
    // 第一版这里只写「本面板没有会话上下文（右栏是会话作用域的）」——
    // 那是**给开发者看的**，用户读完仍然不知道该怎么办。
    //
    // 而且这句话还有个更实际的问题：用户真正想知道的是"**文件到底在哪、我怎么看**"。
    // 所以现在写清三件事：为什么点不开、文件在哪个目录、去哪儿点能打开。
    //
    // ⚠️ 根因是硬边界，不是可以修的 bug（已核实 `_ref/asar` 里 sidebar-right 的源码）：
    //    `openResource(address)` 第一行就是 `this.require()`，而 `require()` 里
    //    `this.mounted.getSnapshot()` 取的是**屏幕上挂载的会话**；root 面板没有会话
    //    → 必然抛 `sidebarRight: no session surface is mounted`。
    //    这与用 session scope 还是 absolute scope 拼地址**无关**。
    previewDisabled
      ? h('div', { style: styles.note },
        '这些文件在项目的 `deliverables/` 目录下。'
        + '本面板（主栏）没有会话上下文，点不开预览 —— '
        + '要打开它们，请到**会话页右侧栏**的 DDD 页签里点同一份文件。')
      : null,
    undeclared > 0
      ? h('div', { style: styles.note },
        '「未声明」= 文件存在，但 AI 从没调用 `present` 声明它是交付物。'
        + '你可能不知道有它，它也可能只是中间产物。')
      : null,
  )
}

/** 归档（M2-E）：待归档清单 + 勾选 + 归档；坟场里的可还原。 */
export function GraveyardTab({
  snapshot,
  onArchive,
  onRestore,
  pending,
}: {
  snapshot: Snapshot
  onArchive?: (ids: string[]) => void
  /**
   * 还原（M2.5 · W7 补）。
   *
   * ⚠️ 2026-11-14 之前**没有这个 prop**：界面上只能归档、不能还原。
   * 于是「已在坟场」那一区只显示路径，用户想把文件拿回来只能手改磁盘 ——
   * 而 host 侧的 `restoreDocuments` 一直是好的（七条判据都验过）。
   * 这是"host 有能力、UI 没入口"的典型缺口。
   *
   * 参数是**坟场里的相对路径**，不是 id：坟场里的文件已经不在注册表里了。
   */
  onRestore?: (paths: string[]) => void
  pending?: boolean
}): React.ReactElement {
  const [picked, setPicked] = React.useState<string[]>([])
  const toggle = (id: string) => {
    setPicked((current) => (current.includes(id) ? current.filter((each) => each !== id) : [...current, id]))
  }

  const candidates = snapshot.graveyardCandidates

  return h('div', null,
    h('div', { style: styles.sectionTitle }, `待归档（${candidates.length}）`),
    candidates.length === 0
      ? h('div', { style: styles.empty },
        '没有待归档的文档。（AI 会标 `status: void` 表示"这份别再用了"，然后出现在这里）')
      : h('div', null,
        candidates.map((item) => h('label', {
          key: item.id,
          style: {
            display: 'flex',
            gap: '8px',
            alignItems: 'baseline',
            padding: '4px 0',
            cursor: 'pointer',
            // ---- 2026-11-16 M2.9：**让说明文字拿到宽度**（用户报的 UI 问题）----
            //
            // 现场（用户在归档页看到的）：文件名右边的说明被挤成一窄条。
            //
            // 根因：这一行是三段文字抢一条横向空间，而只有中间的 `summary`
            // 写了 `flex: 1`。另外两段**没有上限**，于是：
            //   · `id` 长一点（`instruction-2`）就多占一截；
            //   · `reason` 是模型写的整句话（实测能到 40+ 字），它**越长，
            //     summary 被挤得越扁** —— 而 summary 恰恰是最需要读的那段。
            //
            // ⇒ 给两侧都设上限，把剩余宽度**确定地**留给 summary：
            //   · `id`   最多 22ch（够放 `handover-1` / `instruction-2`）；
            //   · `reason` 最多 34ch，超出省略号，完整内容放 `title` 悬停看；
            // ---- 2026-11-16 M2.9（第二轮）：**根因是 flex-basis，不是 maxWidth** ----
            //
            // 用户第一次反馈「UI 没修成功」，并给了**决定性的观察**：
            // > 只有当第三列的更详细的说明只占用一行时，第二列才能变宽。
            //
            // 这句话直接指向 flex 的 basis：
            //   · `flex: 1`        = `1 1 0%`   → basis **0**，只分剩余空间
            //   · `flex: 1 1 auto` = basis **内容宽度** → 内容长就先占一大块，
            //     再把空间从别人那儿抢过来
            //
            // 我第一版给 summary 写的是 `1 1 auto`（basis = 内容宽度），
            // 而 reason 是 `0 0 auto`（**不收缩**）。于是 reason 有多长就占多长，
            // summary 只能捡剩下的 —— 这正是用户看到的现象。
            //
            // ⇒ 修法必须是两条一起：
            //   ① summary 用 `flex: '1 1 0%'` —— **basis 归零**，它拿的是"剩余空间"，
            //      而不是"我的内容宽度"；
            //   ② reason 用 `flex: '0 1 34ch'` —— **basis 封顶 34ch 且允许收缩**
            //      （原来 `0 0 auto` 是"不收缩"，那才是真正的病根）。
            //
            // ⚠️ 只加 `maxWidth` 不够：`maxWidth` 只是上限，
            //    在 basis=auto 且 shrink=0 时它照样把行占满。
          },
        },
          h('input', {
            type: 'checkbox',
            checked: picked.includes(item.id),
            onChange: () => toggle(item.id),
            style: { flex: '0 0 auto' },
          }),
          h('span', {
            style: {
              ...styles.id,
              // id 长度可控（kebab-case），给个上限就够；不收缩，避免被截成半个词。
              flex: '0 0 auto',
              maxWidth: '22ch',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
            title: item.id,
          }, item.id),
          h('span', {
            style: {
              fontSize: '12px',
              opacity: 0.75,
              // **basis 0** + 可增长 → 拿"剩余空间"，而不是"我的内容宽度"。
              flex: '1 1 0%',
              minWidth: '0',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
            title: item.summary,
          }, item.summary),
          // **每一条必须带 reason**（SPEC §8.4 M2-5c：没有理由的提议等于没提议）
          item.reason === undefined || item.reason === ''
            ? h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-state-warn-primary, #d29922)', flex: '0 0 auto' } }, '⚠️ 没有理由')
            : h('span', {
              style: {
                fontSize: '11px',
                opacity: 0.6,
                // **basis 封顶 + 允许收缩**：原来 `0 0 auto`（不收缩）是真正的病根。
                flex: '0 1 34ch',
                maxWidth: '34ch',
                minWidth: '0',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
              title: item.reason,
            }, item.reason),
        )),
        h('div', { style: { marginTop: '10px', display: 'flex', gap: '8px' } },
          h('button', {
            style: styles.button,
            type: 'button',
            disabled: picked.length === 0 || pending === true,
            onClick: () => onArchive?.(picked),
          }, pending === true ? '归档中…' : `归档选中的 ${picked.length} 份`)),
        h('div', { style: styles.note },
          '归档 = 物理移动到 docs/_graveyard/，**不是删除**（文件仍占磁盘、仍进 git）。'
          + 'AI 只能标 `void`，移动由插件做 —— 这是 M2-Q6 的权限分工。'),
      ),

    snapshot.graveyard.length > 0
      ? h('div', { style: { marginTop: '20px' } },
        h('div', { style: styles.sectionTitle }, `已在坟场（${snapshot.graveyard.length}）`),
        snapshot.graveyard.map((item) => h('div', {
          key: item.path,
          style: {
            display: 'flex',
            gap: '8px',
            alignItems: 'baseline',
            fontSize: '12px',
            opacity: 0.7,
            padding: '2px 0',
          },
        },
          h('span', { style: { flex: 1, wordBreak: 'break-all' } }, item.path),
          // ---- 还原入口（M2.5 · W7 补）----
          //
          // 之前这里**只有路径**，没有任何操作。host 侧 `restoreDocuments` 一直是好的，
          // 缺的只是这个按钮 —— 用户想把文件拿回来只能手改磁盘。
          h('button', {
            type: 'button',
            style: styles.button,
            disabled: pending === true,
            title: '放回归档前的原路径（原位已有文件会被拒绝，绝不覆盖）',
            onClick: () => onRestore?.([item.path]),
          }, '还原'),
        )))
      : null,
  )
}

/** 主栏整页：三个 tab 切区。 */
export function MainPage({
  snapshot,
  onOpenDoc,
  onOpenFile,
  onArchive,
  onRestore,
  archiving,
  previewDisabled = false,
}: {
  snapshot: Snapshot
  onOpenDoc?: (doc: SnapshotDoc) => void
  onOpenFile?: (path: string) => void
  onArchive?: (ids: string[]) => void
  /** 还原（M2.5 · W7 补）：参数是坟场里的相对路径。 */
  onRestore?: (paths: string[]) => void
  archiving?: boolean
  /** 预览在本面板里是否**根本不可能**（见 `GraphTab` 的说明）。 */
  previewDisabled?: boolean
}): React.ReactElement {
  const [tab, setTab] = React.useState<'graph' | 'deliverables' | 'graveyard'>('graph')

  return h('div', { style: styles.root },
    h('div', { style: styles.tabs },
      h('button', { style: styles.tab(tab === 'graph'), onClick: () => setTab('graph'), type: 'button' },
        `图谱（${snapshot.all.length}）`),
      h('button', { style: styles.tab(tab === 'deliverables'), onClick: () => setTab('deliverables'), type: 'button' },
        `交付（${snapshot.deliverables.length}）`),
      h('button', { style: styles.tab(tab === 'graveyard'), onClick: () => setTab('graveyard'), type: 'button' },
        `归档（${snapshot.graveyardCandidates.length}）`),
    ),
    tab === 'graph' ? h(GraphTab, { snapshot, onOpenDoc, previewDisabled }) : null,
    tab === 'deliverables' ? h(DeliverablesTab, { snapshot, onOpenFile, previewDisabled }) : null,
    tab === 'graveyard' ? h(GraveyardTab, { snapshot, onArchive, onRestore, pending: archiving }) : null,
  )
}

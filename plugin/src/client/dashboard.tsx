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

import * as React from 'react'

import type { Snapshot, SnapshotDoc } from './api.ts'

const h = React.createElement

/** 状态徽标（与索引块的 `statusMark` 同一个语义，但**不共享代码**：core 是 host 侧）。 */
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

/** 精简路径：只留 `docs/` 之后的部分（看板宽度有限）。 */
function shortPath(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? path : path.slice(slash + 1)
}

const styles = {
  root: {
    padding: '12px 14px',
    font: '13px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif',
    color: 'var(--dsw-alias-label-primary, #e6e6e6)',
    overflowY: 'auto' as const,
    height: '100%',
  },
  section: { marginBottom: '14px' },
  label: {
    fontSize: '11px',
    letterSpacing: '0.04em',
    textTransform: 'uppercase' as const,
    opacity: 0.55,
    marginBottom: '4px',
  },
  big: { fontSize: '15px', fontWeight: 600 as const },
  bar: {
    height: '6px',
    borderRadius: '3px',
    background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.22))',
    overflow: 'hidden',
    margin: '6px 0',
  },
  barFill: (ratio: number, ready: boolean) => ({
    width: `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`,
    height: '100%',
    background: ready
      ? 'var(--dsw-alias-state-success-primary, #3fb950)'
      : 'var(--dsw-alias-state-warn-primary, #d29922)',
    transition: 'width 160ms ease',
  }),
  docRow: {
    display: 'flex',
    gap: '6px',
    alignItems: 'baseline',
    padding: '3px 0',
    cursor: 'pointer',
    borderBottom: '1px solid transparent',
  },
  docId: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '12px',
  },
  dim: { opacity: 0.66 },
  anomaly: {
    border: '1px solid var(--dsw-alias-state-error-primary, #f85149)',
    borderRadius: '6px',
    padding: '8px 10px',
    marginBottom: '12px',
    background: 'var(--dsw-alias-bg-overlay, rgba(248,81,73,0.08))',
  },
  budgetOver: { color: 'var(--dsw-alias-state-warn-primary, #d29922)' },
  hint: { fontSize: '12px', opacity: 0.8, marginTop: '4px' },
  button: {
    font: 'inherit',
    padding: '4px 10px',
    borderRadius: '6px',
    border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.4))',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
  note: { fontSize: '11px', opacity: 0.5, marginTop: '10px', lineHeight: 1.5 },
}

/** loading 态：**必须有**，否则首屏是一片空白（看起来像插件坏了）。 */
export function LoadingView(): React.ReactElement {
  return h('div', { style: { ...styles.root, ...styles.dim } }, '正在读取文档状态…')
}

/** 错误态：**必须带重试**，而且要说清是哪一类错（401 与 500 的处置完全不同）。 */
export function ErrorView({ message, onRetry }: { message: string; onRetry: () => void }): React.ReactElement {
  return h('div', { style: styles.root },
    h('div', { style: styles.anomaly },
      h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '读不到文档状态'),
      h('div', { style: { fontSize: '12px' } }, message),
    ),
    h('button', { style: styles.button, onClick: onRetry, type: 'button' }, '重试'),
    h('div', { style: styles.note },
      '如果反复失败：这个面板只在 DDD 项目里显示；普通仓库里没有数据是正常的。'),
  )
}

/** 空态：不是 DDD 项目，或者项目里还没有受管文档。 */
export function EmptyView({ projectRoot }: { projectRoot: string }): React.ReactElement {
  return h('div', { style: styles.root },
    h('div', { style: styles.label }, '文档驱动开发'),
    h('div', { style: styles.big }, '当前项目没有启用 DDD'),
    h('div', { style: { ...styles.dim, fontSize: '12px', marginTop: '6px' } },
      projectRoot === '' ? '没有探测到项目根。' : `项目根：${projectRoot}`),
    h('div', { style: styles.note },
      '启用方式：在项目里建 docs/ 并放一份带合法 frontmatter 的 .md，'
      + '或在 AGENTS.md 里加 `<!-- ddd:index -->` 标记。'),
  )
}

/** 一行文档。点击 → 开预览（M2-B）；**但这不会让 AI 的 readSet 记上**。 */
function DocRow({ doc, onOpen }: { doc: SnapshotDoc; onOpen?: (doc: SnapshotDoc) => void }): React.ReactElement {
  return h('div', {
    style: styles.docRow,
    onClick: () => onOpen?.(doc),
    title: doc.summary === '' ? doc.id : doc.summary,
  },
    h('span', null, statusMark(doc.status)),
    h('span', { style: styles.docId }, doc.id),
    h('span', { style: { ...styles.dim, fontSize: '12px', flex: 1 } }, doc.summary),
    doc.read ? h('span', { title: 'AI 已读过（指纹一致）' }, '✅') : null,
  )
}

/**
 * 看板主体。
 *
 * @param props.snapshot 已取到的快照
 * @param props.onOpenDoc 点文档时开预览
 */
export function Dashboard({
  snapshot,
  onOpenDoc,
}: {
  snapshot: Snapshot
  onOpenDoc?: (doc: SnapshotDoc) => void
}): React.ReactElement {
  const { gate, budget, required, anomalies, forbidden, project, slice, nextStep, basisDoc } = snapshot
  const ratio = gate.required === 0 ? 0 : gate.read / gate.required
  const unread = required.filter((doc) => doc.read !== true)

  return h('div', { style: styles.root },
    // ① 文档异常置顶：这是唯一"必须马上处理"的状态。
    anomalies.length > 0
      ? h('div', { style: styles.anomaly },
        h('div', { style: { fontWeight: 600, marginBottom: '4px' } },
          `⚠️ 有 ${anomalies.length} 份文档坏了`),
        anomalies.slice(0, 5).map((item) => h('div', {
          key: item.id,
          style: { fontSize: '12px', marginTop: '2px' },
        }, `- ${item.id || '(无 id)'}：${item.message}`)),
        h('div', { style: { ...styles.dim, fontSize: '11px', marginTop: '6px' } },
          '坏文档不参与必读判定，也不能当依据用。修法：用 edit 只改 frontmatter。'),
      )
      : null,

    // ② 当前切片（拿不到就整行不显示，不写占位）
    slice !== ''
      ? h('div', { style: styles.section },
        h('div', { style: styles.label }, '当前切片'),
        h('div', { style: styles.big }, slice))
      : null,

    // ③ 项目一句话
    project !== ''
      ? h('div', { style: styles.section },
        h('div', { style: styles.label }, '项目'),
        h('div', null, project))
      : null,

    // ④ 必读进度
    h('div', { style: styles.section },
      h('div', { style: styles.label }, '必读进度'),
      h('div', { style: styles.big },
        `${gate.read}/${gate.required}`,
        gate.required > 0 && gate.read >= gate.required ? ' ✅ 可以动 docs/' : ' ⏳ 还没读完'),
      gate.required > 0 ? h('div', { style: styles.bar }, h('div', { style: styles.barFill(ratio, gate.ready) })) : null,
      unread.length > 0
        ? h('div', { style: { marginTop: '6px' } },
          unread.map((doc) => h(DocRow, { key: doc.id, doc, onOpen: onOpenDoc })))
        : null,
      // R-5 的显式说明：不写这句，它会被反复当成 bug 报。
      h('div', { style: styles.note },
        '在这里点开文档，**不会**让 AI 变成"已读"——门禁记的是 AI 自己的读取。'),
    ),

    // ⑤ 下一步（拿不到就不显示）
    nextStep !== ''
      ? h('div', { style: styles.section },
        h('div', { style: styles.label }, '下一步'),
        h('div', null, nextStep))
      : null,

    // ⑥ 依据文档（拿不到就不显示）
    basisDoc !== null && basisDoc.id !== ''
      ? h('div', { style: styles.section },
        h('div', { style: styles.label }, '依据文档'),
        h('div', { style: { fontSize: '12px' } },
          `${basisDoc.id}${basisDoc.section === '' ? '' : ` ${basisDoc.section}`}`
          + `${basisDoc.fingerprint === '' ? '' : `（v${basisDoc.fingerprint.slice(0, 6)}）`}`))
      : null,

    // ⑦ 预算
    budget !== null && budget.required > 0
      ? h('div', { style: styles.section },
        h('div', { style: styles.label }, '预算'),
        h('div', { style: budget.over ? styles.budgetOver : undefined },
          `必读 ${budget.required} 份 ≈ ${Math.round(budget.tokens / 100) / 10}k tokens（上限 ${Math.round(budget.limit / 1000)}k）`,
          budget.over ? ` ⚠️ 超出 ${Math.round(budget.overBy / 100) / 10}k` : ''),
        budget.over
          ? h('div', { style: styles.hint },
            '超限时索引块的【预算】行会列出「先读哪几份」。这里只报数字，优先级以索引块为准。')
          : null)
      : null,

    // ⑧ 禁止执行
    forbidden.length > 0
      ? h('div', { style: styles.section },
        h('div', { style: styles.label }, `禁止执行（${forbidden.length}）`),
        forbidden.slice(0, 5).map((item) => h('div', {
          key: item.id,
          style: { fontSize: '12px' },
        }, `🔴 ${item.id}`)))
      : null,

    // ⑨ 待归档（M2-E 的入口，数量在此，操作在主栏）
    snapshot.graveyardCandidates.length > 0
      ? h('div', { style: styles.section },
        h('div', { style: styles.label }, '待归档'),
        h('div', null, `${snapshot.graveyardCandidates.length} 份（在主栏「归档」里处理）`))
      : null,

    h('div', { style: styles.note },
      `快照时间 ${new Date(snapshot.generatedAt).toLocaleTimeString('zh-CN')}`
      + `${snapshot.sessionId === '' ? ' · ⚠️ 没有会话 id（进度可能不准）' : ''}`),
  )
}

/** 交付网格里的一格（M2-D）。 */
export function DeliverableCell({
  item,
  onOpen,
  /**
   * 预览是否**根本不可能**（与 `GraphTab` 的 `previewDisabled` 同一条纪律）。
   *
   * ---- 2026-11-14 M2.6：用户实测「交付页点文件点不开」----
   *
   * 真因不是预览坏了，是**这里从来没拿到过 `onOpen`**：
   * `BoardPage` 挂 `MainPage` 时只传了 `onOpenDoc` / `onArchive` / `onRestore`，
   * **漏了 `onOpenFile`** —— 于是 `onOpen?.(item.path)` 的可选链把点击吞掉，
   * 既不预览也不报错。与 M2.5 的 W7（归档按钮没接线）是**同一个病**：
   * 「可选链 + 没传 prop」= 静默失败。
   *
   * 修法照 `GraphTab`：**不可能预览时不给 onClick、不给 pointer 手势**。
   * 让"看起来能点"和"点了会怎样"一致 —— 静默失败是本项目最忌讳的症状。
   */
  previewDisabled = false,
}: {
  item: { path: string; presented: boolean; size: number }
  onOpen?: (path: string) => void
  previewDisabled?: boolean
}): React.ReactElement {
  const clickable = !previewDisabled && onOpen !== undefined
  return h('div', {
    style: {
      border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35))',
      borderRadius: '8px',
      padding: '10px 12px',
      // 只有真能打开时才显示手势（否则就是"看起来能点、点了没反应"）。
      cursor: clickable ? 'pointer' : 'default',
      minWidth: 0,
    },
    ...(clickable ? { onClick: () => onOpen(item.path) } : {}),
    title: clickable ? item.path : `${item.path}（预览需在会话页打开）`,
  },
    h('div', { style: { fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
      shortPath(item.path)),
    // ⚠️ 「未声明」是 SPEC §2.6 的明确要求，**不是可选项**。
    // 它的意思是"这个文件存在，但 AI 从没 `present` 过它" —— 用户可能不知道有它。
    h('div', { style: { fontSize: '11px', opacity: 0.7, marginTop: '4px' } },
      item.presented ? '已声明交付' : '未声明',
      item.size > 0 ? ` · ${Math.max(1, Math.round(item.size / 1024))} KB` : ''),
  )
}

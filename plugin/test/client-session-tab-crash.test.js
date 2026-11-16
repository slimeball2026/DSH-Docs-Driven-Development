/**
 * 回归测试：**会话右栏被整个炸空**那类错误（2026-11-14 实机事故）。
 *
 * ---- 事故现象（用户实测）----
 *
 *   1. 在**已经开始工作**的会话里点开页签 → 正常；
 *   2. 切到一个**还没发过任何话**的新会话 → 右栏**纯空页**；
 *   3. 再切回原来那个正常的会话 → **它也变空了**。
 *
 * 第 3 句是决定性的：取数失败只会让**这一格**显示"没数据"，
 * 不可能让**已经渲染好的另一格**变空。能让整棵子树消失的只有：
 * **React 渲染期抛错 → 错误边界卸载整棵树**。
 *
 * ---- 这个文件钉住的三条 ----
 *
 * 1. **组件里不许调框架 hook**（`useSessions` 等）。那是这次的根因：
 *    把 hook 放进 `useMemo` 回调 → 有条件调用 → hook 顺序变化 → React 抛错。
 * 2. **必须有错误边界**：即使将来又写错，也只能坏**这一格**，不许连累整个右栏。
 * 3. **不许循环依赖**：`session-tab.tsx` 不能 import `index.tsx`。
 *
 * 这三条都是**静态可查**的，所以用源码断言钉住 —— 不需要真浏览器。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_SRC = join(HERE, '..', 'src', 'client')

/** 读一个 client 源文件，并**剥掉注释**（注释里解释"为什么不这样做"不该让断言红）。 */
function codeOf(name) {
  const raw = readFileSync(join(CLIENT_SRC, name), 'utf8')
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

test('回归：**session-tab.tsx 里不许出现任何框架 hook 调用**（2026-11-14 事故根因）', () => {
  const code = codeOf('session-tab.tsx')
  // 框架注入的 standard props 里的 hook 一律不许出现。
  // `useSessions` 是那次事故的直接肇事者；其余几个同理（它们全是 hook）。
  const frameworkHooks = [
    'useSessions',
    'useResource',
    'useContextMenu',
    'useWorkspaces',
    'usePanelInfo',
    'useSessionStatus',
    'useSessionRetainInfo',
    'useChat',
    'useConversation',
    'useInput',
    'useSession(',
    'useProjection',
    'useTrajectory',
  ]
  for (const hook of frameworkHooks) {
    assert.ok(
      !code.includes(hook),
      `session-tab.tsx 里出现了框架 hook \`${hook}\` —— 这正是把右栏炸空的那类写法。\n`
      + '框架 hook 只能在组件顶层无条件调用；本页签改用纯快照读（cwdOfSession）。',
    )
  }
})

test('回归：**hook 只在顶层无条件调用**（不许出现在 if / 短路 / 回调里）', () => {
  const code = codeOf('session-tab.tsx')
  // 判据：hook 调用必须**整行以 `React.use` 开头**（可以带 `const x = ` / 解构）。
  // 这样 `if (x) React.useMemo(...)`、`cond && React.useMemo(...)`、
  // `foo(() => React.useMemo(...))` 一律会被抓出来。
  const lines = code.split('\n')
  const offenders = []
  lines.forEach((line, index) => {
    if (!/React\.use(State|Effect|Memo|Ref|Callback)\s*\(/.test(line)) return
    const trimmed = line.trim()
    // 允许：`React.useX(` 或 `const ... = React.useX(` 或 `const [, x] = React.useX(`。
    const okStart = /^(const|let|var)\s+[^=]*=\s*React\.use/.test(trimmed) || /^React\.use/.test(trimmed)
    if (!okStart) offenders.push(`${index + 1}: ${trimmed}`)
  })
  assert.deepEqual(offenders, [], `这些 hook 调用看起来嵌在表达式里（可能被有条件调用）：\n${offenders.join('\n')}`)
})

test('回归：**必须有错误边界**（否则我抛错会连累整个右栏）', () => {
  const code = codeOf('session-tab.tsx')
  // 必须是 class 组件 + getDerivedStateFromError（函数组件做不了错误边界）。
  assert.match(code, /class\s+TabErrorBoundary\s+extends\s+React\.Component/, '必须有 class 形式的错误边界')
  assert.match(code, /getDerivedStateFromError/, '必须实现 getDerivedStateFromError')
  assert.match(code, /componentDidCatch/, '必须实现 componentDidCatch（留痕）')
  // 导出给宿主的是**包了边界的**版本。
  assert.match(
    code,
    /export function SessionTab\([\s\S]*?h\(TabErrorBoundary[\s\S]*?\)/,
    'SessionTab 必须把正文包进错误边界',
  )
})

test('回归：错误边界对 `React.Component` 是**硬依赖**（产物级验证踩过）', () => {
  // 2026-11-14：产物级验证的 react 桩漏了 `Component`，一加载就
  // `Class extends value undefined is not a constructor or null`。
  // 这条钉住"我们确实用了 class 组件"，提醒任何改桩/改渲染方式的人：
  // 必须确认宿主注入的 react 里有 `Component`（官方 React 当然有，但别假设）。
  const code = codeOf('session-tab.tsx')
  assert.match(code, /extends\s+React\.Component/, '错误边界依赖 React.Component')
  // 不许改用 `react-dom` 的错误边界（我们只被允许 require 白名单里的 react）。
  assert.ok(!/react-dom/.test(code), '不许依赖 react-dom（白名单里没有）')
})

test('回归：**session-tab.tsx 不许 import index.tsx**（循环依赖）', () => {
  const raw = readFileSync(join(CLIENT_SRC, 'session-tab.tsx'), 'utf8')
  assert.ok(
    !/from\s+['"]\.\/index\.tsx['"]/.test(raw),
    'session-tab.tsx 不能 import index.tsx —— index.tsx 要 import SessionTab，两边互引就是循环依赖',
  )
  // controller 的造法必须通过 wiring 传进来。
  assert.match(raw, /makeController/, 'controller 必须通过 wiring.makeController 注入')
})

test('回归：**页签只渲染一个主内容区**（MainPage 与 Dashboard 不许并列）', () => {
  const code = codeOf('session-tab.tsx')
  // 两者都带 height:100%，并列渲染会在窄栏里互相挤压。
  const hasMain = /h\(MainPage,/.test(code)
  const hasDashboard = /h\(Dashboard,/.test(code)
  assert.ok(hasMain, '页签应当渲染 MainPage（图谱/交付/归档）')
  assert.ok(!hasDashboard, '页签里不许再并列渲染 Dashboard（与 MainPage 重复，且都 height:100%）')
})

test('回归：**cwdOf 是纯函数**（签名只收 sessionId，不收 hook）', () => {
  const src = readFileSync(join(CLIENT_SRC, 'session-tab.ts'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  // `resolveCwd` 的签名不许出现 useSessions 之类。
  const resolve = /export function resolveCwd\(([^)]*)\)/.exec(code)
  assert.ok(resolve !== null, '找不到 resolveCwd')
  assert.ok(!/useSessions/.test(resolve[1]), 'resolveCwd 的入参里不许有 useSessions（那会诱使人在渲染期调 hook）')
  // 生产入口只走纯快照读。
  assert.match(code, /return cwdOfSession\(ctx, sessionId\)/, 'resolveCwd 必须只走纯快照读')
})

test('回归：**inject 不回传 sessionId**（避免覆盖框架注入的同名 standard prop）', () => {
  const code = codeOf('index.tsx')
  const block = /name: 'sidebar\.right\.pane\.tab',[\s\S]*?\}, SessionTab\)\)\)/.exec(code)
  assert.ok(block !== null, '找不到 sidebar.right.pane.tab 的注册块')
  assert.ok(
    !/sessionId\s*:/.test(block[0]),
    'inject 里回传了 sessionId —— 它会覆盖框架注入的 standard prop，是 active:false 的嫌疑之一',
  )
})

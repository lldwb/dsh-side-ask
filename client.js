/**
 * `dsh-side-ask` —— 浏览器半：原生右侧栏里的「侧边提问」。
 *
 * ## 这个插件做什么
 *
 * 1. **右侧栏入口**：在右侧栏「新建标签页」的引导页（guide）里贡献一张「侧边提问」卡片，
 *    点它就在右侧栏打开本插件的**页面型标签**（`sidebar://sideask`）。
 * 2. **标题栏入口**：会话标题栏右侧也有一个「侧边提问」按钮，效果相同（标签已存在时
 *    直接聚焦，不重复开）。
 * 3. **继承当前会话记录**：标签页里的会话不是新会话，而是 `ctx.sessions.fork` 出来的
 *    **分支**（默认截在最近一个已完成回合），因此它带着当前会话已完成的上下文继续问。
 * 4. **合并的选中弹层**：在会话里选中文字后，弹出的操作条里**并排两个按钮**——
 *    「引用文本」（等同官方 `message-quotes` 的引用，插入主会话输入框）和「侧边提问」
 *    （把选中文字组成 Markdown 引用块，预填进侧边会话输入框，不自动发送）。
 * 5. **默认归档，用户可保留**：侧边会话关闭标签后默认归档（不出现在会话列表）；
 *    标签页顶部有「保留」开关，打开后关闭标签也不再归档，它就是一个普通会话。
 *
 * ## 为什么是「页面型标签」而不是资源型标签
 *
 * 资源型标签（`dsh-resource://…`）要自己注册协议、解析地址、维护 SessionReference，
 * 而且无法直接出现在右侧栏的引导页里（引导页只打开「页面型」类型）。改成页面型后：
 * 标签记录的是 `sidebar://sideask`，子会话 id 由本插件自己的存储按「宿主会话」绑定
 * （`localStorage`），打开标签时取出来渲染；重载后标签与绑定都还在。
 *
 * ## 为什么选中弹层是「接管官方 quote 表面」
 *
 * 官方 `ctx.uiConversation.interactions` 是**独占式**的：`dispatch` 按注册顺序询问，
 * 第一个 `open()` 的插件独占当前手势的渲染表面（`message-quotes` 在 selection 手势上
 * 永远 `open()`）。要让「引用文本」和「侧边提问」并排出现在**同一个**弹层里，只能接管
 * 它渲染的那个表面：`conversation.chat.text-interaction` 的 keyed 槽位按 id `quote`
 * 分发，**同 key 用更低 priority 注册即可 shadow 官方实现**（最低 priority 渲染）。
 * 我们的组件用公开的 `inputActions.insertQuote()` 完整复刻官方「引用」行为，再并排
 * 加一个自己的「侧边提问」按钮；插件卸载后官方表面自动恢复。
 * 另外用本插件自己的 key 注册同一组件作为兜底：`message-quotes` 不在时（或右键手势，
 * 官方不处理右键）也能弹出这两项。
 *
 * ## 为什么归档要「打开时恢复、关闭时归档」
 *
 * 宿主的 `ArchivedSessionGate` 会拒绝给**已归档**会话跑模型步（`agent/pre-step` 直接
 * reject）。所以「默认归档」不能是「创建即归档」，否则标签页里根本问不了。本插件的
 * 语义是：标签页打开期间会话处于未归档（可对话），关闭标签后归档；用户把「保留」
 * 打开则关闭后仍留在会话列表。浏览器重启后，未被保留且没有标签页的遗留侧边会话会在
 * 启动清扫里归档。
 *
 * ## 手写 bundle 的约束
 *
 * `dsh.client` 只要求 `exports["./client"]` 是一个 JS 文件；shell 的冻结模块表提供
 * `react` / `react/jsx-runtime` / `react-dom` / `@deepseek-ai/dsh-client-ui-primitives`
 * 等固定说明符。这里没有 `import`、没有 JSX、没有 npm 依赖：元素用 `jsx/jsxs` 构造，
 * 样式全部内联（主题 CSS 变量 + fallback），不引用任何私有 CSS class。
 */

window.__ModuleLoader__.load({
  id: 'dsh-side-ask',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { jsx, jsxs } = require('react/jsx-runtime')
    const P = require('@deepseek-ai/dsh-client-ui-primitives')

    // #region 常量

    /** 文案命名空间。 */
    const NS = 'sideAsk'
    /** 右侧栏标签类型（页面型；也是选中交互的 id）。 */
    const KIND = 'sideask'
    /** 本实现的标签类型 id：内容注册在这个 key 下，也作 guide 卡片的 provider id。 */
    const TAB_ID = 'dsh-side-ask/tab'
    /** guide 卡片 id（同一个类型内唯一）。 */
    const GUIDE_ID = 'side-ask'
    /**
     * 私有占位子槽：只声明、不渲染。
     *
     * 框架只在「注册声明了非 root 作用域子槽」时给组件注入 `SessionProvider`
     * （`ui-renderer` 的 `standardProps` 分支），而随附 `ui-subagent` 已经全局声明了
     * `sidebar.chat.conversation`，第三方再声明会抛 `slot ... is already declared`。
     * 所以这里声明一个自己命名的 session 子槽来触发 Provider 注入（槽位声明是全局的，
     * 但没有任何渲染点，因而是惰性的）。
     */
    const SESSION_SEAT = 'dsh-side-ask.side-session'
    /** 浏览器存储键：侧边会话的「保留 / 已归档」状态与「宿主会话 → 子会话」绑定。 */
    const STORAGE_KEY = 'dsh.side-ask.v2'
    /** 单次引用最多取多少个字符（避免把整篇文档塞进输入框）。 */
    const MAX_QUOTE_CHARS = 20000
    /** 启动清扫延迟（等布局恢复与标签挂载先跑完）。 */
    const SWEEP_DELAY_MS = 5000
    /**
     * 侧边会话默认使用的权限预设：DSH base bundle 内置的 `read-only`
     * （sandbox: read-only + approval: ask）。只读模式下写文件/跑改文件的命令会被
     * 宿主沙箱拒绝，读文件与网页检索仍然可用。
     */
    const READ_ONLY_PRESET = 'read-only'

    /** 宿主主题变量（带 fallback，深/浅色都能用）。 */
    const TOKEN = {
      border: 'var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.18))',
      labelPrimary: 'var(--dsw-alias-label-primary, currentColor)',
      labelSecondary: 'var(--dsw-alias-label-secondary, #7a7f87)',
      overlay: 'var(--dsw-alias-bg-overlay, #ffffff)',
      sidebarFill: 'var(--dsw-specific-sidebar-fill, rgba(127, 127, 127, 0.06))',
    }

    /** 选中弹层：两个按钮并排的分组容器。 */
    const ACTION_GROUP_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      background: TOKEN.overlay,
      border: `1px solid ${TOKEN.border}`,
      borderRadius: 8,
      boxShadow: '0 6px 20px rgba(0, 0, 0, 0.16)',
      overflow: 'hidden',
    }

    /** 选中弹层：单个按钮。 */
    const ACTION_BUTTON_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      height: 30,
      padding: '0 12px',
      border: 'none',
      background: 'transparent',
      color: TOKEN.labelPrimary,
      font: 'inherit',
      fontSize: 13,
      lineHeight: '30px',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }

    /** 选中弹层：按钮之间的分隔线。 */
    const ACTION_SEPARATOR_STYLE = {
      width: 1,
      height: 16,
      flex: '0 0 auto',
      background: TOKEN.border,
    }

    // #endregion

    // #region 词典

    /** 中文文案。 */
    const zh = {
      'tab.title': '侧边提问',
      'tab.temporary': '临时 · 只读 · 关闭标签后归档',
      'tab.kept': '已保留 · 完整权限 · 关闭标签后仍在会话列表',
      'tab.keep': '保留',
      'tab.unkeep': '改回临时',
      'tab.keepHint': '保留为持久会话：恢复父会话的权限（可写文件），关闭标签后仍留在会话列表。',
      'tab.creating': '正在创建侧边会话…',
      'tab.unavailable': '当前部署没有可用的侧栏会话组件（sidebar.chat.conversation 席位不可用）。',
      'guide.title': '侧边提问',
      'guide.description': '从当前会话分支一个临时只读会话，带着上下文问一句；关闭标签后默认归档。',
      'header.open': '侧边提问',
      'header.hint': '在右侧栏开一个继承当前会话上下文的分支会话。',
      'selection.quote': '引用文本',
      'selection.ask': '侧边提问',
      'selection.askHint': '把选中的文字作为引用，在侧边栏里提问。',
      'error.fork': '创建侧边会话失败',
    }

    /** 英文文案。 */
    const en = {
      'tab.title': 'Side ask',
      'tab.temporary': 'Temporary · read-only · archived when this tab closes',
      'tab.kept': 'Kept · full access · stays in the session list after closing',
      'tab.keep': 'Keep',
      'tab.unkeep': 'Make temporary',
      'tab.keepHint': 'Keep as a persistent session: restores the parent session permissions (file writes allowed) and stays in the session list after closing.',
      'tab.creating': 'Creating the side session…',
      'tab.unavailable': 'This deployment has no sidebar conversation slot (sidebar.chat.conversation is unavailable).',
      'guide.title': 'Side ask',
      'guide.description': 'Branch a temporary read-only side session off this conversation and ask with its context; the tab archives when closed.',
      'header.open': 'Side ask',
      'header.hint': 'Open a branched side session in the right sidebar, inheriting the current conversation.',
      'selection.quote': 'Quote text',
      'selection.ask': 'Side ask',
      'selection.askHint': 'Ask in the sidebar with the selected text as a quote.',
      'error.fork': 'Could not create the side session',
    }

    // #endregion

    // #region 纯函数（引用 / 存储）

    /**
     * Turn selected text into a Markdown blockquote prompt for the side composer.
     * @param {unknown} text - selected text.
     * @returns {string} blockquote text (empty for blank input).
     */
    function formatQuote(text) {
      const normalized = String(text ?? '').replace(/\r\n?/gu, '\n').trim()
      if (normalized === '') return ''
      const clipped = normalized.length > MAX_QUOTE_CHARS
        ? normalized.slice(0, MAX_QUOTE_CHARS)
        : normalized
      const quoted = clipped.split('\n').map(line => (line === '' ? '>' : `> ${line}`)).join('\n')
      return `${quoted}\n\n`
    }

    /**
     * Normalize a stored state object; malformed entries are dropped, never trusted.
     * @param {unknown} raw - parsed JSON value.
     * @returns {{ version: 2, records: Record<string, object> }} safe store state.
     */
    function normalizeStore(raw) {
      const empty = { version: 2, records: {} }
      if (raw === null || typeof raw !== 'object') return empty
      const recs = raw.records
      if (recs === null || typeof recs !== 'object') return empty
      const records = {}
      for (const [key, value] of Object.entries(recs)) {
        if (value === null || typeof value !== 'object') continue
        const childSessionId = typeof value.childSessionId === 'string' ? value.childSessionId : key
        const parentSessionId = typeof value.parentSessionId === 'string' ? value.parentSessionId : ''
        if (childSessionId === '' || parentSessionId === '') continue
        records[childSessionId] = {
          childSessionId,
          parentSessionId,
          kept: value.kept === true,
          archived: value.archived === true,
          restorePreset: typeof value.restorePreset === 'string' && value.restorePreset !== '' ? value.restorePreset : null,
          createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
        }
      }
      return { version: 2, records }
    }

    /**
     * Create the localStorage-backed record store.
     * @param {{ getItem(key: string): string | null, setItem(key: string, value: string): void }} storage - browser storage (or a fake in tests).
     * @returns {object} store operations.
     */
    function createStore(storage) {
      /** @returns {{ version: 2, records: Record<string, object> }} */
      function read() {
        try {
          const raw = storage.getItem(STORAGE_KEY)
          if (raw === null || raw === '') return normalizeStore(undefined)
          return normalizeStore(JSON.parse(raw))
        } catch {
          // 存储不可用或 JSON 损坏时退化为空表：侧边会话仍能工作，只是不记得保留状态。
          return normalizeStore(undefined)
        }
      }
      /** @param {{ version: 2, records: Record<string, object> }} state */
      function write(state) {
        try { storage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* 忽略：状态非关键 */ }
      }
      return {
        list() { return Object.values(read().records) },
        get(childSessionId) { return read().records[String(childSessionId)] },
        /**
         * 宿主会话当前绑定的、未归档的侧边会话（有多个时取最新）。
         * @param {string} parentSessionId - 宿主会话 id。
         * @returns {object | undefined} 记录。
         */
        childOf(parentSessionId) {
          const records = Object.values(read().records)
            .filter(record => record.parentSessionId === String(parentSessionId) && record.archived !== true)
            .sort((a, b) => b.createdAt - a.createdAt)
          return records[0]
        },
        upsert(childSessionId, parentSessionId, restorePreset = null) {
          const state = read()
          const existing = state.records[childSessionId]
          state.records[childSessionId] = {
            childSessionId,
            parentSessionId,
            kept: existing === undefined ? false : existing.kept,
            archived: false,
            restorePreset: existing !== undefined && existing.restorePreset !== null
              ? existing.restorePreset
              : (typeof restorePreset === 'string' && restorePreset !== '' ? restorePreset : null),
            createdAt: existing === undefined ? Date.now() : existing.createdAt,
          }
          write(state)
          return state.records[childSessionId]
        },
        setRestorePreset(childSessionId, preset) {
          const state = read()
          const record = state.records[childSessionId]
          if (record === undefined) return
          record.restorePreset = typeof preset === 'string' && preset !== '' ? preset : null
          write(state)
        },
        setKept(childSessionId, kept) {
          const state = read()
          const record = state.records[childSessionId]
          if (record === undefined) return
          record.kept = kept === true
          write(state)
        },
        markArchived(childSessionId) {
          const state = read()
          const record = state.records[childSessionId]
          if (record === undefined) return
          record.archived = true
          write(state)
        },
        markActive(childSessionId) {
          const state = read()
          const record = state.records[childSessionId]
          if (record === undefined) return
          record.archived = false
          write(state)
        },
        isChild(sessionId) { return read().records[String(sessionId)] !== undefined },
      }
    }

    // #endregion

    // #region 组件

    /**
     * 侧边会话标签页正文：一行状态栏 + 原生会话。
     * @param {object} props - 槽位运行时 props（`sessionId` / `SessionProvider` / `renderFactorySlot` / `t`）与本插件注入面。
     * @returns {object} React 元素。
     */
    function SideAskTab(props) {
      const { sessionId, SessionProvider, renderFactorySlot, t, sideAsk } = props
      const initialChild = sideAsk.childOf(sessionId)
      const [childSessionId, setChildSessionId] = React.useState(initialChild)
      const [reference, setReference] = React.useState(null)
      const [kept, setKept] = React.useState(() => (
        initialChild === undefined ? false : sideAsk.isKept(initialChild)
      ))
      // 从 guide 入口打开时标签里还没有子会话：在挂载时为本会话创建一个（有绑定则复用）。
      React.useEffect(() => {
        let cancelled = false
        const existing = sideAsk.childOf(sessionId)
        if (existing !== undefined) {
          setChildSessionId(existing)
          setKept(sideAsk.isKept(existing))
          return () => { cancelled = true }
        }
        Promise.resolve(sideAsk.ensureChild(sessionId)).then((childId) => {
          if (cancelled || typeof childId !== 'string') return
          setChildSessionId(childId)
          setKept(sideAsk.isKept(childId))
        }).catch((error) => {
          console.warn('dsh-side-ask: could not create the side session', error)
        })
        return () => { cancelled = true }
      }, [sessionId])
      // 为子会话持有一个引用（Provider 与输入框都靠它）；卸载时释放。
      React.useEffect(() => {
        if (childSessionId === undefined) { setReference(null); return }
        let next = null
        try { next = sideAsk.retain(childSessionId) } catch (error) {
          console.warn('dsh-side-ask: could not retain the side session', error)
        }
        setReference(next)
        sideAsk.onTabOpen(childSessionId)
        return () => { if (next !== null) sideAsk.release(next) }
      }, [childSessionId])
      const toggle = () => {
        if (childSessionId === undefined) return
        const next = !kept
        sideAsk.setKept(childSessionId, next)
        setKept(next)
      }
      // 原生会话内容：`conversation.content` 工厂（与主会话同一套渲染）。不传 `slots`
      // 时默认 views 就是 `renderSlot('conversation.session')`，即原生聊天流 + 输入框。
      const content = renderFactorySlot('conversation.content', {
        variant: 'embedded',
        phase: 'active',
        hero: false,
        onWorkspaceSelected: (workspaceId, adopt) => sideAsk.openWorkspace(workspaceId, adopt),
      })
      let body
      if (reference === null) {
        body = jsx('div', {
          style: { padding: '14px 16px', color: TOKEN.labelSecondary, fontSize: 13 },
          children: t('tab.creating'),
        })
      } else if (typeof SessionProvider !== 'function') {
        body = jsx('div', {
          style: { padding: '14px 16px', color: TOKEN.labelSecondary, fontSize: 13 },
          children: t('tab.unavailable'),
        })
      } else {
        body = jsx(SessionProvider, { session: reference, children: content })
      }
      return jsxs('div', {
        style: {
          display: 'flex', flexDirection: 'column', width: '100%', height: '100%',
          minWidth: 0, minHeight: 0,
        },
        children: [
          jsxs('div', {
            style: {
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
              padding: '5px 10px', flex: '0 0 auto', fontSize: 12,
              color: TOKEN.labelSecondary, borderBottom: `1px solid ${TOKEN.border}`,
              background: TOKEN.sidebarFill,
            },
            children: [
              jsx('span', {
                style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                title: kept ? t('tab.kept') : t('tab.temporary'),
                children: kept ? t('tab.kept') : t('tab.temporary'),
              }),
              childSessionId === undefined
                ? null
                : jsx(P.Button, {
                  size: 'sm',
                  onClick: toggle,
                  title: t('tab.keepHint'),
                  'aria-pressed': kept,
                  children: kept ? t('tab.unkeep') : t('tab.keep'),
                }),
            ],
          }),
          jsx('div', {
            style: {
              display: 'flex', flexDirection: 'column', flex: '1 1 auto',
              minHeight: 0, minWidth: 0,
            },
            children: body,
          }),
        ],
      })
    }

    /**
     * 会话标题栏入口：一个紧凑的图标按钮。
     * @param {object} props - `sessionId`、`onOpen`、`hidden`、`t`。
     * @returns {object | null} React 元素或 null。
     */
    function SideAskHeaderButton(props) {
      const { onOpen, hidden, t } = props
      if (hidden === true) return null
      return jsx(P.Button, {
        size: 'sm',
        title: t('header.hint'),
        'aria-label': t('header.open'),
        onClick: onOpen,
        children: jsxs('span', {
          style: { display: 'inline-flex', alignItems: 'center', gap: 5 },
          children: [icon(), jsx('span', { children: t('header.open') })],
        }),
      })
    }

    /**
     * 选中文字的合并操作条：「引用文本」与「侧边提问」并排。
     *
     * 通过 shadow 官方 `quote` 表面（更低 priority）接管官方「引用」弹层，因此「引用文本」
     * 必须完整复刻官方行为：`inputActions.insertQuote(text)` + 清选区 + 关弹层。
     * 侧边会话里只显示「引用文本」（不再递归开侧边会话）。
     * @param {object} props - 槽位运行时 props（`readText` / `clearSelection` / `dismiss` /
     *   `inputActions` / `useSession` / `sessionId`）、本插件注入面与文案。
     * @returns {object | null} React 元素或 null。
     */
    function SideAskTextActions(props) {
      const {
        readText, clearSelection, dismiss, inputActions, useSession, sessionId, onAsk, isChild, t,
      } = props
      const enabled = useSession(state => state !== undefined && !state.removed
        && (state.subagent === null || state.subagent.address.mode === 'continuable'))
      React.useEffect(() => {
        if (!enabled) dismiss()
      }, [enabled, dismiss])
      if (!enabled) return null
      const canQuote = inputActions !== undefined && typeof inputActions.insertQuote === 'function'
      const canAsk = isChild(sessionId) !== true
      const runQuote = () => {
        const text = readText()
        if (text === null) { dismiss(); return }
        if (!inputActions.insertQuote(text)) return
        clearSelection()
        dismiss()
      }
      const runAsk = () => {
        const text = readText()
        if (text === null) { dismiss(); return }
        clearSelection()
        dismiss()
        onAsk(sessionId, text)
      }
      const children = []
      if (canQuote) {
        children.push(jsx('button', {
          key: 'quote',
          type: 'button',
          style: ACTION_BUTTON_STYLE,
          onPointerDown: (event) => { event.preventDefault() },
          onClick: runQuote,
          children: t('selection.quote'),
        }))
      }
      if (canQuote && canAsk) children.push(jsx('span', { key: 'sep', style: ACTION_SEPARATOR_STYLE }))
      if (canAsk) {
        children.push(jsx('button', {
          key: 'ask',
          type: 'button',
          style: ACTION_BUTTON_STYLE,
          title: t('selection.askHint'),
          onPointerDown: (event) => { event.preventDefault() },
          onClick: runAsk,
          children: [icon(), jsx('span', { key: 'label', children: t('selection.ask') })],
        }))
      }
      return jsx('span', { style: ACTION_GROUP_STYLE, children })
    }

    /**
     * 小图标：对话框 + 右侧栏。
     * @returns {object} React 元素。
     */
    function icon() {
      return jsxs('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true,
        style: { display: 'block', flex: '0 0 auto' },
        children: [
          jsx('path', {
            d: 'M2.5 3.2h7.2a1 1 0 0 1 1 1v5.1a1 1 0 0 1-1 1H6.1L3.6 12v-1.7h-.1a1 1 0 0 1-1-1V4.2a1 1 0 0 1 1-1Z',
            fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round',
          }),
          jsx('path', {
            d: 'M12.4 5.4h1.1a1 1 0 0 1 1 1v6.1a1 1 0 0 1-1 1h-2.2l-1.6 1.2v-1.2h-.2',
            fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round', opacity: 0.55,
          }),
        ],
      })
    }

    /**
     * guide 卡片图标（`ComponentType<IconProps>` 形态：无参函数组件）。
     * @returns {object} React 元素。
     */
    function SideAskGlyph() {
      return icon()
    }

    // #endregion

    // #region 插件

    /** 需要的客户端服务。 */
    const inject = [
      'slots',
      'locale',
      'sessions',
      'conversation',
      'uiConversation',
      'sidebarRightTabs',
      'sidebarRight',
      'uiWorkspace',
      'workspaces',
      'remote',
      'remote.permissionPresets',
    ]

    /**
     * 安装侧边提问：标签类型与 guide 入口、标签内容、关闭归档、标题栏入口、合并选中弹层。
     *
     * 根插件本身不声明 `inject`：先 apply、再用 `ctx.inject` 等服务就绪，这样即使某个
     * 服务在当前部署里不存在，也留下可诊断的状态（而不是整插件静默 pending）。
     * @param {object} ctx - 浏览器端 Cordis 上下文。
     * @returns {void}
     */
    function apply(ctx) {
      ctx.inject(inject, (scope) => {
        install(scope)
      })
    }

    /**
     * 服务就绪后的实际安装（失败只告警，不拖垮整页）。
     * @param {object} ctx - 服务 scope。
     * @returns {void}
     */
    function install(ctx) {
      try {
        installUnsafe(ctx)
      } catch (error) {
        // 安装失败不拖垮整页：后续用户动作会表现为入口缺失，控制台保留原因。
        console.warn('dsh-side-ask: install failed', error)
      }
    }

    /**
     * 安装主体。
     * @param {object} ctx - 服务 scope。
     * @returns {void}
     */
    function installUnsafe(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'side-ask: dictionaries')
      const t = ctx.locale.bind(NS)
      const store = createStore(window.localStorage)
      /** childSessionId → SessionReference：创建后到标签关闭期间保持会话代活（用于预填引用）。 */
      const holds = new Map()
      /** parentSessionId → 正在创建中的 Promise，避免双击重复 fork。 */
      const creating = new Map()

      /**
       * 归档一个侧边会话（尽力而为；失败只告警，不影响 UI）。
       * @param {string} childSessionId - 侧边会话 id。
       * @returns {void}
       */
      function archive(childSessionId) {
        try {
          ctx.uiWorkspace.archiveSession(childSessionId, { stopActivity: true }).catch((error) => {
            console.warn('dsh-side-ask: could not archive the side session', error)
          })
        } catch (error) {
          console.warn('dsh-side-ask: could not archive the side session', error)
        }
      }

      /**
       * 取消归档一个侧边会话。
       * @param {string} childSessionId - 侧边会话 id。
       * @returns {void}
       */
      function unarchive(childSessionId) {
        try {
          ctx.uiWorkspace.unarchiveSession(childSessionId).catch((error) => {
            console.warn('dsh-side-ask: could not restore the side session', error)
          })
        } catch (error) {
          console.warn('dsh-side-ask: could not restore the side session', error)
        }
      }

      /**
       * 找到当前会话所属的 workspace id（新建兜底会话时用）。
       * @param {string} sessionId - 会话 id。
       * @returns {string | undefined}
       */
      function workspaceOf(sessionId) {
        try {
          const snapshot = ctx.workspaces.list.getSnapshot()
          const item = snapshot.items.find(candidate => candidate.sessionIds.includes(sessionId))
          return item === undefined ? undefined : item.workspaceId
        } catch { return undefined }
      }

      /**
       * 读一个会话当前的权限预设 key（`permissions` 投影的 currentValue）。
       * @param {string} sessionId - 会话 id。
       * @returns {string | undefined} 预设 key；`custom` / `auto` / 读不到时返回 undefined。
       */
      function permissionOf(sessionId) {
        try {
          const entry = ctx.sessions.list.getSnapshot().byId[sessionId]
          const value = entry === undefined ? undefined : entry.projectionValues?.permissions?.currentValue
          if (typeof value !== 'string' || value === '' || value === 'custom' || value === 'auto') return undefined
          return value
        } catch { return undefined }
      }

      /**
       * 把一个活会话切到指定权限预设（写 `permission/preset` 与旋钮事件）。
       * 只读模式下写文件/改文件的命令会被宿主沙箱拒绝；读与检索不受影响。
       * @param {string} childSessionId - 侧边会话 id。
       * @param {string} preset - 预设 key（如 `read-only` / `workspace-write`）。
       * @returns {Promise<boolean>} 是否切换成功。
       */
      /**
       * 把一个活会话切到指定权限预设。
       *
       * 官方的 per-session 切换走的是斜杠命令 `/permission <preset>`（浏览器半
       * `ui-permission-presets` 的 composer 控件就是这么做的）；`permissionPresets.set`
       * 这个 Host Remote 没有暴露给浏览器端的生成命名空间（只有 `catalog`），所以这里
       * 复用官方同一条命令通道。只读模式下写文件/改文件的命令会被宿主沙箱拒绝，读与
       * 检索不受影响。
       * @param {string} childSessionId - 侧边会话 id（必须已 retain，否则没有 binding）。
       * @param {string} preset - 预设 key（如 `read-only` / `workspace-write`）。
       * @returns {Promise<boolean>} 是否切换成功。
       */
      async function applyPreset(childSessionId, preset) {
        try {
          const binding = ctx.sessions.binding(childSessionId)
          if (binding === undefined) {
            console.warn('dsh-side-ask: side session is not retained; cannot switch its permission')
            return false
          }
          const result = await binding.session.command(`/permission ${preset}`)
          if (result !== undefined && result !== null && result.ok === false) {
            console.warn('dsh-side-ask: permission preset refused', result.error)
            return false
          }
          if (result !== undefined && result !== null && result.ok === true && result.value?.matched === false) {
            console.warn(`dsh-side-ask: this host offers no /permission command; "${preset}" not applied`)
            return false
          }
          return true
        } catch (error) {
          // 部署没注册 /permission（或会话不是活的）时只告警：侧边会话照常可用，只是不强制只读。
          console.warn(`dsh-side-ask: could not switch the side session to "${preset}"`, error)
          return false
        }
      }

      /**
       * 「保留」后恢复的预设：优先记录里父会话当时的预设，否则 catalog 的默认预设，
       * 最后退回 workspace-write（base bundle 一定配置了它）。
       * @param {object | undefined} record - 侧边会话记录。
       * @returns {Promise<string>} 预设 key。
       */
      async function presetToRestore(record) {
        if (record !== undefined && typeof record.restorePreset === 'string') return record.restorePreset
        try {
          const result = await ctx.remote.permissionPresets.catalog()
          if (result !== undefined && result !== null && result.ok === true
            && typeof result.value?.defaultPreset === 'string') return result.value.defaultPreset
        } catch { /* 忽略：退回下面的固定值 */ }
        return 'workspace-write'
      }

      /**
       * 按「保留 / 临时」切换侧边会话的权限：临时 = 只读；保留 = 恢复父会话的权限。
       * @param {string} childSessionId - 侧边会话 id。
       * @param {boolean} kept - 是否保留为持久会话。
       * @returns {Promise<void>}
       */
      async function switchPresetForKept(childSessionId, kept) {
        // 确保有 binding（body 已 retain 过时这里是幂等的）。
        if (ctx.sessions.binding(childSessionId) === undefined) holdChild(childSessionId)
        if (kept) {
          const preset = await presetToRestore(store.get(childSessionId))
          await applyPreset(childSessionId, preset)
          return
        }
        await applyPreset(childSessionId, READ_ONLY_PRESET)
      }

      /**
       * 为一个宿主会话确保存在一个可用的侧边会话：有绑定就复用，否则 fork 一个分支。
       * @param {string} parentSessionId - 宿主会话。
       * @returns {Promise<string>} 侧边会话 id。
       */
      function ensureChild(parentSessionId) {
        const existing = store.childOf(parentSessionId)
        if (existing !== undefined) return Promise.resolve(existing.childSessionId)
        const running = creating.get(parentSessionId)
        if (running !== undefined) return running
        const task = (async () => {
          let childSessionId
          try {
            childSessionId = await ctx.sessions.fork({ sessionId: parentSessionId })
          } catch (forkError) {
            // 空会话（还没有已完成回合）无法 fork：退化为同 workspace 的新会话。
            const workspaceId = workspaceOf(parentSessionId)
            childSessionId = await ctx.sessions.create(workspaceId === undefined ? {} : { workspaceId })
          }
          store.upsert(childSessionId, parentSessionId, permissionOf(parentSessionId) ?? null)
          // 临时会话默认只读：在用户输入第一条消息之前就切好，避免模型先动文件。
          // 命令通道要求会话已 retain（有 binding），所以先拿一个持有、标签关闭时释放。
          holdChild(childSessionId)
          await applyPreset(childSessionId, READ_ONLY_PRESET)
          void ctx.sessions.refresh().catch(() => {})
          return childSessionId
        })().finally(() => { creating.delete(parentSessionId) })
        creating.set(parentSessionId, task)
        return task
      }

      /**
       * 持有一个侧边会话引用（用于给它的输入框预填引用）；已有则复用。
       * @param {string} childSessionId - 侧边会话 id。
       * @returns {object | null} SessionReference。
       */
      function holdChild(childSessionId) {
        const existing = holds.get(childSessionId)
        if (existing !== undefined) return existing
        try {
          const reference = ctx.sessions.retain(childSessionId, {
            source: 'sideAsk',
            facets: { conversation: true },
          })
          holds.set(childSessionId, reference)
          return reference
        } catch (error) {
          console.warn('dsh-side-ask: could not retain the side session', error)
          return null
        }
      }

      /**
       * 释放一个预填用的持有（标签关闭时调用）。
       * @param {string} childSessionId - 侧边会话 id。
       * @returns {void}
       */
      function releaseHold(childSessionId) {
        const reference = holds.get(childSessionId)
        if (reference === undefined) return
        holds.delete(childSessionId)
        reference.release()
      }

      /**
       * 把引用预填进目标会话的原生输入框（不自动发送）。
       * @param {object} binding - 已 retain 的会话 binding。
       * @param {string} text - 选中文字。
       * @returns {void}
       */
      function prefillQuote(binding, text) {
        const prompt = formatQuote(text)
        if (prompt === '') return
        try {
          ctx.conversation.input.requestDraftInitialization(binding, {
            prompt,
            whenDraftExists: 'append',
          })
        } catch (error) {
          console.warn('dsh-side-ask: could not prefill the quote', error)
        }
      }

      /**
       * 在右侧栏打开（或聚焦）本插件的侧边提问标签；带引用时同时预填输入框。
       * @param {string} parentSessionId - 发起提问的会话。
       * @param {string | undefined} quoteText - 选中并要引用的文字。
       * @returns {Promise<void>}
       */
      async function openSideAsk(parentSessionId, quoteText) {
        if (typeof parentSessionId !== 'string' || parentSessionId === '') return
        try {
          const childSessionId = await ensureChild(parentSessionId)
          if (quoteText !== undefined) {
            const reference = holdChild(childSessionId)
            if (reference !== null) prefillQuote(reference.binding, quoteText)
          }
          try { ctx.sidebarRight.openTab(KIND) } catch (error) {
            console.warn('dsh-side-ask: could not open the side tab', error)
          }
        } catch (error) {
          console.warn('dsh-side-ask: side session creation failed', error)
        }
      }

      // ① 标签类型：页面型 + guide（右侧栏「新建标签页」引导页）入口。
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: KIND,
        priority: 'extension',
        title: () => t('tab.title'),
        guide: [{
          id: GUIDE_ID,
          order: 30,
          title: () => t('guide.title'),
          description: () => t('guide.description'),
          icon: SideAskGlyph,
        }],
      }), 'side-ask: tab type')

      // ② 标签内容：状态栏 + 原生会话（为子会话声明私有 session 子槽换取 SessionProvider）。
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
        locale: NS,
        inject: () => ({
          sideAsk: {
            childOf: parentSessionId => {
              const record = store.childOf(parentSessionId)
              return record === undefined ? undefined : record.childSessionId
            },
            ensureChild: parentSessionId => ensureChild(parentSessionId),
            isKept: childSessionId => {
              const record = store.get(childSessionId)
              return record !== undefined && record.kept === true
            },
            setKept: (childSessionId, kept) => {
              store.setKept(childSessionId, kept)
              // 保留 = 持久会话（恢复父会话权限）；改回临时 = 只读。
              void switchPresetForKept(childSessionId, kept)
            },
            retain: childSessionId => ctx.sessions.retain(childSessionId, {
              source: 'sideAsk',
              facets: { conversation: true },
            }),
            release: reference => reference.release(),
            onTabOpen: (childSessionId) => {
              const record = store.get(childSessionId)
              if (record !== undefined && record.archived === true) {
                store.markActive(childSessionId)
                unarchive(childSessionId)
              }
              // 临时会话永远是只读：旧版本创建、或外部改过权限时在这里纠正。
              if (record === undefined || record.kept !== true) {
                if (permissionOf(childSessionId) !== READ_ONLY_PRESET) {
                  void applyPreset(childSessionId, READ_ONLY_PRESET)
                }
              }
            },
            openWorkspace: (workspaceId, adopt) => ctx.uiWorkspace.openWorkspace(workspaceId, adopt),
          },
        }),
        children: {
          [SESSION_SEAT]: { kind: 'single', scope: 'session' },
        },
      }, SideAskTab)), 'side-ask: tab body')

      // ③ 关闭归档：默认归档，用户选择了「保留」才留下。
      ctx.effect(() => ctx.sidebarRight.registerCloseHandler(KIND, (sessionId, tab) => {
        const record = store.childOf(sessionId)
        if (record === undefined) return
        const childSessionId = record.childSessionId
        // 同一会话在别的分栏里还有本插件的标签时，先不归档（仍有一处在看）。
        let remaining = []
        try {
          remaining = ctx.sidebarRight.tabsIn(sessionId)
            .filter(candidate => candidate.kind === KIND && candidate.id !== tab.id)
        } catch { remaining = [] }
        if (remaining.length > 0) return
        releaseHold(childSessionId)
        const current = store.get(childSessionId)
        if (current !== undefined && current.kept === true) return
        if (current !== undefined && current.archived === true) return
        store.markArchived(childSessionId)
        archive(childSessionId)
      }), 'side-ask: close handler')

      // ④ 标题栏入口（标签已存在时 openTab 会聚焦，不重复开）。
      ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'side-ask',
        order: -20,
        locale: NS,
        inject: sessionId => ({
          onOpen: () => { void openSideAsk(sessionId) },
          hidden: store.isChild(sessionId),
        }),
      }, SideAskHeaderButton)), 'side-ask: header button')

      /** 合并操作条的注入面。 */
      const textActionsInjected = {
        onAsk: (sessionId, text) => { void openSideAsk(sessionId, text) },
        isChild: sessionId => store.isChild(sessionId),
      }

      // ⑤ 接管官方「引用」表面：同 key 'quote' 用更低 priority 注册即可 shadow
      //    （槽位规则：最低 priority 渲染），把「引用文本」与「侧边提问」并排放在一个弹层里。
      ctx.effect(() => ctx.slots.inject('conversation.chat.text-interaction', () => ctx.slots.register({
        name: 'conversation.chat.text-interaction',
        key: 'quote',
        priority: -1,
        locale: NS,
        inject: () => textActionsInjected,
      }, SideAskTextActions)), 'side-ask: quote surface')

      // ⑥ 兜底表面：官方 message-quotes 不在时（或右键手势，官方不处理）用本插件自己的 key。
      ctx.effect(() => ctx.slots.inject('conversation.chat.text-interaction', () => ctx.slots.register({
        name: 'conversation.chat.text-interaction',
        key: KIND,
        locale: NS,
        inject: () => textActionsInjected,
      }, SideAskTextActions)), 'side-ask: selection surface')

      // ⑦ 手势准入：selection 上官方先注册（先 open 者赢），这里只在官方缺席时兜底；
      //    contextmenu 官方明确不处理，由这里打开同一个合并操作条。
      ctx.effect(() => ctx.uiConversation.interactions.register({
        id: KIND,
        onInteraction(request) {
          const text = request.readText()
          if (text === null || text.trim() === '') return
          const binding = ctx.sessions.binding(request.sessionId)
          if (binding === undefined) return
          const session = binding.session.getSnapshot()
          if (session.removed) return
          if (session.subagent !== null && session.subagent.address.mode !== 'continuable') return
          request.open()
        },
      }), 'side-ask: text interaction')

      // ⑧ 启动清扫：上次运行遗留、未保留、也没有对应标签页的侧边会话归档掉。
      ctx.effect(() => {
        const timer = window.setTimeout(() => {
          try {
            for (const record of store.list()) {
              if (record.kept === true || record.archived === true) continue
              let open = false
              try {
                open = ctx.sidebarRight.tabsIn(record.parentSessionId)
                  .some(candidate => candidate.kind === KIND)
              } catch { open = false }
              if (open) continue
              store.markArchived(record.childSessionId)
              archive(record.childSessionId)
            }
          } catch (error) {
            console.warn('dsh-side-ask: startup sweep failed', error)
          }
        }, SWEEP_DELAY_MS)
        return () => { window.clearTimeout(timer) }
      }, 'side-ask: startup sweep')
    }

    module.exports = {
      name: 'dsh-side-ask',
      apply,
      /** 测试用内部实现（生产代码不读它）。 */
      __internals: {
        formatQuote,
        normalizeStore,
        createStore,
        inject,
        MAX_QUOTE_CHARS,
        STORAGE_KEY,
        KIND,
        TAB_ID,
        GUIDE_ID,
      },
    }
    return module.exports
  },
})

/**
 * `dsh-side-ask` 的离线单测。
 *
 * 浏览器半是手写 ModuleLoader bundle（`window.__ModuleLoader__.load({ factory })`），
 * 没有构建步骤。这里用 `node:vm` 提供一个假 `window` / 假 `require`，把 bundle 真正
 * 执行一遍，然后测工厂返回的插件对象与 `__internals` 里的纯函数。测的是**真实代码**，
 * 不是复制品——引用格式化、存储与装配逻辑一旦写坏，这里会红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT_SOURCE = readFileSync(join(here, '..', 'client.js'), 'utf8')

/** 平台冻结模块表里允许的说明符（`packages/client/web/src/platform.ts`）。 */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  'zod', '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/**
 * 把 vm 跨 realm 生成的值归一化到测试 realm（`deepStrictEqual` 比较原型，跨 realm 会假红）。
 * @param {unknown} value - vm 内生成的值。
 * @returns {unknown} 同结构、本 realm 的值。
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

/** 一个够用的内存 storage。 */
function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null },
    setItem(key, value) { map.set(key, String(value)) },
  }
}

/**
 * 在 vm 里执行 client.js，拿到注册的 factory 与插件对象。
 * @param {object} [options] - 可注入的假 storage。
 * @returns {{ plugin: object, registration: object, window: object }}
 */
function loadPlugin(options = {}) {
  let registration
  const window = {
    __ModuleLoader__: { load: (value) => { registration = value } },
    localStorage: options.localStorage ?? createMemoryStorage(),
    setTimeout: () => 0,
    clearTimeout: () => {},
    document: { addEventListener() {}, removeEventListener() {}, getSelection() { return null } },
    innerHeight: 900,
    innerWidth: 1440,
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
  }
  const sandbox = {
    window, globalThis: { window }, console, URL, URLSearchParams, Date, Math, Promise,
    String, Object, JSON, Array, Number, Set, Map, Error,
  }
  vm.createContext(sandbox)
  vm.runInContext(CLIENT_SOURCE, sandbox, { filename: 'client.js' })
  assert.ok(registration !== undefined, 'client.js 必须通过 window.__ModuleLoader__.load 注册')
  assert.equal(registration.id, 'dsh-side-ask')

  const fakeReact = {
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useRef: (value) => ({ current: value }),
    createElement: () => ({}),
  }
  const table = {
    react: fakeReact,
    'react/jsx-runtime': { jsx: () => ({}), jsxs: () => ({}) },
    'react-dom': { createPortal: () => ({}) },
    '@deepseek-ai/dsh-client-ui-primitives': { Button: () => ({}) },
  }
  const missing = []
  const plugin = registration.factory((specifier) => {
    if (!(specifier in table)) {
      missing.push(specifier)
      throw new Error(`require("${specifier}") missed the module table`)
    }
    return table[specifier]
  })
  assert.deepEqual(missing, [], 'client.js 只能 require 平台模块表里的说明符')
  return { plugin, registration, window }
}

test('bundle 只 require 平台冻结模块表里的说明符', () => {
  const used = [...CLIENT_SOURCE.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/gu)].map(match => match[1])
  assert.ok(used.length > 0)
  for (const specifier of used) assert.ok(PLATFORM_MODULES.includes(specifier), `${specifier} 不在平台模块表里`)
})

test('插件清单：名字、注入服务与 apply', () => {
  const { plugin } = loadPlugin()
  assert.equal(plugin.name, 'dsh-side-ask')
  assert.equal(typeof plugin.apply, 'function')
  // 根插件不声明 inject（否则某服务缺失时整插件静默 pending）；服务列表在 __internals。
  assert.equal(plugin.inject, undefined)
  for (const service of [
    'slots', 'locale', 'sessions', 'conversation', 'uiConversation',
    'sidebarRightTabs', 'sidebarRight', 'uiWorkspace', 'workspaces',
    'remote', 'remote.permissionPresets',
  ]) assert.ok(plugin.__internals.inject.includes(service), `缺少注入服务 ${service}`)
})

test('引用格式化：多行变成 Markdown 引用块，空行保留', () => {
  const { plugin } = loadPlugin()
  const { formatQuote } = plugin.__internals
  assert.equal(formatQuote('hello'), '> hello\n\n')
  assert.equal(formatQuote('a\r\nb\n\nc'), '> a\n> b\n>\n> c\n\n')
  assert.equal(formatQuote('   '), '')
  assert.equal(formatQuote(null), '')
})

test('引用格式化：超长截断到上限', () => {
  const { plugin } = loadPlugin()
  const { formatQuote, MAX_QUOTE_CHARS } = plugin.__internals
  const long = 'x'.repeat(MAX_QUOTE_CHARS + 100)
  const quoted = formatQuote(long)
  assert.ok(quoted.length < long.length + 8)
  assert.ok(quoted.startsWith('> xxx'))
})

test('存储：normalizeStore 丢弃坏记录', () => {
  const { plugin } = loadPlugin()
  const { normalizeStore } = plugin.__internals
  const state = normalizeStore({
    records: {
      'session-a': { childSessionId: 'session-a', parentSessionId: 'session-p', kept: true, archived: false, createdAt: 5 },
      broken: null,
      'session-b': { parentSessionId: '' },
      'session-c': 'nope',
    },
  })
  assert.deepEqual(Object.keys(state.records), ['session-a'])
  assert.equal(state.records['session-a'].kept, true)
  assert.deepEqual(plain(normalizeStore('garbage')), { version: 2, records: {} })
})

test('存储：upsert / setKept / markArchived 持久化，childOf 只返回未归档的最新绑定', () => {
  const { plugin } = loadPlugin()
  const { createStore, STORAGE_KEY } = plugin.__internals
  const storage = createMemoryStorage()
  const store = createStore(storage)
  store.upsert('session-child', 'session-parent', 'workspace-write')
  assert.equal(store.get('session-child').restorePreset, 'workspace-write')
  store.setKept('session-child', true)
  store.markArchived('session-child')
  assert.equal(store.get('session-child').archived, true)
  // 已归档的绑定不再被 childOf 返回（关闭后再次提问会新建一个会话）。
  assert.equal(store.childOf('session-parent'), undefined)
  store.upsert('session-child-2', 'session-parent')
  assert.equal(store.childOf('session-parent').childSessionId, 'session-child-2')
  assert.equal(store.isChild('session-child'), true)
  const raw = storage.getItem(STORAGE_KEY)
  assert.ok(raw !== null && raw.includes('session-child'))
  // 新实例读取同一 storage：状态还在。
  const again = createStore(storage)
  assert.equal(again.get('session-child').kept, true)
  assert.equal(again.childOf('session-parent').childSessionId, 'session-child-2')
  // 恢复预设可以单独更新（保留前父会话权限变了也能跟上）。
  again.setRestorePreset('session-child-2', 'danger-full-access')
  assert.equal(createStore(storage).get('session-child-2').restorePreset, 'danger-full-access')
})

test('存储：损坏 JSON 退化为空表且不抛错', () => {
  const { plugin } = loadPlugin()
  const { createStore, STORAGE_KEY } = plugin.__internals
  const storage = createMemoryStorage({ [STORAGE_KEY]: '{{{not json' })
  const store = createStore(storage)
  assert.deepEqual(plain(store.list()), [])
  assert.equal(store.isChild('anything'), false)
  assert.equal(store.childOf('anything'), undefined)
})

test('apply 能装配：假 ctx 下注册全部席位与 guide 入口', () => {
  const { plugin } = loadPlugin()
  const registered = []
  const effects = []
  const tabDefinitions = []
  const slotRegistrations = []
  const ctx = {
    inject(deps, callback) {
      assert.ok(Array.isArray(deps) && deps.length > 0)
      return callback(ctx)
    },
    get(service) { return service === 'missing' ? undefined : {} },
    effect(factory, label) {
      effects.push(label)
      const disposer = factory()
      return () => { if (typeof disposer === 'function') disposer() }
    },
    locale: {
      register() { registered.push('locale'); return () => {} },
      bind() { return key => key },
    },
    conversation: { input: { requestDraftInitialization() { return 'applied' } } },
    uiConversation: { interactions: { register(definition) { registered.push(`interaction:${definition.id}`); return () => {} } } },
    sessions: {
      binding() { return undefined },
      fork() { throw new Error('not used in this test') },
      create() { throw new Error('not used in this test') },
      retain() { return { binding: {}, release() {} } },
      refresh() { return Promise.resolve() },
    },
    sidebarRightTabs: {
      register(definition) {
        tabDefinitions.push(definition)
        registered.push(`tab:${definition.kind}`)
        assert.ok(Array.isArray(definition.guide) && definition.guide.length > 0, '必须提供右侧栏 guide 入口')
        assert.equal(typeof definition.guide[0].title, 'function')
        return () => {}
      },
    },
    sidebarRight: {
      registerCloseHandler(kind) { registered.push(`close:${kind}`); return () => {} },
      tabsIn() { return [] },
      openTab(kind) { registered.push(`openTab:${kind}`) },
    },
    uiWorkspace: {
      archiveSession() { return Promise.resolve() },
      unarchiveSession() { return Promise.resolve() },
      openWorkspace() { return Promise.resolve() },
    },
    workspaces: { list: { getSnapshot() { return { items: [] } } } },
    slots: {
      inject(name, factory) {
        registered.push(`inject:${name}`)
        const disposer = factory()
        return () => { if (typeof disposer === 'function') disposer() }
      },
      register(options) {
        slotRegistrations.push(options)
        registered.push(`slot:${options.name}:${options.key ?? options.id}`)
        return () => {}
      },
    },
  }
  plugin.apply(ctx)
  for (const expected of [
    'tab:sideask',
    'slot:sidebar.right.pane.tab:dsh-side-ask/tab',
    'close:sideask',
    'inject:conversation.session.header.utilities',
    'inject:conversation.chat.text-interaction',
    'interaction:sideask',
  ]) assert.ok(registered.includes(expected), `缺少注册 ${expected}`)
  // 合并弹层：同一个组件注册在官方的 quote key（shadow）与自己的 key 上。
  const interactionKeys = slotRegistrations
    .filter(options => options.name === 'conversation.chat.text-interaction')
    .map(options => options.key)
  assert.deepEqual(interactionKeys.sort(), ['quote', 'sideask'])
  const shadow = slotRegistrations.find(options => options.name === 'conversation.chat.text-interaction' && options.key === 'quote')
  assert.equal(shadow.priority, -1, '接管官方 quote 表面必须用更低 priority')
  // 标签正文声明了私有 session 子槽（换取 SessionProvider）。
  const tabBody = slotRegistrations.find(options => options.name === 'sidebar.right.pane.tab')
  assert.ok(Object.values(tabBody.children).some(spec => spec.scope === 'session'))
  assert.ok(effects.includes('side-ask: startup sweep'))
})

test('apply：标题栏入口隐藏逻辑与 childOf 注入面', () => {
  const { plugin } = loadPlugin()
  const injected = []
  const ctx = {
    inject(deps, callback) { return callback(ctx) },
    get() { return {} },
    effect(factory) { const disposer = factory(); return () => { if (typeof disposer === 'function') disposer() } },
    locale: { register() { return () => {} }, bind() { return key => key } },
    conversation: { input: { requestDraftInitialization() { return 'applied' } } },
    uiConversation: { interactions: { register() { return () => {} } } },
    sessions: { binding() { return undefined }, retain() { return { binding: {}, release() {} } }, refresh() { return Promise.resolve() } },
    sidebarRightTabs: { register() { return () => {} } },
    sidebarRight: { registerCloseHandler() { return () => {} }, tabsIn() { return [] }, openTab() {} },
    uiWorkspace: { archiveSession() { return Promise.resolve() }, unarchiveSession() { return Promise.resolve() }, openWorkspace() { return Promise.resolve() } },
    workspaces: { list: { getSnapshot() { return { items: [] } } } },
    slots: {
      inject(name, factory) {
        const disposer = factory()
        return () => { if (typeof disposer === 'function') disposer() }
      },
      register(options, component) {
        injected.push({ options, component })
        return () => {}
      },
    },
  }
  plugin.apply(ctx)
  const header = injected.find(entry => entry.options.name === 'conversation.session.header.utilities')
  const injectFace = header.options.inject('session-x')
  assert.equal(typeof injectFace.onOpen, 'function')
  assert.equal(injectFace.hidden, false)
  const tabBody = injected.find(entry => entry.options.name === 'sidebar.right.pane.tab')
  const face = tabBody.options.inject()
  assert.equal(typeof face.sideAsk.childOf, 'function')
  assert.equal(typeof face.sideAsk.ensureChild, 'function')
  assert.equal(face.sideAsk.childOf('nobody'), undefined)
})

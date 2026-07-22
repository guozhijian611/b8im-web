import assert from 'node:assert/strict'
import test from 'node:test'
import { createRenderer, ssrContextKey } from 'vue'
import { createServer, type ViteDevServer } from 'vite'
import {
  MODULE_WORKBENCH_LOAD_DEPENDENCIES_KEY,
  type ModuleWorkbenchLoadDependencies
} from '../src/components/moduleWorkbenchLoad.ts'
import type { TenantBrandConfig } from '../src/services/tenantConfig.ts'
import type { WebImSession } from '../src/types.ts'

interface HostNode {
  type: string
  text: string
  parent: HostNode | null
  children: HostNode[]
  props: Record<string, unknown>
}

function hostNode(type: string, text = ''): HostNode {
  return { type, text, parent: null, children: [], props: {} }
}

const renderer = createRenderer<HostNode, HostNode>({
  patchProp(node, key, _previous, value) {
    node.props[key] = value
  },
  insert(child, parent, anchor) {
    child.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(child)
    else parent.children.splice(index, 0, child)
  },
  remove(child) {
    if (!child.parent) return
    const index = child.parent.children.indexOf(child)
    if (index >= 0) child.parent.children.splice(index, 1)
    child.parent = null
  },
  createElement(type) {
    return hostNode(type)
  },
  createText(text) {
    return hostNode('#text', text)
  },
  createComment(text) {
    return hostNode('#comment', text)
  },
  setText(node, text) {
    node.text = text
  },
  setElementText(node, text) {
    node.text = text
    node.children = []
  },
  parentNode(node) {
    return node.parent
  },
  nextSibling(node) {
    if (!node.parent) return null
    const index = node.parent.children.indexOf(node)
    return node.parent.children[index + 1] ?? null
  },
  querySelector() {
    return null
  },
  setScopeId() {},
  cloneNode(node) {
    return { ...node, parent: null, children: [...node.children], props: { ...node.props } }
  },
  insertStaticContent(content, parent, anchor) {
    const node = hostNode('#static', content)
    node.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(node)
    else parent.children.splice(index, 0, node)
    return [node, node]
  }
})

function config(): TenantBrandConfig {
  return {
    organization: '901',
    discovered: true,
    serverInfo: {
      routingVersion: 1,
      routes: [{
        routeId: 'primary',
        endpoints: {
          apiServerUrl: 'https://api.example.test',
          imServerUrl: 'wss://ws.example.test',
          uploadServerUrl: 'https://api.example.test',
          webServerUrl: 'https://web.example.test'
        }
      }],
      apiServerUrl: 'https://api.example.test'
    }
  } as TenantBrandConfig
}

function session(): WebImSession {
  return {
    accessToken: 'token-901',
    organization: '901',
    user: { userId: 'user-901' }
  } as WebImSession
}

function dependencies(
  overrides: Partial<ModuleWorkbenchLoadDependencies>
): ModuleWorkbenchLoadDependencies {
  return {
    fetchI18nLocales: async () => [],
    fetchI18nMessages: async () => ({ locale: '', messages: {} }),
    fetchFavorites: async () => ({ items: [], total: 0, page: 1, limit: 20 }),
    fetchStickerPacks: async () => [],
    fetchStickerItems: async () => [],
    fetchMyCsConversations: async () => ({ items: [], total: 0 }),
    fetchRobots: async () => ({ items: [], total: 0, page: 1, limit: 20 }),
    fetchFileMediaUsage: async () => {
      throw new Error('unused')
    },
    fetchFileMediaFolders: async () => [],
    fetchFileMediaItems: async () => [],
    fetchMomentsFeed: async () => ({ items: [], total: 0 }),
    ...overrides
  } as ModuleWorkbenchLoadDependencies
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

let server: ViteDevServer
let moduleWorkbenchComponent: Record<string, unknown>
let addedListeners = 0
let removedListeners = 0
const originalWindow = globalThis.window

test.before(async () => {
  Object.assign(globalThis, {
    window: {
      addEventListener() {
        addedListeners += 1
      },
      removeEventListener() {
        removedListeners += 1
      }
    }
  })
  server = await createServer({
    root: process.cwd(),
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent'
  })
  moduleWorkbenchComponent = (
    await server.ssrLoadModule('/src/components/ModuleWorkbenchView.vue')
  ).default as Record<string, unknown>
})

test.after(async () => {
  await server.close()
  Object.assign(globalThis, { window: originalWindow })
})

function mountWorkbench(loadDependencies: ModuleWorkbenchLoadDependencies) {
  const runtimeComponent = { ...moduleWorkbenchComponent, render: () => null }
  const app = renderer.createApp(runtimeComponent, {
    moduleKey: 'favorite',
    title: '收藏',
    tenantConfig: config(),
    webSession: session()
  })
  app.provide(MODULE_WORKBENCH_LOAD_DEPENDENCIES_KEY, loadDependencies)
  app.provide(ssrContextKey, { modules: new Set<string>() })
  const proxy = app.mount(hostNode('#root')) as { $: { setupState: Record<string, any> } }
  return {
    app,
    setup: proxy.$.setupState
  }
}

test('actual ModuleWorkbenchView mount wires the injected loader result into component state', async () => {
  const favorite = {
    id: 77,
    organization: 901,
    userId: 'user-901',
    targetType: 'text' as const,
    targetId: '',
    title: '运行时收藏',
    summary: '',
    payload: null,
    createTime: '2026-07-22 00:00:00'
  }
  const mounted = mountWorkbench(dependencies({
    async fetchFavorites(receivedConfig, receivedSession) {
      assert.equal(receivedConfig.organization, '901')
      assert.equal(receivedSession.accessToken, 'token-901')
      return { items: [favorite], total: 1, page: 1, limit: 20 }
    }
  }))
  await flush()

  assert.equal(mounted.setup.loading, false)
  assert.deepEqual(mounted.setup.favorites, [favorite])
  assert.equal(addedListeners, 1)
  mounted.app.unmount()
  assert.equal(removedListeners, 1)
})

test('actual ModuleWorkbenchView unmount disposes the pending load before success/finally writes', async () => {
  const pending = deferred<{
    items: []
    total: number
    page: number
    limit: number
  }>()
  const mounted = mountWorkbench(dependencies({
    fetchFavorites() {
      return pending.promise
    }
  }))

  assert.equal(mounted.setup.loading, true)
  mounted.app.unmount()
  pending.resolve({ items: [], total: 0, page: 1, limit: 20 })
  await flush()

  assert.deepEqual(mounted.setup.favorites, [])
  assert.equal(mounted.setup.loading, true)
  assert.equal(removedListeners, 2)
})

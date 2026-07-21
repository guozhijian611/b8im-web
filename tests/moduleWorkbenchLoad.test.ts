import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createModuleWorkbenchLoadCoordinator,
  isModuleWorkbenchLoadContextCurrent,
  type ModuleWorkbenchLoadCallbacks,
  type ModuleWorkbenchLoadDependencies,
  type ModuleWorkbenchLoadInput,
  type ModuleWorkbenchLoadResult
} from '../src/components/moduleWorkbenchLoad.ts'
import type { TenantBrandConfig } from '../src/services/tenantConfig.ts'
import type { WebImSession } from '../src/types.ts'

function createConfig(organization: string): TenantBrandConfig {
  return {
    organization,
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

function createSession(organization: string, accessToken: string): WebImSession {
  return {
    accessToken,
    organization,
    user: { userId: 'user-' + organization }
  } as WebImSession
}

function input(
  moduleKey: ModuleWorkbenchLoadInput['moduleKey'],
  organization = '901',
  title = moduleKey
): ModuleWorkbenchLoadInput {
  return {
    moduleKey,
    title,
    tenantConfig: createConfig(organization),
    webSession: createSession(organization, 'token-' + organization)
  }
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

function dependencies(
  overrides: Partial<ModuleWorkbenchLoadDependencies>
): ModuleWorkbenchLoadDependencies {
  const defaults = {
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
    fetchMomentsFeed: async () => ({ items: [], total: 0 })
  } as ModuleWorkbenchLoadDependencies
  return { ...defaults, ...overrides }
}

function recorder() {
  const successes: ModuleWorkbenchLoadResult[] = []
  const errors: unknown[] = []
  let loading = false
  let finishes = 0
  const callbacks: ModuleWorkbenchLoadCallbacks = {
    isContextCurrent() {
      return true
    },
    onStart() {
      loading = true
    },
    onSuccess(result) {
      successes.push(result)
    },
    onError(error) {
      errors.push(error)
    },
    onFinish() {
      loading = false
      finishes += 1
    }
  }
  return {
    callbacks,
    successes,
    errors,
    get loading() {
      return loading
    },
    get finishes() {
      return finishes
    }
  }
}

test('a module switch suppresses stale nested locale success and stale finally', async () => {
  const messages = deferred<{ locale: string; messages: Record<string, string> }>()
  const favorites = deferred<{
    items: []
    total: number
    page: number
    limit: number
  }>()
  let markMessagesStarted!: () => void
  const messagesStarted = new Promise<void>((resolve) => {
    markMessagesStarted = resolve
  })
  const coordinator = createModuleWorkbenchLoadCoordinator(dependencies({
    async fetchI18nLocales() {
      return [{ code: 'zh-CN', name: '简体中文', isDefault: true }]
    },
    fetchI18nMessages() {
      markMessagesStarted()
      return messages.promise
    },
    fetchFavorites() {
      return favorites.promise
    }
  }))
  const state = recorder()

  const staleRun = coordinator.run(input('i18n'), state.callbacks)
  await messagesStarted
  const currentRun = coordinator.run(input('favorite'), state.callbacks)
  messages.resolve({ locale: 'zh-CN', messages: { hello: '旧机构词条' } })
  await staleRun

  assert.deepEqual(state.successes, [])
  assert.deepEqual(state.errors, [])
  assert.equal(state.loading, true, '旧 finally 不得关闭新请求的 loading')
  assert.equal(state.finishes, 0)

  favorites.resolve({ items: [], total: 0, page: 1, limit: 20 })
  await currentRun
  assert.deepEqual(state.successes.map((result) => result.moduleKey), ['favorite'])
  assert.equal(state.loading, false)
  assert.equal(state.finishes, 1)
})

test('a concurrent refresh suppresses stale nested sticker failure while newer loading remains', async () => {
  const staleStickerItems = deferred<[]>()
  const currentStickerItems = deferred<[]>()
  let markStickerItemsStarted!: () => void
  const stickerItemsStarted = new Promise<void>((resolve) => {
    markStickerItemsStarted = resolve
  })
  let packRequest = 0
  const coordinator = createModuleWorkbenchLoadCoordinator(dependencies({
    async fetchStickerPacks() {
      packRequest += 1
      return [{
        id: packRequest,
        organization: 901,
        code: 'default',
        name: '默认',
        description: ''
      }]
    },
    fetchStickerItems(_config, _session, packId) {
      if (packId === 1) {
        markStickerItemsStarted()
        return staleStickerItems.promise
      }
      return currentStickerItems.promise
    }
  }))
  const state = recorder()

  const staleRun = coordinator.run(input('sticker'), state.callbacks)
  await stickerItemsStarted
  const currentRun = coordinator.run(input('sticker'), state.callbacks)
  staleStickerItems.reject(new Error('旧请求失败'))
  await staleRun

  assert.deepEqual(state.errors, [])
  assert.equal(state.loading, true)
  assert.equal(state.finishes, 0)

  currentStickerItems.resolve([])
  await currentRun
  assert.deepEqual(state.successes.map((result) => result.moduleKey), ['sticker'])
  assert.equal(state.loading, false)
})

test('dispose prevents pending success, failure, and finally writes after unmount', async () => {
  for (const outcome of ['success', 'failure'] as const) {
    const favorites = deferred<{
      items: []
      total: number
      page: number
      limit: number
    }>()
    const coordinator = createModuleWorkbenchLoadCoordinator(dependencies({
      fetchFavorites() {
        return favorites.promise
      }
    }))
    const state = recorder()
    const run = coordinator.run(input('favorite'), state.callbacks)
    coordinator.dispose()
    if (outcome === 'success') {
      favorites.resolve({ items: [], total: 0, page: 1, limit: 20 })
    } else {
      favorites.reject(new Error('卸载后的失败'))
    }
    await run

    assert.deepEqual(state.successes, [])
    assert.deepEqual(state.errors, [])
    assert.equal(state.finishes, 0)
  }
})

test('tenant config, session, title, and module are detached immutable request snapshots', async () => {
  const favorites = deferred<{
    items: []
    total: number
    page: number
    limit: number
  }>()
  let capturedConfig: TenantBrandConfig | undefined
  let capturedSession: WebImSession | undefined
  const original = input('favorite', '901', '旧收藏')
  const coordinator = createModuleWorkbenchLoadCoordinator(dependencies({
    fetchFavorites(config, session) {
      capturedConfig = config
      capturedSession = session
      return favorites.promise
    }
  }))
  const state = recorder()
  const run = coordinator.run(original, state.callbacks)

  original.moduleKey = 'moments'
  original.title = '新动态'
  original.tenantConfig.organization = '902'
  original.tenantConfig.serverInfo.apiServerUrl = 'https://evil.example.test'
  original.webSession.organization = '902'
  original.webSession.accessToken = 'token-902'

  assert.equal(capturedConfig?.organization, '901')
  assert.equal(capturedConfig?.serverInfo.apiServerUrl, 'https://api.example.test')
  assert.equal(capturedSession?.organization, '901')
  assert.equal(capturedSession?.accessToken, 'token-901')
  assert.equal(Object.isFrozen(capturedConfig), true)
  assert.equal(Object.isFrozen(capturedConfig?.serverInfo), true)
  assert.equal(Object.isFrozen(capturedSession), true)
  assert.throws(() => {
    if (capturedConfig) capturedConfig.organization = '999'
  }, TypeError)

  favorites.resolve({ items: [], total: 0, page: 1, limit: 20 })
  await run
  assert.deepEqual(state.successes.map((result) => result.moduleKey), ['favorite'])
})

test('live tenantConfig and webSession changes fail the context fence before watcher refresh', async () => {
  const favorites = deferred<{
    items: []
    total: number
    page: number
    limit: number
  }>()
  const live = input('favorite', '901', '收藏')
  const coordinator = createModuleWorkbenchLoadCoordinator(dependencies({
    fetchFavorites() {
      return favorites.promise
    }
  }))
  const state = recorder()
  const callbacks: ModuleWorkbenchLoadCallbacks = {
    ...state.callbacks,
    isContextCurrent(snapshot) {
      return isModuleWorkbenchLoadContextCurrent(snapshot, live)
    }
  }
  const run = coordinator.run(live, callbacks)

  live.tenantConfig.organization = '902'
  live.webSession.organization = '902'
  live.webSession.accessToken = 'token-902'
  favorites.resolve({ items: [], total: 0, page: 1, limit: 20 })
  await run

  assert.deepEqual(state.successes, [])
  assert.deepEqual(state.errors, [])
  assert.equal(state.loading, true, '上下文变化后的旧 finally 必须等待 watcher 的新请求接管')
  assert.equal(state.finishes, 0)
})

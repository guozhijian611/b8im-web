import type {
  fetchMyCsConversations,
  CustomerServiceConversation
} from '../services/customerService.ts'
import type { fetchFavorites, FavoriteItem } from '../services/favorite.ts'
import type {
  fetchFileMediaFolders,
  fetchFileMediaItems,
  fetchFileMediaUsage,
  FileMediaFolder,
  FileMediaItem,
  FileMediaUsage
} from '../services/fileMedia.ts'
import type {
  fetchI18nLocales,
  fetchI18nMessages,
  I18nLocaleItem
} from '../services/i18n.ts'
import type { fetchMomentsFeed, MomentsPost } from '../services/moments.ts'
import type { fetchRobots, RobotSingleItem } from '../services/robotSingle.ts'
import type {
  fetchStickerItems,
  fetchStickerPacks,
  StickerItem,
  StickerPack
} from '../services/sticker.ts'
import type { ClientModuleKey } from '../services/clientModuleRegistry.ts'
import type { TenantBrandConfig } from '../services/tenantConfig.ts'
import type { WebImSession } from '../types.ts'

export type ModuleWorkbenchKey = Exclude<ClientModuleKey, 'announcement'>

export const MODULE_WORKBENCH_LOAD_DEPENDENCIES_KEY =
  'b8im:module-workbench-load-dependencies'

export interface ModuleWorkbenchLoadInput {
  moduleKey: ModuleWorkbenchKey
  title: string
  tenantConfig: TenantBrandConfig
  webSession: WebImSession
}

export type ModuleWorkbenchLoadSnapshot = ModuleWorkbenchLoadInput

export interface ModuleWorkbenchLoadDependencies {
  fetchI18nLocales: typeof fetchI18nLocales
  fetchI18nMessages: typeof fetchI18nMessages
  fetchFavorites: typeof fetchFavorites
  fetchStickerPacks: typeof fetchStickerPacks
  fetchStickerItems: typeof fetchStickerItems
  fetchMyCsConversations: typeof fetchMyCsConversations
  fetchRobots: typeof fetchRobots
  fetchFileMediaUsage: typeof fetchFileMediaUsage
  fetchFileMediaFolders: typeof fetchFileMediaFolders
  fetchFileMediaItems: typeof fetchFileMediaItems
  fetchMomentsFeed: typeof fetchMomentsFeed
}

export type ModuleWorkbenchLoadResult =
  | {
      moduleKey: 'i18n'
      locales: I18nLocaleItem[]
      localeMessages: Record<string, string>
      selectedId: number
    }
  | { moduleKey: 'favorite'; favorites: FavoriteItem[] }
  | {
      moduleKey: 'sticker'
      stickerPacks: StickerPack[]
      stickerItems: StickerItem[]
      selectedId: number
    }
  | {
      moduleKey: 'customer_service'
      conversations: CustomerServiceConversation[]
    }
  | { moduleKey: 'robot_single'; robots: RobotSingleItem[]; selectedId: number }
  | {
      moduleKey: 'file_media'
      fileMediaUsage: FileMediaUsage
      folders: FileMediaFolder[]
      files: FileMediaItem[]
    }
  | { moduleKey: 'search' }
  | { moduleKey: 'moments'; moments: MomentsPost[] }

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
  return Object.freeze(value)
}

function immutableJsonClone<T>(value: T, label: string): T {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Error(label + ' 无法生成请求快照')
  return deepFreeze(JSON.parse(serialized) as T)
}

export function createModuleWorkbenchLoadSnapshot(
  input: ModuleWorkbenchLoadInput
): ModuleWorkbenchLoadSnapshot {
  return deepFreeze({
    moduleKey: input.moduleKey,
    title: input.title,
    tenantConfig: immutableJsonClone(input.tenantConfig, 'tenantConfig'),
    webSession: immutableJsonClone(input.webSession, 'webSession')
  })
}

export function isModuleWorkbenchLoadContextCurrent(
  snapshot: ModuleWorkbenchLoadSnapshot,
  current: ModuleWorkbenchLoadInput
): boolean {
  return (
    snapshot.moduleKey === current.moduleKey &&
    snapshot.title === current.title &&
    JSON.stringify(snapshot.tenantConfig) === JSON.stringify(current.tenantConfig) &&
    JSON.stringify(snapshot.webSession) === JSON.stringify(current.webSession)
  )
}

export async function loadModuleWorkbenchData(
  snapshot: ModuleWorkbenchLoadSnapshot,
  dependencies: ModuleWorkbenchLoadDependencies
): Promise<ModuleWorkbenchLoadResult> {
  const config = snapshot.tenantConfig
  const session = snapshot.webSession

  switch (snapshot.moduleKey) {
    case 'i18n': {
      const locales = await dependencies.fetchI18nLocales(config, session)
      const selected = locales.find((item) => item.isDefault) ?? locales[0]
      const localeMessages = selected
        ? (await dependencies.fetchI18nMessages(config, session, selected.code)).messages
        : {}
      return {
        moduleKey: 'i18n',
        locales,
        localeMessages,
        selectedId: selected ? locales.findIndex((item) => item.code === selected.code) + 1 : 0
      }
    }
    case 'favorite':
      return {
        moduleKey: 'favorite',
        favorites: (await dependencies.fetchFavorites(config, session)).items
      }
    case 'sticker': {
      const stickerPacks = await dependencies.fetchStickerPacks(config, session)
      const selected = stickerPacks[0]
      const stickerItems = selected
        ? await dependencies.fetchStickerItems(config, session, selected.id)
        : []
      return {
        moduleKey: 'sticker',
        stickerPacks,
        stickerItems,
        selectedId: selected?.id ?? 0
      }
    }
    case 'customer_service':
      return {
        moduleKey: 'customer_service',
        conversations: (await dependencies.fetchMyCsConversations(config, session)).items
      }
    case 'robot_single': {
      const robots = (await dependencies.fetchRobots(config, session)).items
      return { moduleKey: 'robot_single', robots, selectedId: robots[0]?.id ?? 0 }
    }
    case 'file_media': {
      const [fileMediaUsage, folders, files] = await Promise.all([
        dependencies.fetchFileMediaUsage(config, session),
        dependencies.fetchFileMediaFolders(config, session),
        dependencies.fetchFileMediaItems(config, session)
      ])
      return { moduleKey: 'file_media', fileMediaUsage, folders, files }
    }
    case 'search':
      return { moduleKey: 'search' }
    case 'moments':
      return {
        moduleKey: 'moments',
        moments: (await dependencies.fetchMomentsFeed(config, session)).items
      }
  }
}

export interface ModuleWorkbenchLoadCallbacks {
  isContextCurrent: (snapshot: ModuleWorkbenchLoadSnapshot) => boolean
  onStart: (snapshot: ModuleWorkbenchLoadSnapshot) => void
  onSuccess: (
    result: ModuleWorkbenchLoadResult,
    snapshot: ModuleWorkbenchLoadSnapshot
  ) => void
  onError: (error: unknown, snapshot: ModuleWorkbenchLoadSnapshot) => void
  onFinish: (snapshot: ModuleWorkbenchLoadSnapshot) => void
}

export interface ModuleWorkbenchLoadCoordinator {
  run: (input: ModuleWorkbenchLoadInput, callbacks: ModuleWorkbenchLoadCallbacks) => Promise<void>
  invalidate: () => void
  dispose: () => void
}

export function createModuleWorkbenchLoadCoordinator(
  dependencies: ModuleWorkbenchLoadDependencies
): ModuleWorkbenchLoadCoordinator {
  let generation = 0
  let disposed = false
  const current = (
    token: number,
    snapshot: ModuleWorkbenchLoadSnapshot,
    callbacks: ModuleWorkbenchLoadCallbacks
  ) => {
    if (disposed || token !== generation) return false
    try {
      return callbacks.isContextCurrent(snapshot)
    } catch {
      return false
    }
  }

  return {
    async run(input, callbacks) {
      if (disposed) return
      const token = ++generation
      const snapshot = createModuleWorkbenchLoadSnapshot(input)
      callbacks.onStart(snapshot)
      try {
        const result = await loadModuleWorkbenchData(snapshot, dependencies)
        if (current(token, snapshot, callbacks)) callbacks.onSuccess(result, snapshot)
      } catch (error) {
        if (current(token, snapshot, callbacks)) callbacks.onError(error, snapshot)
      } finally {
        if (current(token, snapshot, callbacks)) callbacks.onFinish(snapshot)
      }
    },
    invalidate() {
      generation += 1
    },
    dispose() {
      disposed = true
      generation += 1
    }
  }
}

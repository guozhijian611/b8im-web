export const CLIENT_MODULE_REGISTRY = {
  announcement: {
    moduleKey: 'announcement',
    title: '公告',
    route: '/announcements',
    permission: 'saimulti:web:announcement:index',
    capability: 'announcement.web.page'
  },
  i18n: {
    moduleKey: 'i18n',
    title: '语言',
    route: '/i18n',
    permission: 'saimulti:web:i18n:read',
    capability: 'i18n.web.page'
  },
  favorite: {
    moduleKey: 'favorite',
    title: '收藏',
    route: '/favorites',
    permission: 'saimulti:web:favorite:index',
    capability: 'favorite.web.page'
  },
  sticker: {
    moduleKey: 'sticker',
    title: '表情',
    route: '/stickers',
    permission: 'saimulti:web:sticker:read',
    capability: 'sticker.web.page'
  },
  customer_service: {
    moduleKey: 'customer_service',
    title: '在线客服',
    route: '/customer-service',
    permission: 'saimulti:web:customer_service:conversation',
    capability: 'customer_service.web.page'
  },
  robot_single: {
    moduleKey: 'robot_single',
    title: '机器人助手',
    route: '/robot-single',
    permission: 'saimulti:web:robot_single:use',
    capability: 'robot_single.web.page'
  },
  file_media: {
    moduleKey: 'file_media',
    title: '文件空间',
    route: '/file-media',
    permission: 'saimulti:web:file_media:use',
    capability: 'file_media.web.page'
  },
  search: {
    moduleKey: 'search',
    title: '消息搜索',
    route: '/search',
    permission: 'saimulti:web:search:use',
    capability: 'search.web.page'
  },
  moments: {
    moduleKey: 'moments',
    title: '朋友圈',
    route: '/moments',
    permission: 'saimulti:web:moments:use',
    capability: 'moments.web.page'
  }
} as const

export type ClientModuleKey = keyof typeof CLIENT_MODULE_REGISTRY

export interface ClientModuleProjection {
  moduleKey: ClientModuleKey
  version: string
  available: boolean
  capabilities: string[]
  permissions: string[]
  config: Record<string, unknown>
}

export interface ClientTabbarItem {
  moduleKey: ClientModuleKey
  title: string
}

export interface WebClientConfig {
  version: number
  organization: string
  deploymentId: string
  features: Partial<Record<ClientModuleKey, boolean>>
  modules: ClientModuleProjection[]
  tabbar: ClientTabbarItem[]
}

export interface ClientConfigContext {
  organization: string
  deploymentId: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function isClientModuleKey(value: string): value is ClientModuleKey {
  return Object.prototype.hasOwnProperty.call(CLIENT_MODULE_REGISTRY, value)
}

function readStringArray(value: unknown, field: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`客户端配置 ${field} 格式无效`)
  }
  return value.map((item) => item.trim()).filter(Boolean)
}

export function parseClientConfig(
  payload: unknown,
  context: ClientConfigContext
): WebClientConfig {
  if (!isRecord(payload)) throw new Error('客户端配置响应格式无效')

  const version = payload.version
  const organization = String(payload.organization ?? '')
  const deploymentId = String(payload.deployment_id ?? '')
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new Error('客户端配置 version 无效')
  }
  if (organization !== context.organization) {
    throw new Error('客户端配置 organization 与登录上下文不一致')
  }
  if (deploymentId !== context.deploymentId) {
    throw new Error('客户端配置 deployment_id 与发现上下文不一致')
  }

  if (!isRecord(payload.features)) throw new Error('客户端配置 features 格式无效')
  const features: Partial<Record<ClientModuleKey, boolean>> = {}
  Object.entries(payload.features).forEach(([key, value]) => {
    if (!isClientModuleKey(key)) return
    if (typeof value !== 'boolean') throw new Error(`客户端配置 features.${key} 格式无效`)
    features[key] = value
  })

  if (!Array.isArray(payload.modules)) throw new Error('客户端配置 modules 格式无效')
  const modules: ClientModuleProjection[] = []
  const seenModules = new Set<ClientModuleKey>()
  payload.modules.forEach((item) => {
    if (!isRecord(item)) throw new Error('客户端配置 modules 项格式无效')
    const moduleKey = String(item.module_key ?? '')
    if (!isClientModuleKey(moduleKey)) return
    if (seenModules.has(moduleKey)) throw new Error(`客户端配置 modules 含重复模块: ${moduleKey}`)
    if (typeof item.version !== 'string' || !item.version.trim()) {
      throw new Error(`客户端配置 modules.${moduleKey}.version 无效`)
    }
    if (typeof item.available !== 'boolean' || !isRecord(item.config)) {
      throw new Error(`客户端配置 modules.${moduleKey} 格式无效`)
    }
    modules.push({
      moduleKey,
      version: item.version.trim(),
      available: item.available,
      capabilities: readStringArray(item.capabilities, `modules.${moduleKey}.capabilities`),
      permissions: readStringArray(item.permissions, `modules.${moduleKey}.permissions`),
      config: { ...item.config }
    })
    seenModules.add(moduleKey)
  })

  if (!Array.isArray(payload.tabbar)) throw new Error('客户端配置 tabbar 格式无效')
  const tabbar: ClientTabbarItem[] = []
  const seenTabbar = new Set<ClientModuleKey>()
  payload.tabbar.forEach((item) => {
    if (!isRecord(item)) throw new Error('客户端配置 tabbar 项格式无效')
    const moduleKey = String(item.module_key ?? '')
    if (!isClientModuleKey(moduleKey)) return
    if (seenTabbar.has(moduleKey)) throw new Error(`客户端配置 tabbar 含重复模块: ${moduleKey}`)
    if (typeof item.title !== 'string' || !item.title.trim()) {
      throw new Error(`客户端配置 tabbar.${moduleKey}.title 无效`)
    }
    tabbar.push({ moduleKey, title: item.title.trim() })
    seenTabbar.add(moduleKey)
  })

  return { version, organization, deploymentId, features, modules, tabbar }
}

export function clientModuleConfig(
  config: WebClientConfig | null,
  moduleKey: ClientModuleKey
): Record<string, unknown> {
  return config?.modules.find((item) => item.moduleKey === moduleKey)?.config ?? {}
}

export function isClientModuleAvailable(
  config: WebClientConfig | null,
  moduleKey: ClientModuleKey
) {
  if (!config || config.features[moduleKey] !== true) return false
  const registration = CLIENT_MODULE_REGISTRY[moduleKey]
  const projection = config.modules.find((item) => item.moduleKey === moduleKey)
  return Boolean(
    projection?.available &&
    projection.capabilities.includes(registration.capability) &&
    projection.permissions.includes(registration.permission) &&
    config.tabbar.some((item) => item.moduleKey === moduleKey)
  )
}

export function availableClientTabbar(config: WebClientConfig | null) {
  if (!config) return []
  return config.tabbar.filter((item) => isClientModuleAvailable(config, item.moduleKey))
}

export function clientModuleTitle(config: WebClientConfig | null, moduleKey: ClientModuleKey) {
  return config?.tabbar.find((item) => item.moduleKey === moduleKey)?.title ||
    CLIENT_MODULE_REGISTRY[moduleKey].title
}

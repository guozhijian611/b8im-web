import { API_PATHS } from '../config/apiPaths'
import { requestWebApi } from './apiClient'
import type { TenantBrandConfig } from './tenantConfig'
import type { WebImSession } from '../types'

export const CLIENT_MODULE_REGISTRY = {
  announcement: {
    moduleKey: 'announcement',
    title: '公告',
    route: '/announcements',
    permission: 'saimulti:web:announcement:index',
    capability: 'announcement.web.page'
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isKnownModuleKey(value: string): value is ClientModuleKey {
  return Object.prototype.hasOwnProperty.call(CLIENT_MODULE_REGISTRY, value)
}

function readStringArray(value: unknown) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null
  return value.map((item) => item.trim()).filter(Boolean)
}

function parseClientConfig(
  payload: unknown,
  tenantConfig: TenantBrandConfig
): WebClientConfig {
  if (!isRecord(payload)) throw new Error('客户端配置响应格式无效')

  const version = payload.version
  const organization = String(payload.organization ?? '')
  const deploymentId = String(payload.deployment_id ?? '')
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new Error('客户端配置 version 无效')
  }
  if (organization !== tenantConfig.organization) {
    throw new Error('客户端配置 organization 与登录上下文不一致')
  }
  if (deploymentId !== tenantConfig.deploymentId) {
    throw new Error('客户端配置 deployment_id 与发现上下文不一致')
  }

  const features: Partial<Record<ClientModuleKey, boolean>> = {}
  if (!isRecord(payload.features)) throw new Error('客户端配置 features 格式无效')
  Object.entries(payload.features).forEach(([key, value]) => {
    if (!isKnownModuleKey(key)) {
      console.warn(`[b8im] ignore unknown feature: ${key}`)
      return
    }
    if (typeof value !== 'boolean') throw new Error(`客户端配置 features.${key} 格式无效`)
    features[key] = value
  })

  if (!Array.isArray(payload.modules)) throw new Error('客户端配置 modules 格式无效')
  const modules: ClientModuleProjection[] = []
  const seenModules = new Set<ClientModuleKey>()
  payload.modules.forEach((item) => {
    if (!isRecord(item)) {
      console.warn('[b8im] ignore malformed module projection')
      return
    }
    const moduleKey = String(item.module_key ?? '')
    if (!isKnownModuleKey(moduleKey)) {
      console.warn(`[b8im] ignore unknown module: ${moduleKey || '<empty>'}`)
      return
    }
    if (seenModules.has(moduleKey)) {
      throw new Error(`客户端配置 modules 含重复模块: ${moduleKey}`)
    }
    const capabilities = readStringArray(item.capabilities)
    const permissions = readStringArray(item.permissions)
    const config = item.config
    if (
      typeof item.version !== 'string' ||
      !item.version.trim() ||
      typeof item.available !== 'boolean' ||
      !capabilities ||
      !permissions ||
      !isRecord(config)
    ) {
      console.warn(`[b8im] ignore malformed module projection: ${moduleKey}`)
      return
    }
    modules.push({
      moduleKey,
      version: item.version.trim(),
      available: item.available,
      capabilities,
      permissions,
      config: { ...config }
    })
    seenModules.add(moduleKey)
  })

  const tabbar: ClientTabbarItem[] = []
  if (!Array.isArray(payload.tabbar)) throw new Error('客户端配置 tabbar 格式无效')
  payload.tabbar.forEach((item) => {
    if (!isRecord(item)) return
    const moduleKey = String(item.module_key ?? '')
    if (!isKnownModuleKey(moduleKey)) {
      console.warn(`[b8im] ignore unknown tabbar module: ${moduleKey || '<empty>'}`)
      return
    }
    const title = typeof item.title === 'string' ? item.title.trim() : ''
    tabbar.push({ moduleKey, title: title || CLIENT_MODULE_REGISTRY[moduleKey].title })
  })

  return { version, organization, deploymentId, features, modules, tabbar }
}

export function clientModuleConfig(
  config: WebClientConfig | null,
  moduleKey: ClientModuleKey
): Record<string, unknown> {
  return config?.modules.find((item) => item.moduleKey === moduleKey)?.config ?? {}
}

export async function fetchWebClientConfig(
  tenantConfig: TenantBrandConfig,
  session: WebImSession
) {
  const payload = await requestWebApi<unknown>(tenantConfig, API_PATHS.clientConfig, {
    token: session.accessToken,
    query: { client_family: 'web' }
  })
  return parseClientConfig(payload, tenantConfig)
}

export function isClientModuleAvailable(
  config: WebClientConfig | null,
  moduleKey: ClientModuleKey
) {
  if (!config) return false
  const registration = CLIENT_MODULE_REGISTRY[moduleKey]
  const projection = config.modules.find((item) => item.moduleKey === moduleKey)
  if (
    !projection?.available ||
    !projection.capabilities.includes(registration.capability) ||
    !projection.permissions.includes(registration.permission)
  ) return false
  return config.features[moduleKey] !== false
}

export function clientModuleTitle(config: WebClientConfig | null, moduleKey: ClientModuleKey) {
  return config?.tabbar.find((item) => item.moduleKey === moduleKey)?.title ||
    CLIENT_MODULE_REGISTRY[moduleKey].title
}

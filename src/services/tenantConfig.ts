import { API_PATHS } from '../config/apiPaths'
import {
  parseRoutingPublicKeys,
  parseRoutingServerInfo,
  verifyRoutingSignature,
  type RoutingServerInfo,
  type RoutingSignature
} from './routing'

export interface AppDownloadLink {
  label: string
  url: string
  platform: 'ios' | 'android'
}

export type TenantServerInfo = RoutingServerInfo

export interface LegalAgreement {
  title: string
  content: string
}

export type TenantDiscoveryMode = 'domain' | 'enterprise_code'

export interface TenantBrandConfig {
  organization: string
  deploymentId: string
  enterpriseCode: string
  clientFamily: 'web'
  configVersion: number
  updatedAt: string
  mode: TenantDiscoveryMode
  domain: string
  siteName: string
  logoUrl: string
  faviconUrl: string
  logoText: string
  icp: string
  publicSecurityRecordNo: string
  publicSecurityRecordUrl: string
  copyright: string
  serverInfo: TenantServerInfo
  routingSignature: RoutingSignature | null
  agreements: {
    userAgreement: LegalAgreement
    privacyPolicy: LegalAgreement
  }
  appDownloads: AppDownloadLink[]
  discovered: boolean
}

interface AppInfoEnvelope {
  code: number
  message?: string
  data?: unknown
}

const env = import.meta.env
const PUBLIC_SECURITY_RECORD_SEARCH_URL = 'https://beian.mps.gov.cn/#/query/webSearch'
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const DISCOVERY_TIMEOUT_MS = 8000
const ENTERPRISE_CODE_STORAGE_PREFIX = 'b8im:enterprise-code:'

function envValue(key: keyof ImportMetaEnv) {
  return String(env[key] ?? '').trim()
}

function readRequiredString(data: Record<string, unknown>, key: string) {
  const value = data[key]
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim()) {
    throw new Error(`企业信息缺少 ${key}`)
  }
  return String(value).trim()
}

function readOptionalString(data: Record<string, unknown>, key: string) {
  const value = data[key]
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}

function readObject(data: Record<string, unknown>, key: string) {
  const value = data[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

function readAgreement(data: Record<string, unknown>, key: string, title: string): LegalAgreement {
  const value = readObject(data, key)
  return {
    title: readOptionalString(value, 'title') || title,
    content: readOptionalString(value, 'content')
  }
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, '')
}

function normalizeHost(value: string) {
  return value.trim().toLowerCase()
}

export function normalizeEnterpriseCode(value: string) {
  const normalized = value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(normalized)) {
    throw new Error('企业码格式无效')
  }
  return normalized
}

function assertDeploymentId(value: string) {
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(value)) {
    throw new Error('企业信息 deployment_id 格式无效')
  }
  return value
}

function assertOrganization(value: string) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    throw new Error('企业信息 organization 格式无效')
  }
  return value
}

function assertHighestRoutingVersion(deploymentId: string, organization: number, routingVersion: number) {
  const key = `b8im:routing-version:${deploymentId}:${organization}:web`
  let previous = 0
  try {
    previous = Number(window.localStorage.getItem(key) || 0)
  } catch {
    previous = 0
  }
  if (Number.isSafeInteger(previous) && previous > routingVersion) {
    throw new Error('检测到旧线路配置回放，已拒绝加载')
  }
  try {
    window.localStorage.setItem(key, String(Math.max(previous, routingVersion)))
  } catch {
    // 浏览器禁用 localStorage 时，本次签名和有效期校验仍然成立。
  }
}

function assertServerUrl(
  value: string,
  field: string,
  kind: 'http' | 'websocket',
  required: boolean,
  allowQuery = false
) {
  if (!value) {
    if (required) throw new Error(`企业信息缺少 server_info.${field}`)
    return ''
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`server_info.${field} 不是有效 URL`)
  }

  if (!url.hostname || url.username || url.password || url.hash) {
    throw new Error(`server_info.${field} 主机或凭据无效`)
  }

  const local = LOCAL_HOSTS.has(url.hostname.toLowerCase())
  const allowed = kind === 'http'
    ? url.protocol === 'https:' || (local && url.protocol === 'http:')
    : url.protocol === 'wss:' || (local && url.protocol === 'ws:')

  if (!allowed) {
    throw new Error(`server_info.${field} 必须使用安全协议`)
  }

  if ((!allowQuery && url.search) || (kind === 'websocket' && url.search)) {
    throw new Error(`server_info.${field} 不允许包含查询参数或片段`)
  }

  return normalizeBaseUrl(url.toString())
}

function normalizeDownloadUrl(value: string, platform: AppDownloadLink['platform']) {
  if (!value) return null
  return {
    label: platform === 'ios' ? 'iOS 下载' : 'Android 下载',
    platform,
    url: assertServerUrl(value, `download.${platform}`, 'http', false, true)
  } satisfies AppDownloadLink
}

function normalizeOptionalResourceUrl(value: string, field: string) {
  return value ? assertServerUrl(value, field, 'http', false, true) : ''
}

function platformDefaultHosts() {
  return new Set(
    envValue('VITE_PLATFORM_DEFAULT_HOSTS')
      .split(',')
      .map(normalizeHost)
      .filter(Boolean)
  )
}

function defaultMode(): TenantDiscoveryMode {
  if (platformDefaultHosts().has(normalizeHost(window.location.hostname))) {
    return 'enterprise_code'
  }
  const value = envValue('VITE_APP_MODE') || 'domain'
  if (value !== 'domain' && value !== 'enterprise_code') {
    throw new Error('VITE_APP_MODE 只能是 domain 或 enterprise_code')
  }
  return value
}

function discoveryBaseUrl() {
  const configured = envValue('VITE_DISCOVERY_BASE_URL')
  if (!configured) return window.location.origin
  return assertServerUrl(configured, 'discovery_base_url', 'http', true)
}

function discoveryPath() {
  const configured = envValue('VITE_APP_INFO_PATH') || API_PATHS.appInfo
  if (!configured.startsWith('/') || configured.startsWith('//')) {
    throw new Error('VITE_APP_INFO_PATH 必须是站内绝对路径')
  }
  return configured
}

function queryEnterpriseCode() {
  const searchParams = new URLSearchParams(window.location.search)
  return (searchParams.get('enterprise_code') || '').trim()
}

function enterpriseCodeStorageKey() {
  return `${ENTERPRISE_CODE_STORAGE_PREFIX}${normalizeHost(window.location.hostname)}`
}

function cachedEnterpriseCode() {
  try {
    const value = window.localStorage.getItem(enterpriseCodeStorageKey()) || ''
    return value ? normalizeEnterpriseCode(value) : ''
  } catch {
    try {
      window.localStorage.removeItem(enterpriseCodeStorageKey())
    } catch {
      // localStorage 不可用时保持无缓存启动。
    }
    return ''
  }
}

function initialEnterpriseCode(mode: TenantDiscoveryMode) {
  if (mode !== 'enterprise_code') return ''
  return queryEnterpriseCode() || cachedEnterpriseCode()
}

function cacheEnterpriseCode(enterpriseCode: string) {
  try {
    window.localStorage.setItem(enterpriseCodeStorageKey(), normalizeEnterpriseCode(enterpriseCode))
  } catch {
    // 浏览器禁用 localStorage 时不影响本次已验签的发现结果。
  }
}

export function createUndiscoveredTenantConfig(): TenantBrandConfig {
  const mode = defaultMode()
  return {
    organization: '',
    deploymentId: '',
    enterpriseCode: initialEnterpriseCode(mode),
    clientFamily: 'web',
    configVersion: 0,
    updatedAt: '',
    mode,
    domain: normalizeHost(window.location.hostname),
    siteName: envValue('VITE_WEB_DEFAULT_NAME') || 'b8im',
    logoUrl: '',
    faviconUrl: '',
    logoText: envValue('VITE_WEB_DEFAULT_LOGO_TEXT') || 'b8',
    icp: '',
    publicSecurityRecordNo: '',
    publicSecurityRecordUrl: '',
    copyright: envValue('VITE_WEB_DEFAULT_COPYRIGHT') || 'Copyright © 2026 b8im',
    serverInfo: {
      schemaVersion: 2,
      routePoolId: '',
      routePoolVersion: 0,
      routingVersion: 0,
      issuedAt: '',
      expiresAt: '',
      staleIfErrorUntil: '',
      policy: {
        mode: 'single',
        primaryRouteId: '',
        backupRouteIds: [],
        switchCooldownSeconds: 0,
        connectTimeoutMs: 5000
      },
      routes: [],
      webServerUrl: '',
      apiServerUrl: '',
      imServerUrl: '',
      uploadServerUrl: ''
    },
    routingSignature: null,
    agreements: {
      userAgreement: { title: '用户协议', content: '' },
      privacyPolicy: { title: '隐私政策', content: '' }
    },
    appDownloads: [],
    discovered: false
  }
}

async function mapAppInfo(data: Record<string, unknown>, mode: TenantDiscoveryMode): Promise<TenantBrandConfig> {
  const serverInfo = readObject(data, 'server_info')
  const agreements = readObject(data, 'agreements')
  const download = readObject(data, 'download')
  const siteName = readRequiredString(data, 'site_name')
  const configVersion = data.config_version
  if (typeof configVersion !== 'number' || !Number.isInteger(configVersion) || configVersion < 1) {
    throw new Error('企业信息 config_version 格式无效')
  }
  const publicSecurityRecordNo = readOptionalString(data, 'public_security_record_no')
  const iosDownload = normalizeDownloadUrl(readOptionalString(download, 'ios'), 'ios')
  const androidDownload = normalizeDownloadUrl(readOptionalString(download, 'android'), 'android')
  const organizationValue = data.organization
  if (typeof organizationValue !== 'number' || !Number.isSafeInteger(organizationValue) || organizationValue <= 0) {
    throw new Error('企业信息 organization 格式无效')
  }
  const deploymentId = assertDeploymentId(readRequiredString(data, 'deployment_id'))
  const enterpriseCode = normalizeEnterpriseCode(readRequiredString(data, 'enterprise_code'))
  if (data.client_family !== 'web') throw new Error('企业信息 client_family 与 Web 请求不一致')
  const trustedKeys = parseRoutingPublicKeys(envValue('VITE_ROUTING_PUBLIC_KEYS'))
  const routingSignature = await verifyRoutingSignature(
    {
      organization: organizationValue,
      deployment_id: deploymentId,
      enterprise_code: enterpriseCode,
      client_family: 'web',
      server_info: serverInfo
    },
    data.routing_signature,
    trustedKeys
  )
  const routingServerInfo = parseRoutingServerInfo(serverInfo, deploymentId, assertServerUrl)
  assertHighestRoutingVersion(deploymentId, organizationValue, routingServerInfo.routingVersion)

  return {
    organization: assertOrganization(String(organizationValue)),
    deploymentId,
    enterpriseCode,
    clientFamily: 'web',
    configVersion,
    updatedAt: (() => {
      const value = readRequiredString(data, 'updated_at')
      if (Number.isNaN(Date.parse(value))) throw new Error('企业信息 updated_at 格式无效')
      return value
    })(),
    mode,
    domain: normalizeHost(window.location.hostname),
    siteName,
    logoUrl: normalizeOptionalResourceUrl(readOptionalString(data, 'logo'), 'logo'),
    faviconUrl: normalizeOptionalResourceUrl(readOptionalString(data, 'favicon'), 'favicon'),
    logoText: siteName.slice(0, 2) || 'b8',
    icp: readOptionalString(data, 'icp'),
    publicSecurityRecordNo,
    publicSecurityRecordUrl: normalizeOptionalResourceUrl(
      readOptionalString(data, 'public_security_record_url') ||
        (publicSecurityRecordNo ? PUBLIC_SECURITY_RECORD_SEARCH_URL : ''),
      'public_security_record_url'
    ),
    copyright: readOptionalString(data, 'copyright') || `Copyright © ${new Date().getFullYear()} ${siteName}`,
    serverInfo: routingServerInfo,
    routingSignature,
    agreements: {
      userAgreement: readAgreement(agreements, 'user_agreement', '用户协议'),
      privacyPolicy: readAgreement(agreements, 'privacy_policy', '隐私政策')
    },
    appDownloads: [iosDownload, androidDownload].filter(
      (item): item is AppDownloadLink => item !== null
    ),
    discovered: true
  }
}

function discoveryUrl(mode: TenantDiscoveryMode, enterpriseCode = '') {
  const url = new URL(discoveryPath(), discoveryBaseUrl())
  url.searchParams.set('client_family', 'web')
  if (mode === 'domain') {
    url.searchParams.set('mode', 'domain')
    url.searchParams.set('domain', normalizeHost(window.location.hostname))
  } else {
    const code = normalizeEnterpriseCode(enterpriseCode)
    url.searchParams.set('enterprise_code', code)
  }
  return url
}

export async function resolveTenantConfig(
  enterpriseCode = '',
  externalSignal?: AbortSignal
): Promise<TenantBrandConfig> {
  const mode = defaultMode()
  const url = discoveryUrl(mode, enterpriseCode || queryEnterpriseCode())
  const controller = new AbortController()
  const relayAbort = () => controller.abort()
  externalSignal?.addEventListener('abort', relayAbort, { once: true })
  const timeout = window.setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal
    })
  } catch (error) {
    if (controller.signal.aborted && !externalSignal?.aborted) {
      throw new Error('企业信息请求超时，请检查发现服务')
    }
    throw error
  } finally {
    window.clearTimeout(timeout)
    externalSignal?.removeEventListener('abort', relayAbort)
  }

  const payload = (await response.json().catch(() => null)) as AppInfoEnvelope | null
  if (!response.ok || !payload || payload.code !== 200) {
    throw new Error(payload?.message || `企业信息请求失败：${response.status}`)
  }
  if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
    throw new Error('企业信息响应格式无效')
  }

  const config = await mapAppInfo(payload.data as Record<string, unknown>, mode)
  if (
    mode === 'enterprise_code' &&
    config.enterpriseCode !== normalizeEnterpriseCode(enterpriseCode || queryEnterpriseCode())
  ) {
    throw new Error('企业信息 enterprise_code 与发现请求不一致')
  }
  if (mode === 'enterprise_code') cacheEnterpriseCode(config.enterpriseCode)
  console.info('[b8im] tenant discovered', {
    organization: config.organization,
    deploymentId: config.deploymentId,
    enterpriseCode: config.enterpriseCode,
    apiHost: new URL(config.serverInfo.apiServerUrl).host,
    imHost: new URL(config.serverInfo.imServerUrl).host
  })
  return config
}

export const createTextFavicon = (text: string, background = '#25c06d') => {
  const safeText = encodeURIComponent((text || 'b8').slice(0, 2))
  const safeBackground = encodeURIComponent(background)
  return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='12' fill='${safeBackground}'/%3E%3Ctext x='32' y='40' text-anchor='middle' font-size='24' font-family='Arial,sans-serif' font-weight='700' fill='white'%3E${safeText}%3C/text%3E%3C/svg%3E`
}

export function applyDocumentBrand(config: TenantBrandConfig, title: string) {
  document.title = title
  const favicon = config.faviconUrl || config.logoUrl || createTextFavicon(config.logoText || config.siteName)
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.appendChild(link)
  }
  link.id = 'app-favicon'
  link.href = favicon
  if (favicon.startsWith('data:image/svg+xml')) link.type = 'image/svg+xml'
  else link.removeAttribute('type')
}

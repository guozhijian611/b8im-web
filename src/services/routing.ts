export type RoutingMode = 'single' | 'primary_backup'
export type RoutingService = 'api' | 'im' | 'upload' | 'web'

export interface RoutingEndpoints {
  apiServerUrl: string
  imServerUrl: string
  uploadServerUrl: string
  webServerUrl: string
}

export interface RoutingRoute {
  routeId: string
  routeVersion: number
  name: string
  priority: number
  weight: number
  region: string
  carrier: string
  deploymentId: string
  endpoints: RoutingEndpoints
}

export interface RoutingPolicy {
  mode: RoutingMode
  primaryRouteId: string
  backupRouteIds: string[]
  switchCooldownSeconds: number
  connectTimeoutMs: number
}

export interface RoutingServerInfo {
  schemaVersion: 2
  routePoolId: string
  routePoolVersion: number
  routingVersion: number
  issuedAt: string
  expiresAt: string
  staleIfErrorUntil: string
  policy: RoutingPolicy
  routes: RoutingRoute[]
  apiServerUrl: string
  imServerUrl: string
  uploadServerUrl: string
  webServerUrl: string
}

export interface RoutingSignature {
  alg: 'Ed25519'
  kid: string
  canonicalization: 'JCS-RFC8785'
  value: string
}

const runtimeRouteIndexes = new Map<string, number>()

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} 格式无效`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 格式无效`)
  return value.trim()
}

function integer(value: unknown, field: string, min = 1) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new Error(`${field} 格式无效`)
  }
  return value
}

function routeSlug(value: unknown, field: string) {
  const normalized = string(value, field)
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(normalized)) throw new Error(`${field} 格式无效`)
  return normalized
}

function date(value: unknown, field: string) {
  const normalized = string(value, field)
  if (Number.isNaN(Date.parse(normalized))) throw new Error(`${field} 格式无效`)
  return normalized
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

export function parseRoutingPublicKeys(value: string): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('VITE_ROUTING_PUBLIC_KEYS 必须是 JSON 对象')
  }
  const keys = object(parsed, 'VITE_ROUTING_PUBLIC_KEYS')
  for (const [kid, key] of Object.entries(keys)) {
    routeSlug(kid, 'routing key kid')
    if (typeof key !== 'string' || decodeBase64Url(key).length !== 32) {
      throw new Error(`线路签名公钥 ${kid} 无效`)
    }
  }
  if (Object.keys(keys).length === 0) throw new Error('VITE_ROUTING_PUBLIC_KEYS 不能为空')
  return keys as Record<string, string>
}

export async function verifyRoutingSignature(
  payload: Record<string, unknown>,
  signatureValue: unknown,
  trustedKeys: Record<string, string>
): Promise<RoutingSignature> {
  const signature = object(signatureValue, 'routing_signature')
  const alg = string(signature.alg, 'routing_signature.alg')
  const kid = routeSlug(signature.kid, 'routing_signature.kid')
  const canonicalization = string(signature.canonicalization, 'routing_signature.canonicalization')
  const value = string(signature.value, 'routing_signature.value')
  if (alg !== 'Ed25519' || canonicalization !== 'JCS-RFC8785') {
    throw new Error('线路签名算法或规范不受信任')
  }
  const encodedKey = trustedKeys[kid]
  if (!encodedKey) throw new Error(`线路签名密钥 ${kid} 不受信任`)
  const key = await crypto.subtle.importKey('raw', decodeBase64Url(encodedKey), 'Ed25519', false, ['verify'])
  const valid = await crypto.subtle.verify(
    'Ed25519',
    key,
    decodeBase64Url(value),
    new TextEncoder().encode(canonicalJson(payload))
  )
  if (!valid) throw new Error('线路配置签名验证失败')
  return { alg: 'Ed25519', kid, canonicalization: 'JCS-RFC8785', value }
}

export function parseRoutingServerInfo(
  value: unknown,
  deploymentId: string,
  assertUrl: (value: string, field: string, kind: 'http' | 'websocket', required: boolean) => string
): RoutingServerInfo {
  const info = object(value, 'server_info')
  if (info.schema_version !== 2) throw new Error('server_info.schema_version 必须为 2')
  const routePoolId = routeSlug(info.route_pool_id, 'server_info.route_pool_id')
  const routePoolVersion = integer(info.route_pool_version, 'server_info.route_pool_version')
  const routingVersion = integer(info.routing_version, 'server_info.routing_version')
  date(info.server_time, 'server_info.server_time')
  const issuedAt = date(info.issued_at, 'server_info.issued_at')
  const expiresAt = date(info.expires_at, 'server_info.expires_at')
  const staleIfErrorUntil = date(info.stale_if_error_until, 'server_info.stale_if_error_until')
  if (Date.parse(expiresAt) <= Date.now()) throw new Error('线路配置已经过期，请重新发现')
  if (Date.parse(staleIfErrorUntil) < Date.parse(expiresAt) || Date.parse(issuedAt) >= Date.parse(expiresAt)) {
    throw new Error('线路配置有效期无效')
  }

  const rawPolicy = object(info.policy, 'server_info.policy')
  const mode = string(rawPolicy.mode, 'server_info.policy.mode')
  if (mode !== 'single' && mode !== 'primary_backup') throw new Error('当前客户端不支持该线路策略')
  if (rawPolicy.route_bundle_required !== true || rawPolicy.failover_scope !== 'service') {
    throw new Error('线路 bundle 或切换范围无效')
  }
  const primaryRouteId = routeSlug(rawPolicy.primary_route_id, 'server_info.policy.primary_route_id')
  const backupRouteIds = Array.isArray(rawPolicy.backup_route_ids)
    ? rawPolicy.backup_route_ids.map((routeId) => routeSlug(routeId, 'server_info.policy.backup_route_ids'))
    : (() => { throw new Error('server_info.policy.backup_route_ids 格式无效') })()
  if (mode === 'single' && backupRouteIds.length !== 0) throw new Error('single 模式不能包含备线')
  if (mode === 'primary_backup' && backupRouteIds.length === 0) throw new Error('primary_backup 缺少备线')

  if (!Array.isArray(info.routes) || info.routes.length === 0) throw new Error('server_info.routes 不能为空')
  const seen = new Set<string>()
  const routes = info.routes.map((raw, index): RoutingRoute => {
    const route = object(raw, `server_info.routes[${index}]`)
    const routeId = routeSlug(route.route_id, `server_info.routes[${index}].route_id`)
    if (seen.has(routeId)) throw new Error('server_info.routes route_id 重复')
    seen.add(routeId)
    const routeDeploymentId = string(route.deployment_id, `server_info.routes[${index}].deployment_id`)
    if (routeDeploymentId !== deploymentId) throw new Error('线路 deployment_id 与发现上下文不一致')
    const endpoints = object(route.endpoints, `server_info.routes[${index}].endpoints`)
    return {
      routeId,
      routeVersion: integer(route.route_version, `server_info.routes[${index}].route_version`),
      name: string(route.name, `server_info.routes[${index}].name`),
      priority: integer(route.priority, `server_info.routes[${index}].priority`),
      weight: integer(route.weight, `server_info.routes[${index}].weight`),
      region: typeof route.region === 'string' ? route.region : '',
      carrier: typeof route.carrier === 'string' ? route.carrier : '',
      deploymentId: routeDeploymentId,
      endpoints: {
        apiServerUrl: assertUrl(string(endpoints.api_server_url, 'api_server_url'), 'api_server_url', 'http', true),
        imServerUrl: assertUrl(string(endpoints.im_server_url, 'im_server_url'), 'im_server_url', 'websocket', true),
        uploadServerUrl: assertUrl(string(endpoints.upload_server_url, 'upload_server_url'), 'upload_server_url', 'http', true),
        webServerUrl: assertUrl(string(endpoints.web_server_url, 'web_server_url'), 'web_server_url', 'http', true)
      }
    }
  })
  const byId = new Map(routes.map((route) => [route.routeId, route]))
  if (!byId.has(primaryRouteId) || backupRouteIds.some((routeId) => !byId.has(routeId))) {
    throw new Error('线路策略引用了不存在的 route_id')
  }
  const ordered = [primaryRouteId, ...backupRouteIds]
    .map((routeId) => byId.get(routeId)!)
    .filter(Boolean)
  const primary = ordered[0]
  return {
    schemaVersion: 2,
    routePoolId,
    routePoolVersion,
    routingVersion,
    issuedAt,
    expiresAt,
    staleIfErrorUntil,
    policy: {
      mode,
      primaryRouteId,
      backupRouteIds,
      switchCooldownSeconds: integer(rawPolicy.switch_cooldown_seconds, 'switch_cooldown_seconds', 0),
      connectTimeoutMs: integer(rawPolicy.connect_timeout_ms, 'connect_timeout_ms')
    },
    routes: ordered,
    apiServerUrl: primary.endpoints.apiServerUrl,
    imServerUrl: primary.endpoints.imServerUrl,
    uploadServerUrl: primary.endpoints.uploadServerUrl,
    webServerUrl: primary.endpoints.webServerUrl
  }
}

function runtimeKey(config: { organization: string; serverInfo: RoutingServerInfo }, service: RoutingService) {
  return `${config.organization}:${config.serverInfo.routingVersion}:${service}`
}

export function serviceCandidates(
  config: { organization: string; serverInfo: RoutingServerInfo },
  service: RoutingService
) {
  const field = `${service}ServerUrl` as keyof RoutingEndpoints
  return config.serverInfo.routes.map((route) => ({ routeId: route.routeId, url: route.endpoints[field] }))
}

export function activeServiceCandidate(
  config: { organization: string; serverInfo: RoutingServerInfo },
  service: RoutingService
) {
  const candidates = serviceCandidates(config, service)
  if (candidates.length === 0) throw new Error(`没有可用的 ${service} 线路`)
  const index = runtimeRouteIndexes.get(runtimeKey(config, service)) ?? 0
  return candidates[index % candidates.length]
}

export function promoteServiceCandidate(
  config: { organization: string; serverInfo: RoutingServerInfo },
  service: RoutingService,
  failedRouteId: string
) {
  const candidates = serviceCandidates(config, service)
  if (candidates.length < 2) return activeServiceCandidate(config, service)
  const failedIndex = candidates.findIndex((candidate) => candidate.routeId === failedRouteId)
  const nextIndex = (Math.max(0, failedIndex) + 1) % candidates.length
  runtimeRouteIndexes.set(runtimeKey(config, service), nextIndex)
  return candidates[nextIndex]
}

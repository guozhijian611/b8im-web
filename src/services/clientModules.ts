import { API_PATHS } from '../config/apiPaths'
import { requestWebApi } from './apiClient'
import type { TenantBrandConfig } from './tenantConfig'
import type { WebImSession } from '../types'
import { parseClientConfig } from './clientModuleRegistry'

export * from './clientModuleRegistry'

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

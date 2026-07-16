import { API_PATHS } from '../config/apiPaths'
import { requestWebApi } from './apiClient'
import type { TenantBrandConfig } from './tenantConfig'
import type { WebImSession } from '../types'

export async function fetchMyCsConversations(
  config: TenantBrandConfig,
  session: WebImSession,
  query: Record<string, string | number | undefined> = {}
) {
  return requestWebApi(config, API_PATHS.customerServiceConversationList, {
    token: session.accessToken,
    query
  })
}

export async function createCsConversation(
  config: TenantBrandConfig,
  session: WebImSession,
  body: { subject?: string; queue_code?: string; entry_id?: number }
) {
  return requestWebApi(config, API_PATHS.customerServiceConversationSave, {
    method: 'POST',
    token: session.accessToken,
    body
  })
}

export async function resolveCsEntry(config: TenantBrandConfig, code: string) {
  return requestWebApi(config, API_PATHS.customerServiceEntryResolve, {
    query: { code }
  })
}

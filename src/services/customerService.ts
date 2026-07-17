import { API_PATHS } from '../config/apiPaths'
import { requestWebApi } from './apiClient'
import type { TenantBrandConfig } from './tenantConfig'
import type { WebImSession } from '../types'

export interface CustomerServiceConversation {
  id: number
  conversationNo: string
  subject: string
  status: string
  channel: string
  createTime: string
  updateTime: string
}

interface ConversationPage {
  current_page: number
  data: Array<Record<string, unknown>>
  per_page: number
  total: number
}

function mapConversation(row: Record<string, unknown>): CustomerServiceConversation {
  return {
    id: Number(row.id ?? 0),
    conversationNo: String(row.conversation_no ?? ''),
    subject: String(row.subject ?? ''),
    status: String(row.status ?? ''),
    channel: String(row.channel ?? ''),
    createTime: String(row.create_time ?? ''),
    updateTime: String(row.update_time ?? '')
  }
}

export async function fetchMyCsConversations(
  config: TenantBrandConfig,
  session: WebImSession,
  query: Record<string, string | number | undefined> = {}
) {
  const payload = await requestWebApi<ConversationPage>(config, API_PATHS.customerServiceConversationList, {
    token: session.accessToken,
    query
  })
  return {
    items: (payload?.data ?? []).map(mapConversation),
    total: Number(payload?.total ?? 0)
  }
}

export async function createCsConversation(
  config: TenantBrandConfig,
  session: WebImSession,
  body: { subject?: string; queue_code?: string; entry_id?: number }
) {
  const payload = await requestWebApi<Record<string, unknown>>(config, API_PATHS.customerServiceConversationSave, {
    method: 'POST',
    token: session.accessToken,
    body
  })
  return mapConversation(payload ?? {})
}

export async function resolveCsEntry(config: TenantBrandConfig, code: string) {
  return requestWebApi(config, API_PATHS.customerServiceEntryResolve, {
    query: { code }
  })
}

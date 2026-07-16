import { API_PATHS } from '../config/apiPaths'
import { requestWebApi } from './apiClient'
import type { TenantBrandConfig } from './tenantConfig'
import type { WebImSession } from '../types'

export interface SearchHit {
  messageId: string
  conversationId: string
  senderUserId: string
  messageType: number
  messageSeq: number
  content: string
  sentAt: string | null
}

interface SearchPage {
  current_page: number
  data: Array<Record<string, unknown>>
  per_page: number
  total: number
  backend?: string
}

export async function searchMessagesFull(
  config: TenantBrandConfig,
  session: WebImSession,
  query: {
    q: string
    conversation_id?: string
    sender_user_id?: string
    message_type?: number
    page?: number
    limit?: number
  }
): Promise<{ items: SearchHit[]; total: number; page: number; limit: number; backend: string }> {
  const payload = await requestWebApi<SearchPage>(config, API_PATHS.searchMessagesFull, {
    token: session.accessToken,
    query
  })
  const data = payload?.data ?? []
  return {
    items: data.map((row) => ({
      messageId: String(row.message_id ?? ''),
      conversationId: String(row.conversation_id ?? ''),
      senderUserId: String(row.sender_user_id ?? ''),
      messageType: Number(row.message_type ?? 0),
      messageSeq: Number(row.message_seq ?? 0),
      content: String(row.content ?? ''),
      sentAt: (row.sent_at as string | null) ?? null
    })),
    total: Number(payload?.total ?? 0),
    page: Number(payload?.current_page ?? 1),
    limit: Number(payload?.per_page ?? 20),
    backend: String(payload?.backend ?? 'mysql')
  }
}

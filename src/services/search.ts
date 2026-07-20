import { API_PATHS } from '../config/apiPaths.ts'
import { requestWebApi } from './apiClient.ts'
import type { TenantBrandConfig } from './tenantConfig'
import type { WebImSession } from '../types'

export interface SearchHit {
  messageId: string
  conversationId: string
  senderOrganization: number
  senderUserId: string
  messageType: number
  messageSeq: number
  content: string
  sentAt: string | null
}

type SearchMessagesBaseQuery = {
  q: string
  conversation_id?: string
  message_type?: number
  page?: number
  limit?: number
}

type SearchMessagesSenderFilter =
  | {
      sender_organization: number
      sender_user_id: string
    }
  | {
      sender_organization?: never
      sender_user_id?: never
    }

export type SearchMessagesQuery = SearchMessagesBaseQuery & SearchMessagesSenderFilter

interface SearchPage {
  current_page: number
  data: Array<Record<string, unknown>>
  per_page: number
  total: number
  backend?: string
}

const utf8Encoder = new TextEncoder()
const invalidAccessIdFragments = ['\0', '\t', '\n', '\v', '\r', '|'] as const

function canonicalAccessId(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    utf8Encoder.encode(value).byteLength > 64 ||
    value.startsWith(' ') ||
    value.endsWith(' ') ||
    invalidAccessIdFragments.some((fragment) => value.includes(fragment))
  ) {
    throw new TypeError(`消息搜索结果 ${field} 无效`)
  }
  return value
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`消息搜索结果 ${field} 无效`)
  }
  return value
}

export function parseSearchHit(row: Record<string, unknown>): SearchHit {
  const sentAt = row.sent_at
  if (
    sentAt !== null &&
    (typeof sentAt !== 'string' || sentAt.trim() === '')
  ) {
    throw new TypeError('消息搜索结果 sent_at 无效')
  }
  if (typeof row.content !== 'string') {
    throw new TypeError('消息搜索结果 content 无效')
  }

  return {
    messageId: canonicalAccessId(row.message_id, 'message_id'),
    conversationId: canonicalAccessId(row.conversation_id, 'conversation_id'),
    senderOrganization: positiveSafeInteger(
      row.sender_organization,
      'sender_organization'
    ),
    senderUserId: canonicalAccessId(row.sender_user_id, 'sender_user_id'),
    messageType: positiveSafeInteger(row.message_type, 'message_type'),
    messageSeq: positiveSafeInteger(row.message_seq, 'message_seq'),
    content: row.content,
    sentAt
  }
}

export function searchSenderLabel(
  hit: Pick<SearchHit, 'senderOrganization' | 'senderUserId'>
): string {
  return `机构 ${hit.senderOrganization} · ${hit.senderUserId}`
}

export function serializeSearchMessagesQuery(
  query: SearchMessagesQuery
): Record<string, string | number | undefined> {
  const senderOrganization = query.sender_organization
  const senderUserId = query.sender_user_id
  const hasSenderOrganization = senderOrganization !== undefined
  const hasSenderUserId = senderUserId !== undefined

  if (hasSenderOrganization !== hasSenderUserId) {
    throw new TypeError('sender_organization 与 sender_user_id 必须同时提供')
  }
  if (!hasSenderOrganization) {
    return query
  }
  positiveSafeInteger(senderOrganization, 'sender_organization')

  return {
    ...query,
    sender_organization: senderOrganization,
    sender_user_id: canonicalAccessId(senderUserId, 'sender_user_id')
  }
}

export async function searchMessagesFull(
  config: TenantBrandConfig,
  session: WebImSession,
  query: SearchMessagesQuery
): Promise<{ items: SearchHit[]; total: number; page: number; limit: number; backend: string }> {
  const payload = await requestWebApi<SearchPage>(config, API_PATHS.searchMessagesFull, {
    token: session.accessToken,
    query: serializeSearchMessagesQuery(query)
  })
  const data = payload?.data ?? []
  return {
    items: data.map(parseSearchHit),
    total: Number(payload?.total ?? 0),
    page: Number(payload?.current_page ?? 1),
    limit: Number(payload?.per_page ?? 20),
    backend: String(payload?.backend ?? 'mysql')
  }
}

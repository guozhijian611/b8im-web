import { API_PATHS } from '../config/apiPaths.ts'
import { requestWebApi } from './apiClient.ts'
import type { TenantBrandConfig } from './tenantConfig'
import type { WebImSession } from '../types'
import {
  assertGroupAccessEpochCurrent,
  captureGroupAccessEpoch,
  currentGroupAccessEntry,
  isGroupMessageVisible,
  normalizePositiveDecimal
} from './groupMemberAccess.ts'

export interface SearchHit {
  messageId: string
  conversationId: string
  conversationType: 'single' | 'group'
  senderOrganization: number
  senderUserId: string
  messageType: number
  messageSeq: string
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

function parseConversationType(value: unknown): SearchHit['conversationType'] {
  if (value === 1) return 'single'
  if (value === 2) return 'group'
  throw new TypeError('消息搜索结果 conversation_type 无效')
}

function parseMessageSequence(value: unknown): string {
  const normalized = normalizePositiveDecimal(value)
  if (!normalized) throw new TypeError('消息搜索结果 message_seq 无效')
  return normalized
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
    conversationType: parseConversationType(row.conversation_type),
    senderOrganization: positiveSafeInteger(
      row.sender_organization,
      'sender_organization'
    ),
    senderUserId: canonicalAccessId(row.sender_user_id, 'sender_user_id'),
    messageType: positiveSafeInteger(row.message_type, 'message_type'),
    messageSeq: parseMessageSequence(row.message_seq),
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
  const accessEpoch = captureGroupAccessEpoch(session)
  const payload = await requestWebApi<SearchPage>(config, API_PATHS.searchMessagesFull, {
    token: session.accessToken,
    query: serializeSearchMessagesQuery(query)
  })
  const data = payload?.data ?? []
  assertGroupAccessEpochCurrent(accessEpoch)
  const items = data.map(parseSearchHit)
  for (const hit of items) {
    const entry = currentGroupAccessEntry(session, hit.conversationId)
    if (hit.conversationType === 'single') {
      if (entry) throw new Error('消息搜索结果会话类型与群访问快照冲突')
      continue
    }
    if (!isGroupMessageVisible(entry, hit.conversationId, {
      conversation_id: hit.conversationId,
      message_seq: hit.messageSeq
    })) {
      throw new Error('消息搜索结果超出群成员可见周期')
    }
  }
  assertGroupAccessEpochCurrent(accessEpoch)
  return {
    items,
    total: Number(payload?.total ?? 0),
    page: Number(payload?.current_page ?? 1),
    limit: Number(payload?.per_page ?? 20),
    backend: String(payload?.backend ?? 'mysql')
  }
}

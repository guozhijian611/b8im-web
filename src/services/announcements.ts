import { API_PATHS } from '../config/apiPaths'
import { requestWebApi, WebApiError } from './apiClient'
import { emitClientConfigInvalidated } from './clientConfigEvents'
import type { TenantBrandConfig } from './tenantConfig'
import type { WebImSession } from '../types'

export interface AnnouncementSummary {
  id: string
  title: string
  summary: string
  publishedAt: string
  displayMode: AnnouncementDisplayMode
  isRead: boolean
}

export interface AnnouncementDetail extends AnnouncementSummary {
  content: string
  readAckRequired: boolean
}

export type AnnouncementDisplayMode = 'list' | 'popup' | 'both'

export interface AnnouncementModuleConfig {
  displayMode: AnnouncementDisplayMode
  requireReadAck: boolean
}

interface AnnouncementListPayload {
  list: Array<{
    id: string | number
    title: string
    summary: string
    display_mode: AnnouncementDisplayMode
    published_at: string
    is_read: boolean
  }>
  total: number
  config: {
    display_mode: AnnouncementDisplayMode
    require_read_ack: boolean
  }
}

interface AnnouncementDetailPayload {
  id: string | number
  title: string
  summary: string
  content: string
  display_mode: AnnouncementDisplayMode
  published_at: string
  is_read: boolean
  read_ack_required: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function mapSummary(item: unknown): AnnouncementSummary {
  if (!isRecord(item)) throw new Error('公告列表项目格式无效')
  const id = item.id
  if (
    (typeof id !== 'string' && typeof id !== 'number') ||
    !String(id).trim() ||
    typeof item.title !== 'string' ||
    typeof item.summary !== 'string' ||
    typeof item.published_at !== 'string' ||
    !isDisplayMode(item.display_mode) ||
    typeof item.is_read !== 'boolean'
  ) {
    throw new Error('公告列表项目格式无效')
  }
  return {
    id: String(id),
    title: item.title,
    summary: item.summary,
    publishedAt: item.published_at,
    displayMode: item.display_mode,
    isRead: item.is_read
  }
}

export async function fetchAnnouncements(
  config: TenantBrandConfig,
  session: WebImSession
) {
  const data = await announcementRequest(requestWebApi<AnnouncementListPayload>(
    config,
    API_PATHS.announcementList,
    {
      token: session.accessToken,
      query: { page: 1, limit: 50 }
    }
  ))
  if (!data || !Array.isArray(data.list) || !Number.isInteger(data.total) || data.total < 0) {
    throw new Error('公告列表响应格式无效')
  }
  if (!data.config || !isDisplayMode(data.config.display_mode) || typeof data.config.require_read_ack !== 'boolean') {
    throw new Error('公告模块配置响应格式无效')
  }
  return {
    list: data.list.map(mapSummary),
    total: Number(data.total),
    config: {
      displayMode: data.config.display_mode,
      requireReadAck: data.config.require_read_ack
    } satisfies AnnouncementModuleConfig
  }
}

export async function fetchAnnouncementDetail(
  config: TenantBrandConfig,
  session: WebImSession,
  id: string
): Promise<AnnouncementDetail> {
  const data = await announcementRequest(requestWebApi<AnnouncementDetailPayload>(
    config,
    API_PATHS.announcementRead,
    {
      token: session.accessToken,
      query: { id }
    }
  ))
  if (
    !data ||
    String(data.id) !== id ||
    typeof data.title !== 'string' ||
    typeof data.summary !== 'string' ||
    typeof data.content !== 'string' ||
    typeof data.published_at !== 'string' ||
    !isDisplayMode(data.display_mode) ||
    typeof data.is_read !== 'boolean' ||
    typeof data.read_ack_required !== 'boolean'
  ) {
    throw new Error('公告详情响应格式无效')
  }
  return { ...mapSummary(data), content: data.content, readAckRequired: data.read_ack_required }
}

export async function acknowledgeAnnouncement(
  config: TenantBrandConfig,
  session: WebImSession,
  id: string
) {
  return announcementRequest(requestWebApi<{
    required: boolean
    recorded: boolean
    announcement_id: number
    read_time: string | null
  }>(config, API_PATHS.announcementAcknowledge, {
    method: 'POST',
    token: session.accessToken,
    body: { id: Number(id) }
  }))
}

function isDisplayMode(value: unknown): value is AnnouncementDisplayMode {
  return value === 'list' || value === 'popup' || value === 'both'
}

async function announcementRequest<T>(request: Promise<T>): Promise<T> {
  try {
    return await request
  } catch (error) {
    if (error instanceof WebApiError && (error.status === 403 || error.code === 403)) {
      emitClientConfigInvalidated('announcement')
    }
    throw error
  }
}

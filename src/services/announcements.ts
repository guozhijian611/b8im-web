import { API_PATHS } from '../config/apiPaths'
import { requestWebApi } from './apiClient'
import type { TenantBrandConfig } from './tenantConfig'
import type { WebImSession } from '../types'

export interface AnnouncementSummary {
  id: string
  title: string
  summary: string
  publishedAt: string
}

export interface AnnouncementDetail extends AnnouncementSummary {
  content: string
}

interface AnnouncementListPayload {
  list: Array<{
    id: string | number
    title: string
    summary: string
    published_at: string
  }>
  total: number
}

interface AnnouncementDetailPayload {
  id: string | number
  title: string
  summary: string
  content: string
  published_at: string
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
    typeof item.published_at !== 'string'
  ) {
    throw new Error('公告列表项目格式无效')
  }
  return {
    id: String(id),
    title: item.title,
    summary: item.summary,
    publishedAt: item.published_at
  }
}

export async function fetchAnnouncements(
  config: TenantBrandConfig,
  session: WebImSession
) {
  const data = await requestWebApi<AnnouncementListPayload>(config, API_PATHS.announcementList, {
    token: session.accessToken,
    query: { page: 1, limit: 50 }
  })
  if (!data || !Array.isArray(data.list) || !Number.isInteger(data.total) || data.total < 0) {
    throw new Error('公告列表响应格式无效')
  }
  return { list: data.list.map(mapSummary), total: Number(data.total) }
}

export async function fetchAnnouncementDetail(
  config: TenantBrandConfig,
  session: WebImSession,
  id: string
): Promise<AnnouncementDetail> {
  const data = await requestWebApi<AnnouncementDetailPayload>(config, API_PATHS.announcementRead, {
    token: session.accessToken,
    query: { id }
  })
  if (
    !data ||
    String(data.id) !== id ||
    typeof data.title !== 'string' ||
    typeof data.summary !== 'string' ||
    typeof data.content !== 'string' ||
    typeof data.published_at !== 'string'
  ) {
    throw new Error('公告详情响应格式无效')
  }
  return { ...mapSummary(data), content: data.content }
}

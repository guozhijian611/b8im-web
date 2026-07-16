import { API_PATHS } from '../config/apiPaths'
import { requestWebApi } from './apiClient'
import type { TenantBrandConfig } from './tenantConfig'
import type { WebImSession } from '../types'

export interface MomentsPost {
  id: number
  userId: string
  content: string
  visibility: string
  likeCount: number
  commentCount: number
  liked: boolean
  createTime: string
}

interface Page {
  current_page: number
  data: Array<Record<string, unknown>>
  per_page: number
  total: number
}

function mapPost(row: Record<string, unknown>): MomentsPost {
  return {
    id: Number(row.id ?? 0),
    userId: String(row.user_id ?? ''),
    content: String(row.content ?? ''),
    visibility: String(row.visibility ?? 'friends'),
    likeCount: Number(row.like_count ?? 0),
    commentCount: Number(row.comment_count ?? 0),
    liked: Boolean(row.liked),
    createTime: String(row.create_time ?? '')
  }
}

export async function fetchMomentsFeed(
  config: TenantBrandConfig,
  session: WebImSession,
  query: { page?: number; limit?: number; user_id?: string } = {}
): Promise<{ items: MomentsPost[]; total: number }> {
  const payload = await requestWebApi<Page>(config, API_PATHS.momentsFeed, {
    token: session.accessToken,
    query
  })
  return {
    items: (payload?.data ?? []).map(mapPost),
    total: Number(payload?.total ?? 0)
  }
}

export async function createMoment(
  config: TenantBrandConfig,
  session: WebImSession,
  body: { content: string; visibility?: string; media?: Array<{ url: string; type?: string }> }
): Promise<MomentsPost> {
  const payload = await requestWebApi<Record<string, unknown>>(config, API_PATHS.momentsSave, {
    method: 'POST',
    token: session.accessToken,
    body
  })
  return mapPost(payload ?? {})
}

export async function toggleMomentLike(
  config: TenantBrandConfig,
  session: WebImSession,
  postId: number
): Promise<{ liked: boolean; likeCount: number }> {
  const payload = await requestWebApi<Record<string, unknown>>(config, API_PATHS.momentsLikeToggle, {
    method: 'POST',
    token: session.accessToken,
    body: { post_id: postId }
  })
  return {
    liked: Boolean(payload?.liked),
    likeCount: Number(payload?.like_count ?? 0)
  }
}

export async function createMomentComment(
  config: TenantBrandConfig,
  session: WebImSession,
  body: { post_id: number; content: string; parent_id?: number }
): Promise<Record<string, unknown>> {
  return (
    (await requestWebApi<Record<string, unknown>>(config, API_PATHS.momentsCommentSave, {
      method: 'POST',
      token: session.accessToken,
      body
    })) ?? {}
  )
}

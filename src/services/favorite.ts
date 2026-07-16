import { API_PATHS } from '../config/apiPaths'
import { requestWebApi } from './apiClient'
import type { TenantBrandConfig } from './tenantConfig'
import type { WebImSession } from '../types'

export type FavoriteTargetType = 'message' | 'file' | 'link' | 'text'

export interface FavoriteItem {
  id: number
  organization: number
  userId: string
  targetType: FavoriteTargetType
  targetId: string
  title: string
  summary: string
  payload: Record<string, unknown> | null
  createTime: string
}

interface FavoritePage {
  current_page: number
  data: Array<Record<string, unknown>>
  per_page: number
  total: number
}

function mapItem(row: Record<string, unknown>): FavoriteItem {
  return {
    id: Number(row.id ?? 0),
    organization: Number(row.organization ?? 0),
    userId: String(row.user_id ?? ''),
    targetType: String(row.target_type ?? 'text') as FavoriteTargetType,
    targetId: String(row.target_id ?? ''),
    title: String(row.title ?? ''),
    summary: String(row.summary ?? ''),
    payload: (row.payload as Record<string, unknown> | null) ?? null,
    createTime: String(row.create_time ?? '')
  }
}

export async function fetchFavorites(
  config: TenantBrandConfig,
  session: WebImSession,
  query: { page?: number; limit?: number; keyword?: string; target_type?: string } = {}
): Promise<{ items: FavoriteItem[]; total: number; page: number; limit: number }> {
  const payload = await requestWebApi<FavoritePage>(config, API_PATHS.favoriteList, {
    token: session.accessToken,
    query
  })
  const data = payload?.data ?? []
  return {
    items: data.map(mapItem),
    total: Number(payload?.total ?? 0),
    page: Number(payload?.current_page ?? 1),
    limit: Number(payload?.per_page ?? 20)
  }
}

export async function createFavorite(
  config: TenantBrandConfig,
  session: WebImSession,
  body: {
    target_type: FavoriteTargetType
    target_id?: string
    title: string
    summary?: string
    payload?: Record<string, unknown>
  }
): Promise<FavoriteItem> {
  const payload = await requestWebApi<Record<string, unknown>>(config, API_PATHS.favoriteSave, {
    method: 'POST',
    token: session.accessToken,
    body
  })
  return mapItem(payload ?? {})
}

export async function deleteFavorites(
  config: TenantBrandConfig,
  session: WebImSession,
  ids: number[]
): Promise<number> {
  const payload = await requestWebApi<{ deleted: number }>(config, API_PATHS.favoriteDestroy, {
    method: 'POST',
    token: session.accessToken,
    body: { ids }
  })
  return Number(payload?.deleted ?? 0)
}

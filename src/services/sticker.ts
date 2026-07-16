import { API_PATHS } from '../config/apiPaths'
import { requestWebApi } from './apiClient'
import type { TenantBrandConfig } from './tenantConfig'
import type { WebImSession } from '../types'

export interface StickerPack {
  id: number
  organization: number
  code: string
  name: string
  description: string
}

export interface StickerItem {
  id: number
  packId: number
  organization: number
  code: string
  name: string
  fileId: string
}

export async function fetchStickerPacks(
  config: TenantBrandConfig,
  session: WebImSession
): Promise<StickerPack[]> {
  const payload = await requestWebApi<{ items: Array<Record<string, unknown>> }>(
    config,
    API_PATHS.stickerPacks,
    { token: session.accessToken }
  )
  const items = payload?.items ?? []
  return items.map((row) => ({
    id: Number(row.id ?? 0),
    organization: Number(row.organization ?? 0),
    code: String(row.code ?? ''),
    name: String(row.name ?? ''),
    description: String(row.description ?? '')
  }))
}

export async function fetchStickerItems(
  config: TenantBrandConfig,
  session: WebImSession,
  packId?: number
): Promise<StickerItem[]> {
  const payload = await requestWebApi<{ items: Array<Record<string, unknown>> }>(
    config,
    API_PATHS.stickerItems,
    {
      token: session.accessToken,
      query: packId ? { pack_id: packId } : undefined
    }
  )
  const items = payload?.items ?? []
  return items.map((row) => ({
    id: Number(row.id ?? 0),
    packId: Number(row.pack_id ?? 0),
    organization: Number(row.organization ?? 0),
    code: String(row.code ?? ''),
    name: String(row.name ?? ''),
    fileId: String(row.file_id ?? '')
  }))
}

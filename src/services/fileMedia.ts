import { API_PATHS } from '../config/apiPaths'
import { requestWebApi } from './apiClient'
import type { TenantBrandConfig } from './tenantConfig'
import type { WebImSession } from '../types'

export interface FileMediaQuota {
  organization: number
  maxStorageBytes: number
  maxFileBytes: number
  usedStorageBytes: number
  usedFileCount: number
  usageRatio: number
  previewEnabled: boolean
  largeFileEnabled: boolean
  status: number
}

export interface FileMediaFolder {
  id: number
  parentId: number
  name: string
  createTime: string
}

export interface FileMediaItem {
  id: number
  folderId: number
  name: string
  fileId: string
  mimeType: string
  kind: string
  sizeBytes: number
  previewStatus: string
  createTime: string
}

interface FileMediaPage {
  current_page: number
  data: Array<Record<string, unknown>>
  per_page: number
  total: number
}

function mapQuota(row: Record<string, unknown> | null | undefined): FileMediaQuota {
  const r = row ?? {}
  return {
    organization: Number(r.organization ?? 0),
    maxStorageBytes: Number(r.max_storage_bytes ?? 0),
    maxFileBytes: Number(r.max_file_bytes ?? 0),
    usedStorageBytes: Number(r.used_storage_bytes ?? 0),
    usedFileCount: Number(r.used_file_count ?? 0),
    usageRatio: Number(r.usage_ratio ?? 0),
    previewEnabled: Number(r.preview_enabled ?? 0) === 1,
    largeFileEnabled: Number(r.large_file_enabled ?? 0) === 1,
    status: Number(r.status ?? 0)
  }
}

export async function fetchFileMediaUsage(
  config: TenantBrandConfig,
  session: WebImSession
): Promise<FileMediaQuota> {
  const payload = await requestWebApi<Record<string, unknown>>(config, API_PATHS.fileMediaUsage, {
    token: session.accessToken
  })
  return mapQuota(payload)
}

export async function checkFileMediaUpload(
  config: TenantBrandConfig,
  session: WebImSession,
  sizeBytes: number
): Promise<{ allowed: boolean; reason: string; quota: FileMediaQuota }> {
  const payload = await requestWebApi<Record<string, unknown>>(
    config,
    API_PATHS.fileMediaCheckUpload,
    {
      method: 'POST',
      token: session.accessToken,
      body: { size_bytes: sizeBytes }
    }
  )
  return {
    allowed: Boolean(payload?.allowed),
    reason: String(payload?.reason ?? ''),
    quota: mapQuota((payload?.quota as Record<string, unknown>) ?? {})
  }
}

function mapFolder(row: Record<string, unknown>): FileMediaFolder {
  return {
    id: Number(row.id ?? 0),
    parentId: Number(row.parent_id ?? 0),
    name: String(row.name ?? ''),
    createTime: String(row.create_time ?? '')
  }
}

function mapItem(row: Record<string, unknown>): FileMediaItem {
  return {
    id: Number(row.id ?? 0),
    folderId: Number(row.folder_id ?? 0),
    name: String(row.name ?? ''),
    fileId: String(row.file_id ?? ''),
    mimeType: String(row.mime_type ?? ''),
    kind: String(row.kind ?? 'file'),
    sizeBytes: Number(row.size_bytes ?? 0),
    previewStatus: String(row.preview_status ?? 'none'),
    createTime: String(row.create_time ?? '')
  }
}

export async function fetchFileMediaFolders(config: TenantBrandConfig, session: WebImSession) {
  const payload = await requestWebApi<FileMediaPage>(config, API_PATHS.fileMediaFolderIndex, {
    token: session.accessToken,
    query: { page: 1, limit: 100 }
  })
  return (payload?.data ?? []).map(mapFolder)
}

export async function createFileMediaFolder(
  config: TenantBrandConfig,
  session: WebImSession,
  name: string
) {
  const payload = await requestWebApi<Record<string, unknown>>(config, API_PATHS.fileMediaFolderSave, {
    method: 'POST', token: session.accessToken, body: { name, parent_id: 0 }
  })
  return mapFolder(payload ?? {})
}

export async function fetchFileMediaItems(
  config: TenantBrandConfig,
  session: WebImSession,
  query: { folder_id?: number; keyword?: string } = {}
) {
  const payload = await requestWebApi<FileMediaPage>(config, API_PATHS.fileMediaItemIndex, {
    token: session.accessToken,
    query: { ...query, page: 1, limit: 100 }
  })
  return (payload?.data ?? []).map(mapItem)
}

export async function createFileMediaItem(
  config: TenantBrandConfig,
  session: WebImSession,
  body: {
    folder_id: number
    name: string
    file_id: string
    mime_type: string
    kind: string
    size_bytes: number
  }
) {
  const payload = await requestWebApi<Record<string, unknown>>(config, API_PATHS.fileMediaItemSave, {
    method: 'POST', token: session.accessToken, body
  })
  return mapItem(payload ?? {})
}

export async function deleteFileMediaItem(
  config: TenantBrandConfig,
  session: WebImSession,
  id: number
) {
  const payload = await requestWebApi<{ deleted: number }>(config, API_PATHS.fileMediaItemDestroy, {
    method: 'POST', token: session.accessToken, body: { ids: [id] }
  })
  return Number(payload?.deleted ?? 0)
}

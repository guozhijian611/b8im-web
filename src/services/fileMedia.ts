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

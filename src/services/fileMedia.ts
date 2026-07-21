import { API_PATHS } from '../config/apiPaths.ts'
import { requestWebApi } from './apiClient.ts'
import type { TenantBrandConfig } from './tenantConfig'
import type { WebImSession } from '../types'

const CANONICAL_UNSIGNED_DECIMAL = /^(0|[1-9]\d*)$/
const PHP_INT_MAX_DECIMAL = '9223372036854775807'
const MAX_FILE_BYTES = 2147483648n
const MAX_FILE_BYTES_NUMBER = 2147483648
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'] as const
const UNIT_BASE = 1024n
const USAGE_RATIO_SCALE = 1000000n

export type FileMediaPolicyFlag = 0 | 1

export interface StorageQuota {
  organization: number
  quota_key: 'storage_bytes'
  quota_value: string
  used_value: string
  held_value: string
  occupancy_value: string
  remaining_value: string | null
  unlimited: boolean
  used_file_count: number
  held_file_count: number
  usage_ratio: number | null
  version: number
  update_time: string | null
}

export interface FileMediaPolicy {
  max_file_bytes: string
  large_file_enabled: FileMediaPolicyFlag
  preview_enabled: FileMediaPolicyFlag
  status: FileMediaPolicyFlag
}

export interface FileMediaUsage {
  storage: StorageQuota
  policy: FileMediaPolicy
}

export interface FileMediaUploadCheck extends FileMediaUsage {
  allowed: boolean
  reason: string
  size_bytes: number
}

const STORAGE_QUOTA_KEYS = [
  'organization',
  'quota_key',
  'quota_value',
  'used_value',
  'held_value',
  'occupancy_value',
  'remaining_value',
  'unlimited',
  'used_file_count',
  'held_file_count',
  'usage_ratio',
  'version',
  'update_time'
] as const

const FILE_MEDIA_POLICY_KEYS = [
  'max_file_bytes',
  'large_file_enabled',
  'preview_enabled',
  'status'
] as const

const FILE_MEDIA_USAGE_KEYS = ['storage', 'policy'] as const
const FILE_MEDIA_CHECK_KEYS = ['allowed', 'reason', 'size_bytes', 'storage', 'policy'] as const

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

function fitsPhpInteger(value: string): boolean {
  return (
    value.length < PHP_INT_MAX_DECIMAL.length ||
    (value.length === PHP_INT_MAX_DECIMAL.length && value <= PHP_INT_MAX_DECIMAL)
  )
}

function assertExactRecord(
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' 必须是对象')
  }
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(label + ' 字段集合无效')
  }
  return value as Record<string, unknown>
}

function readDecimal(row: Record<string, unknown>, key: string, label: string): string {
  const value = row[key]
  if (
    typeof value !== 'string' ||
    !CANONICAL_UNSIGNED_DECIMAL.test(value) ||
    !fitsPhpInteger(value)
  ) {
    throw new Error(label + '.' + key + ' 必须是规范十进制字符串')
  }
  return value
}

function readSafeInteger(
  row: Record<string, unknown>,
  key: string,
  label: string,
  minimum: number
): number {
  const value = row[key]
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(label + '.' + key + ' 必须是安全整数')
  }
  return value as number
}

function readFlag(row: Record<string, unknown>, key: string, label: string): FileMediaPolicyFlag {
  const value = row[key]
  if (value !== 0 && value !== 1) {
    throw new Error(label + '.' + key + ' 必须是 0 或 1')
  }
  return value
}

function readUsageRatio(row: Record<string, unknown>, label: string): number | null {
  const value = row.usage_ratio
  if (
    value !== null &&
    (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
  ) {
    throw new Error(label + '.usage_ratio 必须是 0 至 1 的数字或 null')
  }
  return value as number | null
}

function calculateUsageRatio(occupancy: bigint, quota: bigint): number {
  const scaled = occupancy * USAGE_RATIO_SCALE
  const rounded = scaled / quota + ((scaled % quota) * 2n >= quota ? 1n : 0n)
  return Number(rounded) / Number(USAGE_RATIO_SCALE)
}

function assertExpectedOrganization(value: string): string {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('TenantBrandConfig.organization 必须是规范正安全整数')
  }
  return value
}

export function parseStorageQuota(
  value: unknown,
  expectedOrganization: string
): StorageQuota {
  const label = 'StorageQuota'
  const organizationIdentity = assertExpectedOrganization(expectedOrganization)
  const row = assertExactRecord(value, STORAGE_QUOTA_KEYS, label)
  const quotaValue = readDecimal(row, 'quota_value', label)
  const usedValue = readDecimal(row, 'used_value', label)
  const heldValue = readDecimal(row, 'held_value', label)
  const occupancyValue = readDecimal(row, 'occupancy_value', label)
  const remainingValue =
    row.remaining_value === null ? null : readDecimal(row, 'remaining_value', label)
  const unlimited = row.unlimited
  if (typeof unlimited !== 'boolean') {
    throw new Error(label + '.unlimited 必须是布尔值')
  }
  const usageRatio = readUsageRatio(row, label)
  const quota = BigInt(quotaValue)
  const used = BigInt(usedValue)
  const held = BigInt(heldValue)
  const occupancy = BigInt(occupancyValue)

  if (used + held !== occupancy) {
    throw new Error(label + ' 的已用、预留与占用值不一致')
  }
  if (unlimited !== (quota === 0n)) {
    throw new Error(label + ' 的无限配额标记不一致')
  }
  if (quota === 0n) {
    if (remainingValue !== null || usageRatio !== null) {
      throw new Error(label + ' 的无限配额剩余值或使用率无效')
    }
  } else {
    if (
      occupancy > quota ||
      remainingValue === null ||
      BigInt(remainingValue) !== quota - occupancy
    ) {
      throw new Error(label + ' 的有限配额剩余值无效')
    }
    if (usageRatio === null) {
      throw new Error(label + ' 的有限配额使用率无效')
    }
    if (usageRatio !== calculateUsageRatio(occupancy, quota)) {
      throw new Error(label + ' 的有限配额使用率与占用值不一致')
    }
  }
  if (row.quota_key !== 'storage_bytes') {
    throw new Error(label + '.quota_key 必须是 storage_bytes')
  }
  const updateTime = row.update_time
  if (updateTime !== null && typeof updateTime !== 'string') {
    throw new Error(label + '.update_time 必须是字符串或 null')
  }

  const organization = readSafeInteger(row, 'organization', label, 1)
  if (String(organization) !== organizationIdentity) {
    throw new Error(label + '.organization 与 TenantBrandConfig.organization 不一致')
  }

  return {
    organization,
    quota_key: 'storage_bytes',
    quota_value: quotaValue,
    used_value: usedValue,
    held_value: heldValue,
    occupancy_value: occupancyValue,
    remaining_value: remainingValue,
    unlimited,
    used_file_count: readSafeInteger(row, 'used_file_count', label, 0),
    held_file_count: readSafeInteger(row, 'held_file_count', label, 0),
    usage_ratio: usageRatio,
    version: readSafeInteger(row, 'version', label, 1),
    update_time: updateTime as string | null
  }
}

export function parseFileMediaPolicy(value: unknown): FileMediaPolicy {
  const label = 'FileMediaPolicy'
  const row = assertExactRecord(value, FILE_MEDIA_POLICY_KEYS, label)
  const maxFileBytes = readDecimal(row, 'max_file_bytes', label)
  const maximum = BigInt(maxFileBytes)
  if (maximum < 1n || maximum > MAX_FILE_BYTES) {
    throw new Error(label + '.max_file_bytes 必须在 1 字节到 2 GiB 之间')
  }
  return {
    max_file_bytes: maxFileBytes,
    large_file_enabled: readFlag(row, 'large_file_enabled', label),
    preview_enabled: readFlag(row, 'preview_enabled', label),
    status: readFlag(row, 'status', label)
  }
}

export function parseFileMediaUsage(
  value: unknown,
  expectedOrganization: string
): FileMediaUsage {
  const row = assertExactRecord(value, FILE_MEDIA_USAGE_KEYS, 'FileMediaUsage')
  return {
    storage: parseStorageQuota(row.storage, expectedOrganization),
    policy: parseFileMediaPolicy(row.policy)
  }
}

export function parseFileMediaUploadCheck(
  value: unknown,
  expectedOrganization: string,
  expectedSizeBytes: number
): FileMediaUploadCheck {
  const label = 'FileMediaUploadCheck'
  const row = assertExactRecord(value, FILE_MEDIA_CHECK_KEYS, label)
  if (typeof row.allowed !== 'boolean') {
    throw new Error(label + '.allowed 必须是布尔值')
  }
  if (typeof row.reason !== 'string') {
    throw new Error(label + '.reason 必须是字符串')
  }
  if ((row.allowed && row.reason !== '') || (!row.allowed && row.reason.trim() === '')) {
    throw new Error(label + '.allowed 与 reason 不一致')
  }
  if (
    !Number.isSafeInteger(expectedSizeBytes) ||
    expectedSizeBytes < 1 ||
    expectedSizeBytes > MAX_FILE_BYTES_NUMBER
  ) {
    throw new Error('请求文件大小必须是 1 字节到 2 GiB 之间的安全整数')
  }
  const sizeBytes = readSafeInteger(row, 'size_bytes', label, 1)
  if (sizeBytes > MAX_FILE_BYTES_NUMBER) {
    throw new Error(label + '.size_bytes 必须在 1 字节到 2 GiB 之间')
  }
  if (sizeBytes !== expectedSizeBytes) {
    throw new Error(label + '.size_bytes 与请求值不一致')
  }
  return {
    allowed: row.allowed,
    reason: row.reason,
    size_bytes: sizeBytes,
    storage: parseStorageQuota(row.storage, expectedOrganization),
    policy: parseFileMediaPolicy(row.policy)
  }
}

export function formatFileMediaByteCount(value: string): string {
  if (
    !CANONICAL_UNSIGNED_DECIMAL.test(value) ||
    !fitsPhpInteger(value)
  ) {
    return '—'
  }
  const bytes = BigInt(value)
  let unitIndex = 0
  let unitSize = 1n
  while (unitIndex < BYTE_UNITS.length - 1 && bytes >= unitSize * UNIT_BASE) {
    unitIndex += 1
    unitSize *= UNIT_BASE
  }
  if (unitIndex === 0) return bytes.toString() + ' B'

  const whole = bytes / unitSize
  const hundredths = ((bytes % unitSize) * 100n) / unitSize
  const decimal = hundredths.toString().padStart(2, '0').replace(/0+$/, '')
  return whole.toString() + (decimal ? '.' + decimal : '') + ' ' + BYTE_UNITS[unitIndex]
}

export function formatFileMediaQuotaByteCount(value: string, unlimited: boolean): string {
  return unlimited ? '无限' : formatFileMediaByteCount(value)
}

export function formatFileMediaUsageRatio(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return (value * 100).toFixed(2).replace(/\.00$/, '') + '%'
}

export async function fetchFileMediaUsage(
  config: TenantBrandConfig,
  session: WebImSession
): Promise<FileMediaUsage> {
  const payload = await requestWebApi<unknown>(config, API_PATHS.fileMediaUsage, {
    token: session.accessToken
  })
  return parseFileMediaUsage(payload, config.organization)
}

export async function checkFileMediaUpload(
  config: TenantBrandConfig,
  session: WebImSession,
  sizeBytes: number
): Promise<FileMediaUploadCheck> {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_FILE_BYTES_NUMBER) {
    throw new Error('文件大小必须是 1 字节到 2 GiB 之间的安全整数')
  }
  const payload = await requestWebApi<unknown>(
    config,
    API_PATHS.fileMediaCheckUpload,
    {
      method: 'POST',
      token: session.accessToken,
      body: { size_bytes: sizeBytes }
    }
  )
  return parseFileMediaUploadCheck(payload, config.organization, sizeBytes)
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

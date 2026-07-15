import { API_PATHS } from '../config/apiPaths'
import { requestWebApi } from './apiClient'
import type { TenantBrandConfig } from './tenantConfig'
import type { WebImSession } from '../types'

export interface I18nLocaleItem {
  code: string
  name: string
  isDefault: boolean
}

export async function fetchI18nLocales(
  config: TenantBrandConfig,
  session: WebImSession
): Promise<I18nLocaleItem[]> {
  const payload = await requestWebApi<{ items: Array<Record<string, unknown>> }>(
    config,
    API_PATHS.i18nLocales,
    { token: session.accessToken }
  )
  const items = payload?.items
  if (!Array.isArray(items)) {
    throw new Error('语言列表格式无效')
  }
  return items.map((item) => ({
    code: String(item.code ?? ''),
    name: String(item.name ?? ''),
    isDefault: Number(item.is_default ?? 0) === 1
  }))
}

export async function fetchI18nMessages(
  config: TenantBrandConfig,
  session: WebImSession,
  locale: string
): Promise<{ locale: string; messages: Record<string, string> }> {
  const payload = await requestWebApi<{ locale: string; messages: Record<string, string> }>(
    config,
    API_PATHS.i18nMessages,
    {
      token: session.accessToken,
      query: { locale }
    }
  )
  if (!payload || typeof payload.locale !== 'string' || typeof payload.messages !== 'object') {
    throw new Error('词条包格式无效')
  }
  return {
    locale: payload.locale,
    messages: payload.messages ?? {}
  }
}

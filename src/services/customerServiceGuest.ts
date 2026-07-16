import { requestWebApi } from './apiClient'
import type { TenantBrandConfig } from './tenantConfig'

const PREFIX = '/saimulti/public/customer-service'

export interface GuestSessionResult {
  guest_token: string
  expires_at: string
  visitor_id: string
  organization: number
  entry: Record<string, unknown>
  conversation?: Record<string, unknown> | null
}

export async function createGuestSession(
  config: TenantBrandConfig,
  body: {
    public_entry_code: string
    display_name?: string
    contact?: string
    origin?: string
    open_conversation?: boolean
    subject?: string
  }
): Promise<GuestSessionResult> {
  return requestWebApi<GuestSessionResult>(config, `${PREFIX}/session/create`, {
    method: 'POST',
    body
  })
}

export async function guestSessionMe(config: TenantBrandConfig, guestToken: string) {
  return requestWebApi(config, `${PREFIX}/session/me`, { guestToken })
}

export async function guestConversationList(
  config: TenantBrandConfig,
  guestToken: string,
  query: Record<string, string | number | undefined> = {}
) {
  return requestWebApi(config, `${PREFIX}/conversation/index`, { guestToken, query })
}

export async function guestConversationCreate(
  config: TenantBrandConfig,
  guestToken: string,
  body: { subject?: string } = {}
) {
  return requestWebApi(config, `${PREFIX}/conversation/save`, {
    method: 'POST',
    guestToken,
    body
  })
}

export async function closeGuestSession(config: TenantBrandConfig, guestToken: string) {
  return requestWebApi(config, `${PREFIX}/session/close`, {
    method: 'POST',
    guestToken
  })
}

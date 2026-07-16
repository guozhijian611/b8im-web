import { API_PATHS } from '../config/apiPaths'
import { requestWebApi } from './apiClient'
import type { TenantBrandConfig } from './tenantConfig'
import type { WebImSession } from '../types'

export interface RobotSingleItem {
  id: number
  organization: number
  code: string
  name: string
  welcomeText: string
  fallbackText: string
  description: string
  status: number
}

interface RobotPage {
  current_page: number
  data: Array<Record<string, unknown>>
  per_page: number
  total: number
}

function mapRobot(row: Record<string, unknown>): RobotSingleItem {
  return {
    id: Number(row.id ?? 0),
    organization: Number(row.organization ?? 0),
    code: String(row.code ?? ''),
    name: String(row.name ?? ''),
    welcomeText: String(row.welcome_text ?? ''),
    fallbackText: String(row.fallback_text ?? ''),
    description: String(row.description ?? ''),
    status: Number(row.status ?? 0)
  }
}

export async function fetchRobots(
  config: TenantBrandConfig,
  session: WebImSession,
  query: { page?: number; limit?: number; keyword?: string } = {}
): Promise<{ items: RobotSingleItem[]; total: number; page: number; limit: number }> {
  const payload = await requestWebApi<RobotPage>(config, API_PATHS.robotSingleList, {
    token: session.accessToken,
    query
  })
  const data = payload?.data ?? []
  return {
    items: data.map(mapRobot),
    total: Number(payload?.total ?? 0),
    page: Number(payload?.current_page ?? 1),
    limit: Number(payload?.per_page ?? 20)
  }
}

export async function matchRobotReply(
  config: TenantBrandConfig,
  session: WebImSession,
  robotId: number,
  text: string
): Promise<{ matched: boolean; replyText: string }> {
  const payload = await requestWebApi<Record<string, unknown>>(config, API_PATHS.robotSingleMatch, {
    method: 'POST',
    token: session.accessToken,
    body: { robot_id: robotId, text }
  })
  return {
    matched: Boolean(payload?.matched),
    replyText: String(payload?.reply_text ?? '')
  }
}

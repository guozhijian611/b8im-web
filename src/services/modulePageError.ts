import { WebApiError } from './apiClient'
import { emitClientConfigInvalidated } from './clientConfigEvents'
import type { ClientModuleKey } from './clientModuleRegistry'

export function modulePageError(error: unknown, moduleKey: ClientModuleKey, fallback: string) {
  const forbidden = error instanceof WebApiError &&
    (error.status === 401 || error.status === 403 || error.code === 401 || error.code === 403)
  if (forbidden) emitClientConfigInvalidated(moduleKey)
  return {
    forbidden,
    message: error instanceof Error ? error.message : fallback
  }
}

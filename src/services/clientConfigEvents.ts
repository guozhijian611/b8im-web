export const CLIENT_CONFIG_INVALIDATED_EVENT = 'b8im:client-config-invalidated'

export function emitClientConfigInvalidated(moduleKey: string) {
  window.dispatchEvent(new CustomEvent(CLIENT_CONFIG_INVALIDATED_EVENT, {
    detail: { moduleKey }
  }))
}

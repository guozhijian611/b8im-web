export type ContextMenuSource = 'app' | 'conversation' | 'message'

export const CONTEXT_MENU_CLOSE_EVENT = 'b8im:close-context-menus'

export interface ContextMenuCloseDetail {
  source: ContextMenuSource
}

export function emitCloseContextMenus(source: ContextMenuSource) {
  window.dispatchEvent(
    new CustomEvent<ContextMenuCloseDetail>(CONTEXT_MENU_CLOSE_EVENT, {
      detail: { source }
    })
  )
}

export function isCloseFromSource(event: Event, source: ContextMenuSource) {
  return event instanceof CustomEvent && event.detail?.source === source
}

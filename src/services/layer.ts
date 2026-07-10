import { reactive } from 'vue'

export type LayerType = 'success' | 'error' | 'warning' | 'info'

export interface LayerToast {
  id: number
  type: LayerType
  message: string
  duration: number
}

const state = reactive({
  toasts: [] as LayerToast[]
})

let seed = 0

function remove(id: number) {
  const index = state.toasts.findIndex((item) => item.id === id)
  if (index >= 0) {
    state.toasts.splice(index, 1)
  }
}

function open(type: LayerType, message: string, duration = 2600) {
  const id = ++seed
  state.toasts.push({ id, type, message, duration })
  window.setTimeout(() => remove(id), duration)
  return id
}

export const layer = {
  state,
  open,
  remove,
  success(message: string, duration?: number) {
    return open('success', message, duration)
  },
  error(message: string, duration?: number) {
    return open('error', message, duration)
  },
  warning(message: string, duration?: number) {
    return open('warning', message, duration)
  },
  info(message: string, duration?: number) {
    return open('info', message, duration)
  }
}

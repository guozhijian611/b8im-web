const WINDOW_DEVICE_ID_KEY = 'b8im_web_window_device_id'
const DEVICE_ID_PATTERN = /^web-[a-zA-Z0-9_-]{1,40}$/

let runtimeDeviceId = ''

function generateDeviceId() {
  const randomValue =
    typeof window.crypto?.randomUUID === 'function'
      ? window.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`

  return `web-${randomValue.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)}`
}

export function getWebDeviceId() {
  if (DEVICE_ID_PATTERN.test(runtimeDeviceId)) return runtimeDeviceId

  try {
    const stored = window.sessionStorage.getItem(WINDOW_DEVICE_ID_KEY) || ''
    if (DEVICE_ID_PATTERN.test(stored)) {
      runtimeDeviceId = stored
      return runtimeDeviceId
    }
  } catch {
    // Keep a stable in-memory device id when sessionStorage is unavailable.
  }

  runtimeDeviceId = generateDeviceId()
  try {
    window.sessionStorage.setItem(WINDOW_DEVICE_ID_KEY, runtimeDeviceId)
  } catch {
    // The in-memory id remains stable for this page lifetime.
  }

  return runtimeDeviceId
}

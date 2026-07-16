import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import test from 'node:test'

class MemoryStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

function installWindow(sessionStorage: MemoryStorage) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { crypto: webcrypto, sessionStorage }
  })
}

test('device id remains stable across page module reloads', async () => {
  const storage = new MemoryStorage()
  installWindow(storage)

  const first = await import(`../src/services/webDevice.ts?first=${Date.now()}`)
  const firstId = first.getWebDeviceId()
  assert.match(firstId, /^web-[a-zA-Z0-9_-]{1,40}$/)
  assert.equal(first.getWebDeviceId(), firstId)

  const second = await import(`../src/services/webDevice.ts?second=${Date.now()}`)
  assert.equal(second.getWebDeviceId(), firstId)
})

test('invalid stored device id is replaced', async () => {
  const storage = new MemoryStorage()
  storage.setItem('b8im_web_window_device_id', 'invalid device id')
  installWindow(storage)

  const module = await import(`../src/services/webDevice.ts?invalid=${Date.now()}`)
  const deviceId = module.getWebDeviceId()
  assert.match(deviceId, /^web-[a-zA-Z0-9_-]{1,40}$/)
  assert.notEqual(deviceId, 'invalid device id')
  assert.equal(storage.getItem('b8im_web_window_device_id'), deviceId)
})

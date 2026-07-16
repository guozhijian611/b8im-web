import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import test from 'node:test'
import type { TenantBrandConfig } from '../src/services/tenantConfig.ts'

class MemoryStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }

  removeItem(key: string) {
    this.values.delete(key)
  }

  allValues() {
    return [...this.values.values()]
  }
}

const storage = new MemoryStorage()
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    crypto: webcrypto,
    sessionStorage: storage,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis)
  }
})

const config = {
  organization: '901',
  deploymentId: 'deployment-test',
  enterpriseCode: 'qa_org',
  discovered: true,
  serverInfo: {
    routes: [
      {
        routeId: 'primary',
        endpoints: {
          apiServerUrl: 'https://api.example.test',
          imServerUrl: 'wss://ws.example.test',
          uploadServerUrl: 'https://api.example.test',
          webServerUrl: 'https://web.example.test'
        }
      }
    ],
    apiServerUrl: 'https://api.example.test',
    imServerUrl: 'wss://ws.example.test'
  }
} as unknown as TenantBrandConfig

function jwt(payload: Record<string, unknown>) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.test-signature`
}

function loginPayload(deviceId: string, overrides: Record<string, unknown> = {}) {
  return {
    organization: 901,
    deployment_id: 'deployment-test',
    token: {
      expires_in: 3600,
      access_token: jwt({
        organization: 901,
        iss: 'deployment-test',
        deployment_id: 'deployment-test',
        aud: ['web-api'],
        device_id: deviceId,
        exp: Math.floor(Date.now() / 1000) + 3600
      }),
      refresh_token: 'refresh-token'
    },
    user: {
      id: 7,
      user_id: 'user-7',
      account: 'qa-user',
      nickname: '测试用户'
    },
    ...overrides
  }
}

test('registration sends password confirmation and persists only the normalized session', async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
  const webIm = await import(`../src/services/webIm.ts?register=${Date.now()}`)
  const deviceId = webIm.getWebDeviceId()

  globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    })
    return new Response(JSON.stringify({ code: 200, data: loginPayload(deviceId) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  try {
    const session = await webIm.registerWebIm(config, {
      account: 'qa-user',
      nickname: '测试用户',
      password: 'password-123',
      passwordConfirm: 'password-123',
      uuid: '11111111-2222-4333-8444-555555555555',
      code: 'AbCd'
    })
    webIm.saveWebSession(session)

    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, 'https://api.example.test/saimulti/web/im/register')
    assert.equal(requests[0].headers.get('App-Id'), '901')
    assert.equal(requests[0].body.device_id, deviceId)
    assert.equal(requests[0].body.password_confirm, 'password-123')
    assert.equal(session.organization, '901')
    assert.equal(session.deploymentId, 'deployment-test')
    assert.ok(storage.allValues().every((value) => !value.includes('browser-secret')))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('QR flow accepts consumed and validates a confirmed session before returning it', async () => {
  const originalFetch = globalThis.fetch
  const webIm = await import(`../src/services/webIm.ts?qr=${Date.now()}`)
  const deviceId = webIm.getWebDeviceId()
  let pollCount = 0
  const requestBodies: Record<string, unknown>[] = []

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    requestBodies.push(body)
    let data: unknown
    if (url.pathname.endsWith('/create')) {
      data = {
        qr_id: 'qr-session-1',
        browser_token: 'browser-secret',
        qr_content: 'b8im://qr-login/qr-session-1',
        expires_at: Math.floor(Date.now() / 1000) + 120
      }
    } else if (url.pathname.endsWith('/poll')) {
      pollCount += 1
      data = pollCount === 1
        ? { status: 'consumed' }
        : { status: 'confirmed', ...loginPayload(deviceId) }
    } else {
      data = null
    }
    return new Response(JSON.stringify({ code: 200, data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  try {
    const secret = await webIm.createQrLogin(config)
    const consumed = await webIm.pollQrLogin(config, secret)
    const confirmed = await webIm.pollQrLogin(config, secret)
    await webIm.cancelQrLogin(config, secret)

    assert.equal(consumed.status, 'consumed')
    assert.equal(consumed.session, null)
    assert.equal(confirmed.status, 'confirmed')
    assert.equal(confirmed.session.organization, '901')
    assert.ok(requestBodies.every((body) => body.device_id === deviceId))
    assert.ok(requestBodies.slice(1).every((body) => body.browser_token === 'browser-secret'))
    assert.ok(storage.allValues().every((value) => !value.includes('browser-secret')))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('account policy requires an explicit boolean register flag', async () => {
  const originalFetch = globalThis.fetch
  const webIm = await import(`../src/services/webIm.ts?policy=${Date.now()}`)
  let registerEnabled: unknown = true
  globalThis.fetch = async () => new Response(JSON.stringify({
    code: 200,
    data: { register_enabled: registerEnabled }
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })

  try {
    assert.deepEqual(await webIm.fetchWebAccountPolicy(config), { registerEnabled: true })
    registerEnabled = 1
    await assert.rejects(() => webIm.fetchWebAccountPolicy(config), /register_enabled 格式无效/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('confirmed QR login rejects organization, deployment and JWT context mismatch', async () => {
  const originalFetch = globalThis.fetch
  const webIm = await import(`../src/services/webIm.ts?mismatch=${Date.now()}`)
  const deviceId = webIm.getWebDeviceId()
  let responseData = { status: 'confirmed', ...loginPayload(deviceId, { organization: 902 }) }
  globalThis.fetch = async () => new Response(JSON.stringify({
    code: 200,
    data: responseData
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })

  try {
    await assert.rejects(
      () => webIm.pollQrLogin(config, { qrId: 'qr-session-2', browserToken: 'browser-secret-2' }),
      /organization 与发现上下文不一致/
    )

    responseData = { status: 'confirmed', ...loginPayload(deviceId, { deployment_id: 'another-deployment' }) }
    await assert.rejects(
      () => webIm.pollQrLogin(config, { qrId: 'qr-session-2', browserToken: 'browser-secret-2' }),
      /deployment_id 与发现上下文不一致/
    )

    const wrongJwt = loginPayload('web-wrong-device')
    responseData = { status: 'confirmed', ...wrongJwt }
    await assert.rejects(
      () => webIm.pollQrLogin(config, { qrId: 'qr-session-2', browserToken: 'browser-secret-2' }),
      /web-api 凭证与当前部署或机构不一致/
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { requestWebApi, requestWebApiWithUpload } from '../src/services/apiClient.ts'
import {
  createTraceContext,
  setTelemetryObserverForTests,
  type TelemetrySpanSnapshot
} from '../src/services/telemetry.ts'
import type { TenantBrandConfig } from '../src/services/tenantConfig.ts'

const config = {
  organization: '1',
  discovered: true,
  serverInfo: {
    routingVersion: 1,
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
    apiServerUrl: 'https://api.example.test'
  }
} as TenantBrandConfig

test('fetch API injects W3C headers without recording authorization or body', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  const snapshots: TelemetrySpanSnapshot[] = []
  let capturedHeaders: Headers | null = null
  let capturedUrl = ''
  Object.assign(globalThis, { window: globalThis })
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input)
    capturedHeaders = new Headers(init?.headers)
    return new Response(JSON.stringify({ code: 200, data: { ok: true } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }
  setTelemetryObserverForTests((snapshot) => snapshots.push(snapshot))

  try {
    const parent = createTraceContext()
    const result = await requestWebApi<{ ok: boolean }>(config, '/saimulti/web/im/login', {
      method: 'POST',
      token: 'secret-access-token',
      body: { account: 'qa-user', password: 'secret-password' },
      traceContext: { ...parent, tracestate: 'vendor=opaque' }
    })

    assert.deepEqual(result, { ok: true })
    assert.equal(capturedUrl, 'https://api.example.test/saimulti/web/im/login')
    assert.ok(capturedHeaders)
    assert.match(capturedHeaders.get('traceparent') ?? '', /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    assert.equal(
      capturedHeaders.get('traceparent')?.slice(3, 35),
      parent.traceparent.slice(3, 35)
    )
    assert.equal(capturedHeaders.get('tracestate'), 'vendor=opaque')
    assert.equal(capturedHeaders.get('Authorization'), 'Bearer secret-access-token')
    assert.equal(snapshots.length, 2)
    assert.ok(snapshots.every((snapshot) => snapshot.status === 'OK'))
    assert.doesNotMatch(
      JSON.stringify(snapshots),
      /secret-access-token|secret-password|qa-user|Authorization|body/
    )
  } finally {
    setTelemetryObserverForTests(null)
    globalThis.fetch = originalFetch
    Object.assign(globalThis, { window: originalWindow })
  }
})

test('XHR upload injects W3C headers and keeps upload payload out of telemetry', async () => {
  const originalWindow = globalThis.window
  const originalXhr = globalThis.XMLHttpRequest
  const snapshots: TelemetrySpanSnapshot[] = []
  let latestXhr: FakeXMLHttpRequest | null = null

  class FakeXMLHttpRequest {
    status = 200
    responseText = JSON.stringify({ code: 200, data: { file_id: 'safe-id' } })
    timeout = 0
    withCredentials = false
    upload: { onprogress?: (event: ProgressEvent) => void } = {}
    onerror: (() => void) | null = null
    ontimeout: (() => void) | null = null
    onload: (() => void) | null = null
    readonly headers = new Map<string, string>()

    constructor() {
      latestXhr = this
    }

    open(_method: string, _url: string, _async: boolean) {}

    setRequestHeader(name: string, value: string) {
      this.headers.set(name.toLowerCase(), value)
    }

    send(_body: Document | XMLHttpRequestBodyInit | null) {
      queueMicrotask(() => this.onload?.())
    }
  }

  Object.assign(globalThis, {
    window: globalThis,
    XMLHttpRequest: FakeXMLHttpRequest
  })
  setTelemetryObserverForTests((snapshot) => snapshots.push(snapshot))

  try {
    const body = new FormData()
    body.set('file', 'private-upload-content')
    const result = await requestWebApiWithUpload<{ file_id: string }>(config, '/saimulti/web/im/upload', {
      token: 'secret-upload-token',
      body
    })

    assert.deepEqual(result, { file_id: 'safe-id' })
    assert.ok(latestXhr)
    assert.match(latestXhr.headers.get('traceparent') ?? '', /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    assert.equal(latestXhr.headers.get('authorization'), 'Bearer secret-upload-token')
    assert.equal(snapshots.length, 1)
    assert.equal(snapshots[0].status, 'OK')
    assert.doesNotMatch(
      JSON.stringify(snapshots),
      /secret-upload-token|private-upload-content|Authorization|body/
    )
  } finally {
    setTelemetryObserverForTests(null)
    Object.assign(globalThis, {
      window: originalWindow,
      XMLHttpRequest: originalXhr
    })
  }
})

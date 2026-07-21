import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GroupAccessSnapshotStore,
  setGroupAccessNotReady,
  type CommittedGroupAccessSnapshot,
  type GroupAccessEntry
} from '../src/services/groupMemberAccess.ts'
import {
  ConversationAccessEpochChangedError,
  observeConversationAccessSnapshot
} from '../src/services/conversationAccess.ts'
import { uploadImAsset } from '../src/services/webIm.ts'
import type { TenantBrandConfig } from '../src/services/tenantConfig.ts'
import type { WebImSession } from '../src/types.ts'

const organization = '934'
const userId = 'upload-reservation-user'
const conversationId = 'group_upload_reservation'
const uploadId = 'a'.repeat(64)
const fileId = 'b'.repeat(40)
const config = {
  organization,
  discovered: true,
  serverInfo: {
    routes: [{
      routeId: 'primary',
      endpoints: {
        apiServerUrl: 'https://api.example.test',
        imServerUrl: 'wss://ws.example.test',
        uploadServerUrl: 'https://api.example.test',
        webServerUrl: 'https://web.example.test'
      }
    }],
    apiServerUrl: 'https://api.example.test'
  }
} as TenantBrandConfig
const session = {
  accessToken: '',
  organization,
  user: { userId }
} as WebImSession
const file = new File(['hello'], 'note.txt', { type: 'text/plain' })

function prepared(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'proxy',
    method: 'POST',
    upload_path: '/saimulti/web/im/upload',
    upload_id: uploadId,
    expires_at: 2_000_000_000,
    filename: file.name,
    size: file.size,
    mime_type: file.type,
    extension: 'txt',
    ...overrides
  }
}

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify({ code: 200, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

interface FakeXhrOptions {
  respond?: boolean
  responseData?: Record<string, unknown>
}

function installFakeXhr(options: FakeXhrOptions = {}) {
  let latest: FakeXMLHttpRequest | null = null
  class FakeXMLHttpRequest {
    status = 200
    responseText = JSON.stringify({
      code: 200,
      data: options.responseData ?? {
        file_id: fileId,
        kind: 'file',
        name: file.name,
        size: file.size,
        mime_type: file.type,
        extension: 'txt'
      }
    })
    timeout = 0
    withCredentials = false
    upload: { onprogress?: (event: ProgressEvent) => void } = {}
    onerror: (() => void) | null = null
    ontimeout: (() => void) | null = null
    onabort: (() => void) | null = null
    onload: (() => void) | null = null
    sentBody: Document | XMLHttpRequestBodyInit | null = null
    aborted = false

    constructor() {
      latest = this
    }

    open(_method: string, _url: string, _async: boolean) {}

    setRequestHeader(_name: string, _value: string) {}

    send(body: Document | XMLHttpRequestBodyInit | null) {
      this.sentBody = body
      if (options.respond !== false) queueMicrotask(() => this.onload?.())
    }

    abort() {
      this.aborted = true
      this.onabort?.()
    }
  }

  Object.assign(globalThis, { XMLHttpRequest: FakeXMLHttpRequest })
  return {
    latest: () => latest,
    respond: () => latest?.onload?.()
  }
}

function jwt(payload: Record<string, unknown>) {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode(payload)}.signature`
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('timed out waiting for upload request')
}

function groupAccess(): CommittedGroupAccessSnapshot {
  const entry: GroupAccessEntry = {
    conversationId,
    conversationType: 2,
    accessVersion: '1',
    accessState: 'active',
    lastMessageSeq: '0',
    lastChangeSeq: '0',
    periods: [{ periodNo: '1', fromSeq: '1', toSeq: null }]
  }
  return { snapshotId: '1', entries: new Map([[conversationId, entry]]) }
}

test('prepare payload rejects invalid proxy path, upload id, and expiration', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  const originalXhr = globalThis.XMLHttpRequest
  Object.assign(globalThis, { window: globalThis })
  let xhrCount = 0
  class UnexpectedXMLHttpRequest {
    constructor() {
      xhrCount += 1
    }
  }
  Object.assign(globalThis, { XMLHttpRequest: UnexpectedXMLHttpRequest })

  try {
    const cases = [
      { upload_path: '/saimulti/app/im/upload' },
      { upload_id: 'A'.repeat(64) },
      { expires_at: Math.floor(Date.now() / 1000) - 60 }
    ]
    for (const overrides of cases) {
      const calls: string[] = []
      globalThis.fetch = async (input) => {
        const path = new URL(String(input)).pathname
        calls.push(path)
        return path.endsWith('/releaseUpload')
          ? jsonResponse({ released: true })
          : jsonResponse(prepared(overrides))
      }

      await assert.rejects(
        uploadImAsset(config, session, file, 'file'),
        /上传准备响应格式无效/
      )
      assert.equal(calls[0], '/saimulti/web/im/prepareUpload')
      assert.equal(
        calls.includes('/saimulti/web/im/releaseUpload'),
        overrides.upload_id === undefined
      )
    }
    assert.equal(xhrCount, 0)
  } finally {
    Object.assign(globalThis, {
      window: originalWindow,
      fetch: originalFetch,
      XMLHttpRequest: originalXhr
    })
  }
})

test('prepare sends one secure idempotency key and upload multipart sends only upload_id metadata', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  const originalXhr = globalThis.XMLHttpRequest
  Object.assign(globalThis, { window: globalThis })
  const xhr = installFakeXhr()
  let prepareBody: Record<string, unknown> = {}
  const paths: string[] = []
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname
    paths.push(path)
    prepareBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return jsonResponse(prepared())
  }

  try {
    const asset = await uploadImAsset(config, session, file, 'file')
    assert.match(String(prepareBody.idempotency_key), /^[0-9a-f]{32}$/)
    assert.deepEqual(Object.keys(prepareBody).sort(), [
      'filename',
      'idempotency_key',
      'kind',
      'mime_type',
      'size'
    ])
    const body = xhr.latest()?.sentBody
    assert.ok(body instanceof FormData)
    assert.deepEqual(Array.from(body.keys()).sort(), ['file', 'upload_id'])
    assert.equal(body.get('upload_id'), uploadId)
    assert.equal(body.get('kind'), null)
    assert.equal(asset.fileId, fileId)
    assert.deepEqual(paths, ['/saimulti/web/im/prepareUpload'])
  } finally {
    Object.assign(globalThis, {
      window: originalWindow,
      fetch: originalFetch,
      XMLHttpRequest: originalXhr
    })
  }
})

test('empty browser MIME is canonicalized to application/octet-stream for the whole intent', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  const originalXhr = globalThis.XMLHttpRequest
  Object.assign(globalThis, { window: globalThis })
  const unknownMimeFile = new File(['unknown'], 'unknown.txt')
  installFakeXhr({
    responseData: {
      file_id: fileId,
      kind: 'file',
      name: unknownMimeFile.name,
      size: unknownMimeFile.size,
      mime_type: 'application/octet-stream',
      extension: 'txt'
    }
  })
  let prepareBody: Record<string, unknown> = {}
  globalThis.fetch = async (_input, init) => {
    prepareBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return jsonResponse(prepared({
      filename: unknownMimeFile.name,
      size: unknownMimeFile.size,
      mime_type: 'application/octet-stream'
    }))
  }

  try {
    const asset = await uploadImAsset(config, session, unknownMimeFile, 'file')
    assert.equal(prepareBody.mime_type, 'application/octet-stream')
    assert.equal(asset.mimeType, 'application/octet-stream')
  } finally {
    Object.assign(globalThis, {
      window: originalWindow,
      fetch: originalFetch,
      XMLHttpRequest: originalXhr
    })
  }
})

test('filename whitespace is canonicalized before prepare and multipart upload', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  const originalXhr = globalThis.XMLHttpRequest
  Object.assign(globalThis, { window: globalThis })
  const spacedFile = new File(['hello'], ' note.txt ', { type: 'text/plain' })
  const xhr = installFakeXhr({
    responseData: {
      file_id: fileId,
      kind: 'file',
      name: 'note.txt',
      size: spacedFile.size,
      mime_type: 'text/plain',
      extension: 'txt'
    }
  })
  let prepareBody: Record<string, unknown> = {}
  globalThis.fetch = async (_input, init) => {
    prepareBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return jsonResponse(prepared({
      filename: 'note.txt',
      size: spacedFile.size,
      mime_type: 'text/plain',
      extension: 'txt'
    }))
  }

  try {
    const asset = await uploadImAsset(config, session, spacedFile, 'file')
    assert.equal(prepareBody.filename, 'note.txt')
    const body = xhr.latest()?.sentBody
    assert.ok(body instanceof FormData)
    const uploadedFile = body.get('file')
    assert.ok(uploadedFile instanceof File)
    assert.equal(uploadedFile.name, 'note.txt')
    assert.equal(asset.name, 'note.txt')
  } finally {
    Object.assign(globalThis, {
      window: originalWindow,
      fetch: originalFetch,
      XMLHttpRequest: originalXhr
    })
  }
})

test('group access cancellation aborts upload and releases through a fresh request', async () => {
  const store = new GroupAccessSnapshotStore(organization, userId, null)
  await store.commit(groupAccess(), () => {})
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  const originalXhr = globalThis.XMLHttpRequest
  Object.assign(globalThis, { window: globalThis })
  const xhr = installFakeXhr({ respond: false })
  const calls: Array<{ path: string; body: Record<string, unknown>; signal: AbortSignal | null }> = []
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname
    calls.push({
      path,
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {},
      signal: init?.signal ?? null
    })
    return path.endsWith('/releaseUpload')
      ? jsonResponse({ released: true })
      : jsonResponse(prepared())
  }

  try {
    const pending = uploadImAsset(config, session, file, 'file', {
      conversationType: 'group',
      conversationId
    })
    await waitFor(() => xhr.latest() !== null)
    setGroupAccessNotReady(organization, userId)

    await assert.rejects(pending, (error: unknown) =>
      error instanceof DOMException && error.name === 'AbortError'
    )
    assert.equal(xhr.latest()?.aborted, true)
    assert.deepEqual(calls.map((call) => call.path), [
      '/saimulti/web/im/prepareUpload',
      '/saimulti/web/im/releaseUpload'
    ])
    assert.deepEqual(calls[1].body, { upload_id: uploadId })
    assert.equal(calls[1].signal?.aborted, false)
  } finally {
    setGroupAccessNotReady(organization, userId)
    Object.assign(globalThis, {
      window: originalWindow,
      fetch: originalFetch,
      XMLHttpRequest: originalXhr
    })
  }
})

test('server-confirmed upload is not released when the local access epoch changes', async () => {
  const epochOrganization = '935'
  const epochUserId = 'upload-epoch-user'
  const epochConfig = {
    ...config,
    organization: epochOrganization
  } as TenantBrandConfig
  const epochSession = {
    ...session,
    organization: epochOrganization,
    accessToken: jwt({
      organization: epochOrganization,
      user_id: epochUserId
    }),
    user: { userId: epochUserId }
  } as WebImSession
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  const originalXhr = globalThis.XMLHttpRequest
  Object.assign(globalThis, { window: globalThis })
  const xhr = installFakeXhr({ respond: false })
  const paths: string[] = []
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname
    paths.push(path)
    return path.endsWith('/releaseUpload')
      ? jsonResponse({ released: false, state: 'confirmed' })
      : jsonResponse(prepared())
  }

  try {
    assert.equal(
      observeConversationAccessSnapshot(epochOrganization, epochUserId, '100'),
      'new'
    )
    const pending = uploadImAsset(epochConfig, epochSession, file, 'file')
    await waitFor(() => xhr.latest() !== null)
    assert.equal(
      observeConversationAccessSnapshot(epochOrganization, epochUserId, '101'),
      'new'
    )
    xhr.respond()
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof ConversationAccessEpochChangedError
    )
    assert.deepEqual(paths, ['/saimulti/web/im/prepareUpload'])
  } finally {
    Object.assign(globalThis, {
      window: originalWindow,
      fetch: originalFetch,
      XMLHttpRequest: originalXhr
    })
  }
})

test('confirmed upload success never calls releaseUpload', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  const originalXhr = globalThis.XMLHttpRequest
  Object.assign(globalThis, { window: globalThis })
  installFakeXhr()
  const paths: string[] = []
  globalThis.fetch = async (input) => {
    paths.push(new URL(String(input)).pathname)
    return jsonResponse(prepared())
  }

  try {
    await assert.doesNotReject(uploadImAsset(config, session, file, 'file'))
    assert.deepEqual(paths, ['/saimulti/web/im/prepareUpload'])
  } finally {
    Object.assign(globalThis, {
      window: originalWindow,
      fetch: originalFetch,
      XMLHttpRequest: originalXhr
    })
  }
})

test('confirmed response validates file id and all reserved metadata without release', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  const originalXhr = globalThis.XMLHttpRequest
  Object.assign(globalThis, { window: globalThis })
  try {
    const cases = [
      {
        responseData: {
          file_id: 'invalid',
          kind: 'file',
          name: file.name,
          size: file.size,
          mime_type: file.type,
          extension: 'txt'
        },
        error: /上传响应缺少可信 file_id/
      },
      {
        responseData: {
          file_id: fileId,
          kind: 'file',
          name: file.name,
          size: file.size,
          mime_type: file.type,
          extension: 'pdf'
        },
        error: /上传响应与预留意图不一致/
      }
    ]
    for (const item of cases) {
      installFakeXhr({ responseData: item.responseData })
      const paths: string[] = []
      globalThis.fetch = async (input) => {
        paths.push(new URL(String(input)).pathname)
        return jsonResponse(prepared())
      }
      await assert.rejects(
        uploadImAsset(config, session, file, 'file'),
        item.error
      )
      assert.deepEqual(paths, ['/saimulti/web/im/prepareUpload'])
    }
  } finally {
    Object.assign(globalThis, {
      window: originalWindow,
      fetch: originalFetch,
      XMLHttpRequest: originalXhr
    })
  }
})

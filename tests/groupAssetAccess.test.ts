import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GroupAccessSnapshotStore,
  groupAccessTaskCount,
  setGroupAccessNotReady,
  type CommittedGroupAccessSnapshot,
  type GroupAccessEntry
} from '../src/services/groupMemberAccess.ts'
import { resolveImAssetUrl } from '../src/services/webIm.ts'
import type { TenantBrandConfig } from '../src/services/tenantConfig.ts'
import type { WebImSession } from '../src/types.ts'

const organization = '934'
const userId = 'asset-epoch-user'
const conversationId = 'group_asset'
const fileId = 'a'.repeat(40)
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
  accessToken: '', organization, user: { userId }
} as WebImSession

function access(snapshotId: string): CommittedGroupAccessSnapshot {
  const entry: GroupAccessEntry = {
    conversationId,
    conversationType: 2,
    accessVersion: snapshotId,
    accessState: 'active',
    lastMessageSeq: '20',
    lastChangeSeq: '1',
    periods: [{ periodNo: '1', fromSeq: '5', toSeq: null }]
  }
  return { snapshotId, entries: new Map([[conversationId, entry]]) }
}

test('revocation aborts delayed group asset URL work and stale response never seeds cache', async () => {
  const store = new GroupAccessSnapshotStore(organization, userId, null)
  await store.commit(access('1'), () => {})
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  Object.assign(globalThis, { window: globalThis })
  let requestCount = 0
  let capturedSignal: AbortSignal | null = null
  globalThis.fetch = (_input, init) => {
    requestCount += 1
    capturedSignal = init?.signal ?? null
    return new Promise<Response>((_resolve, reject) => {
      capturedSignal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'))
      }, { once: true })
    })
  }

  try {
    const pending = resolveImAssetUrl(config, session, {
      fileId,
      conversationId,
      messageId: 'message-10',
      conversationType: 'group',
      messageSeq: 10
    })
    await Promise.resolve()
    assert.equal(groupAccessTaskCount(organization, userId), 1)
    setGroupAccessNotReady(organization, userId)
    assert.equal(capturedSignal?.aborted, true)
    await assert.rejects(pending, (error: unknown) =>
      error instanceof DOMException && error.name === 'AbortError'
    )
    assert.equal(groupAccessTaskCount(organization, userId), 0)

    await store.commit(access('2'), () => {})
    globalThis.fetch = async () => {
      requestCount += 1
      return new Response(JSON.stringify({
        code: 200,
        data: {
          file_id: fileId,
          url: 'https://assets.example.test/rejoined',
          expires_at: Math.floor(Date.now() / 1000) + 600
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    const url = await resolveImAssetUrl(config, session, {
      fileId,
      conversationId,
      messageId: 'message-10',
      conversationType: 'group',
      messageSeq: 10
    })
    assert.equal(url, 'https://assets.example.test/rejoined')
    assert.equal(requestCount, 2)
  } finally {
    globalThis.fetch = originalFetch
    Object.assign(globalThis, { window: originalWindow })
  }
})

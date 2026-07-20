import assert from 'node:assert/strict'
import test from 'node:test'
import { GroupAccessSnapshotStore, type GroupAccessEntry } from '../src/services/groupMemberAccess.ts'
import { fetchMessages, searchConversationMessages } from '../src/services/webIm.ts'
import type { TenantBrandConfig } from '../src/services/tenantConfig.ts'
import type { WebImSession } from '../src/types.ts'

const organization = '935'
const userId = 'message-ingress-user'
const conversationId = 'group_periods'
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
const session = { accessToken: '', organization, user: { userId } } as WebImSession

function message(messageSeq: number) {
  return { conversation_id: conversationId, message_seq: messageSeq }
}

function response(data: unknown) {
  return new Response(JSON.stringify({ code: 200, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

test('HTTP history and conversation search reject an entire page at period gaps and to_seq + 1', async () => {
  const entry: GroupAccessEntry = {
    conversationId,
    conversationType: 2,
    accessVersion: '1',
    accessState: 'history_only',
    lastMessageSeq: '20',
    lastChangeSeq: '1',
    periods: [
      { periodNo: '1', fromSeq: '2', toSeq: '4' },
      { periodNo: '2', fromSeq: '9', toSeq: '11' }
    ]
  }
  await new GroupAccessSnapshotStore(organization, userId, null).commit({
    snapshotId: '1', entries: new Map([[conversationId, entry]])
  }, () => {})
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  Object.assign(globalThis, { window: globalThis })
  try {
    globalThis.fetch = async () => response({
      messages: [message(2), message(4), message(9), message(11)],
      next_after_seq: 11,
      next_before_seq: 2,
      has_more_before: false
    })
    const valid = await fetchMessages(config, session, {
      conversationId,
      conversationType: 'group'
    })
    assert.deepEqual(valid.messages.map((item) => item.message_seq), [2, 4, 9, 11])

    for (const invalidSeq of [5, 12]) {
      globalThis.fetch = async () => response({
        messages: [message(4), message(invalidSeq)],
        next_after_seq: invalidSeq,
        next_before_seq: 4,
        has_more_before: false
      })
      await assert.rejects(fetchMessages(config, session, {
        conversationId,
        conversationType: 'group'
      }), /超出成员可见周期/)

      globalThis.fetch = async () => response([message(4), message(invalidSeq)])
      await assert.rejects(searchConversationMessages(config, session, {
        conversationId,
        conversationType: 'group',
        keyword: 'period'
      }), /超出成员可见周期/)
    }
  } finally {
    globalThis.fetch = originalFetch
    Object.assign(globalThis, { window: originalWindow })
  }
})

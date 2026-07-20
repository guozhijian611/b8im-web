import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseSearchHit,
  searchMessagesFull,
  searchSenderLabel,
  serializeSearchMessagesQuery,
  type SearchMessagesQuery
} from '../src/services/search.ts'
import type { TenantBrandConfig } from '../src/services/tenantConfig.ts'
import type { WebImSession } from '../src/types.ts'

const config = {
  organization: '901',
  discovered: true,
  serverInfo: {
    routingVersion: 1,
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

const session = { accessToken: '' } as WebImSession

function row(senderOrganization: unknown, senderUserId: unknown, messageId = 'message-1') {
  return {
    message_id: messageId,
    conversation_id: 'conversation-1',
    sender_organization: senderOrganization,
    sender_user_id: senderUserId,
    message_type: 1,
    message_seq: 1,
    content: 'hello',
    sent_at: '2026-07-20 12:00:00'
  }
}

test('消息搜索保留同名用户的机构维度并显示显式复合身份', () => {
  const first = parseSearchHit(row(901, 'same-user', 'message-1'))
  const second = parseSearchHit(row(902, 'same-user', 'message-2'))

  assert.equal(first.senderUserId, second.senderUserId)
  assert.notEqual(first.senderOrganization, second.senderOrganization)
  assert.equal(searchSenderLabel(first), '机构 901 · same-user')
  assert.equal(searchSenderLabel(second), '机构 902 · same-user')
})

test('消息搜索结果缺少或伪造发送机构时失败关闭', () => {
  for (const value of [
    undefined,
    null,
    0,
    -1,
    1.5,
    '901',
    Number.NaN,
    Number.MAX_SAFE_INTEGER + 1
  ]) {
    assert.throws(
      () => parseSearchHit(row(value, 'sender')),
      /sender_organization 无效/,
      String(value)
    )
  }
})

test('消息搜索结果只接受 canonical 非空发送用户 ID', () => {
  for (const value of [
    undefined,
    null,
    '',
    ' sender',
    'sender ',
    7,
    'bad|id',
    'bad\0id',
    'bad\tid',
    'bad\nid',
    'bad\vid',
    'bad\rid',
    '界'.repeat(22),
    'x'.repeat(65)
  ]) {
    assert.throws(
      () => parseSearchHit(row(901, value)),
      /sender_user_id 无效/,
      String(value)
    )
  }
  assert.equal(
    parseSearchHit(row(901, '界'.repeat(21))).senderUserId,
    '界'.repeat(21)
  )
  for (const value of ['\fidentity\f', '\u00a0identity\u00a0']) {
    assert.equal(parseSearchHit(row(901, value)).senderUserId, value)
  }
})

test('消息搜索固定 DTO 的其余字段缺失或类型错误时失败关闭', () => {
  const invalidIds: unknown[] = [
    undefined,
    null,
    '',
    ' id',
    'id ',
    7,
    'bad|id',
    'bad\0id',
    'bad\tid',
    'bad\nid',
    'bad\vid',
    'bad\rid',
    '界'.repeat(22),
    'x'.repeat(65)
  ]
  const invalidPositiveIntegers: unknown[] = [
    undefined,
    null,
    0,
    -1,
    1.5,
    '1',
    Number.NaN,
    Number.MAX_SAFE_INTEGER + 1
  ]
  const cases: Array<[string, unknown[]]> = [
    ['message_id', invalidIds],
    ['conversation_id', invalidIds],
    ['message_type', invalidPositiveIntegers],
    ['message_seq', invalidPositiveIntegers],
    ['content', [undefined, null, 7, {}]],
    ['sent_at', [undefined, '', '   ', 7, {}]]
  ]

  for (const [field, values] of cases) {
    for (const value of values) {
      assert.throws(
        () => parseSearchHit({ ...row(901, 'sender'), [field]: value }),
        new RegExp(`${field} 无效`),
        `${field}: ${String(value)}`
      )
    }
  }

  const nullableTime = parseSearchHit({ ...row(901, 'sender'), sent_at: null })
  const emptyContent = parseSearchHit({ ...row(901, 'sender'), content: '' })
  assert.equal(nullableTime.sentAt, null)
  assert.equal(emptyContent.content, '')
})

test('发送人筛选必须成对序列化，纯 q 查询保持有效', async () => {
  assert.deepEqual(serializeSearchMessagesQuery({ q: 'hello' }), { q: 'hello' })
  assert.deepEqual(
    serializeSearchMessagesQuery({
      q: 'hello',
      sender_organization: 902,
      sender_user_id: 'same-user'
    }),
    {
      q: 'hello',
      sender_organization: 902,
      sender_user_id: 'same-user'
    }
  )

  for (const halfPair of [
    { q: 'hello', sender_organization: 902 },
    { q: 'hello', sender_user_id: 'same-user' }
  ]) {
    assert.throws(
      () => serializeSearchMessagesQuery(halfPair as SearchMessagesQuery),
      /必须同时提供/
    )
  }
  assert.throws(
    () => serializeSearchMessagesQuery({
      q: 'hello',
      sender_organization: 0,
      sender_user_id: 'same-user'
    }),
    /sender_organization 无效/
  )
  assert.throws(
    () => serializeSearchMessagesQuery({
      q: 'hello',
      sender_organization: 902,
      sender_user_id: ' same-user'
    }),
    /sender_user_id 无效/
  )

  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  let capturedUrl: URL | null = null
  Object.assign(globalThis, { window: globalThis })
  globalThis.fetch = async (input) => {
    capturedUrl = new URL(String(input))
    return new Response(JSON.stringify({
      code: 200,
      data: {
        current_page: 1,
        per_page: 50,
        total: 2,
        backend: 'mysql',
        data: [
          row(901, 'same-user', 'message-1'),
          row(902, 'same-user', 'message-2')
        ]
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  try {
    const result = await searchMessagesFull(config, session, {
      q: 'hello',
      sender_organization: 902,
      sender_user_id: 'same-user'
    })
    assert.equal(capturedUrl?.searchParams.get('sender_organization'), '902')
    assert.equal(capturedUrl?.searchParams.get('sender_user_id'), 'same-user')
    assert.deepEqual(
      result.items.map((item) => searchSenderLabel(item)),
      ['机构 901 · same-user', '机构 902 · same-user']
    )
  } finally {
    globalThis.fetch = originalFetch
    Object.assign(globalThis, { window: originalWindow })
  }
})

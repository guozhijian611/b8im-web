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
import {
  GroupAccessSnapshotStore,
  setGroupAccessNotReady,
  type GroupAccessEntry
} from '../src/services/groupMemberAccess.ts'

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

const session = {
  accessToken: '',
  organization: '901',
  user: { userId: 'search-user' }
} as WebImSession
const UINT64_MAX = '18446744073709551615'

function row(
  senderOrganization: unknown,
  senderUserId: unknown,
  messageId = 'message-1',
  conversationType: unknown = 1,
  conversationId = 'conversation-1',
  messageSeq: unknown = '1'
) {
  return {
    message_id: messageId,
    conversation_id: conversationId,
    conversation_type: conversationType,
    sender_organization: senderOrganization,
    sender_user_id: senderUserId,
    message_type: 1,
    message_seq: messageSeq,
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
    ['conversation_type', [undefined, null, 0, 3, '1', 1.5, Number.NaN]],
    ['message_type', invalidPositiveIntegers],
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
  assert.equal(parseSearchHit(row(901, 'sender', 'single', 1)).conversationType, 'single')
  assert.equal(parseSearchHit(row(901, 'sender', 'group', 2)).conversationType, 'group')
})

test('消息搜索 message_seq 保留 canonical uint64 decimal string', () => {
  assert.equal(
    parseSearchHit(row(901, 'sender', 'uint64-max', 1, 'single-max', UINT64_MAX)).messageSeq,
    UINT64_MAX
  )
  for (const value of [
    undefined,
    null,
    '',
    '0',
    '01',
    '+1',
    '-1',
    '18446744073709551616',
    1,
    Number.MAX_SAFE_INTEGER,
    1n
  ]) {
    assert.throws(
      () => parseSearchHit({
        ...row(901, 'sender', 'invalid-seq', 1, 'single-invalid'),
        message_seq: value
      }),
      /message_seq 无效/,
      String(value)
    )
  }
})

test('商业全文搜索整页原子拒绝缺席、period gap 与非法类型的群结果', async () => {
  const scopedSession = {
    ...session,
    user: { ...session.user, userId: 'group-search-page-user' }
  }
  const groupId = 'search-group-periods'
  const entry: GroupAccessEntry = {
    conversationId: groupId,
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
  await new GroupAccessSnapshotStore('901', 'group-search-page-user', null).commit({
    snapshotId: '1',
    entries: new Map([[groupId, entry]])
  }, () => {})

  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  Object.assign(globalThis, { window: globalThis })
  const searchResponse = (data: Array<Record<string, unknown>>) => new Response(JSON.stringify({
    code: 200,
    data: { current_page: 1, per_page: 20, total: data.length, backend: 'mysql', data }
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })

  try {
    globalThis.fetch = async () => searchResponse([
      row(901, 'single-user', 'single-valid', 1),
      row(901, 'single-user', 'single-uint64-max', 1, 'single-max', UINT64_MAX),
      row(901, 'group-user', 'group-valid-a', 2, groupId, '4'),
      row(901, 'group-user', 'group-valid-b', 2, groupId, '9')
    ])
    const valid = await searchMessagesFull(config, scopedSession, { q: 'valid' })
    assert.deepEqual(
      valid.items.map((item) => [item.conversationType, item.messageSeq]),
      [
        ['single', '1'],
        ['single', UINT64_MAX],
        ['group', '4'],
        ['group', '9']
      ]
    )

    const invalidPages = [
      {
        label: 'revoked/missing group',
        rows: [
          row(901, 'single-user', 'single-before-revoked', 1),
          row(901, 'revoked-user', 'revoked-group-hit', 2, 'revoked-group', '3')
        ],
        pattern: /超出群成员可见周期/
      },
      {
        label: 'period gap',
        rows: [
          row(901, 'single-user', 'single-before-gap', 1),
          row(901, 'group-user', 'group-gap-hit', 2, groupId, '5')
        ],
        pattern: /超出群成员可见周期/
      },
      {
        label: 'invalid type',
        rows: [
          row(901, 'single-user', 'single-before-type', 1),
          row(901, 'invalid-user', 'invalid-type-hit', 3, groupId, '4')
        ],
        pattern: /conversation_type 无效/
      },
      {
        label: 'single/group identity conflict',
        rows: [
          row(901, 'single-user', 'single-before-conflict', 1),
          row(901, 'conflict-user', 'single-conflict-hit', 1, groupId, '4')
        ],
        pattern: /会话类型与群访问快照冲突/
      }
    ]
    for (const invalid of invalidPages) {
      let publishedItems: ReturnType<typeof parseSearchHit>[] = []
      globalThis.fetch = async () => searchResponse(invalid.rows)
      await assert.rejects(
        searchMessagesFull(config, scopedSession, { q: invalid.label }).then((page) => {
          publishedItems = page.items
        }),
        invalid.pattern,
        invalid.label
      )
      assert.deepEqual(publishedItems, [], `${invalid.label} 不得发布部分结果`)
    }
  } finally {
    globalThis.fetch = originalFetch
    Object.assign(globalThis, { window: originalWindow })
  }
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
    await new GroupAccessSnapshotStore('901', 'search-user', null).commit({
      snapshotId: '1',
      entries: new Map()
    }, () => {})
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

test('服务端全文搜索在群访问快照未提交时失败关闭且不发请求', async () => {
  let called = false
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    called = true
    throw new Error('unexpected request')
  }
  try {
    await assert.rejects(searchMessagesFull(config, {
      ...session,
      user: { ...session.user, userId: 'not-ready-search-user' }
    }, { q: 'blocked' }), /群成员访问快照尚未就绪/)
    assert.equal(called, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('服务端全文搜索丢弃快照变更前发起的在途响应', async () => {
  const scopedSession = {
    ...session,
    user: { ...session.user, userId: 'inflight-search-user' }
  }
  await new GroupAccessSnapshotStore('901', 'inflight-search-user', null).commit({
    snapshotId: '1',
    entries: new Map()
  }, () => {})
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  Object.assign(globalThis, { window: globalThis })
  let release!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  globalThis.fetch = async () => {
    await waiting
    return new Response(JSON.stringify({
      code: 200,
      data: { current_page: 1, per_page: 20, total: 0, data: [] }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const pending = searchMessagesFull(config, scopedSession, { q: 'stale' })
    setGroupAccessNotReady('901', 'inflight-search-user')
    release()
    await assert.rejects(pending, /旧请求结果已丢弃/)
  } finally {
    globalThis.fetch = originalFetch
    Object.assign(globalThis, { window: originalWindow })
  }
})

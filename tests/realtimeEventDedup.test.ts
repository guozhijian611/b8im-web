import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyConversationReadEventDirection,
  classifyMutationChangeSequence,
  classifyReceiptEventDirection,
  isCanonicalRealtimeCommand,
  isCanonicalRealtimeEventPacketValid,
  isControlAckResponseValid,
  isDurableMutationValidForContext,
  isFriendRequestRealtimeEventPacketValid,
  isMessageValidForConversation,
  isMessageSenderValidForConversation,
  isPendingImRequestExpired,
  RealtimeEventDedupWindow,
  reusablePendingScreenshotClientMsgId,
  type RealtimeEventStorage
} from '../src/services/realtimeEventDedup.ts'

class MemoryStorage implements RealtimeEventStorage {
  readonly values = new Map<string, string>()

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

const eventId = (value: number) => value.toString(16).padStart(64, '0')

const canonicalPacket = (cmd: 'push' | 'recall' | 'edit' | 'delete') => {
  const data: Record<string, unknown> = {
    event_id: eventId(900),
    message_id: 'message-1',
    conversation_id: 'conversation-1',
    message_seq: 7
  }
  if (cmd !== 'push') {
    data.actor_organization = 902
    data.actor_user_id = 'user_b'
    data.change_seq = 1
  }
  if (cmd === 'push' || cmd === 'edit') {
    data.event_type = cmd === 'push' ? 'message.created' : 'message.edited'
    data.message = {
      organization: 901,
      sender_organization: 902,
      sender_id: 'user_b',
      sender_user: {
        organization: 902,
        user_id: 'user_b',
        nickname: '跨机构用户'
      },
      message_id: data.message_id,
      conversation_id: data.conversation_id,
      message_seq: data.message_seq
    }
  } else if (cmd === 'recall') {
    data.event_type = 'message.recalled'
    data.status = 'recalled'
  } else {
    data.event_type = 'message.deleted_both'
    data.scope = 'both'
  }

  return { cmd, organization: 901, data }
}

const canonicalConversationReadPacket = () => ({
  cmd: 'conversation_read' as const,
  organization: 901,
  data: {
    event_id: eventId(901),
    event_type: 'conversation.read',
    conversation_id: 'conversation-1',
    last_read_message_id: 'message-9',
    last_read_seq: 9,
    unread_count: 0,
    user_organization: 902,
    user_id: 'user_b',
    time: '2026-07-20 12:00:00',
    cross_org_access_snapshot_id: '42'
  }
})

const canonicalReceiptPacket = () => ({
  cmd: 'ack' as const,
  organization: 901,
  data: {
    event_id: eventId(902),
    event_type: 'message.receipt',
    organization: 901,
    conversation_id: 'conversation-1',
    message_id: 'message-7',
    message_seq: 7,
    sender_organization: 901,
    sender_id: 'user_a',
    user_organization: 902,
    user_id: 'user_b',
    status: 'read',
    time: '2026-07-20 12:00:00',
    cross_org_access_snapshot_id: '42'
  }
})

const canonicalReceiptOptions = () => ({
  conversation: {
    conversationId: 'conversation-1',
    conversationType: 'single' as const,
    peerOrganization: 902,
    peerUserId: 'user_b'
  },
  message: {
    conversationId: 'conversation-1',
    messageId: 'message-7',
    messageSeq: 7,
    senderOrganization: 901,
    senderUserId: 'user_a',
    side: 'out' as const
  },
  currentAccessSnapshotId: '42'
})

test('canonical Rabbit events require a valid event id and matching schema', () => {
  for (const cmd of ['push', 'recall', 'edit', 'delete'] as const) {
    const packet = canonicalPacket(cmd)
    assert.equal(isCanonicalRealtimeEventPacketValid(packet, '901'), true, cmd)

    const missingEventId = canonicalPacket(cmd)
    delete missingEventId.data.event_id
    assert.equal(isCanonicalRealtimeEventPacketValid(missingEventId, '901'), false, `${cmd}:missing`)

    const invalidEventId = canonicalPacket(cmd)
    invalidEventId.data.event_id = 'A'.repeat(64)
    assert.equal(isCanonicalRealtimeEventPacketValid(invalidEventId, '901'), false, `${cmd}:invalid`)
  }

  const mismatchedMessage = canonicalPacket('push')
  ;(mismatchedMessage.data.message as Record<string, unknown>).conversation_id = 'other'
  assert.equal(isCanonicalRealtimeEventPacketValid(mismatchedMessage, '901'), false)

  const invalidRecall = canonicalPacket('recall')
  invalidRecall.data.status = 'pending'
  assert.equal(isCanonicalRealtimeEventPacketValid(invalidRecall, '901'), false)

  const invalidEdit = canonicalPacket('edit')
  invalidEdit.data.event_type = 'message.created'
  assert.equal(isCanonicalRealtimeEventPacketValid(invalidEdit, '901'), false)

  const missingSenderId = canonicalPacket('push')
  ;(missingSenderId.data.message as Record<string, unknown>).sender_id = ''
  assert.equal(isCanonicalRealtimeEventPacketValid(missingSenderId, '901'), false)

  const missingActor = canonicalPacket('recall')
  delete missingActor.data.actor_organization
  assert.equal(isCanonicalRealtimeEventPacketValid(missingActor, '901'), false)

  const invalidDelete = canonicalPacket('delete')
  invalidDelete.data.scope = 'unknown'
  assert.equal(isCanonicalRealtimeEventPacketValid(invalidDelete, '901'), false)

  const deleteSelf = canonicalPacket('delete')
  deleteSelf.data.event_type = 'message.deleted_self'
  deleteSelf.data.scope = 'self'
  deleteSelf.data.target_organization = 901
  deleteSelf.data.target_user_id = 'user_a'
  assert.equal(isCanonicalRealtimeEventPacketValid(deleteSelf, '901', 'user_a'), true)
  deleteSelf.data.target_organization = 902
  assert.equal(isCanonicalRealtimeEventPacketValid(deleteSelf, '901', 'user_a'), false)

  assert.equal(isCanonicalRealtimeEventPacketValid(canonicalPacket('push'), '902'), false)
})

test('message receipt is a canonical reliable event validated before deduplication', () => {
  const packet = canonicalReceiptPacket()
  const options = canonicalReceiptOptions()
  assert.equal(
    isCanonicalRealtimeEventPacketValid(packet, '901', 'user_a', options),
    true
  )

  const missingEventId = structuredClone(packet) as any
  delete missingEventId.data.event_id
  assert.equal(
    isCanonicalRealtimeEventPacketValid(missingEventId, '901', 'user_a', options),
    false
  )
  const uppercaseEventId = structuredClone(packet)
  uppercaseEventId.data.event_id = 'A'.repeat(64)
  assert.equal(
    isCanonicalRealtimeEventPacketValid(uppercaseEventId, '901', 'user_a', options),
    false
  )
  const shortEventId = structuredClone(packet)
  shortEventId.data.event_id = 'a'.repeat(63)
  assert.equal(
    isCanonicalRealtimeEventPacketValid(shortEventId, '901', 'user_a', options),
    false
  )

  const invalidReceiptFields: Array<[string, (candidate: any) => void]> = [
    ['wrong event_type', candidate => { candidate.data.event_type = 'message.receipt.read' }],
    ['string packet organization', candidate => { candidate.organization = '901' }],
    ['wrong data organization', candidate => { candidate.data.organization = 902 }],
    ['string data organization', candidate => { candidate.data.organization = '901' }],
    ['empty conversation_id', candidate => { candidate.data.conversation_id = ' ' }],
    ['empty message_id', candidate => { candidate.data.message_id = '' }],
    ['zero message_seq', candidate => { candidate.data.message_seq = 0 }],
    ['string message_seq', candidate => { candidate.data.message_seq = '7' }],
    ['unsafe message_seq', candidate => {
      candidate.data.message_seq = Number.MAX_SAFE_INTEGER + 1
    }],
    ['zero sender organization', candidate => { candidate.data.sender_organization = 0 }],
    ['string sender organization', candidate => { candidate.data.sender_organization = '901' }],
    ['empty sender id', candidate => { candidate.data.sender_id = ' ' }],
    ['zero reader organization', candidate => { candidate.data.user_organization = 0 }],
    ['string reader organization', candidate => { candidate.data.user_organization = '902' }],
    ['empty reader id', candidate => { candidate.data.user_id = '' }],
    ['invalid status', candidate => { candidate.data.status = 'sent' }],
    ['missing time', candidate => { delete candidate.data.time }],
    ['empty time', candidate => { candidate.data.time = ' ' }]
  ]
  for (const [label, mutate] of invalidReceiptFields) {
    const candidate = structuredClone(packet)
    mutate(candidate)
    assert.equal(
      isCanonicalRealtimeEventPacketValid(candidate, '901', 'user_a', options),
      false,
      label
    )
  }

  const invalidContexts = [
    { ...options, conversation: null },
    {
      ...options,
      conversation: { ...options.conversation, conversationId: 'conversation-other' }
    },
    { ...options, message: null },
    { ...options, message: { ...options.message, messageId: 'message-other' } },
    { ...options, message: { ...options.message, messageSeq: 8 } },
    { ...options, message: { ...options.message, senderUserId: 'user-other' } }
  ]
  for (const [index, invalidOptions] of invalidContexts.entries()) {
    assert.equal(
      isCanonicalRealtimeEventPacketValid(packet, '901', 'user_a', invalidOptions),
      false,
      'context:' + index
    )
  }

  const invalidReader = structuredClone(packet)
  invalidReader.data.user_organization = 903
  assert.equal(
    isCanonicalRealtimeEventPacketValid(invalidReader, '901', 'user_a', options),
    false
  )

  for (const snapshotId of [undefined, '0', '01', 'snapshot-42', '1'.repeat(21), '43']) {
    const candidate = structuredClone(packet) as any
    if (snapshotId === undefined) {
      delete candidate.data.cross_org_access_snapshot_id
    } else {
      candidate.data.cross_org_access_snapshot_id = snapshotId
    }
    assert.equal(
      isCanonicalRealtimeEventPacketValid(candidate, '901', 'user_a', options),
      false,
      'payload snapshot:' + String(snapshotId)
    )
  }
  for (const currentAccessSnapshotId of [undefined, '0', '01', '42x', '43']) {
    assert.equal(
      isCanonicalRealtimeEventPacketValid(packet, '901', 'user_a', {
        ...options,
        currentAccessSnapshotId
      }),
      false,
      'current snapshot:' + String(currentAccessSnapshotId)
    )
  }

  const window = new RealtimeEventDedupWindow('901', 'user_a', new MemoryStorage())
  assert.equal(window.observe(packet.data.event_id), 'new')
  assert.equal(window.observe(packet.data.event_id), 'duplicate')
})

test('message receipt validates sender-home and reader-home projections', () => {
  const senderHome = canonicalReceiptPacket()
  assert.equal(isCanonicalRealtimeEventPacketValid(
    senderHome,
    '901',
    'user_a',
    canonicalReceiptOptions()
  ), true)

  const readerHome = canonicalReceiptPacket()
  readerHome.organization = 902
  readerHome.data.organization = 902
  assert.equal(isCanonicalRealtimeEventPacketValid(
    readerHome,
    '902',
    'user_b',
    {
      conversation: {
        conversationId: 'conversation-1',
        conversationType: 'single',
        peerOrganization: 901,
        peerUserId: 'user_a'
      },
      message: {
        conversationId: 'conversation-1',
        messageId: 'message-7',
        messageSeq: 7,
        senderOrganization: 901,
        senderUserId: 'user_a',
        side: 'in'
      },
      currentAccessSnapshotId: '42'
    }
  ), true)
})

test('same-organization single and group receipts reject access snapshot fields', () => {
  for (const conversationType of ['single', 'group'] as const) {
    const packet = canonicalReceiptPacket()
    packet.data.user_organization = 901
    delete (
      packet.data as Partial<typeof packet.data>
    ).cross_org_access_snapshot_id
    const options = {
      conversation: {
        conversationId: 'conversation-1',
        conversationType,
        peerOrganization: 901,
        peerUserId: 'user_b'
      },
      message: {
        conversationId: 'conversation-1',
        messageId: 'message-7',
        messageSeq: 7,
        senderOrganization: 901,
        senderUserId: 'user_a',
        side: 'out' as const
      },
      currentAccessSnapshotId: '42'
    }
    assert.equal(
      isCanonicalRealtimeEventPacketValid(packet, '901', 'user_a', options),
      true,
      conversationType + ':missing'
    )
    const withSnapshot = structuredClone(packet) as any
    withSnapshot.data.cross_org_access_snapshot_id = '42'
    assert.equal(
      isCanonicalRealtimeEventPacketValid(withSnapshot, '901', 'user_a', options),
      false,
      conversationType + ':present'
    )
  }
})

test('conversation read is a canonical reliable event with its own schema and dedup window', () => {
  const packet = canonicalConversationReadPacket()
  const conversation = {
    conversationId: 'conversation-1',
    conversationType: 'single' as const,
    peerOrganization: 902,
    peerUserId: 'user_b'
  }
  const options = {
    conversation,
    currentAccessSnapshotId: '42'
  }
  assert.equal(
    isCanonicalRealtimeEventPacketValid(packet, '901', 'user_a', options),
    true
  )

  const missingEventId = structuredClone(packet)
  delete (missingEventId.data as Partial<typeof packet.data>).event_id
  assert.equal(
    isCanonicalRealtimeEventPacketValid(missingEventId, '901', 'user_a', options),
    false
  )

  const uppercaseEventId = structuredClone(packet)
  uppercaseEventId.data.event_id = 'A'.repeat(64)
  assert.equal(
    isCanonicalRealtimeEventPacketValid(uppercaseEventId, '901', 'user_a', options),
    false
  )

  const wrongEventType = structuredClone(packet)
  wrongEventType.data.event_type = 'message.receipt'
  assert.equal(
    isCanonicalRealtimeEventPacketValid(wrongEventType, '901', 'user_a', options),
    false
  )

  const invalidReadFields: Array<[string, (candidate: any) => void]> = [
    ['missing conversation_id', candidate => delete candidate.data.conversation_id],
    ['empty conversation_id', candidate => { candidate.data.conversation_id = ' ' }],
    ['missing last_read_message_id', candidate => delete candidate.data.last_read_message_id],
    ['empty last_read_message_id', candidate => { candidate.data.last_read_message_id = '' }],
    ['zero last_read_seq', candidate => { candidate.data.last_read_seq = 0 }],
    ['string last_read_seq', candidate => { candidate.data.last_read_seq = '9' }],
    ['unsafe last_read_seq', candidate => { candidate.data.last_read_seq = Number.MAX_SAFE_INTEGER + 1 }],
    ['negative unread_count', candidate => { candidate.data.unread_count = -1 }],
    ['string unread_count', candidate => { candidate.data.unread_count = '0' }],
    ['unsafe unread_count', candidate => { candidate.data.unread_count = Number.MAX_SAFE_INTEGER + 1 }],
    ['string organization', candidate => { candidate.organization = '901' }],
    ['zero user_organization', candidate => { candidate.data.user_organization = 0 }],
    ['unsafe user_organization', candidate => {
      candidate.data.user_organization = Number.MAX_SAFE_INTEGER + 1
    }],
    ['empty user_id', candidate => { candidate.data.user_id = ' ' }],
    ['missing time', candidate => delete candidate.data.time],
    ['empty time', candidate => { candidate.data.time = '' }]
  ]
  for (const [label, mutate] of invalidReadFields) {
    const candidate = structuredClone(packet)
    mutate(candidate)
    assert.equal(
      isCanonicalRealtimeEventPacketValid(candidate, '901', 'user_a', options),
      false,
      label
    )
  }

  const window = new RealtimeEventDedupWindow('901', 'user_a', new MemoryStorage())
  assert.equal(window.observe(packet.data.event_id), 'new')
  assert.equal(window.observe(packet.data.event_id), 'duplicate')
})

test('conversation read binds cross-organization snapshot to both home projections', () => {
  const readerHome = canonicalConversationReadPacket()
  readerHome.data.user_organization = 901
  assert.equal(isCanonicalRealtimeEventPacketValid(
    readerHome,
    '901',
    'reader',
    {
      conversation: {
        conversationId: 'conversation-1',
        conversationType: 'single',
        peerOrganization: 902,
        peerUserId: 'peer'
      },
      currentAccessSnapshotId: '42'
    }
  ), true)

  const peerHome = canonicalConversationReadPacket()
  peerHome.organization = 902
  peerHome.data.user_organization = 901
  assert.equal(isCanonicalRealtimeEventPacketValid(
    peerHome,
    '902',
    'peer',
    {
      conversation: {
        conversationId: 'conversation-1',
        conversationType: 'single',
        peerOrganization: 901,
        peerUserId: 'reader'
      },
      currentAccessSnapshotId: '42'
    }
  ), true)
})

test('conversation read rejects missing, malformed or mismatched cross-organization snapshots', () => {
  const packet = canonicalConversationReadPacket()
  const conversation = {
    conversationId: 'conversation-1',
    conversationType: 'single' as const,
    peerOrganization: 902,
    peerUserId: 'user_b'
  }
  const validOptions = {
    conversation,
    currentAccessSnapshotId: '42'
  }

  assert.equal(isCanonicalRealtimeEventPacketValid(
    packet, '901', 'user_a', { ...validOptions, conversation: null }
  ), false)
  assert.equal(isCanonicalRealtimeEventPacketValid(
    packet,
    '901',
    'user_a',
    {
      ...validOptions,
      conversation: { ...conversation, conversationId: 'conversation-other' }
    }
  ), false)

  for (const snapshotId of [undefined, '0', '01', 'snapshot-42', '1'.repeat(21), '43']) {
    const candidate = structuredClone(packet)
    if (snapshotId === undefined) {
      delete (
        candidate.data as Partial<typeof candidate.data>
      ).cross_org_access_snapshot_id
    } else {
      candidate.data.cross_org_access_snapshot_id = snapshotId
    }
    assert.equal(
      isCanonicalRealtimeEventPacketValid(candidate, '901', 'user_a', validOptions),
      false,
      'payload snapshot: ' + String(snapshotId)
    )
  }

  for (const currentAccessSnapshotId of [undefined, '0', '01', '42x', '1'.repeat(21), '43']) {
    assert.equal(
      isCanonicalRealtimeEventPacketValid(packet, '901', 'user_a', {
        conversation,
        currentAccessSnapshotId
      }),
      false,
      'current snapshot: ' + String(currentAccessSnapshotId)
    )
  }
})

test('same-organization single and group reads reject access snapshot fields', () => {
  for (const conversationType of ['single', 'group'] as const) {
    const withoutSnapshot = canonicalConversationReadPacket()
    withoutSnapshot.data.user_organization = 901
    delete (
      withoutSnapshot.data as Partial<typeof withoutSnapshot.data>
    ).cross_org_access_snapshot_id
    const options = {
      conversation: {
        conversationId: 'conversation-1',
        conversationType,
        peerOrganization: 901,
        peerUserId: 'user_b'
      },
      currentAccessSnapshotId: '42'
    }
    assert.equal(
      isCanonicalRealtimeEventPacketValid(
        withoutSnapshot,
        '901',
        'user_a',
        options
      ),
      true,
      conversationType + ':missing'
    )
    const withSnapshot = canonicalConversationReadPacket()
    withSnapshot.data.user_organization = 901
    assert.equal(
      isCanonicalRealtimeEventPacketValid(
        withSnapshot,
        '901',
        'user_a',
        options
      ),
      false,
      conversationType + ':present'
    )
  }
})

test('point-to-point ACK responses and SYNC stay outside the canonical event-id gate', () => {
  assert.equal(isCanonicalRealtimeCommand('send_ack'), false)
  assert.equal(isCanonicalRealtimeCommand('sync'), false)
  assert.equal(isCanonicalRealtimeCommand('sync_ack'), false)
  assert.equal(isCanonicalRealtimeCommand('recall_ack'), false)
  assert.equal(isCanonicalRealtimeCommand('ack_ack'), false)
  assert.equal(isCanonicalRealtimeCommand('conversation_read_ack'), false)
  assert.equal(isCanonicalRealtimeCommand('push'), true)
  assert.equal(isCanonicalRealtimeCommand('ack'), true)
  assert.equal(isCanonicalRealtimeCommand('conversation_read'), true)
})

test('control ACK responses bind client id, request metadata and current identity', () => {
  const expected = {
    command: 'ack' as const,
    clientMsgId: 'ack-1',
    conversationId: 'conversation-1',
    messageId: 'message-1',
    messageSeq: 7,
    status: 'read' as const,
    senderOrganization: '902',
    senderUserId: 'user_b',
    createdAt: 1
  }
  const packet = {
    cmd: 'ack_ack',
    organization: 901,
    client_msg_id: 'ack-1',
    data: {
      client_msg_id: 'ack-1',
      request_client_msg_id: 'ack-1',
      actor_organization: 901,
      actor_user_id: 'user_a',
      conversation_id: 'conversation-1',
      message_id: 'message-1',
      message_seq: 7,
      status: 'read',
      sender_organization: 902,
      sender_id: 'user_b',
      user_organization: 901,
      user_id: 'user_a'
    }
  }
  assert.equal(isControlAckResponseValid(packet, expected, '901', 'user_a'), true)
  assert.equal(isControlAckResponseValid(
    { ...packet, client_msg_id: 'ack-other' }, expected, '901', 'user_a'
  ), false)
  assert.equal(isControlAckResponseValid({
    ...packet,
    client_msg_id: undefined
  }, expected, '901', 'user_a'), false)
  assert.equal(isControlAckResponseValid({
    ...packet,
    data: { ...packet.data, request_client_msg_id: 'ack-other' }
  }, expected, '901', 'user_a'), false)
  assert.equal(isControlAckResponseValid({
    ...packet,
    data: { ...packet.data, user_organization: 902 }
  }, expected, '901', 'user_a'), false)
  assert.equal(isControlAckResponseValid({
    ...packet,
    data: { ...packet.data, status: 'read' }
  }, { ...expected, status: 'delivered' }, '901', 'user_a'), true)
  assert.equal(isControlAckResponseValid({
    ...packet,
    data: { ...packet.data, sender_id: 'other' }
  }, expected, '901', 'user_a'), false)

  const readExpected = {
    command: 'conversation_read' as const,
    clientMsgId: 'read-1',
    conversationId: 'conversation-1',
    messageId: 'message-9',
    messageSeq: 9,
    createdAt: 1
  }
  const readPacket = {
    cmd: 'conversation_read_ack',
    organization: 901,
    client_msg_id: 'read-1',
    data: {
      conversation_id: 'conversation-1',
      last_read_message_id: 'message-9',
      last_read_seq: 9,
      user_organization: 901,
      user_id: 'user_a'
    }
  }
  assert.equal(isControlAckResponseValid(
    readPacket, readExpected, '901', 'user_a'
  ), true)
  assert.equal(isControlAckResponseValid({
    ...readPacket,
    client_msg_id: undefined
  }, readExpected, '901', 'user_a'), false)
  assert.equal(isControlAckResponseValid({
    ...readPacket,
    data: { ...readPacket.data, last_read_message_id: 'message-fake' }
  }, readExpected, '901', 'user_a'), false)
  assert.equal(isControlAckResponseValid({
    ...readPacket,
    data: {
      ...readPacket.data,
      last_read_message_id: 'message-10',
      last_read_seq: 10
    }
  }, readExpected, '901', 'user_a'), true)
})

test('SEND_ACK and mutation ACK reject mismatched request metadata', () => {
  const expectedSend = {
    command: 'send' as const,
    clientMsgId: 'send-1',
    conversationId: 'conversation-1',
    conversationType: 'single' as const,
    messageType: 1,
    content: { text: 'hello' },
    createdAt: 1
  }
  const sendAck = {
    cmd: 'send_ack',
    organization: 901,
    client_msg_id: 'send-1',
    data: {
      client_msg_id: 'send-1',
      conversation_id: 'conversation-1',
      message_id: 'message-1',
      message_seq: 8,
      message: {
        organization: 901,
        conversation_id: 'conversation-1',
        conversation_type: 1,
        message_id: 'message-1',
        message_seq: 8,
        client_msg_id: 'send-1',
        sender_organization: 901,
        sender_id: 'user_a',
        message_type: 1,
        content: { text: 'hello' }
      }
    }
  }
  assert.equal(isControlAckResponseValid(
    sendAck, expectedSend, '901', 'user_a'
  ), true)
  assert.equal(isControlAckResponseValid({
    ...sendAck,
    client_msg_id: undefined
  }, expectedSend, '901', 'user_a'), false)
  assert.equal(isControlAckResponseValid({
    ...sendAck,
    data: {
      ...sendAck.data,
      message: { ...sendAck.data.message, content: { text: 'forged' } }
    }
  }, expectedSend, '901', 'user_a'), false)
  assert.equal(isControlAckResponseValid({
    ...sendAck,
    data: { ...sendAck.data, conversation_id: 'conversation-other' }
  }, expectedSend, '901', 'user_a'), false)

  const expectedAsset = {
    ...expectedSend,
    clientMsgId: 'send-file-1',
    messageType: 3,
    content: { file_id: 'a'.repeat(40) }
  }
  const assetAck = structuredClone(sendAck)
  assetAck.client_msg_id = 'send-file-1'
  assetAck.data.client_msg_id = 'send-file-1'
  assetAck.data.message.client_msg_id = 'send-file-1'
  assetAck.data.message.message_type = 3
  assetAck.data.message.content = {
    file_id: 'a'.repeat(40),
    name: 'report.pdf',
    size: 123
  }
  assert.equal(isControlAckResponseValid(
    assetAck, expectedAsset, '901', 'user_a'
  ), true)
  assetAck.data.message.content.file_id = 'b'.repeat(40)
  assert.equal(isControlAckResponseValid(
    assetAck, expectedAsset, '901', 'user_a'
  ), false)

  const expectedEdit = {
    command: 'edit' as const,
    clientMsgId: 'edit-1',
    conversationId: 'conversation-1',
    messageId: 'message-1',
    content: { text: 'after' },
    createdAt: 1
  }
  const editAck = {
    cmd: 'edit_ack',
    organization: 901,
    client_msg_id: 'edit-1',
    data: {
      client_msg_id: 'edit-1',
      request_client_msg_id: 'edit-1',
      conversation_id: 'conversation-1',
      message_id: 'message-1',
      actor_organization: 901,
      actor_user_id: 'user_a',
      content: { text: 'after' },
      message: {
        organization: 901,
        conversation_id: 'conversation-1',
        conversation_type: 1,
        message_id: 'message-1',
        message_seq: 8,
        client_msg_id: 'send-1',
        sender_organization: 901,
        sender_id: 'user_a',
        message_type: 1,
        content: { text: 'after' }
      },
      change_seq: 4
    }
  }
  assert.equal(isControlAckResponseValid(
    editAck, expectedEdit, '901', 'user_a'
  ), true)
  assert.equal(isControlAckResponseValid({
    ...editAck,
    data: { ...editAck.data, actor_user_id: 'user_b' }
  }, expectedEdit, '901', 'user_a'), false)
  assert.equal(isControlAckResponseValid({
    ...editAck,
    data: {
      ...editAck.data,
      content: { text: 'server-normalized' },
      message: {
        ...editAck.data.message,
        content: { text: 'server-normalized' }
      }
    }
  }, expectedEdit, '901', 'user_a'), true)
  assert.equal(isControlAckResponseValid({
    ...editAck,
    data: {
      ...editAck.data,
      content: { text: 'server-normalized' }
    }
  }, expectedEdit, '901', 'user_a'), false)
  for (const missing of [
    'packet_client_msg_id',
    'data_client_msg_id',
    'request_client_msg_id'
  ] as const) {
    const invalid = structuredClone(editAck)
    if (missing === 'packet_client_msg_id') delete invalid.client_msg_id
    if (missing === 'data_client_msg_id') delete invalid.data.client_msg_id
    if (missing === 'request_client_msg_id') {
      delete invalid.data.request_client_msg_id
    }
    assert.equal(
      isControlAckResponseValid(invalid, expectedEdit, '901', 'user_a'),
      false,
      missing
    )
  }
  assert.equal(isControlAckResponseValid({
    ...editAck,
    data: { ...editAck.data, request_client_msg_id: 'edit-other' }
  }, expectedEdit, '901', 'user_a'), false)

  const expectedScreenshot = {
    command: 'screenshot' as const,
    clientMsgId: 'screenshot-1',
    conversationId: 'conversation-1',
    createdAt: 1
  }
  const screenshotAck = {
    cmd: 'screenshot_ack',
    organization: 901,
    client_msg_id: 'screenshot-1',
    data: {
      client_msg_id: 'screenshot-1',
      request_client_msg_id: 'screenshot-1',
      conversation_id: 'conversation-1',
      actor_organization: 901,
      actor_user_id: 'user_a',
      enabled: false
    }
  }
  assert.equal(isControlAckResponseValid(
    screenshotAck,
    expectedScreenshot,
    '901',
    'user_a'
  ), true)
  assert.equal(isControlAckResponseValid({
    ...screenshotAck,
    data: { ...screenshotAck.data, request_client_msg_id: undefined }
  }, expectedScreenshot, '901', 'user_a'), false)
})

test('friend request control events require their own canonical schema before observation', () => {
  const packet = {
    cmd: 'friend_request',
    organization: 901,
    data: {
      event: 'created',
      event_id: eventId(901),
      request_id: 77,
      from_organization: 902,
      from_user_id: 'user_b',
      to_organization: 901,
      to_user_id: 'user_a',
      message: 'hello',
      pending_count: 2,
      create_time: '2026-07-10 14:10:00',
      from_user: {
        organization: 902,
        user_id: 'user_b'
      }
    }
  }
  assert.equal(isFriendRequestRealtimeEventPacketValid(packet, '901', 'user_a'), true)

  const missingId = structuredClone(packet)
  delete (missingId.data as Partial<typeof packet.data>).event_id
  assert.equal(isFriendRequestRealtimeEventPacketValid(missingId, '901', 'user_a'), false)

  const wrongTarget = structuredClone(packet)
  wrongTarget.data.to_user_id = 'user_c'
  assert.equal(isFriendRequestRealtimeEventPacketValid(wrongTarget, '901', 'user_a'), false)

  const wrongTargetOrganization = structuredClone(packet)
  wrongTargetOrganization.data.to_organization = 902
  assert.equal(
    isFriendRequestRealtimeEventPacketValid(wrongTargetOrganization, '901', 'user_a'),
    false
  )

  const mismatchedSenderIdentity = structuredClone(packet)
  mismatchedSenderIdentity.data.from_user.organization = 903
  assert.equal(
    isFriendRequestRealtimeEventPacketValid(mismatchedSenderIdentity, '901', 'user_a'),
    false
  )

  const invalidRequest = structuredClone(packet)
  invalidRequest.data.request_id = 0
  assert.equal(isFriendRequestRealtimeEventPacketValid(invalidRequest, '901', 'user_a'), false)

  const window = new RealtimeEventDedupWindow('901', 'user_a', new MemoryStorage())
  assert.equal(window.observe(packet.data.event_id), 'new')
  assert.equal(window.observe(packet.data.event_id), 'duplicate')
})

test('cross-organization PUSH keeps packet and message scoped to recipient home', () => {
  const packet = canonicalPacket('push')
  assert.equal(packet.organization, 901)
  assert.equal((packet.data.message as Record<string, unknown>).organization, 901)
  assert.equal((packet.data.message as Record<string, unknown>).sender_organization, 902)
  assert.equal(isCanonicalRealtimeEventPacketValid(packet, '901'), true)

  const senderHomeProjection = structuredClone(packet)
  senderHomeProjection.organization = 902
  ;(senderHomeProjection.data.message as Record<string, unknown>).organization = 902
  assert.equal(isCanonicalRealtimeEventPacketValid(senderHomeProjection, '901'), false)

  const mismatchedSenderSummary = structuredClone(packet)
  ;(
    (mismatchedSenderSummary.data.message as Record<string, any>).sender_user as Record<
      string,
      unknown
    >
  ).organization = 903
  assert.equal(isCanonicalRealtimeEventPacketValid(mismatchedSenderSummary, '901'), false)
})

test('receipt and read directions bind both composite identities and group home', () => {
  const single = {
    conversationId: 'conversation-1',
    conversationType: 'single' as const,
    peerOrganization: 902,
    peerUserId: 'same-id'
  }
  const receipt = {
    conversation_id: 'conversation-1',
    message_id: 'message-1',
    sender_organization: 901,
    sender_id: 'user_a',
    user_organization: 902,
    user_id: 'same-id',
    status: 'read',
    message_seq: 7,
    event_type: 'message.receipt'
  }
  assert.equal(classifyReceiptEventDirection(
    receipt, '901', 'user_a', single
  ), 'peer_reads_current')
  assert.equal(classifyReceiptEventDirection(
    { ...receipt, event_type: 'message.receipt.read' },
    '901',
    'user_a',
    single
  ), 'invalid')
  assert.equal(classifyReceiptEventDirection(
    { ...receipt, user_organization: 903 }, '901', 'user_a', single
  ), 'invalid')

  const currentOtherDeviceRead = {
    ...receipt,
    sender_organization: 902,
    sender_id: 'same-id',
    user_organization: 901,
    user_id: 'user_a'
  }
  assert.equal(classifyReceiptEventDirection(
    currentOtherDeviceRead, '901', 'user_a', single
  ), 'current_reads_peer')
  const systemReceipt = {
    ...receipt,
    sender_organization: 901,
    sender_id: 'system_notification',
    user_organization: 901,
    user_id: 'user_a'
  }
  assert.equal(classifyReceiptEventDirection(
    systemReceipt,
    '901',
    'user_a',
    single,
    {
      conversationId: 'conversation-1',
      messageId: 'message-1',
      messageSeq: 7,
      senderOrganization: 901,
      senderUserId: 'system_notification',
      side: 'system'
    }
  ), 'current_reads_peer')

  const group = { ...single, conversationType: 'group' as const }
  assert.equal(classifyReceiptEventDirection(
    { ...receipt, user_organization: 903 }, '901', 'user_a', group
  ), 'invalid')
  assert.equal(classifyReceiptEventDirection({
    ...receipt,
    sender_organization: 901,
    user_organization: 901
  }, '901', 'user_a', group), 'group_member')

  const read = {
    conversation_id: 'conversation-1',
    user_organization: 902,
    user_id: 'same-id',
    last_read_seq: 9,
    event_type: 'conversation.read'
  }
  assert.equal(classifyConversationReadEventDirection(
    read, '901', 'user_a', single
  ), 'peer_reads_current')
  assert.equal(classifyConversationReadEventDirection({
    ...read,
    user_organization: 901,
    user_id: 'user_a'
  }, '901', 'user_a', single), 'current_reads_peer')
  assert.equal(classifyConversationReadEventDirection(
    { ...read, user_organization: 903 }, '901', 'user_a', single
  ), 'invalid')
  assert.equal(classifyConversationReadEventDirection(
    { ...read, user_organization: 903 }, '901', 'user_a', group
  ), 'invalid')
})

test('single senders and durable mutation actors must be current user or exact peer', () => {
  const single = {
    conversationId: 'conversation-1',
    conversationType: 'single' as const,
    peerOrganization: 902,
    peerUserId: 'peer'
  }
  assert.equal(isMessageSenderValidForConversation({
    sender_organization: 901,
    sender_id: 'current'
  }, '901', 'current', single), true)
  assert.equal(isMessageSenderValidForConversation({
    sender_organization: 902,
    sender_id: 'peer'
  }, '901', 'current', single), true)
  assert.equal(isMessageSenderValidForConversation({
    sender_organization: 903,
    sender_id: 'peer'
  }, '901', 'current', single), false)
  const completeMessage = {
    organization: 901,
    conversation_id: 'conversation-1',
    conversation_type: 1,
    message_id: 'message-1',
    message_seq: 7,
    sender_organization: 902,
    sender_id: 'peer'
  }
  assert.equal(isMessageValidForConversation(
    completeMessage, '901', 'current', single
  ), true)
  assert.equal(isMessageValidForConversation({
    ...completeMessage,
    conversation_type: 2
  }, '901', 'current', single), false)
  assert.equal(isMessageValidForConversation({
    ...completeMessage,
    conversation_id: 'conversation-other'
  }, '901', 'current', single), false)
  assert.equal(isMessageValidForConversation({
    ...completeMessage,
    organization: 902
  }, '901', 'current', single), false)
  assert.equal(isMessageValidForConversation({
    ...completeMessage,
    sender_organization: 903
  }, '901', 'current', single), false)
  assert.equal(isMessageSenderValidForConversation({
    sender_organization: 901,
    sender_id: 'system_notification',
    message_type: 5,
    content: {
      actor_organization: 902,
      actor_user_id: 'peer'
    }
  }, '901', 'current', single), true)
  assert.equal(isMessageSenderValidForConversation({
    sender_organization: 901,
    sender_id: 'system_notification',
    message_type: 5,
    content: {
      actor_organization: 903,
      actor_user_id: 'peer'
    }
  }, '901', 'current', single), false)

  const original = {
    conversationId: 'conversation-1',
    messageId: 'message-1',
    messageSeq: 7,
    senderOrganization: 902,
    senderUserId: 'peer',
    messageType: 1
  }
  const recall = {
    conversation_id: 'conversation-1',
    message_id: 'message-1',
    message_seq: 7,
    actor_organization: 902,
    actor_user_id: 'peer',
    status: 'recalled'
  }
  assert.equal(isDurableMutationValidForContext(
    'recall', recall, '901', 'current', single, original
  ), true)
  assert.equal(isDurableMutationValidForContext(
    'recall',
    { ...recall, actor_organization: 903 },
    '901',
    'current',
    single,
    original
  ), false)

  const group = { ...single, conversationType: 'group' as const }
  assert.equal(isMessageSenderValidForConversation({
    sender_organization: 902,
    sender_id: 'foreign'
  }, '901', 'current', group), false)
  assert.equal(isDurableMutationValidForContext(
    'recall',
    { ...recall, actor_organization: 902 },
    '901',
    'current',
    group,
    original
  ), false)
})

test('mutation change sequence rejects missing/stale events and identifies gaps', () => {
  assert.equal(classifyMutationChangeSequence(4, 2, 5), 'apply')
  assert.equal(classifyMutationChangeSequence(4, 2, 7), 'gap')
  assert.equal(classifyMutationChangeSequence(4, 6, 6), 'stale')
  assert.equal(classifyMutationChangeSequence(6, 4, 5), 'stale')
  assert.equal(classifyMutationChangeSequence(4, 2, 0), 'invalid')
  assert.equal(classifyMutationChangeSequence(4, 2, undefined), 'invalid')
})

test('pending screenshot requests reuse client id until timeout and then expire', () => {
  const pending = {
    command: 'screenshot' as const,
    clientMsgId: 'shot-1',
    conversationId: 'conversation-1',
    createdAt: 1000
  }
  assert.equal(reusablePendingScreenshotClientMsgId(
    pending, 'conversation-1', 1999, 1000
  ), 'shot-1')
  assert.equal(reusablePendingScreenshotClientMsgId(
    pending, 'conversation-1', 2000, 1000
  ), '')
  assert.equal(reusablePendingScreenshotClientMsgId(
    pending, 'conversation-other', 1500, 1000
  ), '')
  assert.equal(isPendingImRequestExpired(pending, 1999, 1000), false)
  assert.equal(isPendingImRequestExpired(pending, 2000, 1000), true)
})

test('persists a bounded organization/user window across reloads', () => {
  const storage = new MemoryStorage()
  const first = new RealtimeEventDedupWindow('901', 'user_a', storage, 3)

  assert.equal(first.observe(eventId(1)), 'new')
  assert.equal(first.observe(eventId(2)), 'new')
  assert.equal(first.observe(eventId(3)), 'new')
  assert.equal(first.observe(eventId(4)), 'new')
  assert.equal(first.size, 3)
  assert.equal(first.has(eventId(1)), false)
  const [storageKey, rawSnapshot] = [...storage.values.entries()][0] ?? []
  assert.match(String(storageKey), /:901:user_a$/)
  assert.deepEqual(JSON.parse(String(rawSnapshot)), {
    version: 1,
    organization: '901',
    user_id: 'user_a',
    event_ids: [eventId(2), eventId(3), eventId(4)]
  })

  const reloaded = new RealtimeEventDedupWindow('901', 'user_a', storage, 3)
  assert.equal(reloaded.observe(eventId(4)), 'duplicate')
  assert.equal(reloaded.observe(eventId(1)), 'new')
  assert.equal(reloaded.size, 3)
})

test('does not share event ids across organizations or users', () => {
  const storage = new MemoryStorage()
  const owner = new RealtimeEventDedupWindow('901', 'user_a', storage)
  assert.equal(owner.observe(eventId(10)), 'new')

  const anotherUser = new RealtimeEventDedupWindow('901', 'user_b', storage)
  const anotherOrganization = new RealtimeEventDedupWindow('902', 'user_a', storage)
  assert.equal(anotherUser.observe(eventId(10)), 'new')
  assert.equal(anotherOrganization.observe(eventId(10)), 'new')
  assert.equal(owner.observe(eventId(10)), 'duplicate')
})

test('ignores malformed snapshots and invalid event ids', () => {
  const storage = new MemoryStorage()
  const initial = new RealtimeEventDedupWindow('901', 'user_a', storage)
  assert.equal(initial.observe(eventId(20)), 'new')

  const [key] = storage.values.keys()
  assert.ok(key)
  storage.values.set(key, JSON.stringify({
    version: 1,
    organization: '902',
    user_id: 'user_a',
    event_ids: [eventId(20)]
  }))
  const wrongScope = new RealtimeEventDedupWindow('901', 'user_a', storage)
  assert.equal(wrongScope.has(eventId(20)), false)
  assert.equal(wrongScope.observe('not-an-event-id'), 'invalid')
  assert.equal(wrongScope.size, 0)

  storage.values.set(key, '{invalid json')
  const corrupt = new RealtimeEventDedupWindow('901', 'user_a', storage)
  assert.equal(corrupt.observe(eventId(21)), 'new')
})

test('falls back to memory when sessionStorage throws', () => {
  const failingStorage: RealtimeEventStorage = {
    getItem() {
      throw new Error('denied')
    },
    setItem() {
      throw new Error('quota')
    }
  }
  const window = new RealtimeEventDedupWindow('901', 'user_a', failingStorage)
  assert.equal(window.observe(eventId(30)), 'new')
  assert.equal(window.observe(eventId(30)), 'duplicate')
  assert.equal(window.size, 1)
})

test('never exceeds the hard 2048 event bound', () => {
  const window = new RealtimeEventDedupWindow('901', 'user_a', null, Number.NaN)
  for (let index = 1; index <= 2050; index += 1) {
    assert.equal(window.observe(eventId(index)), 'new')
  }
  assert.equal(window.size, 2048)
  assert.equal(window.has(eventId(1)), false)
  assert.equal(window.has(eventId(2050)), true)
})

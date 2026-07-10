import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isCanonicalRealtimeCommand,
  isCanonicalRealtimeEventPacketValid,
  isFriendRequestRealtimeEventPacketValid,
  RealtimeEventDedupWindow,
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
  if (cmd === 'push' || cmd === 'edit') {
    data.event_type = cmd === 'push' ? 'message.created' : 'message.edited'
    data.message = {
      organization: 901,
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

  const invalidDelete = canonicalPacket('delete')
  invalidDelete.data.scope = 'unknown'
  assert.equal(isCanonicalRealtimeEventPacketValid(invalidDelete, '901'), false)

  assert.equal(isCanonicalRealtimeEventPacketValid(canonicalPacket('push'), '902'), false)
})

test('ACK and SYNC commands are outside the canonical event-id gate', () => {
  assert.equal(isCanonicalRealtimeCommand('send_ack'), false)
  assert.equal(isCanonicalRealtimeCommand('sync'), false)
  assert.equal(isCanonicalRealtimeCommand('recall_ack'), false)
  assert.equal(isCanonicalRealtimeCommand('push'), true)
})

test('friend request control events require their own canonical schema before observation', () => {
  const packet = {
    cmd: 'friend_request',
    organization: 901,
    data: {
      event: 'created',
      event_id: eventId(901),
      request_id: 77,
      from_user_id: 'user_b',
      to_user_id: 'user_a',
      message: 'hello',
      pending_count: 2,
      create_time: '2026-07-10 14:10:00',
      from_user: null
    }
  }
  assert.equal(isFriendRequestRealtimeEventPacketValid(packet, '901', 'user_a'), true)

  const missingId = structuredClone(packet)
  delete (missingId.data as Partial<typeof packet.data>).event_id
  assert.equal(isFriendRequestRealtimeEventPacketValid(missingId, '901', 'user_a'), false)

  const wrongTarget = structuredClone(packet)
  wrongTarget.data.to_user_id = 'user_c'
  assert.equal(isFriendRequestRealtimeEventPacketValid(wrongTarget, '901', 'user_a'), false)

  const invalidRequest = structuredClone(packet)
  invalidRequest.data.request_id = 0
  assert.equal(isFriendRequestRealtimeEventPacketValid(invalidRequest, '901', 'user_a'), false)

  const window = new RealtimeEventDedupWindow('901', 'user_a', new MemoryStorage())
  assert.equal(window.observe(packet.data.event_id), 'new')
  assert.equal(window.observe(packet.data.event_id), 'duplicate')
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

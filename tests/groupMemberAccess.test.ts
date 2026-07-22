import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  canonicalAccessId,
  classifyGroupAccessEvent,
  GroupAccessFrameBarrier,
  GroupAccessSnapshotStaging,
  GroupAccessSnapshotStore,
  groupAccessConversationPatch,
  isGroupMessageBatchVisible,
  isMessageSequenceVisible,
  nextCanonicalDecimal,
  normalizeNonNegativeDecimal,
  normalizePositiveDecimal,
  parseGroupAccessChanged,
  revokedGroupConversationIds,
  type CommittedGroupAccessSnapshot,
  type GroupAccessChangedEvent,
  type GroupAccessEntry,
  type StorageLike
} from '../src/services/groupMemberAccess.ts'

const organization = '901'
const userId = 'user_a'

function rawEntry(id: string, version = '1', state: 'active' | 'history_only' = 'active') {
  return {
    conversation_id: id,
    conversation_type: 2,
    access_version: version,
    access_state: state,
    last_message_seq: '20',
    last_change_seq: '3',
    periods: state === 'active'
      ? [{ period_no: '1', from_seq: '5', to_seq: null }]
      : [{ period_no: '1', from_seq: '5', to_seq: '20' }]
  }
}

function ack(clientMsgId: string, snapshotId: string, entries: unknown[], cursor: string | null) {
  return {
    cmd: 'group_member_access_snapshot_ack',
    organization: 901,
    client_msg_id: clientMsgId,
    data: {
      access_snapshot_id: snapshotId,
      entries,
      next_cursor: cursor,
      has_more: cursor !== null
    }
  }
}

function entry(overrides: Partial<GroupAccessEntry> = {}): GroupAccessEntry {
  return {
    conversationId: 'group_a',
    conversationType: 2,
    accessVersion: '7',
    accessState: 'active',
    lastMessageSeq: '20',
    lastChangeSeq: '3',
    periods: [{ periodNo: '1', fromSeq: '5', toSeq: null }],
    ...overrides
  }
}

function snapshot(snapshotId = '10', value = entry()): CommittedGroupAccessSnapshot {
  return { snapshotId, entries: new Map([[value.conversationId, value]]) }
}

function eventId(conversationId: string, snapshotId: string, accessVersion: string) {
  return createHash('sha256').update([
    organization,
    'group.member_access_changed',
    conversationId,
    organization,
    userId,
    snapshotId,
    accessVersion
  ].join('|')).digest('hex')
}

function changed(overrides: Partial<GroupAccessChangedEvent> = {}): GroupAccessChangedEvent {
  const result: GroupAccessChangedEvent = {
    eventId: '',
    snapshotId: '11',
    conversationId: 'group_a',
    accessVersion: '8',
    accessState: 'history_only',
    lastMessageSeq: '20',
    lastChangeSeq: '3',
    periods: [{ periodNo: '1', fromSeq: '5', toSeq: '20' }],
    reason: 'leave',
    changedAt: '2026-07-21 10:00:00',
    ...overrides
  }
  result.eventId ||= eventId(result.conversationId, result.snapshotId, result.accessVersion)
  return result
}

class MemoryStorage implements StorageLike {
  values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

test('strictly stages continuous pages and commits only after the terminal page', () => {
  const staging = new GroupAccessSnapshotStaging(organization, '10', 2)
  const first = staging.request('page_1')
  assert.deepEqual(first.data, { access_snapshot_id: null, cursor: null, limit: 2 })
  staging.accept(ack('page_1', '10', [rawEntry('group_a'), rawEntry('group_b')], 'opaque.1'))
  assert.throws(() => staging.committed(), /尚未完成/)
  const second = staging.request('page_2')
  assert.deepEqual(second.data, { access_snapshot_id: '10', cursor: 'opaque.1', limit: 2 })
  staging.accept(ack('page_2', '10', [rawEntry('group_c', '2', 'history_only')], null))
  assert.deepEqual([...staging.committed().entries.keys()], ['group_a', 'group_b', 'group_c'])
})

test('rejects stale, duplicate, out-of-order and malformed snapshot pages as a whole', () => {
  for (const packet of [
    ack('page_1', '9', [rawEntry('group_a')], null),
    ack('wrong', '10', [rawEntry('group_a')], null),
    ack('page_1', '10', [rawEntry('group_b'), rawEntry('group_a')], null),
    ack('page_1', '10', [{ ...rawEntry('group_a'), access_version: '01' }], null),
    ack('page_1', '10', [{ ...rawEntry('group_a'), conversation_type: 1 }], null),
    ack('page_1', '10', [{ ...rawEntry('group_a'), periods: [{ period_no: '1', from_seq: '5', to_seq: '4' }] }], null)
  ]) {
    const staging = new GroupAccessSnapshotStaging(organization, '10')
    staging.request('page_1')
    assert.throws(() => staging.accept(packet), /无效/)
  }
})

test('high-water is never persisted before runtime cleanup succeeds', async () => {
  const storage = new MemoryStorage()
  const store = new GroupAccessSnapshotStore(organization, userId, storage)
  await assert.rejects(
    store.commit(snapshot('10'), () => { throw new Error('crash-before-cleanup') }),
    /crash-before-cleanup/
  )
  assert.equal(storage.getItem(store.key), null)

  let cleaned = false
  await store.commit(snapshot('10'), () => { cleaned = true })
  assert.equal(cleaned, true)
  assert.equal(new GroupAccessSnapshotStore(organization, userId, storage).read()?.snapshotId, '10')
  await assert.rejects(store.commit(snapshot('9'), () => {}), /high-water 不允许倒退/)
  assert.equal(new GroupAccessSnapshotStore(organization, userId, storage).read()?.snapshotId, '10')
})

test('applies only continuous shrinking events and reloads gaps or expansions', () => {
  const committed = snapshot()
  const shrink = changed()
  const decision = classifyGroupAccessEvent(committed, shrink, new Set())
  assert.equal(decision.kind, 'shrink')
  if (decision.kind === 'shrink') {
    assert.equal(decision.next.snapshotId, '11')
    assert.equal(decision.next.entries.get('group_a')?.accessState, 'history_only')
  }
  assert.equal(classifyGroupAccessEvent(committed, changed({ snapshotId: '12' }), new Set()).kind, 'reload')
  assert.equal(classifyGroupAccessEvent(committed, changed({ accessVersion: '9' }), new Set()).kind, 'reload')
  assert.equal(classifyGroupAccessEvent(committed, changed({ accessState: 'active' }), new Set()).kind, 'reload')
  assert.equal(classifyGroupAccessEvent(committed, changed({ periods: [{ periodNo: '1', fromSeq: '1', toSeq: '20' }] }), new Set()).kind, 'reload')
  assert.equal(classifyGroupAccessEvent(committed, changed({ snapshotId: '9' }), new Set()).kind, 'stale')
  assert.equal(classifyGroupAccessEvent(committed, changed({ snapshotId: '10' }), new Set()).kind, 'reload')
  assert.equal(classifyGroupAccessEvent(committed, changed({ snapshotId: '10' }), new Set([changed({ snapshotId: '10' }).eventId])).kind, 'duplicate')
})

test('history-only visibility clips disjoint periods and revoked removes the entry', () => {
  const history = entry({
    accessState: 'history_only',
    periods: [
      { periodNo: '1', fromSeq: '2', toSeq: '4' },
      { periodNo: '2', fromSeq: '9', toSeq: '11' }
    ]
  })
  assert.equal(isMessageSequenceVisible(history, 3), true)
  assert.equal(isMessageSequenceVisible(history, 7), false)
  assert.equal(isMessageSequenceVisible(history, 12), false)
  const decision = classifyGroupAccessEvent(snapshot('10', history), changed({
    accessVersion: '8',
    accessState: 'revoked',
    periods: [],
    reason: 'history_revoke'
  }), new Set())
  assert.equal(decision.kind, 'shrink')
  if (decision.kind === 'shrink') assert.equal(decision.next.entries.has('group_a'), false)
})

test('validates exact realtime identity, event id, schema and canonical versions', async () => {
  const data = {
    event_id: eventId('group_a', '11', '8'),
    event_type: 'group.member_access_changed',
    target_organization: 901,
    target_user_id: userId,
    conversation_id: 'group_a',
    conversation_type: 2,
    access_snapshot_id: '11',
    access_version: '8',
    access_state: 'history_only',
    last_message_seq: '20',
    last_change_seq: '3',
    periods: [{ period_no: '1', from_seq: '5', to_seq: '20' }],
    reason: 'leave',
    changed_at: '2026-07-21 10:00:00'
  }
  const packet = { cmd: 'group_member_access_changed', organization: 901, data }
  assert.equal((await parseGroupAccessChanged(packet, organization, userId))?.eventId, data.event_id)
  assert.equal(await parseGroupAccessChanged({ ...packet, organization: 902 }, organization, userId), null)
  assert.equal(await parseGroupAccessChanged({ ...packet, data: { ...data, target_user_id: 'user_b' } }, organization, userId), null)
  assert.equal(await parseGroupAccessChanged({ ...packet, data: { ...data, event_type: 'conversation.access_changed' } }, organization, userId), null)
  assert.equal(await parseGroupAccessChanged({ ...packet, data: { ...data, access_version: '08' } }, organization, userId), null)
  assert.equal(await parseGroupAccessChanged({ ...packet, data: { ...data, event_id: '0'.repeat(64) } }, organization, userId), null)
})

test('a restored active event never revives previously cleared cache directly', () => {
  const removed = snapshot('11', entry({
    accessState: 'history_only',
    accessVersion: '8',
    periods: [{ periodNo: '1', fromSeq: '5', toSeq: '20' }]
  }))
  const restore = changed({
    snapshotId: '12',
    accessVersion: '9',
    accessState: 'active',
    periods: [
      { periodNo: '1', fromSeq: '5', toSeq: '20' },
      { periodNo: '2', fromSeq: '30', toSeq: null }
    ],
    reason: 'restore'
  })
  assert.equal(classifyGroupAccessEvent(removed, restore, new Set()).kind, 'reload')
})

test('canonical identifiers and decimals reject overflow and unpaired surrogates', () => {
  assert.equal(normalizePositiveDecimal('18446744073709551615'), '18446744073709551615')
  assert.equal(normalizeNonNegativeDecimal('18446744073709551615'), '18446744073709551615')
  assert.equal(normalizePositiveDecimal('18446744073709551616'), '')
  assert.equal(normalizeNonNegativeDecimal('18446744073709551616'), '')
  assert.equal(nextCanonicalDecimal('18446744073709551615'), '')
  assert.equal(canonicalAccessId('group_\ud83d\ude00'), 'group_😀')
  assert.equal(canonicalAccessId('group_\ud800'), '')
  assert.equal(canonicalAccessId('group_\udc00'), '')

  const staging = new GroupAccessSnapshotStaging(organization, '10', 1)
  staging.request('page_limit')
  assert.throws(() => staging.accept(ack(
    'page_limit', '10', [rawEntry('group_a'), rawEntry('group_b')], null
  )), /schema 无效/)

  const overflow = new GroupAccessSnapshotStaging(organization, '10')
  overflow.request('overflow')
  assert.throws(() => overflow.accept(ack('overflow', '18446744073709551616', [], null)), /无效/)

  const surrogate = new GroupAccessSnapshotStaging(organization, '10')
  surrogate.request('surrogate')
  assert.throws(() => surrogate.accept(ack('surrogate', '10', [rawEntry('group_\ud800')], null)), /无效/)
})

test('group message batches share exact disjoint-period visibility boundaries', () => {
  const access = entry({
    accessState: 'history_only',
    periods: [
      { periodNo: '1', fromSeq: '2', toSeq: '4' },
      { periodNo: '2', fromSeq: '9', toSeq: '11' }
    ]
  })
  assert.equal(isGroupMessageBatchVisible(access, 'group_a', [
    { conversation_id: 'group_a', message_seq: 2 },
    { conversation_id: 'group_a', message_seq: 4 },
    { conversation_id: 'group_a', message_seq: 9 },
    { conversation_id: 'group_a', message_seq: 11 }
  ]), true)
  assert.equal(isGroupMessageBatchVisible(access, 'group_a', [
    { conversation_id: 'group_a', message_seq: 4 },
    { conversation_id: 'group_a', message_seq: 5 }
  ]), false)
  assert.equal(isGroupMessageBatchVisible(access, 'group_a', [
    { conversation_id: 'group_a', message_seq: 12 }
  ]), false)
  assert.equal(isGroupMessageBatchVisible(null, 'group_b', [
    { conversation_id: 'group_b', message_seq: 3 }
  ]), false)
})

test('snapshot reconciliation revokes missing old entries and scrubs history summaries', () => {
  const activeA = entry({ conversationId: 'group_a' })
  const activeB = entry({ conversationId: 'group_b' })
  const previous: CommittedGroupAccessSnapshot = {
    snapshotId: '10', entries: new Map([['group_a', activeA], ['group_b', activeB]])
  }
  const historyA = entry({
    conversationId: 'group_a', accessVersion: '8', accessState: 'history_only',
    periods: [{ periodNo: '1', fromSeq: '5', toSeq: '20' }]
  })
  const next: CommittedGroupAccessSnapshot = {
    snapshotId: '11', entries: new Map([['group_a', historyA]])
  }
  assert.deepEqual([...revokedGroupConversationIds(previous, next)], ['group_b'])
  assert.deepEqual(groupAccessConversationPatch(historyA), {
    groupAccessState: 'history_only', unread: 0, preview: '', time: '',
    lastMessageId: '', lastMessageIndexId: 0, lastMessageTime: '', sortTime: '',
    avatarMembers: [], description: '', isPinned: false, isMuted: false,
    messageGroupId: 0, messageGroupName: ''
  })
})

test('shrink transitions match period_no/from/to and reason exactly', () => {
  const current = snapshot('10', entry({
    periods: [
      { periodNo: '1', fromSeq: '2', toSeq: '4' },
      { periodNo: '2', fromSeq: '9', toSeq: null }
    ]
  }))
  const valid = changed({
    periods: [
      { periodNo: '1', fromSeq: '2', toSeq: '4' },
      { periodNo: '2', fromSeq: '9', toSeq: '20' }
    ]
  })
  assert.equal(classifyGroupAccessEvent(current, valid, new Set()).kind, 'shrink')
  for (const invalid of [
    changed({ periods: [{ periodNo: '2', fromSeq: '9', toSeq: '20' }] }),
    changed({ periods: [
      { periodNo: '1', fromSeq: '2', toSeq: '3' },
      { periodNo: '2', fromSeq: '9', toSeq: '20' }
    ] }),
    changed({ periods: [
      { periodNo: '1', fromSeq: '2', toSeq: '4' },
      { periodNo: '3', fromSeq: '9', toSeq: '20' }
    ] }),
    changed({ periods: [
      { periodNo: '1', fromSeq: '2', toSeq: '4' },
      { periodNo: '2', fromSeq: '10', toSeq: '20' }
    ] }),
    changed({ periods: [
      { periodNo: '1', fromSeq: '2', toSeq: '4' },
      { periodNo: '2', fromSeq: '9', toSeq: '19' }
    ] }),
    changed({ reason: 'history_revoke', periods: valid.periods })
  ]) {
    assert.equal(classifyGroupAccessEvent(current, invalid, new Set()).kind, 'reload')
  }

  const history = snapshot('10', entry({
    accessState: 'history_only',
    periods: [
      { periodNo: '1', fromSeq: '2', toSeq: '4' },
      { periodNo: '2', fromSeq: '9', toSeq: '11' }
    ]
  }))
  assert.equal(classifyGroupAccessEvent(history, changed({
    reason: 'history_revoke',
    periods: [{ periodNo: '2', fromSeq: '9', toSeq: '11' }]
  }), new Set()).kind, 'shrink')
  assert.equal(classifyGroupAccessEvent(history, changed({
    reason: 'history_revoke',
    periods: [{ periodNo: '2', fromSeq: '10', toSeq: '11' }]
  }), new Set()).kind, 'reload')
  assert.equal(classifyGroupAccessEvent(history, changed({
    reason: 'leave', periods: [] , accessState: 'revoked'
  }), new Set()).kind, 'reload')
})

test('access frame barrier blocks send and serializes a following PUSH behind cleanup', async () => {
  const order: string[] = []
  let release!: () => void
  const delayedValidation = new Promise<void>((resolve) => { release = resolve })
  const barrier = new GroupAccessFrameBarrier(
    () => order.push('not-ready'),
    () => order.push('ready'),
    (error) => { throw error }
  )
  const access = barrier.enqueueAccess(async () => {
    order.push('hash-start')
    await delayedValidation
    order.push('cleanup-commit')
  })
  let sends = 0
  if (!barrier.blocked) sends += 1
  const push = barrier.enqueueBusiness(() => order.push('push'))
  assert.equal(sends, 0)
  assert.deepEqual(order, ['not-ready'])
  await Promise.resolve()
  assert.deepEqual(order, ['not-ready', 'hash-start'])
  release()
  await Promise.all([access, push])
  assert.deepEqual(order, ['not-ready', 'hash-start', 'cleanup-commit', 'ready', 'push'])
})

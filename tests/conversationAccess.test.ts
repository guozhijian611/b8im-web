import assert from 'node:assert/strict'
import test from 'node:test'
import {
  advanceConversationAccessEpoch,
  captureConversationAccessEpoch,
  classifyAuthAccessSnapshot,
  compareAccessSnapshotIds,
  CrossOrgAccessSnapshotStore,
  isAccessSnapshotFailClosed,
  isConversationAccessRecoveryRequired,
  isConversationAccessEpochCurrent,
  normalizeAccessSnapshotId,
  observeConversationAccessSnapshot,
  parseConversationAccessChanged,
  reconcileRevokedConversationIds,
  setConversationAccessRecoveryRequired,
  shouldProcessAccessSnapshotEvent
} from '../src/services/conversationAccess.ts'
import { canRecoverGlobalSyncConversation } from '../src/services/imGlobalSync.ts'
import type { RealtimeEventStorage } from '../src/services/realtimeEventDedup.ts'

class MemoryStorage implements RealtimeEventStorage {
  readonly values = new Map<string, string>()
  beforeSet: ((key: string, value: string) => void) | null = null
  beforeRemove: ((key: string) => void) | null = null

  get length() {
    return this.values.size
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null
  }

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.beforeSet?.(key, value)
    this.values.set(key, value)
  }

  removeItem(key: string) {
    this.beforeRemove?.(key)
    this.values.delete(key)
  }
}

const eventId = 'a'.repeat(64)

test('access snapshot ids are canonical decimal strings and compare without precision loss', () => {
  assert.equal(normalizeAccessSnapshotId('0'), '0')
  assert.equal(normalizeAccessSnapshotId('90071992547409931234'), '90071992547409931234')
  assert.equal(normalizeAccessSnapshotId(1), '')
  assert.equal(normalizeAccessSnapshotId('01'), '')
  assert.equal(normalizeAccessSnapshotId('-1'), '')
  assert.equal(normalizeAccessSnapshotId('1'.repeat(21)), '')
  assert.equal(isAccessSnapshotFailClosed(''), true)
  assert.equal(isAccessSnapshotFailClosed('0'), true)
  assert.equal(isAccessSnapshotFailClosed('1'), false)
  assert.equal(compareAccessSnapshotIds(
    '90071992547409931235',
    '90071992547409931234'
  ), 1)
})

test('distinct access events sharing one snapshot are both processable', () => {
  const organization = '92001'
  const userId = 'same-snapshot-user'
  const packets = ['conversation-a', 'conversation-b'].map(
    (conversationId, index) => ({
      cmd: 'conversation.access_changed',
      organization,
      data: {
        event_type: 'conversation.access_changed',
        event_id: (index === 0 ? 'b' : 'c').repeat(64),
        cross_org_access_snapshot_id: '200',
        conversation_id: conversationId,
        conversation_type: 1,
        allowed: false,
        target_organization: organization,
        target_user_id: userId,
        peer_organization: 92002,
        peer_user_id: `peer-${index}`
      }
    })
  )
  const events = packets.map((packet) =>
    parseConversationAccessChanged(packet, organization, userId)
  )
  assert.ok(events.every(Boolean))
  assert.notEqual(events[0]?.eventId, events[1]?.eventId)
  const first = observeConversationAccessSnapshot(
    organization,
    userId,
    events[0]?.snapshotId
  )
  const firstEventEpoch = captureConversationAccessEpoch(
    organization,
    userId
  )
  const second = observeConversationAccessSnapshot(
    organization,
    userId,
    events[1]?.snapshotId
  )
  assert.equal(first, 'new')
  assert.equal(second, 'duplicate')
  assert.equal(
    advanceConversationAccessEpoch(organization, userId),
    true
  )
  assert.equal(isConversationAccessEpochCurrent(firstEventEpoch), false)
  assert.equal(shouldProcessAccessSnapshotEvent(first), true)
  assert.equal(shouldProcessAccessSnapshotEvent(second), true)
  let dispatchedRevocations = 0
  for (const observation of [first, second]) {
    if (shouldProcessAccessSnapshotEvent(observation)) {
      dispatchedRevocations += 1
    }
  }
  assert.equal(dispatchedRevocations, 2)
  assert.equal(shouldProcessAccessSnapshotEvent('stale'), false)
})

test('access snapshot store persists newest value and ignores duplicate or stale values', () => {
  const storage = new MemoryStorage()
  const store = new CrossOrgAccessSnapshotStore('901', 'user-a', storage)
  assert.equal(store.observe('10'), 'new')
  assert.equal(store.observe('10'), 'duplicate')
  assert.equal(store.observe('9'), 'stale')
  assert.equal(store.current, '10')
  assert.equal(store.observe('0'), 'new')
  assert.equal(store.current, '0')
  assert.equal(store.highWater, '10')
  assert.equal(store.observe('9'), 'stale')
  assert.equal(store.current, '0')
  assert.equal(store.observe('10'), 'stale')
  assert.equal(store.current, '0')

  const restored = new CrossOrgAccessSnapshotStore('901', 'user-a', storage)
  assert.equal(restored.current, '0')
  assert.equal(restored.highWater, '10')
  assert.equal(restored.observe('11'), 'new')
  assert.equal(restored.current, '11')
})

test('access high-water stays monotonic under cross-tab interleaving and compacts stale entries', () => {
  const storage = new MemoryStorage()
  const oldTab = new CrossOrgAccessSnapshotStore(
    '901', 'interleaved-access-user', storage
  )
  const newTab = new CrossOrgAccessSnapshotStore(
    '901', 'interleaved-access-user', storage
  )
  assert.equal(oldTab.observe('50'), 'new')

  storage.beforeSet = (key, value) => {
    if (!key.includes('cross-org-access-high-water') || value !== '60') {
      return
    }
    storage.beforeSet = null
    assert.equal(newTab.observe('100'), 'new')
  }

  // The old tab has accepted 60 in memory, then tab B durably records 100
  // before tab A finishes its own storage write.
  assert.equal(oldTab.observe('60'), 'stale')
  const restored = new CrossOrgAccessSnapshotStore(
    '901', 'interleaved-access-user', storage
  )
  assert.equal(restored.highWater, '100')
  assert.equal(restored.observe('60'), 'stale')
  assert.equal(restored.observe('100'), 'duplicate')
  assert.equal(restored.current, '100')
  assert.equal(
    [...storage.values.keys()].filter((key) =>
      key.includes('cross-org-access-high-water')
    ).length,
    1
  )
})

test('persistent revocation floor survives stale-tab equality and only a higher snapshot recovers', () => {
  const storage = new MemoryStorage()
  const tabA = new CrossOrgAccessSnapshotStore(
    '901', 'revocation-floor-user', storage
  )
  const tabB = new CrossOrgAccessSnapshotStore(
    '901', 'revocation-floor-user', storage
  )

  assert.equal(tabA.observe('100'), 'new')
  assert.equal(tabB.observe('0'), 'new')
  assert.equal(tabA.observe('100'), 'stale')
  assert.equal(tabA.current, '0')

  const failClosedReload = new CrossOrgAccessSnapshotStore(
    '901', 'revocation-floor-user', storage
  )
  assert.equal(failClosedReload.current, '0')
  assert.equal(failClosedReload.highWater, '100')
  assert.equal(failClosedReload.observe('99'), 'stale')
  assert.equal(failClosedReload.observe('100'), 'stale')
  assert.equal(failClosedReload.current, '0')
  assert.equal(failClosedReload.observe('101'), 'new')
  assert.equal(failClosedReload.current, '101')
  assert.equal(failClosedReload.highWater, '101')

  const recoveredReload = new CrossOrgAccessSnapshotStore(
    '901', 'revocation-floor-user', storage
  )
  assert.equal(recoveredReload.current, '101')
  assert.equal(recoveredReload.highWater, '101')
  assert.equal(
    [...storage.values.keys()].filter((key) =>
      key.includes('cross-org-access-high-water')
    ).length,
    1
  )
  assert.equal(
    [...storage.values.keys()].filter((key) =>
      key.includes('cross-org-access-revocation-floor')
    ).length,
    1
  )
})

test('concurrent compaction and reload preserve a higher revocation tombstone', () => {
  const storage = new MemoryStorage()
  const lowTab = new CrossOrgAccessSnapshotStore(
    '901', 'revocation-compaction-user', storage
  )
  const highTab = new CrossOrgAccessSnapshotStore(
    '901', 'revocation-compaction-user', storage
  )

  assert.equal(lowTab.observe('100'), 'new')
  assert.equal(lowTab.observe('0'), 'new')
  assert.equal(highTab.observe('200'), 'new')

  const floor100Key = [...storage.values.keys()].find((key) =>
    key.includes('cross-org-access-revocation-floor') &&
    key.endsWith(':100')
  )
  assert.ok(floor100Key)
  const floorPrefix = floor100Key.slice(0, -'100'.length)
  storage.setItem(`${floorPrefix}50`, '50')
  storage.beforeRemove = (key) => {
    if (key !== `${floorPrefix}50`) return
    storage.beforeRemove = null
    assert.equal(highTab.observe('0'), 'new')
  }

  // The low tab starts compaction with floor 100. Tab B installs floor 200
  // while the lower floor is being removed.
  assert.equal(lowTab.current, '0')
  const restored = new CrossOrgAccessSnapshotStore(
    '901', 'revocation-compaction-user', storage
  )
  assert.equal(restored.current, '0')
  assert.equal(restored.highWater, '200')
  assert.equal(lowTab.observe('101'), 'stale')

  const reloadedAgain = new CrossOrgAccessSnapshotStore(
    '901', 'revocation-compaction-user', storage
  )
  assert.equal(reloadedAgain.current, '0')
  assert.equal(
    [...storage.values.keys()].filter((key) =>
      key.includes('cross-org-access-revocation-floor')
    ).length,
    1
  )
  assert.ok(storage.values.has(`${floorPrefix}200`))
})

test('access epoch fail-closes on zero without lowering the positive high-water', () => {
  const organization = '9100100'
  const userId = 'epoch-user'
  assert.equal(
    observeConversationAccessSnapshot(organization, userId, '100'),
    'new'
  )
  const beforeZero = captureConversationAccessEpoch(organization, userId)
  assert.equal(
    observeConversationAccessSnapshot(organization, userId, '0'),
    'new'
  )
  assert.equal(isConversationAccessEpochCurrent(beforeZero), false)
  const failClosed = captureConversationAccessEpoch(organization, userId)
  assert.equal(failClosed.snapshotId, '0')
  assert.equal(
    observeConversationAccessSnapshot(organization, userId, '99'),
    'stale'
  )
  assert.equal(
    captureConversationAccessEpoch(organization, userId).snapshotId,
    '0'
  )
  assert.equal(
    observeConversationAccessSnapshot(organization, userId, '100'),
    'stale'
  )
  assert.equal(
    captureConversationAccessEpoch(organization, userId).snapshotId,
    '0'
  )
  assert.equal(
    observeConversationAccessSnapshot(organization, userId, '101'),
    'new'
  )
  assert.equal(
    captureConversationAccessEpoch(organization, userId).snapshotId,
    '101'
  )
})

test('process-wide recovery state keeps HTTP projections fail-closed until AUTH recovery commits', () => {
  const organization = '9100200'
  const userId = 'recovery-user'
  assert.equal(
    setConversationAccessRecoveryRequired(organization, userId, true),
    true
  )
  assert.equal(
    isConversationAccessRecoveryRequired(organization, userId),
    true
  )
  assert.equal(
    setConversationAccessRecoveryRequired(organization, userId, false),
    true
  )
  assert.equal(
    isConversationAccessRecoveryRequired(organization, userId),
    false
  )
  assert.equal(
    setConversationAccessRecoveryRequired('', userId, true),
    false
  )
  assert.equal(isConversationAccessRecoveryRequired('', userId), true)
})

test('every newly observed or explicitly advanced access epoch fail-closes immediately', () => {
  const organization = '9100250'
  const userId = 'epoch-fail-close-user'
  assert.equal(
    observeConversationAccessSnapshot(organization, userId, '1'),
    'new'
  )
  assert.equal(
    isConversationAccessRecoveryRequired(organization, userId),
    true
  )
  setConversationAccessRecoveryRequired(organization, userId, false)
  assert.equal(
    advanceConversationAccessEpoch(organization, userId),
    true
  )
  assert.equal(
    isConversationAccessRecoveryRequired(organization, userId),
    true
  )
})

test('stale positive AUTH keeps same-org recovery usable until a higher snapshot rebuilds', () => {
  const organization = '9100260'
  const userId = 'stale-auth-user'
  const storage = new MemoryStorage()
  const store = new CrossOrgAccessSnapshotStore(
    organization,
    userId,
    storage
  )
  assert.equal(store.observe('100'), 'new')
  assert.equal(
    observeConversationAccessSnapshot(organization, userId, '100'),
    'new'
  )
  setConversationAccessRecoveryRequired(organization, userId, false)

  const staleAuthObservation = store.observe('99')
  assert.equal(staleAuthObservation, 'stale')
  assert.equal(
    classifyAuthAccessSnapshot(
      staleAuthObservation,
      '99',
      captureConversationAccessEpoch(organization, userId).snapshotId
    ),
    'behind_high_water'
  )
  setConversationAccessRecoveryRequired(organization, userId, true)
  assert.equal(canRecoverGlobalSyncConversation(
    true,
    organization,
    {
      conversationType: 'single',
      peerOrganization: organization
    }
  ), true)
  assert.equal(canRecoverGlobalSyncConversation(
    true,
    organization,
    {
      conversationType: 'single',
      peerOrganization: '9100261'
    }
  ), false)
  assert.equal(
    captureConversationAccessEpoch(organization, userId).snapshotId,
    '100'
  )

  const caughtUpObservation = store.observe('101')
  assert.equal(caughtUpObservation, 'new')
  assert.equal(
    observeConversationAccessSnapshot(organization, userId, '101'),
    'new'
  )
  assert.equal(
    classifyAuthAccessSnapshot(
      caughtUpObservation,
      '101',
      captureConversationAccessEpoch(organization, userId).snapshotId
    ),
    'current'
  )
  assert.equal(
    isConversationAccessRecoveryRequired(organization, userId),
    true
  )
  setConversationAccessRecoveryRequired(organization, userId, false)
  assert.equal(
    isConversationAccessRecoveryRequired(organization, userId),
    false
  )
})

test('authoritative restore never clears an unrelated revoked peer', () => {
  const revoked = new Set(['conversation-peer-a', 'conversation-peer-b'])
  const restoredAtSnapshot11 = reconcileRevokedConversationIds(
    revoked,
    ['conversation-peer-a', 'conversation-peer-b'],
    { restorableConversationIds: ['conversation-peer-a'] }
  )
  assert.deepEqual(restoredAtSnapshot11, ['conversation-peer-a'])
  assert.equal(revoked.has('conversation-peer-a'), false)
  assert.equal(revoked.has('conversation-peer-b'), true)

  const staleDeniedEcho = reconcileRevokedConversationIds(
    revoked,
    ['conversation-peer-b'],
    { preserveRevokedConversationId: 'conversation-peer-b' }
  )
  assert.deepEqual(staleDeniedEcho, [])
  assert.equal(revoked.has('conversation-peer-b'), true)
})

test('AUTH authoritative rebuild restores an allow event missed while offline', () => {
  const organization = '93001'
  const userId = 'offline-restore-user'
  assert.equal(
    observeConversationAccessSnapshot(organization, userId, '10'),
    'new'
  )
  const revoked = new Set(['conversation-peer-b'])

  // The browser disconnects after the snapshot-10 revoke and misses the
  // snapshot-11 allow event. AUTH11 plus its authoritative list is the only
  // recovery source.
  assert.equal(
    observeConversationAccessSnapshot(organization, userId, '11'),
    'new'
  )
  const restored = reconcileRevokedConversationIds(
    revoked,
    ['conversation-peer-b'],
    { restoreAllAuthoritative: true }
  )
  assert.deepEqual(restored, ['conversation-peer-b'])
  assert.equal(revoked.has('conversation-peer-b'), false)
})

test('conversation access events bind home, current target and revocation metadata', () => {
  const packet = {
    cmd: 'conversation.access_changed',
    organization: 901,
    data: {
      event_type: 'conversation.access_changed',
      event_id: eventId,
      cross_org_access_snapshot_id: '11',
      conversation_id: 'conversation-1',
      conversation_type: 1,
      allowed: false,
      target_organization: 901,
      target_user_id: 'user-a',
      peer_organization: 902,
      peer_user_id: 'user-b'
    }
  }
  assert.deepEqual(parseConversationAccessChanged(packet, '901', 'user-a'), {
    eventId,
    snapshotId: '11',
    conversationId: 'conversation-1',
    allowed: false,
    targetOrganization: '901',
    targetUserId: 'user-a',
    peerOrganization: '902',
    peerUserId: 'user-b'
  })
  assert.equal(parseConversationAccessChanged({
    ...packet,
    data: { ...packet.data, target_organization: 902 }
  }, '901', 'user-a'), null)
  assert.equal(parseConversationAccessChanged({
    ...packet,
    data: { ...packet.data, peer_organization: 901 }
  }, '901', 'user-a'), null)
  assert.equal(parseConversationAccessChanged({
    ...packet,
    data: { ...packet.data, conversation_type: 2 }
  }, '901', 'user-a'), null)
  assert.equal(parseConversationAccessChanged({
    ...packet,
    data: { ...packet.data, cross_org_access_snapshot_id: '0' }
  }, '901', 'user-a'), null)
  assert.equal(parseConversationAccessChanged({
    ...packet,
    data: { ...packet.data, cross_org_access_snapshot_id: '01' }
  }, '901', 'user-a'), null)
  assert.equal(parseConversationAccessChanged({
    ...packet,
    organization: 902
  }, '901', 'user-a'), null)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  commitGlobalSyncRecoveryCursor,
  compareGlobalSequences,
  GlobalSyncCursorStore,
  isExpectedStaleGlobalSyncSnapshot,
  normalizeGlobalSequence,
  validateGlobalSyncPage
} from '../src/services/imGlobalSync.ts'

function message(globalSeq: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    organization: 901,
    global_seq: globalSeq,
    conversation_id: 'single-1',
    conversation_type: 1,
    message_id: `message-${globalSeq}`,
    message_seq: Number(globalSeq),
    client_msg_id: `client-${globalSeq}`,
    sender_organization: 902,
    sender_id: 'peer',
    message_type: 1,
    content: { text: 'hello' },
    status: 1,
    create_time: '2026-07-20 10:00:00',
    ...overrides
  }
}

test('global sequence remains a canonical decimal string without precision loss', () => {
  assert.equal(normalizeGlobalSequence('0'), '0')
  assert.equal(normalizeGlobalSequence('9007199254740993123'), '9007199254740993123')
  assert.equal(normalizeGlobalSequence(1), '')
  assert.equal(normalizeGlobalSequence('01'), '')
  assert.equal(normalizeGlobalSequence('1'.repeat(21)), '')
  assert.equal(compareGlobalSequences(
    '9007199254740993124', '9007199254740993123'
  ), 1)
})

test('stale AUTH global sync accepts only non-regressing stale positive snapshots', () => {
  assert.equal(
    isExpectedStaleGlobalSyncSnapshot('stale', '99', '99'),
    true
  )
  assert.equal(
    isExpectedStaleGlobalSyncSnapshot('stale', '100', '99'),
    true
  )
  assert.equal(
    isExpectedStaleGlobalSyncSnapshot('stale', '98', '99'),
    false
  )
  assert.equal(
    isExpectedStaleGlobalSyncSnapshot('new', '101', '99'),
    false
  )
  assert.equal(
    isExpectedStaleGlobalSyncSnapshot('stale', '0', '99'),
    false
  )
})

test('global sync page requires ordered home-scoped messages and a progressing cursor', () => {
  const valid = validateGlobalSyncPage({
    scope: 'global',
    messages: [message('6'), message('8')],
    next_after_global_seq: '9',
    has_more: true,
    cross_org_access_snapshot_id: '42'
  }, { organization: '901', afterGlobalSeq: '5' })
  assert.ok(valid)
  assert.equal(valid.nextAfterGlobalSeq, '9')
  assert.equal(valid.messages.length, 2)

  assert.equal(validateGlobalSyncPage({
    scope: 'global', messages: [], next_after_global_seq: '5',
    has_more: true, cross_org_access_snapshot_id: '42'
  }, { organization: '901', afterGlobalSeq: '5' }), null)
  assert.equal(validateGlobalSyncPage({
    scope: 'global', messages: [message('6', { organization: 902 })],
    next_after_global_seq: '6', has_more: false,
    cross_org_access_snapshot_id: '42'
  }, { organization: '901', afterGlobalSeq: '5' }), null)
  assert.equal(validateGlobalSyncPage({
    scope: 'global', messages: [message('7'), message('6')],
    next_after_global_seq: '7', has_more: false,
    cross_org_access_snapshot_id: '42'
  }, { organization: '901', afterGlobalSeq: '5' }), null)
  assert.equal(validateGlobalSyncPage({
    scope: 'global', messages: [message('6'), message('7', { message_id: 'message-6' })],
    next_after_global_seq: '7', has_more: false,
    cross_org_access_snapshot_id: '42'
  }, { organization: '901', afterGlobalSeq: '5' }), null)
})

test('global cursor is monotonic only inside its recoverable runtime', () => {
  const store = new GlobalSyncCursorStore()
  store.write('12')
  assert.equal(store.read(), '12')
  assert.throws(() => store.write('11'), /禁止回退/)
  assert.throws(() => store.write('01'), /global_seq/)
})

test('tabs and reloads never inherit a cursor without durable message state', () => {
  const tabA = new GlobalSyncCursorStore()
  const tabB = new GlobalSyncCursorStore()
  tabA.write('100')
  tabB.write('20')
  assert.equal(tabA.read(), '100')
  assert.equal(tabB.read(), '20')
  assert.equal(new GlobalSyncCursorStore().read(), '0')
})

test('merge or authoritative ACK failure cannot advance the runtime cursor', async () => {
  const mergeFailure = new GlobalSyncCursorStore()
  await assert.rejects(
    commitGlobalSyncRecoveryCursor(
      mergeFailure,
      '10',
      async () => {
        throw new Error('merge failed')
      }
    ),
    /merge failed/
  )
  assert.equal(mergeFailure.read(), '0')

  const ackFailure = new GlobalSyncCursorStore()
  await assert.rejects(
    commitGlobalSyncRecoveryCursor(
      ackFailure,
      '20',
      async () => {
        await Promise.reject(new Error('ack failed'))
        return true
      }
    ),
    /ack failed/
  )
  assert.equal(ackFailure.read(), '0')

  const staleRuntime = new GlobalSyncCursorStore()
  assert.equal(
    await commitGlobalSyncRecoveryCursor(
      staleRuntime,
      '30',
      async () => false
    ),
    false
  )
  assert.equal(staleRuntime.read(), '0')
})

test('successful recovery advances only the current runtime and reload replays', async () => {
  const currentRuntime = new GlobalSyncCursorStore()
  let materialized = false
  let acknowledged = false
  assert.equal(
    await commitGlobalSyncRecoveryCursor(
      currentRuntime,
      '9007199254740993123',
      async () => {
        materialized = true
        await Promise.resolve()
        acknowledged = true
        return materialized && acknowledged
      }
    ),
    true
  )
  assert.equal(currentRuntime.read(), '9007199254740993123')
  assert.equal(new GlobalSyncCursorStore().read(), '0')
})

test('cursor commit waits for authoritative recovery ACK completion', async () => {
  const store = new GlobalSyncCursorStore()
  let acknowledge: (() => void) | null = null
  const authoritativeAck = new Promise<void>((resolve) => {
    acknowledge = resolve
  })
  const committing = commitGlobalSyncRecoveryCursor(
    store,
    '40',
    async () => {
      await authoritativeAck
      return true
    }
  )

  await Promise.resolve()
  assert.equal(store.read(), '0')
  assert.ok(acknowledge)
  acknowledge()
  assert.equal(await committing, true)
  assert.equal(store.read(), '40')
})

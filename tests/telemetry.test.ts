import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createTraceContext,
  parseTraceContext,
  setTelemetryObserverForTests,
  startTelemetrySpan,
  type TelemetrySpanSnapshot
} from '../src/services/telemetry.ts'

const TRACEPARENT_PATTERN = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/

test('creates cryptographically random W3C context and continues a valid trace', () => {
  const root = createTraceContext()
  const child = createTraceContext({
    traceparent: root.traceparent,
    tracestate: 'vendor=opaque'
  })

  assert.match(root.traceparent, TRACEPARENT_PATTERN)
  assert.match(child.traceparent, TRACEPARENT_PATTERN)
  assert.equal(child.traceparent.slice(3, 35), root.traceparent.slice(3, 35))
  assert.notEqual(child.traceparent.slice(36, 52), root.traceparent.slice(36, 52))
  assert.equal(child.tracestate, 'vendor=opaque')
})

test('rejects malformed/all-zero parents and drops invalid tracestate', () => {
  assert.equal(parseTraceContext('00-' + '0'.repeat(32) + '-' + '1'.repeat(16) + '-01'), null)
  assert.equal(parseTraceContext('00-' + '1'.repeat(32) + '-' + '0'.repeat(16) + '-01'), null)
  assert.equal(parseTraceContext('ff-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01'), null)

  const parsed = parseTraceContext(
    '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01',
    'duplicate=one,duplicate=two'
  )
  assert.ok(parsed)
  assert.equal(parsed.tracestate, undefined)
})

test('completed snapshots contain only the fixed safe field set and stable error metadata', () => {
  const snapshots: TelemetrySpanSnapshot[] = []
  setTelemetryObserverForTests((snapshot) => snapshots.push(snapshot))
  try {
    const span = startTelemetrySpan({
      name: 'web.websocket.send',
      kind: 'producer',
      fields: {
        organization: '1',
        command: 'send',
        clientMsgId: 'web-123',
        ...({ password: 'never-record-me', body: 'message-content' } as object)
      }
    })
    span.fail({
      code: 'IM_SEND_ACK_TIMEOUT',
      type: 'timeout',
      clientMsgId: 'web-123'
    })
    span.end()
  } finally {
    setTelemetryObserverForTests(null)
  }

  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0].status, 'ERROR')
  assert.deepEqual(snapshots[0].fields, {
    organization: '1',
    command: 'send',
    clientMsgId: 'web-123'
  })
  assert.deepEqual(snapshots[0].error, {
    code: 'IM_SEND_ACK_TIMEOUT',
    type: 'timeout',
    clientMsgId: 'web-123'
  })
  assert.doesNotMatch(JSON.stringify(snapshots), /never-record-me|message-content|password|body/)
})

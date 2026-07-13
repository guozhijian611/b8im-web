import test from 'node:test'
import assert from 'node:assert/strict'
import { attachTraceContext, PendingSendTraceRegistry } from '../src/services/imTelemetry.ts'
import {
  createTraceContext,
  setTelemetryObserverForTests,
  startTelemetrySpan,
  type TelemetrySpanSnapshot
} from '../src/services/telemetry.ts'

test('places trace context at the WebSocket envelope top level', () => {
  const context = {
    ...createTraceContext(),
    tracestate: 'vendor=opaque'
  }
  const packet = attachTraceContext({
    cmd: 'auth',
    data: { token: 'short-lived-secret', platform: 'web' }
  }, context)

  assert.equal(packet.traceparent, context.traceparent)
  assert.equal(packet.tracestate, 'vendor=opaque')
  assert.equal('traceparent' in packet.data, false)
})

test('holds SEND telemetry until ACK and ERROR, without recording message payload', () => {
  const snapshots: TelemetrySpanSnapshot[] = []
  setTelemetryObserverForTests((snapshot) => snapshots.push(snapshot))
  const registry = new PendingSendTraceRegistry(1000, () => assert.fail('unexpected timeout'))
  try {
    const acknowledged = startTelemetrySpan({
      name: 'web.websocket.send',
      kind: 'producer',
      fields: { command: 'send', clientMsgId: 'web-ok' }
    })
    registry.track('web-ok', acknowledged)
    assert.equal(registry.size(), 1)
    assert.equal(snapshots.length, 0)
    registry.finish('web-ok')

    const rejected = startTelemetrySpan({
      name: 'web.websocket.send',
      kind: 'producer',
      fields: { command: 'send', clientMsgId: 'web-error' }
    })
    registry.track('web-error', rejected)
    registry.finish('web-error', 'CONVERSATION_MEMBER_MUTED')

    assert.equal(registry.size(), 0)
    assert.equal(snapshots.length, 2)
    assert.equal(snapshots[0].status, 'OK')
    assert.equal(snapshots[1].status, 'ERROR')
    assert.equal(snapshots[1].error?.code, 'CONVERSATION_MEMBER_MUTED')
    assert.doesNotMatch(JSON.stringify(snapshots), /message content|short-lived-secret|token|body/)
  } finally {
    registry.failAll('TEST_CLEANUP', 'cleanup')
    setTelemetryObserverForTests(null)
  }
})

test('ends pending SEND telemetry on timeout and connection close', async () => {
  const snapshots: TelemetrySpanSnapshot[] = []
  const timedOut: string[] = []
  setTelemetryObserverForTests((snapshot) => snapshots.push(snapshot))
  const registry = new PendingSendTraceRegistry(1, (clientMsgId) => timedOut.push(clientMsgId))
  try {
    registry.track('web-timeout', startTelemetrySpan({
      name: 'web.websocket.send',
      kind: 'producer',
      fields: { command: 'send', clientMsgId: 'web-timeout' }
    }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(timedOut, ['web-timeout'])

    registry.track('web-close', startTelemetrySpan({
      name: 'web.websocket.send',
      kind: 'producer',
      fields: { command: 'send', clientMsgId: 'web-close' }
    }))
    registry.failAll('IM_WEBSOCKET_CLOSED', 'connection_closed')

    assert.equal(registry.size(), 0)
    assert.deepEqual(snapshots.map((snapshot) => snapshot.error?.code), [
      'IM_SEND_ACK_TIMEOUT',
      'IM_WEBSOCKET_CLOSED'
    ])
  } finally {
    registry.failAll('TEST_CLEANUP', 'cleanup')
    setTelemetryObserverForTests(null)
  }
})

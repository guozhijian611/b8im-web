import type { TelemetrySpan, TraceContext } from './telemetry'

export interface TraceableImPacket {
  cmd: string
  client_msg_id?: string
  traceparent?: string
  tracestate?: string
}

export function attachTraceContext<T extends TraceableImPacket>(packet: T, context?: TraceContext) {
  return {
    ...packet,
    ...(context ? { traceparent: context.traceparent } : {}),
    ...(context?.tracestate ? { tracestate: context.tracestate } : {})
  }
}

export class PendingSendTraceRegistry {
  private readonly pending = new Map<string, { span: TelemetrySpan; timeout: number }>()
  private readonly timeoutMs: number
  private readonly onTimeout: (clientMsgId: string) => void

  constructor(timeoutMs: number, onTimeout: (clientMsgId: string) => void) {
    this.timeoutMs = timeoutMs
    this.onTimeout = onTimeout
  }

  track(clientMsgId: string, span: TelemetrySpan) {
    const previous = this.pending.get(clientMsgId)
    if (previous) {
      globalThis.clearTimeout(previous.timeout)
      previous.span.fail({
        code: 'IM_SEND_REPLACED',
        type: 'duplicate_client_message',
        clientMsgId
      })
    }

    const timeout = globalThis.setTimeout(() => {
      const current = this.pending.get(clientMsgId)
      if (!current || current.span !== span) return
      this.pending.delete(clientMsgId)
      span.fail({
        code: 'IM_SEND_ACK_TIMEOUT',
        type: 'timeout',
        clientMsgId
      })
      this.onTimeout(clientMsgId)
    }, this.timeoutMs)
    this.pending.set(clientMsgId, { span, timeout })
  }

  finish(clientMsgId: string, errorCode = '') {
    if (!clientMsgId) return
    const current = this.pending.get(clientMsgId)
    if (!current) return
    this.pending.delete(clientMsgId)
    globalThis.clearTimeout(current.timeout)
    if (errorCode) {
      current.span.fail({
        code: errorCode,
        type: 'im_command_error',
        clientMsgId
      })
      return
    }
    current.span.end()
  }

  failAll(code: string, type: string) {
    for (const [clientMsgId, current] of this.pending) {
      globalThis.clearTimeout(current.timeout)
      current.span.fail({ code, type, clientMsgId })
    }
    this.pending.clear()
  }

  size() {
    return this.pending.size
  }
}

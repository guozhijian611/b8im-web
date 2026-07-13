export interface TraceContext {
  traceparent: string
  tracestate?: string
}

export type TelemetrySpanKind = 'client' | 'producer' | 'internal'
export type TelemetrySpanStatus = 'UNSET' | 'OK' | 'ERROR'

export interface TelemetrySafeFields {
  organization?: string
  method?: string
  path?: string
  routeId?: string
  command?: string
  retryCount?: number
  statusCode?: number
  clientMsgId?: string
}

export interface TelemetryErrorFields {
  code: string
  type: string
  retryCount?: number
  clientMsgId?: string
}

export interface TelemetrySpanSnapshot {
  name: string
  kind: TelemetrySpanKind
  context: TraceContext
  fields: Readonly<TelemetrySafeFields>
  status: TelemetrySpanStatus
  error?: Readonly<TelemetryErrorFields>
  startedAt: number
  endedAt: number
}

export interface TelemetrySpan {
  readonly context: TraceContext
  end(fields?: Pick<TelemetrySafeFields, 'statusCode' | 'retryCount'>): void
  fail(error: TelemetryErrorFields, fields?: Pick<TelemetrySafeFields, 'statusCode'>): void
}

type TelemetryObserver = (snapshot: TelemetrySpanSnapshot) => void

const TRACEPARENT_VERSION = '00'
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/
const ZERO_TRACE_ID = '0'.repeat(32)
const ZERO_SPAN_ID = '0'.repeat(16)
const TRACESTATE_KEY_PATTERN = /^(?:[a-z][a-z0-9_*/-]{0,255}|[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13})$/
const SAFE_TEXT_PATTERN = /^[A-Za-z0-9_.:/-]{1,160}$/
let telemetryObserver: TelemetryObserver | null = null

function randomHex(byteLength: number) {
  const cryptoApi = globalThis.crypto
  if (!cryptoApi?.getRandomValues) {
    throw new Error('当前运行时不支持安全随机数，已停止创建 Trace 上下文')
  }
  const bytes = new Uint8Array(byteLength)
  cryptoApi.getRandomValues(bytes)
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}

function randomNonZeroHex(byteLength: number, zeroValue: string) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const value = randomHex(byteLength)
    if (value !== zeroValue) return value
  }
  throw new Error('无法生成有效的 Trace 随机标识')
}

function normalizeTracestate(value: unknown) {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (!normalized || normalized.length > 512) return undefined
  const members = normalized.split(',').map((member) => member.trim())
  if (members.length > 32 || members.some((member) => member.length === 0 || member.length > 256)) {
    return undefined
  }

  const keys = new Set<string>()
  for (const member of members) {
    const separator = member.indexOf('=')
    if (separator <= 0 || separator === member.length - 1) return undefined
    const key = member.slice(0, separator)
    const entryValue = member.slice(separator + 1)
    if (
      !TRACESTATE_KEY_PATTERN.test(key) ||
      keys.has(key) ||
      entryValue.length > 256 ||
      entryValue.endsWith(' ') ||
      !/^[\x20-\x2b\x2d-\x3c\x3e-\x7e]+$/.test(entryValue)
    ) {
      return undefined
    }
    keys.add(key)
  }
  return members.join(',')
}

function safeText(value: unknown) {
  const normalized = String(value ?? '').trim()
  return SAFE_TEXT_PATTERN.test(normalized) ? normalized : undefined
}

function normalizeSafeFields(fields: TelemetrySafeFields = {}): TelemetrySafeFields {
  return {
    ...(safeText(fields.organization) ? { organization: safeText(fields.organization) } : {}),
    ...(safeText(fields.method) ? { method: safeText(fields.method) } : {}),
    ...(safeText(fields.path) ? { path: safeText(fields.path) } : {}),
    ...(safeText(fields.routeId) ? { routeId: safeText(fields.routeId) } : {}),
    ...(safeText(fields.command) ? { command: safeText(fields.command) } : {}),
    ...(Number.isSafeInteger(fields.retryCount) && Number(fields.retryCount) >= 0
      ? { retryCount: Number(fields.retryCount) }
      : {}),
    ...(Number.isSafeInteger(fields.statusCode) && Number(fields.statusCode) >= 0
      ? { statusCode: Number(fields.statusCode) }
      : {}),
    ...(safeText(fields.clientMsgId) ? { clientMsgId: safeText(fields.clientMsgId) } : {})
  }
}

function normalizeErrorFields(error: TelemetryErrorFields): TelemetryErrorFields {
  return {
    code: safeText(error.code) ?? 'TELEMETRY_UNKNOWN_ERROR',
    type: safeText(error.type) ?? 'unknown_error',
    ...(Number.isSafeInteger(error.retryCount) && Number(error.retryCount) >= 0
      ? { retryCount: Number(error.retryCount) }
      : {}),
    ...(safeText(error.clientMsgId) ? { clientMsgId: safeText(error.clientMsgId) } : {})
  }
}

export function parseTraceContext(traceparent: unknown, tracestate?: unknown): TraceContext | null {
  if (typeof traceparent !== 'string') return null
  const normalized = traceparent.trim().toLowerCase()
  const match = TRACEPARENT_PATTERN.exec(normalized)
  if (!match || match[1] === ZERO_TRACE_ID || match[2] === ZERO_SPAN_ID) return null

  const normalizedTracestate = normalizeTracestate(tracestate)
  return {
    traceparent: normalized,
    ...(normalizedTracestate ? { tracestate: normalizedTracestate } : {})
  }
}

export function createTraceContext(parent?: TraceContext | null): TraceContext {
  const parsedParent = parent
    ? parseTraceContext(parent.traceparent, parent.tracestate)
    : null
  const parentMatch = parsedParent ? TRACEPARENT_PATTERN.exec(parsedParent.traceparent) : null
  const traceId = parentMatch?.[1] ?? randomNonZeroHex(16, ZERO_TRACE_ID)
  const traceFlags = parentMatch?.[3] ?? '01'
  const spanId = randomNonZeroHex(8, ZERO_SPAN_ID)
  return {
    traceparent: `${TRACEPARENT_VERSION}-${traceId}-${spanId}-${traceFlags}`,
    ...(parsedParent?.tracestate ? { tracestate: parsedParent.tracestate } : {})
  }
}

export function startTelemetrySpan(input: {
  name: string
  kind: TelemetrySpanKind
  parent?: TraceContext | null
  fields?: TelemetrySafeFields
}): TelemetrySpan {
  const name = safeText(input.name) ?? 'b8im.operation'
  const context = createTraceContext(input.parent)
  const startedAt = Date.now()
  const initialFields = normalizeSafeFields(input.fields)
  let ended = false

  const finish = (
    status: TelemetrySpanStatus,
    fields?: Pick<TelemetrySafeFields, 'statusCode' | 'retryCount'>,
    error?: TelemetryErrorFields
  ) => {
    if (ended) return
    ended = true
    const snapshot: TelemetrySpanSnapshot = {
      name,
      kind: input.kind,
      context,
      fields: Object.freeze({ ...initialFields, ...normalizeSafeFields(fields) }),
      status,
      ...(error ? { error: Object.freeze(normalizeErrorFields(error)) } : {}),
      startedAt,
      endedAt: Date.now()
    }
    telemetryObserver?.(Object.freeze(snapshot))
  }

  return {
    context,
    end: (fields) => finish('OK', fields),
    fail: (error, fields) => finish('ERROR', fields, error)
  }
}

export function tryStartTelemetrySpan(input: Parameters<typeof startTelemetrySpan>[0]) {
  try {
    return startTelemetrySpan(input)
  } catch {
    // Telemetry 不是业务前置条件；安全随机源不可用时宁可停止传播，不使用弱随机数降级。
    return null
  }
}

export function injectTraceHeaders(headers: Headers, context: TraceContext) {
  headers.set('traceparent', context.traceparent)
  if (context.tracestate) headers.set('tracestate', context.tracestate)
  else headers.delete('tracestate')
}

export function setTelemetryObserverForTests(observer: TelemetryObserver | null) {
  telemetryObserver = observer
}

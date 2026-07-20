import { normalizeImOrganization } from './imIdentity.ts'

export const GROUP_ACCESS_SNAPSHOT_COMMAND = 'group_member_access_snapshot'
export const GROUP_ACCESS_SNAPSHOT_ACK_COMMAND = 'group_member_access_snapshot_ack'
export const GROUP_ACCESS_CHANGED_COMMAND = 'group_member_access_changed'
export const GROUP_ACCESS_CHANGED_EVENT_TYPE = 'group.member_access_changed'
export const GROUP_ACCESS_BROWSER_EVENT = 'b8im:group-member-access-changed'

const POSITIVE = /^[1-9]\d{0,19}$/
const NON_NEGATIVE = /^(0|[1-9]\d{0,19})$/
const UINT64_MAX = '18446744073709551615'
const encoder = new TextEncoder()
const readyScopes = new Set<string>()
const committedScopes = new Map<string, CommittedGroupAccessSnapshot>()
const scopeGenerations = new Map<string, number>()
const inFlightTasks = new Map<string, Set<AbortController>>()

export type GroupAccessState = 'active' | 'history_only'
export type GroupAccessEventState = GroupAccessState | 'revoked'
export interface GroupAccessPeriod { periodNo: string; fromSeq: string; toSeq: string | null }
export interface GroupAccessEntry {
  conversationId: string
  conversationType: 2
  accessVersion: string
  accessState: GroupAccessState
  lastMessageSeq: string
  lastChangeSeq: string
  periods: GroupAccessPeriod[]
}
export interface CommittedGroupAccessSnapshot {
  snapshotId: string
  entries: ReadonlyMap<string, GroupAccessEntry>
}
export interface GroupAccessChangedEvent {
  eventId: string
  snapshotId: string
  conversationId: string
  accessVersion: string
  accessState: GroupAccessEventState
  lastMessageSeq: string
  lastChangeSeq: string
  periods: GroupAccessPeriod[]
  reason: 'join' | 'leave' | 'remove' | 'suspend' | 'restore' | 'history_revoke'
  changedAt: string
}
export interface GroupAccessPacketLike {
  cmd?: unknown
  organization?: unknown
  client_msg_id?: unknown
  data?: unknown
}
export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }
export type GroupAccessEventDecision =
  | { kind: 'stale' }
  | { kind: 'duplicate' }
  | { kind: 'reload'; conversationId: string }
  | { kind: 'shrink'; next: CommittedGroupAccessSnapshot; event: GroupAccessChangedEvent }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
function hasUnpairedSurrogate(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}
function isUint64(value: string) {
  return value.length < UINT64_MAX.length ||
    (value.length === UINT64_MAX.length && value <= UINT64_MAX)
}
export function canonicalAccessId(value: unknown) {
  return typeof value === 'string' && value.length > 0 && value === value.trim() &&
    encoder.encode(value).byteLength <= 64 && !hasUnpairedSurrogate(value) &&
    !value.includes('\0') && !value.includes('|') ? value : ''
}
export function normalizePositiveDecimal(value: unknown) {
  return typeof value === 'string' && POSITIVE.test(value) && isUint64(value) ? value : ''
}
export function normalizeNonNegativeDecimal(value: unknown) {
  return typeof value === 'string' && NON_NEGATIVE.test(value) && isUint64(value) ? value : ''
}
export function compareCanonicalDecimals(left: string, right: string) {
  if (!normalizeNonNegativeDecimal(left) || !normalizeNonNegativeDecimal(right)) throw new Error('非规范十进制版本')
  const a = BigInt(left); const b = BigInt(right)
  return a === b ? 0 : a > b ? 1 : -1
}
export function nextCanonicalDecimal(value: string) {
  const normalized = normalizeNonNegativeDecimal(value)
  return normalized ? normalizePositiveDecimal((BigInt(normalized) + 1n).toString()) : ''
}
function scope(organization: unknown, userId: unknown) {
  const home = normalizeImOrganization(organization); const user = canonicalAccessId(userId)
  return home && user ? `${home}\u0000${user}` : ''
}
function compareUtf8(left: string, right: string) {
  const a = encoder.encode(left); const b = encoder.encode(right)
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}
function normalizePeriods(value: unknown, state: GroupAccessEventState): GroupAccessPeriod[] | null {
  if (!Array.isArray(value) || (state === 'revoked' ? value.length !== 0 : value.length === 0)) return null
  const result: GroupAccessPeriod[] = []; let previousNo = '0'; let previousTo: string | null = null; let opens = 0
  for (const raw of value) {
    if (!isRecord(raw)) return null
    const periodNo = normalizePositiveDecimal(raw.period_no)
    const fromSeq = normalizePositiveDecimal(raw.from_seq)
    const toSeq = raw.to_seq === null ? null : normalizePositiveDecimal(raw.to_seq)
    if (!periodNo || !fromSeq || (raw.to_seq !== null && !toSeq) ||
      compareCanonicalDecimals(periodNo, previousNo) <= 0 ||
      (toSeq !== null && compareCanonicalDecimals(toSeq, fromSeq) < 0) ||
      (previousTo !== null && compareCanonicalDecimals(fromSeq, previousTo) <= 0)) return null
    if (toSeq === null) { opens += 1; if (state !== 'active') return null }
    result.push({ periodNo, fromSeq, toSeq }); previousNo = periodNo; previousTo = toSeq
  }
  return state === 'active' && (opens !== 1 || result[result.length - 1]?.toSeq !== null) ? null : result
}
function normalizeEntry(value: unknown): GroupAccessEntry | null {
  if (!isRecord(value) || value.conversation_type !== 2 ||
    (value.access_state !== 'active' && value.access_state !== 'history_only')) return null
  const conversationId = canonicalAccessId(value.conversation_id)
  const accessVersion = normalizePositiveDecimal(value.access_version)
  const lastMessageSeq = normalizeNonNegativeDecimal(value.last_message_seq)
  const lastChangeSeq = normalizeNonNegativeDecimal(value.last_change_seq)
  const periods = normalizePeriods(value.periods, value.access_state)
  return conversationId && accessVersion && lastMessageSeq && lastChangeSeq && periods ? {
    conversationId, conversationType: 2, accessVersion, accessState: value.access_state,
    lastMessageSeq, lastChangeSeq, periods
  } : null
}
function normalizeCursor(value: unknown) {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192 &&
    value === value.trim() && !hasUnpairedSurrogate(value) && !value.includes('\0') ? value : ''
}
export function parseGroupAccessSnapshotPage(packet: GroupAccessPacketLike, context: {
  organization: string; clientMsgId: string; expectedSnapshotId: string | null
  previousConversationId: string; limit: number
}) {
  if (packet.cmd !== GROUP_ACCESS_SNAPSHOT_ACK_COMMAND || String(packet.organization ?? '') !== context.organization ||
    packet.client_msg_id !== context.clientMsgId || !isRecord(packet.data)) return null
  const data = packet.data; const snapshotId = normalizePositiveDecimal(data.access_snapshot_id)
  if (!snapshotId || (context.expectedSnapshotId !== null && snapshotId !== context.expectedSnapshotId) ||
    !Array.isArray(data.entries) || data.entries.length > context.limit ||
    typeof data.has_more !== 'boolean') return null
  const nextCursor = data.next_cursor === null ? null : normalizeCursor(data.next_cursor)
  if ((data.has_more && !nextCursor) || (!data.has_more && data.next_cursor !== null) ||
    (data.has_more && data.entries.length === 0)) return null
  const entries: GroupAccessEntry[] = []; let previous = context.previousConversationId
  for (const raw of data.entries) {
    const normalized = normalizeEntry(raw)
    if (!normalized || (previous && compareUtf8(normalized.conversationId, previous) <= 0)) return null
    entries.push(normalized); previous = normalized.conversationId
  }
  return { snapshotId, entries, nextCursor, hasMore: data.has_more }
}

async function sha256(value: string) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
export async function parseGroupAccessChanged(
  packet: GroupAccessPacketLike,
  organization: string,
  userId: string
): Promise<GroupAccessChangedEvent | null> {
  const home = normalizeImOrganization(organization); const user = canonicalAccessId(userId)
  if (!home || !user || packet.cmd !== GROUP_ACCESS_CHANGED_COMMAND ||
    String(packet.organization ?? '') !== home || !isRecord(packet.data)) return null
  const data = packet.data
  if (data.event_type !== GROUP_ACCESS_CHANGED_EVENT_TYPE || data.conversation_type !== 2 ||
    String(data.target_organization ?? '') !== home || data.target_user_id !== user ||
    !/^[0-9a-f]{64}$/.test(String(data.event_id ?? '')) ||
    !['active', 'history_only', 'revoked'].includes(String(data.access_state ?? '')) ||
    !['join', 'leave', 'remove', 'suspend', 'restore', 'history_revoke'].includes(String(data.reason ?? '')) ||
    typeof data.changed_at !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(data.changed_at)) return null
  const conversationId = canonicalAccessId(data.conversation_id)
  const snapshotId = normalizePositiveDecimal(data.access_snapshot_id)
  const accessVersion = normalizePositiveDecimal(data.access_version)
  const lastMessageSeq = normalizeNonNegativeDecimal(data.last_message_seq)
  const lastChangeSeq = normalizeNonNegativeDecimal(data.last_change_seq)
  const accessState = data.access_state as GroupAccessEventState
  const periods = normalizePeriods(data.periods, accessState)
  if (!conversationId || !snapshotId || !accessVersion || !lastMessageSeq || !lastChangeSeq || !periods) return null
  const eventId = String(data.event_id)
  const expected = await sha256([
    home, GROUP_ACCESS_CHANGED_EVENT_TYPE, conversationId, home, user, snapshotId, accessVersion
  ].join('|'))
  if (eventId !== expected) return null
  return {
    eventId, snapshotId, conversationId, accessVersion, accessState, lastMessageSeq, lastChangeSeq,
    periods, reason: data.reason as GroupAccessChangedEvent['reason'], changedAt: data.changed_at
  }
}

export class GroupAccessSnapshotStaging {
  private values: GroupAccessEntry[] = []
  private snapshotId = ''
  private nextCursor: string | null = null
  private previousConversationId = ''
  private clientMsgId = ''
  private complete = false
  readonly organization: string
  readonly authSnapshotId: string
  readonly limit: number

  constructor(organization: string, authSnapshotId: string, limit = 100) {
    if (!normalizeImOrganization(organization) || !normalizePositiveDecimal(authSnapshotId) ||
      !Number.isSafeInteger(limit) || limit <= 0) throw new Error('群访问快照 staging 初始化无效')
    this.organization = organization
    this.authSnapshotId = authSnapshotId
    this.limit = limit
  }
  request(clientMsgId: string) {
    if (this.complete || this.clientMsgId || !canonicalAccessId(clientMsgId)) {
      throw new Error('群访问快照页请求状态无效')
    }
    this.clientMsgId = clientMsgId
    return {
      cmd: GROUP_ACCESS_SNAPSHOT_COMMAND,
      client_msg_id: clientMsgId,
      data: { access_snapshot_id: this.snapshotId || null, cursor: this.nextCursor, limit: this.limit }
    }
  }
  accept(packet: GroupAccessPacketLike) {
    if (!this.clientMsgId) throw new Error('收到未请求的群访问快照页')
    const page = parseGroupAccessSnapshotPage(packet, {
      organization: this.organization,
      clientMsgId: this.clientMsgId,
      expectedSnapshotId: this.snapshotId || null,
      previousConversationId: this.previousConversationId,
      limit: this.limit
    })
    this.clientMsgId = ''
    if (!page || (!this.snapshotId && compareCanonicalDecimals(page.snapshotId, this.authSnapshotId) < 0)) {
      throw new Error('群访问快照页链或 schema 无效')
    }
    this.snapshotId ||= page.snapshotId
    this.values.push(...page.entries)
    this.previousConversationId = page.entries[page.entries.length - 1]?.conversationId ?? this.previousConversationId
    this.nextCursor = page.nextCursor
    this.complete = !page.hasMore
    return page
  }
  committed(): CommittedGroupAccessSnapshot {
    if (!this.complete || !this.snapshotId) throw new Error('群访问快照尚未完成')
    return {
      snapshotId: this.snapshotId,
      entries: new Map(this.values.map((value) => [value.conversationId, structuredClone(value)]))
    }
  }
  get pendingClientMsgId() { return this.clientMsgId }
  get hasMore() { return !this.complete }
  discard() {
    this.values = []; this.snapshotId = ''; this.nextCursor = null
    this.previousConversationId = ''; this.clientMsgId = ''; this.complete = false
  }
}

function hasExactShrinkPeriods(current: GroupAccessEntry, event: GroupAccessChangedEvent) {
  if (current.accessState === 'active') {
    if (event.accessState === 'history_only' && !['leave', 'remove'].includes(event.reason)) return false
    if (event.accessState === 'revoked' && !['leave', 'remove', 'suspend'].includes(event.reason)) return false
    if (event.reason === 'suspend') return event.accessState === 'revoked' && event.periods.length === 0
    const open = current.periods[current.periods.length - 1]
    if (!open || open.toSeq !== null) return false
    if (event.accessState === 'revoked') {
      return current.periods.length === 1 && event.periods.length === 0 &&
        compareCanonicalDecimals(current.lastMessageSeq, open.fromSeq) < 0
    }
    if (event.periods.length !== current.periods.length) return false
    return event.periods.every((candidate, index) => {
      const existing = current.periods[index]
      if (!existing || candidate.periodNo !== existing.periodNo || candidate.fromSeq !== existing.fromSeq) return false
      if (index < current.periods.length - 1) return candidate.toSeq === existing.toSeq
      return candidate.toSeq === event.lastMessageSeq &&
        compareCanonicalDecimals(candidate.toSeq, candidate.fromSeq) >= 0
    })
  }
  if (event.reason !== 'history_revoke' || event.accessState === 'active') return false
  const currentByPeriodNo = new Map(current.periods.map((period) => [period.periodNo, period]))
  return event.periods.every((candidate) => {
    const existing = currentByPeriodNo.get(candidate.periodNo)
    return Boolean(existing && existing.fromSeq === candidate.fromSeq && existing.toSeq === candidate.toSeq)
  }) && (event.accessState === 'history_only' ? event.periods.length > 0 : event.periods.length === 0)
}
export function classifyGroupAccessEvent(
  committed: CommittedGroupAccessSnapshot,
  event: GroupAccessChangedEvent,
  seen: ReadonlySet<string>
): GroupAccessEventDecision {
  const comparison = compareCanonicalDecimals(event.snapshotId, committed.snapshotId)
  if (comparison < 0) return { kind: 'stale' }
  if (comparison === 0) {
    return seen.has(event.eventId)
      ? { kind: 'duplicate' }
      : { kind: 'reload', conversationId: event.conversationId }
  }
  const current = committed.entries.get(event.conversationId)
  if (event.snapshotId !== nextCanonicalDecimal(committed.snapshotId) || !current ||
    event.accessVersion !== nextCanonicalDecimal(current.accessVersion) ||
    compareCanonicalDecimals(event.lastMessageSeq, current.lastMessageSeq) < 0 ||
    compareCanonicalDecimals(event.lastChangeSeq, current.lastChangeSeq) < 0 ||
    event.accessState === 'active' || !hasExactShrinkPeriods(current, event)) {
    return { kind: 'reload', conversationId: event.conversationId }
  }
  const entries = new Map(committed.entries)
  if (event.accessState === 'revoked') entries.delete(event.conversationId)
  else entries.set(event.conversationId, {
    conversationId: event.conversationId,
    conversationType: 2,
    accessVersion: event.accessVersion,
    accessState: event.accessState,
    lastMessageSeq: event.lastMessageSeq,
    lastChangeSeq: event.lastChangeSeq,
    periods: structuredClone(event.periods)
  })
  return { kind: 'shrink', next: { snapshotId: event.snapshotId, entries }, event }
}

function serialize(snapshot: CommittedGroupAccessSnapshot) {
  return JSON.stringify({
    schema: 1,
    snapshot_id: snapshot.snapshotId,
    entries: [...snapshot.entries.values()].map((value) => ({
      conversation_id: value.conversationId,
      conversation_type: 2,
      access_version: value.accessVersion,
      access_state: value.accessState,
      last_message_seq: value.lastMessageSeq,
      last_change_seq: value.lastChangeSeq,
      periods: value.periods.map((period) => ({
        period_no: period.periodNo,
        from_seq: period.fromSeq,
        to_seq: period.toSeq
      }))
    }))
  })
}
function deserialize(raw: string | null): CommittedGroupAccessSnapshot | null {
  if (!raw) return null
  try {
    const decoded = JSON.parse(raw) as Record<string, unknown>
    if (decoded.schema !== 1 || !normalizePositiveDecimal(decoded.snapshot_id) ||
      !Array.isArray(decoded.entries)) return null
    const entries = new Map<string, GroupAccessEntry>(); let previous = ''
    for (const rawEntry of decoded.entries) {
      const value = normalizeEntry(rawEntry)
      if (!value || (previous && compareUtf8(value.conversationId, previous) <= 0)) return null
      entries.set(value.conversationId, value); previous = value.conversationId
    }
    return { snapshotId: decoded.snapshot_id as string, entries }
  } catch { return null }
}

export class GroupAccessSnapshotStore {
  readonly key: string
  readonly organization: string
  readonly userId: string
  private value: CommittedGroupAccessSnapshot | null
  private readonly storage: StorageLike | null
  constructor(
    organization: string,
    userId: string,
    storage: StorageLike | null = typeof window === 'undefined' ? null : window.localStorage
  ) {
    const keyScope = scope(organization, userId)
    if (!keyScope) throw new Error('群访问快照存储作用域无效')
    this.organization = organization
    this.userId = userId
    this.storage = storage
    this.key = `b8im:web:group-member-access:v1:${encodeURIComponent(keyScope)}`
    this.value = deserialize(storage?.getItem(this.key) ?? null)
  }
  read() { return this.value }
  async commit(
    next: CommittedGroupAccessSnapshot,
    applyRuntimeBeforeHighWater: (
      previous: CommittedGroupAccessSnapshot | null,
      next: CommittedGroupAccessSnapshot
    ) => void | Promise<void>
  ) {
    const keyScope = scope(this.organization, this.userId)
    try {
      const raw = serialize(next)
      const committed = deserialize(raw)
      if (!committed) throw new Error('群访问快照原子提交失败')
      if (this.value && compareCanonicalDecimals(committed.snapshotId, this.value.snapshotId) < 0) {
        throw new Error('群访问快照 high-water 不允许倒退')
      }
      await applyRuntimeBeforeHighWater(this.value, committed)
      this.storage?.setItem(this.key, raw)
      this.value = committed
    } catch (error) {
      readyScopes.delete(keyScope)
      scopeGenerations.set(keyScope, (scopeGenerations.get(keyScope) ?? 0) + 1)
      throw error
    }
    readyScopes.add(keyScope)
    committedScopes.set(keyScope, this.value)
    scopeGenerations.set(keyScope, (scopeGenerations.get(keyScope) ?? 0) + 1)
    return this.value
  }
  failClose() { readyScopes.delete(scope(this.organization, this.userId)) }
}

export function revokedGroupConversationIds(
  previous: CommittedGroupAccessSnapshot | null,
  next: CommittedGroupAccessSnapshot
) {
  return new Set(
    [...(previous?.entries.keys() ?? [])].filter((conversationId) => !next.entries.has(conversationId))
  )
}

export function groupAccessConversationPatch(entry: GroupAccessEntry) {
  if (entry.accessState === 'active') return { groupAccessState: 'active' as const }
  return {
    groupAccessState: 'history_only' as const,
    unread: 0,
    preview: '',
    time: '',
    lastMessageId: '',
    lastMessageIndexId: 0,
    lastMessageTime: '',
    sortTime: '',
    avatarMembers: [] as never[],
    description: '',
    isPinned: false,
    isMuted: false,
    messageGroupId: 0,
    messageGroupName: ''
  }
}

export function currentGroupAccessEntry(
  session: { organization: unknown; user: { userId: unknown } },
  conversationId: unknown
) {
  const conversation = canonicalAccessId(conversationId)
  return conversation
    ? committedScopes.get(scope(session.organization, session.user.userId))?.entries.get(conversation) ?? null
    : null
}

export interface GroupAccessMessageLike { conversation_id?: unknown; message_seq?: unknown }
export function isGroupMessageVisible(
  entry: GroupAccessEntry | null | undefined,
  conversationId: unknown,
  message: GroupAccessMessageLike
) {
  const expectedConversationId = canonicalAccessId(conversationId)
  return Boolean(entry && expectedConversationId && entry.conversationId === expectedConversationId &&
    message.conversation_id === expectedConversationId &&
    isMessageSequenceVisible(entry, message.message_seq))
}
export function isGroupMessageBatchVisible(
  entry: GroupAccessEntry | null | undefined,
  conversationId: unknown,
  messages: readonly GroupAccessMessageLike[]
) {
  return Boolean(entry && messages.every((message) =>
    isGroupMessageVisible(entry, conversationId, message)
  ))
}

export interface GroupAccessTask {
  signal: AbortSignal
  cacheEpoch: string
  assertCurrent: () => void
  finish: () => void
}
export function startGroupAccessTask(
  session: { organization: unknown; user: { userId: unknown } },
  conversationId: unknown,
  requireActive: boolean
): GroupAccessTask {
  if (requireActive) assertActiveGroupAccess(session, conversationId)
  else {
    assertGroupAccessReady(session)
    if (!currentGroupAccessEntry(session, conversationId)) {
      throw new Error('当前群成员访问不允许此操作')
    }
  }
  const epoch = captureGroupAccessEpoch(session)
  const controller = new AbortController()
  const controllers = inFlightTasks.get(epoch.scope) ?? new Set<AbortController>()
  controllers.add(controller)
  inFlightTasks.set(epoch.scope, controllers)
  let finished = false
  return {
    signal: controller.signal,
    cacheEpoch: `${epoch.scope}\u0000${epoch.generation}`,
    assertCurrent: () => {
      if (controller.signal.aborted) throw new DOMException('群成员访问已变化', 'AbortError')
      assertGroupAccessEpochCurrent(epoch)
    },
    finish: () => {
      if (finished) return
      finished = true
      controllers.delete(controller)
      if (controllers.size === 0) inFlightTasks.delete(epoch.scope)
    }
  }
}
export function abortGroupAccessTasks(organization: unknown, userId: unknown) {
  const key = scope(organization, userId)
  for (const controller of inFlightTasks.get(key) ?? []) controller.abort()
  inFlightTasks.delete(key)
}
export function groupAccessTaskCount(organization: unknown, userId: unknown) {
  return inFlightTasks.get(scope(organization, userId))?.size ?? 0
}

export class GroupAccessFrameBarrier {
  private tail: Promise<void> = Promise.resolve()
  private pendingAccess = 0
  private failed = false
  private readonly onBlocked: () => void
  private readonly onAccessSettled: (remaining: number) => void
  private readonly onError: (error: unknown) => void
  constructor(
    onBlocked: () => void,
    onAccessSettled: (remaining: number) => void,
    onError: (error: unknown) => void
  ) {
    this.onBlocked = onBlocked
    this.onAccessSettled = onAccessSettled
    this.onError = onError
  }
  get blocked() { return this.pendingAccess > 0 }
  enqueueAccess(task: () => void | Promise<void>) {
    this.pendingAccess += 1
    this.onBlocked()
    const result = this.tail.then(async () => {
      if (this.failed) return
      await task()
    })
    this.tail = result.then(() => {
      this.pendingAccess -= 1
      this.onAccessSettled(this.pendingAccess)
    }, (error) => {
      this.pendingAccess -= 1
      this.failed = true
      this.onError(error)
    })
    return result
  }
  enqueueBusiness(task: () => void | Promise<void>) {
    const result = this.tail.then(async () => {
      if (this.failed) return
      await task()
    })
    this.tail = result.then(undefined, (error) => {
      this.failed = true
      this.onError(error)
    })
    return result
  }
}

export function setGroupAccessNotReady(organization: unknown, userId: unknown) {
  const key = scope(organization, userId)
  if (key) {
    abortGroupAccessTasks(organization, userId)
    readyScopes.delete(key)
    scopeGenerations.set(key, (scopeGenerations.get(key) ?? 0) + 1)
  }
}
export function isGroupAccessReady(organization: unknown, userId: unknown) {
  const key = scope(organization, userId)
  return Boolean(key && readyScopes.has(key))
}
export function assertGroupAccessReady(session: { organization: unknown; user: { userId: unknown } }) {
  if (!isGroupAccessReady(session.organization, session.user.userId)) {
    throw new Error('群成员访问快照尚未就绪')
  }
}
export function assertActiveGroupAccess(
  session: { organization: unknown; user: { userId: unknown } },
  conversationId: unknown
) {
  assertGroupAccessReady(session)
  const entry = committedScopes.get(scope(session.organization, session.user.userId))
    ?.entries.get(canonicalAccessId(conversationId))
  if (!entry || entry.accessState !== 'active') throw new Error('当前群成员访问不允许此操作')
}
export interface GroupAccessEpochToken { scope: string; generation: number }
export function captureGroupAccessEpoch(session: { organization: unknown; user: { userId: unknown } }): GroupAccessEpochToken {
  assertGroupAccessReady(session)
  const key = scope(session.organization, session.user.userId)
  return { scope: key, generation: scopeGenerations.get(key) ?? 0 }
}
export function assertGroupAccessEpochCurrent(token: GroupAccessEpochToken) {
  if (!token.scope || !readyScopes.has(token.scope) ||
    (scopeGenerations.get(token.scope) ?? 0) !== token.generation) {
    throw new Error('群成员访问快照已变化，旧请求结果已丢弃')
  }
}
export function isMessageSequenceVisible(value: GroupAccessEntry, sequence: unknown) {
  const normalized = normalizePositiveDecimal(
    typeof sequence === 'number' && Number.isSafeInteger(sequence) ? String(sequence) : sequence
  )
  return Boolean(normalized && value.periods.some((period) =>
    compareCanonicalDecimals(normalized, period.fromSeq) >= 0 &&
    (period.toSeq === null || compareCanonicalDecimals(normalized, period.toSeq) <= 0)
  ))
}

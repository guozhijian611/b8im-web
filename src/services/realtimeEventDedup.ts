export const MAX_RECENT_REALTIME_EVENT_IDS = 2048
export const REALTIME_EVENT_ID_PATTERN = /^[a-f0-9]{64}$/

const CANONICAL_REALTIME_COMMANDS = ['push', 'recall', 'edit', 'delete'] as const
const REALTIME_EVENT_TYPES = {
  push: 'message.created',
  recall: 'message.recalled',
  edit: 'message.edited'
} as const

const STORAGE_PREFIX = 'b8im:web:realtime-events:v1'
const STORAGE_VERSION = 1
const MAX_SERIALIZED_BYTES = 256 * 1024

export type RealtimeEventObservation = 'new' | 'duplicate' | 'invalid'
export type CanonicalRealtimeCommand = (typeof CANONICAL_REALTIME_COMMANDS)[number]

export interface RealtimeEventPacketLike {
  cmd?: unknown
  organization?: unknown
  data?: unknown
}

export interface RealtimeEventStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface PersistedRealtimeEvents {
  version: number
  organization: string
  user_id: string
  event_ids: string[]
}

export function isValidRealtimeEventId(value: unknown): value is string {
  return typeof value === 'string' && REALTIME_EVENT_ID_PATTERN.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function isCanonicalRealtimeCommand(value: unknown): value is CanonicalRealtimeCommand {
  return (
    typeof value === 'string' &&
    (CANONICAL_REALTIME_COMMANDS as readonly string[]).includes(value)
  )
}

/**
 * Validates canonical Rabbit realtime packets before they are observed or
 * allowed to mutate local state. ACK/SYNC and other point-to-point commands
 * are intentionally outside this contract and do not require an event id.
 */
export function isCanonicalRealtimeEventPacketValid(
  packet: RealtimeEventPacketLike,
  organization: string
): boolean {
  if (!isCanonicalRealtimeCommand(packet.cmd)) return false
  if (String(packet.organization ?? '') !== organization || !isRecord(packet.data)) return false

  const data = packet.data
  if (!isValidRealtimeEventId(data.event_id)) return false

  const messageId = String(data.message_id ?? '')
  const conversationId = String(data.conversation_id ?? '')
  const messageSeq = Number(data.message_seq ?? 0)
  if (!messageId || !conversationId || !Number.isSafeInteger(messageSeq) || messageSeq <= 0) {
    return false
  }

  if (packet.cmd === 'push' || packet.cmd === 'edit') {
    if (data.event_type !== REALTIME_EVENT_TYPES[packet.cmd] || !isRecord(data.message)) {
      return false
    }
    const message = data.message
    return (
      String(message.organization ?? '') === organization &&
      String(message.message_id ?? '') === messageId &&
      String(message.conversation_id ?? '') === conversationId &&
      Number(message.message_seq ?? 0) === messageSeq
    )
  }

  if (packet.cmd === 'recall') {
    return data.event_type === REALTIME_EVENT_TYPES.recall && data.status === 'recalled'
  }

  return (
    (data.event_type === 'message.deleted_both' && data.scope === 'both') ||
    (data.event_type === 'message.deleted_self' && data.scope === 'self')
  )
}

/**
 * Validates the control-plane friend request packet before its event id is
 * observed and before UI callbacks refresh counters or show notifications.
 */
export function isFriendRequestRealtimeEventPacketValid(
  packet: RealtimeEventPacketLike,
  organization: string,
  userId: string
): boolean {
  if (packet.cmd !== 'friend_request') return false
  if (String(packet.organization ?? '') !== organization || !isRecord(packet.data)) return false

  const data = packet.data
  if (!isValidRealtimeEventId(data.event_id) || data.event !== 'created') return false
  if (!Number.isSafeInteger(data.request_id) || Number(data.request_id) <= 0) return false
  if (!Number.isSafeInteger(data.pending_count) || Number(data.pending_count) < 0) return false
  if (typeof data.from_user_id !== 'string' || data.from_user_id.trim() === '') return false
  if (typeof data.to_user_id !== 'string' || data.to_user_id !== userId) return false
  if (typeof data.message !== 'string' || typeof data.create_time !== 'string' || data.create_time.trim() === '') {
    return false
  }

  return data.from_user === null || data.from_user === undefined || isRecord(data.from_user)
}

export function browserSessionStorage(): RealtimeEventStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

/**
 * Maintains an insertion-ordered in-memory window and mirrors it to the
 * current tab's sessionStorage. Persistence is scoped by organization and
 * user id; malformed/unavailable storage never disables the memory window.
 */
export class RealtimeEventDedupWindow {
  readonly organization: string
  readonly userId: string

  private readonly maximum: number
  private readonly storage: RealtimeEventStorage | null
  private readonly key: string
  private readonly eventIds = new Set<string>()

  constructor(
    organization: string,
    userId: string,
    storage: RealtimeEventStorage | null = browserSessionStorage(),
    maximum = MAX_RECENT_REALTIME_EVENT_IDS
  ) {
    this.organization = organization.trim()
    this.userId = userId.trim()
    const requestedMaximum = Number.isSafeInteger(maximum)
      ? maximum
      : MAX_RECENT_REALTIME_EVENT_IDS
    this.maximum = Math.max(
      1,
      Math.min(requestedMaximum, MAX_RECENT_REALTIME_EVENT_IDS)
    )
    const hasSafeScope = this.organization !== '' && this.userId !== ''
    this.storage = hasSafeScope ? storage : null
    this.key = hasSafeScope
      ? `${STORAGE_PREFIX}:${encodeURIComponent(this.organization)}:${encodeURIComponent(this.userId)}`
      : ''
    this.restore()
  }

  get size() {
    return this.eventIds.size
  }

  matches(organization: string, userId: string) {
    return this.organization === organization.trim() && this.userId === userId.trim()
  }

  has(eventId: string) {
    return isValidRealtimeEventId(eventId) && this.eventIds.has(eventId)
  }

  observe(eventId: unknown): RealtimeEventObservation {
    if (!isValidRealtimeEventId(eventId)) return 'invalid'
    if (this.eventIds.has(eventId)) return 'duplicate'

    this.eventIds.add(eventId)
    this.trim()
    this.persist()
    return 'new'
  }

  private restore() {
    if (!this.storage || !this.key) return
    try {
      const raw = this.storage.getItem(this.key)
      if (!raw || raw.length > MAX_SERIALIZED_BYTES) return
      const parsed = JSON.parse(raw) as Partial<PersistedRealtimeEvents>
      if (
        !parsed ||
        Array.isArray(parsed) ||
        parsed.version !== STORAGE_VERSION ||
        parsed.organization !== this.organization ||
        parsed.user_id !== this.userId ||
        !Array.isArray(parsed.event_ids)
      ) {
        return
      }
      for (const eventId of parsed.event_ids) {
        if (!isValidRealtimeEventId(eventId)) continue
        // If a corrupted snapshot repeats an id, retain its newest position.
        this.eventIds.delete(eventId)
        this.eventIds.add(eventId)
        this.trim()
      }
    } catch {
      // sessionStorage can be denied or contain invalid JSON. Memory dedup
      // remains authoritative for this runtime instance.
    }
  }

  private trim() {
    while (this.eventIds.size > this.maximum) {
      const oldest = this.eventIds.values().next().value
      if (typeof oldest !== 'string') break
      this.eventIds.delete(oldest)
    }
  }

  private persist() {
    if (!this.storage || !this.key) return
    const payload: PersistedRealtimeEvents = {
      version: STORAGE_VERSION,
      organization: this.organization,
      user_id: this.userId,
      event_ids: [...this.eventIds]
    }
    try {
      this.storage.setItem(this.key, JSON.stringify(payload))
    } catch {
      // Quota/security failures must not remove already-recorded memory ids.
    }
  }
}

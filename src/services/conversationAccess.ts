import { isSameImIdentity, normalizeImOrganization } from './imIdentity.ts'
import { isValidRealtimeEventId, type RealtimeEventStorage } from './realtimeEventDedup.ts'

export const CONVERSATION_ACCESS_CHANGED_COMMAND = 'conversation.access_changed'
export const CONVERSATION_ACCESS_BROWSER_EVENT = 'b8im:conversation-access-changed'

const STORAGE_PREFIX = 'b8im:web:cross-org-access-snapshot:v1'
const HIGH_WATER_STORAGE_PREFIX = 'b8im:web:cross-org-access-high-water:v2'
const REVOCATION_FLOOR_STORAGE_PREFIX =
  'b8im:web:cross-org-access-revocation-floor:v1'
const SNAPSHOT_PATTERN = /^(0|[1-9]\d{0,19})$/
const accessEpochStates = new Map<string, {
  epoch: number
  snapshotId: string
  highestPositiveSnapshotId: string
}>()
const activeAccessEpochScopes = new Map<string, string>()
const accessRecoveryRequiredScopes = new Set<string>()

export type AccessSnapshotObservation = 'new' | 'duplicate' | 'stale' | 'invalid'
export type AuthAccessSnapshotDecision =
  | 'current'
  | 'behind_high_water'
  | 'invalid'

export interface ConversationAccessPacketLike {
  cmd?: unknown
  organization?: unknown
  data?: unknown
}

export interface ConversationAccessChanged {
  eventId: string
  snapshotId: string
  conversationId: string
  allowed: boolean
  targetOrganization: string
  targetUserId: string
  peerOrganization: string
  peerUserId: string
}

export interface ConversationAccessEpochToken {
  readonly scope: string
  readonly epoch: number
  readonly snapshotId: string
}

export class ConversationAccessEpochChangedError extends Error {
  constructor() {
    super('跨机构访问权限已变化，旧请求结果已丢弃')
    this.name = 'ConversationAccessEpochChangedError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function accessEpochScope(organization: unknown, userId: unknown) {
  const normalizedOrganization = normalizeImOrganization(organization)
  const normalizedUserId = String(userId ?? '').trim()
  return normalizedOrganization && normalizedUserId
    ? `${normalizedOrganization}\u0000${normalizedUserId}`
    : ''
}

export function normalizeAccessSnapshotId(value: unknown): string {
  if (typeof value !== 'string' || !SNAPSHOT_PATTERN.test(value)) return ''
  return value
}

export function isAccessSnapshotFailClosed(value: unknown) {
  const normalized = normalizeAccessSnapshotId(value)
  return normalized === '' || normalized === '0'
}

export function shouldProcessAccessSnapshotEvent(
  observation: AccessSnapshotObservation
) {
  return observation === 'new' || observation === 'duplicate'
}

export function classifyAuthAccessSnapshot(
  observation: AccessSnapshotObservation,
  authSnapshotId: unknown,
  currentSnapshotId: unknown
): AuthAccessSnapshotDecision {
  const auth = normalizeAccessSnapshotId(authSnapshotId)
  const current = normalizeAccessSnapshotId(currentSnapshotId)
  if (!auth || observation === 'invalid') return 'invalid'
  if (observation === 'stale') {
    return auth === '0' ? 'invalid' : 'behind_high_water'
  }
  return auth === current ? 'current' : 'invalid'
}

export function reconcileRevokedConversationIds(
  revokedConversationIds: Set<string>,
  authoritativeConversationIds: Iterable<string>,
  options: {
    preserveRevokedConversationId?: string
    restorableConversationIds?: Iterable<string>
    restoreAllAuthoritative?: boolean
  } = {}
) {
  const preserveRevokedConversationId =
    options.preserveRevokedConversationId ?? ''
  const restorableConversationIds = new Set(
    options.restorableConversationIds ?? []
  )
  const restoreAllAuthoritative =
    options.restoreAllAuthoritative === true
  const accepted: string[] = []
  for (const value of authoritativeConversationIds) {
    const conversationId = String(value ?? '').trim()
    if (
      !conversationId ||
      conversationId === preserveRevokedConversationId ||
      (
        revokedConversationIds.has(conversationId) &&
        !restoreAllAuthoritative &&
        !restorableConversationIds.has(conversationId)
      )
    ) {
      continue
    }
    accepted.push(conversationId)
    revokedConversationIds.delete(conversationId)
  }
  return accepted
}

export function compareAccessSnapshotIds(left: string, right: string): number {
  const normalizedLeft = normalizeAccessSnapshotId(left)
  const normalizedRight = normalizeAccessSnapshotId(right)
  if (!normalizedLeft || !normalizedRight) {
    throw new Error('跨机构访问快照 ID 格式无效')
  }
  const leftValue = BigInt(normalizedLeft)
  const rightValue = BigInt(normalizedRight)
  return leftValue === rightValue ? 0 : leftValue > rightValue ? 1 : -1
}

/**
 * Advances a process-wide epoch shared by the runtime and every authenticated
 * HTTP request in the current tab. A canonical "0" only advances the epoch
 * and replaces the current state with fail-closed; it never clears or lowers
 * the highest positive high-water. A later positive snapshot must advance
 * beyond that high-water before access can initialize again.
 */
export function observeConversationAccessSnapshot(
  organization: unknown,
  userId: unknown,
  snapshotId: unknown
): AccessSnapshotObservation {
  const scope = accessEpochScope(organization, userId)
  const normalized = normalizeAccessSnapshotId(snapshotId)
  if (!scope || !normalized) return 'invalid'
  const current = accessEpochStates.get(scope)
  const scopeOrganization = scope.slice(0, scope.indexOf('\u0000'))
  activeAccessEpochScopes.set(scopeOrganization, scope)
  if (current?.snapshotId === normalized) return 'duplicate'
  if (normalized !== '0' && current?.highestPositiveSnapshotId) {
    const comparison = compareAccessSnapshotIds(
      normalized,
      current.highestPositiveSnapshotId
    )
    if (comparison === 0) {
      return current.snapshotId === normalized ? 'duplicate' : 'stale'
    }
    if (comparison < 0) return 'stale'
  }
  accessEpochStates.set(scope, {
    epoch: (current?.epoch ?? 0) + 1,
    snapshotId: normalized,
    highestPositiveSnapshotId: normalized === '0'
      ? current?.highestPositiveSnapshotId ?? ''
      : normalized
  })
  accessRecoveryRequiredScopes.add(scope)
  return 'new'
}

export function captureConversationAccessEpoch(
  organization: unknown,
  userId: unknown
): ConversationAccessEpochToken {
  const scope = accessEpochScope(organization, userId)
  const current = scope ? accessEpochStates.get(scope) : null
  return {
    scope,
    epoch: current?.epoch ?? 0,
    snapshotId: current?.snapshotId ?? ''
  }
}

export function advanceConversationAccessEpoch(
  organization: unknown,
  userId: unknown
) {
  const scope = accessEpochScope(organization, userId)
  const current = scope ? accessEpochStates.get(scope) : null
  if (!scope || !current) return false
  accessEpochStates.set(scope, {
    ...current,
    epoch: current.epoch + 1
  })
  accessRecoveryRequiredScopes.add(scope)
  return true
}

export function captureOrganizationAccessEpoch(
  organization: unknown
): ConversationAccessEpochToken | null {
  const normalizedOrganization = normalizeImOrganization(organization)
  if (!normalizedOrganization) return null
  const activeScope = activeAccessEpochScopes.get(normalizedOrganization)
  const active = activeScope ? accessEpochStates.get(activeScope) : null
  if (activeScope && active) {
    return {
      scope: activeScope,
      epoch: active.epoch,
      snapshotId: active.snapshotId
    }
  }
  const prefix = `${normalizedOrganization}\u0000`
  const matches = [...accessEpochStates.entries()].filter(([scope]) =>
    scope.startsWith(prefix)
  )
  if (matches.length !== 1) return null
  const [scope, current] = matches[0]
  return {
    scope,
    epoch: current.epoch,
    snapshotId: current.snapshotId
  }
}

export function isConversationAccessEpochCurrent(
  token: ConversationAccessEpochToken
) {
  if (!token.scope) return false
  const current = accessEpochStates.get(token.scope)
  return (current?.epoch ?? 0) === token.epoch &&
    (current?.snapshotId ?? '') === token.snapshotId
}

export function assertConversationAccessEpochCurrent(
  token: ConversationAccessEpochToken
) {
  if (!isConversationAccessEpochCurrent(token)) {
    throw new ConversationAccessEpochChangedError()
  }
}

export function currentConversationAccessSnapshot(
  organization: unknown,
  userId: unknown
) {
  return captureConversationAccessEpoch(organization, userId).snapshotId
}

export function setConversationAccessRecoveryRequired(
  organization: unknown,
  userId: unknown,
  required: boolean
) {
  const scope = accessEpochScope(organization, userId)
  if (!scope) return false
  if (required) {
    accessRecoveryRequiredScopes.add(scope)
  } else {
    accessRecoveryRequiredScopes.delete(scope)
  }
  return true
}

export function isConversationAccessRecoveryRequired(
  organization: unknown,
  userId: unknown
) {
  const scope = accessEpochScope(organization, userId)
  return !scope || accessRecoveryRequiredScopes.has(scope)
}

export function parseConversationAccessChanged(
  packet: ConversationAccessPacketLike,
  organization: string,
  userId: string
): ConversationAccessChanged | null {
  if (
    packet.cmd !== CONVERSATION_ACCESS_CHANGED_COMMAND ||
    String(packet.organization ?? '') !== organization ||
    !isRecord(packet.data)
  ) {
    return null
  }
  const data = packet.data
  const snapshotId = normalizeAccessSnapshotId(data.cross_org_access_snapshot_id)
  const conversationId = String(data.conversation_id ?? '').trim()
  const targetOrganization = normalizeImOrganization(data.target_organization)
  const targetUserId = String(data.target_user_id ?? '').trim()
  const peerOrganization = normalizeImOrganization(data.peer_organization)
  const peerUserId = String(data.peer_user_id ?? '').trim()
  if (
    data.event_type !== CONVERSATION_ACCESS_CHANGED_COMMAND ||
    Number(data.conversation_type ?? 0) !== 1 ||
    !isValidRealtimeEventId(data.event_id) ||
    !snapshotId ||
    snapshotId === '0' ||
    !conversationId ||
    typeof data.allowed !== 'boolean' ||
    !targetOrganization ||
    !targetUserId ||
    !peerOrganization ||
    !peerUserId ||
    !isSameImIdentity(
      targetOrganization,
      targetUserId,
      organization,
      userId
    ) ||
    peerOrganization === organization
  ) {
    return null
  }
  return {
    eventId: data.event_id,
    snapshotId,
    conversationId,
    allowed: data.allowed,
    targetOrganization,
    targetUserId,
    peerOrganization,
    peerUserId
  }
}

export function browserLocalStorage(): RealtimeEventStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

interface EnumerableMutableRealtimeEventStorage
  extends RealtimeEventStorage {
  readonly length: number
  key(index: number): string | null
  removeItem(key: string): void
}

function enumerableMutableStorage(
  storage: RealtimeEventStorage | null
): EnumerableMutableRealtimeEventStorage | null {
  if (!storage) return null
  try {
    const candidate =
      storage as Partial<EnumerableMutableRealtimeEventStorage>
    return typeof candidate.length === 'number' &&
      typeof candidate.key === 'function' &&
      typeof candidate.removeItem === 'function'
      ? storage as EnumerableMutableRealtimeEventStorage
      : null
  } catch {
    return null
  }
}

export class CrossOrgAccessSnapshotStore {
  private readonly key: string
  private readonly storage: RealtimeEventStorage | null
  private readonly enumerableStorage:
    EnumerableMutableRealtimeEventStorage | null
  private readonly highWaterPrefix: string
  private readonly revocationFloorPrefix: string
  private latestSnapshotId = ''
  private highestPositiveSnapshotId = ''
  private highestRevocationFloorSnapshotId = ''

  constructor(
    organization: string,
    userId: string,
    storage: RealtimeEventStorage | null = browserLocalStorage()
  ) {
    this.storage = storage
    this.enumerableStorage = enumerableMutableStorage(storage)
    const normalizedOrganization = normalizeImOrganization(organization)
    const normalizedUserId = userId.trim()
    this.key = normalizedOrganization && normalizedUserId
      ? `${STORAGE_PREFIX}:${encodeURIComponent(normalizedOrganization)}:${encodeURIComponent(normalizedUserId)}`
      : ''
    this.highWaterPrefix = normalizedOrganization && normalizedUserId
      ? `${HIGH_WATER_STORAGE_PREFIX}:${encodeURIComponent(normalizedOrganization)}:${encodeURIComponent(normalizedUserId)}:`
      : ''
    this.revocationFloorPrefix = normalizedOrganization && normalizedUserId
      ? `${REVOCATION_FLOOR_STORAGE_PREFIX}:${encodeURIComponent(normalizedOrganization)}:${encodeURIComponent(normalizedUserId)}:`
      : ''
    if (!this.storage || !this.key) return
    try {
      const persistedCurrent = normalizeAccessSnapshotId(
        this.storage.getItem(this.key)
      )
      this.latestSnapshotId = persistedCurrent
      this.refreshHighWater()
      if (
        persistedCurrent !== '0' &&
        persistedCurrent &&
        (
          !this.highestPositiveSnapshotId ||
          compareAccessSnapshotIds(
            persistedCurrent,
            this.highestPositiveSnapshotId
          ) > 0
        )
      ) {
        this.recordHighWater(persistedCurrent)
      }
      this.refreshHighWater()
      this.refreshRevocationFloor()
      if (
        persistedCurrent === '0' &&
        !this.highestRevocationFloorSnapshotId
      ) {
        // Migrate a fail-closed value written before revocation floors existed.
        this.recordRevocationFloor(
          this.highestPositiveSnapshotId || '0'
        )
      }
      this.synchronizePersistentState()
    } catch {
      this.latestSnapshotId = ''
      this.highestPositiveSnapshotId = ''
      this.highestRevocationFloorSnapshotId = ''
    }
  }

  get current() {
    this.synchronizePersistentState()
    return this.latestSnapshotId
  }

  get highWater() {
    this.synchronizePersistentState()
    return this.highestPositiveSnapshotId
  }

  observe(snapshotId: unknown): AccessSnapshotObservation {
    const normalized = normalizeAccessSnapshotId(snapshotId)
    if (!normalized) return 'invalid'
    this.synchronizePersistentState()

    if (normalized === '0') {
      if (this.latestSnapshotId === '0') return 'duplicate'
      this.recordRevocationFloor(this.highestKnownSnapshotFloor())
      this.synchronizePersistentState()
      return this.latestSnapshotId === '0' ? 'new' : 'stale'
    }

    const previousHighWater = this.highestPositiveSnapshotId
    if (
      previousHighWater &&
      compareAccessSnapshotIds(normalized, previousHighWater) < 0
    ) {
      return 'stale'
    }
    if (
      this.highestRevocationFloorSnapshotId &&
      compareAccessSnapshotIds(
        normalized,
        this.highestRevocationFloorSnapshotId
      ) <= 0
    ) {
      return 'stale'
    }
    if (
      previousHighWater &&
      compareAccessSnapshotIds(normalized, previousHighWater) === 0
    ) {
      return 'duplicate'
    }

    this.recordHighWater(normalized)
    this.synchronizePersistentState()
    if (
      this.latestSnapshotId === '0' ||
      (
        this.highestPositiveSnapshotId &&
        compareAccessSnapshotIds(
          normalized,
          this.highestPositiveSnapshotId
        ) < 0
      )
    ) {
      return 'stale'
    }
    return 'new'
  }

  private refreshHighWater() {
    if (!this.enumerableStorage || !this.highWaterPrefix) return
    try {
      const length = this.enumerableStorage.length
      for (let index = 0; index < length; index += 1) {
        const key = this.enumerableStorage.key(index)
        if (!key?.startsWith(this.highWaterPrefix)) continue
        const suffix = normalizeAccessSnapshotId(
          key.slice(this.highWaterPrefix.length)
        )
        const persisted = normalizeAccessSnapshotId(
          this.enumerableStorage.getItem(key)
        )
        if (!suffix || suffix === '0' || persisted !== suffix) continue
        if (
          !this.highestPositiveSnapshotId ||
          compareAccessSnapshotIds(
            suffix,
            this.highestPositiveSnapshotId
          ) > 0
        ) {
          this.highestPositiveSnapshotId = suffix
        }
      }
    } catch {
      // Keep the process-local high-water while storage is unavailable.
    }
  }

  private refreshRevocationFloor() {
    if (!this.enumerableStorage || !this.revocationFloorPrefix) return
    try {
      const length = this.enumerableStorage.length
      for (let index = 0; index < length; index += 1) {
        const key = this.enumerableStorage.key(index)
        if (!key?.startsWith(this.revocationFloorPrefix)) continue
        const suffix = normalizeAccessSnapshotId(
          key.slice(this.revocationFloorPrefix.length)
        )
        const persisted = normalizeAccessSnapshotId(
          this.enumerableStorage.getItem(key)
        )
        if (!suffix || persisted !== suffix) continue
        if (
          !this.highestRevocationFloorSnapshotId ||
          compareAccessSnapshotIds(
            suffix,
            this.highestRevocationFloorSnapshotId
          ) > 0
        ) {
          this.highestRevocationFloorSnapshotId = suffix
        }
      }
    } catch {
      // Keep the process-local revocation floor while storage is unavailable.
    }
  }

  private recordHighWater(snapshotId: string) {
    if (
      !this.highestPositiveSnapshotId ||
      compareAccessSnapshotIds(
        snapshotId,
        this.highestPositiveSnapshotId
      ) > 0
    ) {
      this.highestPositiveSnapshotId = snapshotId
    }
    if (!this.storage || !this.highWaterPrefix) return
    try {
      this.storage.setItem(
        `${this.highWaterPrefix}${snapshotId}`,
        snapshotId
      )
    } catch {
      // Memory state remains authoritative while localStorage is unavailable.
    }
  }

  private recordRevocationFloor(snapshotId: string) {
    if (
      !this.highestRevocationFloorSnapshotId ||
      compareAccessSnapshotIds(
        snapshotId,
        this.highestRevocationFloorSnapshotId
      ) > 0
    ) {
      this.highestRevocationFloorSnapshotId = snapshotId
    }
    if (!this.storage || !this.revocationFloorPrefix) return
    try {
      this.storage.setItem(
        `${this.revocationFloorPrefix}${snapshotId}`,
        snapshotId
      )
    } catch {
      // Memory state remains fail-closed while localStorage is unavailable.
    }
  }

  private highestKnownSnapshotFloor() {
    if (!this.highestPositiveSnapshotId) {
      return this.highestRevocationFloorSnapshotId || '0'
    }
    if (
      !this.highestRevocationFloorSnapshotId ||
      compareAccessSnapshotIds(
        this.highestPositiveSnapshotId,
        this.highestRevocationFloorSnapshotId
      ) >= 0
    ) {
      return this.highestPositiveSnapshotId
    }
    return this.highestRevocationFloorSnapshotId
  }

  private reconcileLatestSnapshot() {
    const revocationIsEffective =
      Boolean(this.highestRevocationFloorSnapshotId) &&
      (
        !this.highestPositiveSnapshotId ||
        compareAccessSnapshotIds(
          this.highestRevocationFloorSnapshotId,
          this.highestPositiveSnapshotId
        ) >= 0
      )
    this.latestSnapshotId = revocationIsEffective
      ? '0'
      : this.highestPositiveSnapshotId
  }

  private persistCurrentCache() {
    if (!this.storage || !this.key || !this.latestSnapshotId) return
    try {
      if (
        normalizeAccessSnapshotId(this.storage.getItem(this.key)) !==
        this.latestSnapshotId
      ) {
        this.storage.setItem(this.key, this.latestSnapshotId)
      }
    } catch {
      // Immutable floors remain authoritative if the mutable cache is stale.
    }
  }

  private synchronizePersistentState() {
    this.refreshHighWater()
    this.refreshRevocationFloor()
    this.reconcileLatestSnapshot()
    this.compactHighWaterEntries()
    this.compactRevocationFloorEntries()
    // Re-read after compaction so an entry concurrently inserted while lower
    // entries were removed is reflected before the mutable cache is repaired.
    this.refreshHighWater()
    this.refreshRevocationFloor()
    this.reconcileLatestSnapshot()
    this.persistCurrentCache()
  }

  private compactHighWaterEntries() {
    if (
      !this.enumerableStorage ||
      !this.highWaterPrefix ||
      !this.highestPositiveSnapshotId
    ) {
      return
    }
    try {
      const keys: string[] = []
      const length = this.enumerableStorage.length
      for (let index = 0; index < length; index += 1) {
        const key = this.enumerableStorage.key(index)
        if (key?.startsWith(this.highWaterPrefix)) keys.push(key)
      }
      for (const key of keys) {
        const snapshotId = normalizeAccessSnapshotId(
          key.slice(this.highWaterPrefix.length)
        )
        if (
          snapshotId &&
          snapshotId !== '0' &&
          compareAccessSnapshotIds(
            snapshotId,
            this.highestPositiveSnapshotId
          ) < 0
        ) {
          this.enumerableStorage.removeItem(key)
        }
      }
    } catch {
      // Compaction is opportunistic; immutable high-water entries stay safe.
    }
  }

  private compactRevocationFloorEntries() {
    if (
      !this.enumerableStorage ||
      !this.revocationFloorPrefix ||
      !this.highestRevocationFloorSnapshotId
    ) {
      return
    }
    try {
      const keys: string[] = []
      const length = this.enumerableStorage.length
      for (let index = 0; index < length; index += 1) {
        const key = this.enumerableStorage.key(index)
        if (key?.startsWith(this.revocationFloorPrefix)) keys.push(key)
      }
      for (const key of keys) {
        const snapshotId = normalizeAccessSnapshotId(
          key.slice(this.revocationFloorPrefix.length)
        )
        if (
          snapshotId &&
          compareAccessSnapshotIds(
            snapshotId,
            this.highestRevocationFloorSnapshotId
          ) < 0
        ) {
          this.enumerableStorage.removeItem(key)
        }
      }
    } catch {
      // A lower tab only removes floors below its local maximum. A concurrently
      // inserted higher tombstone is therefore never removed.
    }
  }
}

import { isSameImIdentity, normalizeImOrganization } from './imIdentity.ts'

export const MAX_RECENT_REALTIME_EVENT_IDS = 2048
export const REALTIME_EVENT_ID_PATTERN = /^[a-f0-9]{64}$/

const CANONICAL_REALTIME_COMMANDS = [
  'push',
  'recall',
  'edit',
  'delete',
  'ack',
  'conversation_read'
] as const
const REALTIME_EVENT_TYPES = {
  push: 'message.created',
  recall: 'message.recalled',
  edit: 'message.edited',
  ack: 'message.receipt',
  conversation_read: 'conversation.read'
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

export interface ImConversationIdentityContext {
  conversationId: string
  conversationType: 'single' | 'group'
  peerOrganization?: unknown
  peerUserId?: unknown
}

export interface CanonicalRealtimeEventValidationOptions {
  conversation?: ImConversationIdentityContext | null
  message?: ImMessageEventContext | null
  currentAccessSnapshotId?: unknown
}

export interface PendingImControlRequest {
  command: 'send' | 'ack' | 'conversation_read' | 'recall' | 'edit' | 'delete' | 'screenshot'
  clientMsgId: string
  conversationId: string
  messageId?: string
  messageSeq?: number
  status?: 'delivered' | 'read'
  senderOrganization?: string
  senderUserId?: string
  conversationType?: 'single' | 'group'
  peerOrganization?: string
  peerUserId?: string
  messageType?: number
  content?: Record<string, unknown>
  scope?: 'self' | 'both'
  createdAt: number
}

export interface ImMessageEventContext {
  conversationId: string
  messageId: string
  messageSeq: number
  senderOrganization: unknown
  senderUserId: unknown
  messageType?: number | string
  side?: 'in' | 'out' | 'system'
}

export type ReceiptEventDirection =
  | 'peer_reads_current'
  | 'current_reads_peer'
  | 'group_member'
  | 'invalid'

export type ChangeSequenceDecision = 'apply' | 'stale' | 'gap' | 'invalid'

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
 * allowed to mutate local state. Point-to-point ACK responses such as
 * ack_ack, SYNC, and other request responses stay outside this contract.
 */
export function isCanonicalRealtimeEventPacketValid(
  packet: RealtimeEventPacketLike,
  organization: string,
  userId = '',
  options: CanonicalRealtimeEventValidationOptions = {}
): boolean {
  if (!isCanonicalRealtimeCommand(packet.cmd)) return false
  if (String(packet.organization ?? '') !== organization || !isRecord(packet.data)) return false

  const data = packet.data
  if (!isValidRealtimeEventId(data.event_id)) return false

  if (packet.cmd === 'conversation_read') {
    if (!(
      data.event_type === REALTIME_EVENT_TYPES.conversation_read &&
      Number.isSafeInteger(packet.organization) &&
      Number(packet.organization) > 0 &&
      typeof data.conversation_id === 'string' &&
      data.conversation_id.trim() !== '' &&
      typeof data.last_read_message_id === 'string' &&
      data.last_read_message_id.trim() !== '' &&
      Number.isSafeInteger(data.last_read_seq) &&
      Number(data.last_read_seq) > 0 &&
      Number.isSafeInteger(data.unread_count) &&
      Number(data.unread_count) >= 0 &&
      Number.isSafeInteger(data.user_organization) &&
      Number(data.user_organization) > 0 &&
      typeof data.user_id === 'string' &&
      data.user_id.trim() !== '' &&
      typeof data.time === 'string' &&
      data.time.trim() !== ''
    )) {
      return false
    }

    const conversation = options.conversation
    if (!conversation || conversation.conversationId !== data.conversation_id) {
      return false
    }
    return hasCanonicalAccessSnapshotForConversation(
      data,
      organization,
      conversation,
      options.currentAccessSnapshotId
    )
  }

  if (packet.cmd === 'ack') {
    const conversation = options.conversation
    const message = options.message
    if (!conversation || !message) return false
    if (!(
      data.event_type === REALTIME_EVENT_TYPES.ack &&
      Number.isSafeInteger(packet.organization) &&
      Number(packet.organization) > 0 &&
      Number.isSafeInteger(data.organization) &&
      String(data.organization) === organization &&
      typeof data.conversation_id === 'string' &&
      data.conversation_id.trim() !== '' &&
      typeof data.message_id === 'string' &&
      data.message_id.trim() !== '' &&
      Number.isSafeInteger(data.message_seq) &&
      Number(data.message_seq) > 0 &&
      Number.isSafeInteger(data.sender_organization) &&
      Number(data.sender_organization) > 0 &&
      typeof data.sender_id === 'string' &&
      data.sender_id.trim() !== '' &&
      Number.isSafeInteger(data.user_organization) &&
      Number(data.user_organization) > 0 &&
      typeof data.user_id === 'string' &&
      data.user_id.trim() !== '' &&
      (data.status === 'delivered' || data.status === 'read') &&
      typeof data.time === 'string' &&
      data.time.trim() !== ''
    )) {
      return false
    }
    if (
      conversation.conversationId !== data.conversation_id ||
      message.conversationId !== data.conversation_id ||
      message.messageId !== data.message_id ||
      message.messageSeq !== data.message_seq ||
      !isSameImIdentity(
        message.senderOrganization,
        message.senderUserId,
        data.sender_organization,
        data.sender_id
      ) ||
      classifyReceiptEventDirection(
        data,
        organization,
        userId,
        conversation,
        message
      ) === 'invalid'
    ) {
      return false
    }
    return hasCanonicalAccessSnapshotForConversation(
      data,
      organization,
      conversation,
      options.currentAccessSnapshotId
    )
  }

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
    const senderOrganization = normalizeImOrganization(message.sender_organization)
    const senderId = typeof message.sender_id === 'string' ? message.sender_id.trim() : ''
    const senderUser = isRecord(message.sender_user) ? message.sender_user : null
    if (
      !senderOrganization ||
      !senderId ||
      (senderUser &&
        !isSameImIdentity(
          senderUser.organization,
          senderUser.user_id,
          senderOrganization,
          message.sender_id
        ))
    ) {
      return false
    }
    return (
      (packet.cmd !== 'edit' || (
        hasMutationActor(data) && isPositiveSequence(data.change_seq)
      )) &&
      String(message.organization ?? '') === organization &&
      String(message.message_id ?? '') === messageId &&
      String(message.conversation_id ?? '') === conversationId &&
      Number(message.message_seq ?? 0) === messageSeq
    )
  }

  if (packet.cmd === 'recall') {
    return data.event_type === REALTIME_EVENT_TYPES.recall &&
      data.status === 'recalled' && hasMutationActor(data) &&
      isPositiveSequence(data.change_seq)
  }

  if (!hasMutationActor(data) || !isPositiveSequence(data.change_seq)) return false
  if (data.event_type === 'message.deleted_both' && data.scope === 'both') {
    return data.target_organization == null && data.target_user_id == null
  }
  if (data.event_type !== 'message.deleted_self' || data.scope !== 'self') return false
  return Boolean(userId.trim() && isSameImIdentity(
    data.target_organization, data.target_user_id, organization, userId
  ))
}

function isPositiveSequence(value: unknown) {
  const sequence = Number(value ?? 0)
  return Number.isSafeInteger(sequence) && sequence > 0
}

function hasMutationActor(data: Record<string, unknown>) {
  return Boolean(
    normalizeImOrganization(data.actor_organization) &&
    typeof data.actor_user_id === 'string' &&
    data.actor_user_id.trim() !== ''
  )
}

function hasCanonicalAccessSnapshotForConversation(
  data: Record<string, unknown>,
  organization: string,
  conversation: ImConversationIdentityContext,
  currentAccessSnapshotId: unknown
): boolean {
  const hasAccessSnapshot = Object.prototype.hasOwnProperty.call(
    data,
    'cross_org_access_snapshot_id'
  )
  const isCrossOrgSingle =
    conversation.conversationType === 'single' &&
    normalizeImOrganization(conversation.peerOrganization) !== organization
  if (!isCrossOrgSingle) return !hasAccessSnapshot

  const snapshotId = data.cross_org_access_snapshot_id
  return (
    typeof snapshotId === 'string' &&
    /^[1-9][0-9]{0,19}$/.test(snapshotId) &&
    typeof currentAccessSnapshotId === 'string' &&
    /^[1-9][0-9]{0,19}$/.test(currentAccessSnapshotId) &&
    snapshotId === currentAccessSnapshotId
  )
}

export function isConversationParticipantIdentity(
  actorOrganization: unknown,
  actorUserId: unknown,
  organization: string,
  userId: string,
  conversation: ImConversationIdentityContext
): boolean {
  if (conversation.conversationType === 'group') {
    return normalizeImOrganization(actorOrganization) === organization &&
      String(actorUserId ?? '').trim() !== ''
  }
  return isSameImIdentity(actorOrganization, actorUserId, organization, userId) ||
    isSameImIdentity(
      actorOrganization,
      actorUserId,
      conversation.peerOrganization,
      conversation.peerUserId
    )
}

export function isMessageSenderValidForConversation(
  message: Record<string, unknown>,
  organization: string,
  userId: string,
  conversation: ImConversationIdentityContext
): boolean {
  if (
    message.sender_user != null &&
    (
      !isRecord(message.sender_user) ||
      !isSameImIdentity(
        message.sender_user.organization,
        message.sender_user.user_id,
        message.sender_organization,
        message.sender_id
      )
    )
  ) {
    return false
  }
  if (Number(message.message_type ?? 0) === 5) {
    const content = isRecord(message.content) ? message.content : null
    return Boolean(
      normalizeImOrganization(message.sender_organization) === organization &&
      String(message.sender_id ?? '').trim() &&
      content &&
      isConversationParticipantIdentity(
        content.actor_organization,
        content.actor_user_id,
        organization,
        userId,
        conversation
      )
    )
  }
  return isConversationParticipantIdentity(
    message.sender_organization,
    message.sender_id,
    organization,
    userId,
    conversation
  )
}

export function isMessageValidForConversation(
  message: Record<string, unknown>,
  organization: string,
  userId: string,
  conversation: ImConversationIdentityContext
): boolean {
  const messageSequence = Number(message.message_seq ?? 0)
  const expectedConversationType =
    conversation.conversationType === 'single' ? 1 : 2
  return Boolean(
    String(message.organization ?? '') === organization &&
    String(message.conversation_id ?? '').trim() === conversation.conversationId &&
    Number(message.conversation_type ?? 0) === expectedConversationType &&
    String(message.message_id ?? '').trim() &&
    Number.isSafeInteger(messageSequence) &&
    messageSequence > 0 &&
    isMessageSenderValidForConversation(
      message,
      organization,
      userId,
      conversation
    )
  )
}

export function isDurableMutationValidForContext(
  command: 'recall' | 'edit' | 'delete',
  data: Record<string, unknown>,
  organization: string,
  userId: string,
  conversation: ImConversationIdentityContext,
  original: ImMessageEventContext
): boolean {
  if (!isConversationParticipantIdentity(
    data.actor_organization,
    data.actor_user_id,
    organization,
    userId,
    conversation
  )) return false
  if (String(data.conversation_id ?? '') !== original.conversationId ||
    String(data.message_id ?? '') !== original.messageId ||
    Number(data.message_seq ?? 0) !== original.messageSeq) return false

  const actorIsSender = isSameImIdentity(
    data.actor_organization,
    data.actor_user_id,
    original.senderOrganization,
    original.senderUserId
  )
  if (command === 'recall') return actorIsSender && data.status === 'recalled'
  if (command === 'edit') {
    if (
      !actorIsSender ||
      Number(original.messageType ?? 0) !== 1 ||
      !isRecord(data.message) ||
      !isMessageValidForConversation(
        data.message,
        organization,
        userId,
        conversation
      )
    ) {
      return false
    }
    return isSameImIdentity(
      data.message.sender_organization,
      data.message.sender_id,
      original.senderOrganization,
      original.senderUserId
    )
  }
  if (data.scope === 'both') {
    return actorIsSender &&
      data.target_organization == null &&
      data.target_user_id == null
  }
  return data.scope === 'self' &&
    isSameImIdentity(
      data.actor_organization,
      data.actor_user_id,
      organization,
      userId
    ) &&
    isSameImIdentity(
      data.target_organization,
      data.target_user_id,
      organization,
      userId
    )
}

export function classifyReceiptEventDirection(
  data: Record<string, unknown>,
  organization: string,
  userId: string,
  conversation: ImConversationIdentityContext,
  message?: ImMessageEventContext
): ReceiptEventDirection {
  const senderOrganization = normalizeImOrganization(data.sender_organization)
  const userOrganization = normalizeImOrganization(data.user_organization)
  const senderId = String(data.sender_id ?? '').trim()
  const receiptUserId = String(data.user_id ?? '').trim()
  const messageId = String(data.message_id ?? '').trim()
  const conversationId = String(data.conversation_id ?? '').trim()
  const status = data.status
  const messageSeq = Number(data.message_seq ?? 0)
  if (!senderOrganization || !userOrganization || !senderId || !receiptUserId ||
    !messageId || conversationId !== conversation.conversationId ||
    !Number.isSafeInteger(messageSeq) || messageSeq <= 0 ||
    (status !== 'delivered' && status !== 'read') ||
    data.event_type !== 'message.receipt') {
    return 'invalid'
  }
  if (
    message?.side === 'system' &&
    message.conversationId === conversationId &&
    message.messageId === messageId &&
    message.messageSeq === messageSeq &&
    isSameImIdentity(
      senderOrganization,
      senderId,
      message.senderOrganization,
      message.senderUserId
    )
  ) {
    if (isSameImIdentity(userOrganization, receiptUserId, organization, userId)) {
      return 'current_reads_peer'
    }
    if (conversation.conversationType === 'group') {
      return userOrganization === organization ? 'group_member' : 'invalid'
    }
    return isSameImIdentity(
      userOrganization,
      receiptUserId,
      conversation.peerOrganization,
      conversation.peerUserId
    ) ? 'group_member' : 'invalid'
  }
  if (conversation.conversationType === 'group') {
    return senderOrganization === organization && userOrganization === organization
      ? 'group_member'
      : 'invalid'
  }
  const currentIsSender = isSameImIdentity(
    senderOrganization, senderId, organization, userId
  )
  const peerIsReader = isSameImIdentity(
    userOrganization, receiptUserId,
    conversation.peerOrganization, conversation.peerUserId
  )
  if (currentIsSender && peerIsReader) return 'peer_reads_current'
  const peerIsSender = isSameImIdentity(
    senderOrganization, senderId,
    conversation.peerOrganization, conversation.peerUserId
  )
  const currentIsReader = isSameImIdentity(
    userOrganization, receiptUserId, organization, userId
  )
  return peerIsSender && currentIsReader ? 'current_reads_peer' : 'invalid'
}

export function isReceiptEventValidForConversation(
  data: Record<string, unknown>,
  organization: string,
  userId: string,
  conversation: ImConversationIdentityContext
) {
  return classifyReceiptEventDirection(data, organization, userId, conversation) !== 'invalid'
}

export function classifyConversationReadEventDirection(
  data: Record<string, unknown>,
  organization: string,
  currentUserId: string,
  conversation: ImConversationIdentityContext
): ReceiptEventDirection {
  const userOrganization = normalizeImOrganization(data.user_organization)
  const userId = String(data.user_id ?? '').trim()
  const conversationId = String(data.conversation_id ?? '').trim()
  const lastReadSeq = Number(data.last_read_seq ?? 0)
  if (!userOrganization || !userId ||
    conversationId !== conversation.conversationId ||
    !Number.isSafeInteger(lastReadSeq) || lastReadSeq <= 0 ||
    data.event_type !== 'conversation.read') {
    return 'invalid'
  }
  if (conversation.conversationType === 'group') {
    return userOrganization === organization ? 'group_member' : 'invalid'
  }
  if (isSameImIdentity(userOrganization, userId, organization, currentUserId)) {
    return 'current_reads_peer'
  }
  return isSameImIdentity(userOrganization, userId,
    conversation.peerOrganization, conversation.peerUserId)
    ? 'peer_reads_current'
    : 'invalid'
}

export function isControlAckResponseValid(
  packet: RealtimeEventPacketLike & { client_msg_id?: unknown },
  expected: PendingImControlRequest,
  organization: string,
  userId: string
): boolean {
  if (!isRecord(packet.data)) return false
  const data = packet.data
  const clientMsgId = String(packet.client_msg_id ?? '').trim()
  if (!clientMsgId || clientMsgId !== expected.clientMsgId) return false
  if (
    expected.command === 'recall' ||
    expected.command === 'edit' ||
    expected.command === 'delete' ||
    expected.command === 'screenshot'
  ) {
    const packetClientMsgId = String(packet.client_msg_id ?? '').trim()
    const dataClientMsgId = String(data.client_msg_id ?? '').trim()
    const requestClientMsgId = String(data.request_client_msg_id ?? '').trim()
    if (
      packetClientMsgId !== expected.clientMsgId ||
      dataClientMsgId !== expected.clientMsgId ||
      requestClientMsgId !== expected.clientMsgId
    ) {
      return false
    }
  }
  if (expected.command === 'send') {
    if (packet.cmd !== 'send_ack' || !isRecord(data.message)) return false
    const message = data.message
    const conversationId = String(data.conversation_id ?? '').trim()
    if (
      !conversationId ||
      (expected.conversationId !== '' && conversationId !== expected.conversationId)
    ) {
      return false
    }
    const expectedConversationType = expected.conversationType === 'single' ? 1 : 2
    const messageId = String(message.message_id ?? '').trim()
    const messageSequence = Number(message.message_seq ?? 0)
    return Boolean(
      String(message.client_msg_id ?? '').trim() === clientMsgId &&
      String(data.client_msg_id ?? '').trim() === clientMsgId &&
      String(message.conversation_id ?? '').trim() === conversationId &&
      messageId &&
      Number.isSafeInteger(messageSequence) &&
      messageSequence > 0 &&
      String(data.message_id ?? '').trim() === messageId &&
      Number(data.message_seq ?? 0) === messageSequence &&
      Number(message.conversation_type ?? 0) === expectedConversationType &&
      String(message.organization ?? '') === organization &&
      isSameImIdentity(message.sender_organization, message.sender_id, organization, userId) &&
      Number(message.message_type ?? 0) === expected.messageType &&
      containsExpectedContent(message.content, expected.content)
    )
  }
  if (String(data.conversation_id ?? '').trim() !== expected.conversationId) return false
  if (expected.command === 'ack') {
    if (
      String(data.client_msg_id ?? '').trim() !== expected.clientMsgId ||
      String(data.request_client_msg_id ?? '').trim() !== expected.clientMsgId ||
      !isSameImIdentity(
        data.actor_organization,
        data.actor_user_id,
        organization,
        userId
      )
    ) {
      return false
    }
    const statusMatches = expected.status === 'delivered'
      ? data.status === 'delivered' || data.status === 'read'
      : data.status === 'read'
    return Boolean(
      packet.cmd === 'ack_ack' &&
      isSameImIdentity(data.user_organization, data.user_id, organization, userId) &&
      String(data.message_id ?? '').trim() === expected.messageId &&
      Number(data.message_seq ?? 0) === expected.messageSeq &&
      statusMatches &&
      isSameImIdentity(
        data.sender_organization,
        data.sender_id,
        expected.senderOrganization,
        expected.senderUserId
      )
    )
  }
  if (expected.command === 'conversation_read') {
    const responseSequence = Number(data.last_read_seq ?? 0)
    const expectedSequence = Number(expected.messageSeq ?? 0)
    return Boolean(
      packet.cmd === 'conversation_read_ack' &&
      isSameImIdentity(data.user_organization, data.user_id, organization, userId) &&
      Number.isSafeInteger(responseSequence) &&
      responseSequence >= expectedSequence &&
      (
        responseSequence > expectedSequence ||
        String(data.last_read_message_id ?? '').trim() === expected.messageId
      )
    )
  }
  const commandMatches = packet.cmd === `${expected.command}_ack`
  const actorMatches = isSameImIdentity(
    data.actor_organization, data.actor_user_id, organization, userId
  )
  if (!commandMatches || !actorMatches) return false
  if (expected.command === 'screenshot') return expected.messageId === undefined
  if (String(data.message_id ?? '').trim() !== expected.messageId) return false
  if (expected.command === 'recall') return data.recalled === true && isPositiveSequence(data.change_seq)
  if (expected.command === 'edit') {
    if (
      !isPositiveSequence(data.change_seq) ||
      !isRecord(data.content) ||
      typeof data.content.text !== 'string' ||
      data.content.text.trim() === '' ||
      !isRecord(data.message)
    ) {
      return false
    }
    return Boolean(
      String(data.message.organization ?? '') === organization &&
      String(data.message.conversation_id ?? '').trim() === expected.conversationId &&
      String(data.message.message_id ?? '').trim() === expected.messageId &&
      Number(data.message.message_type ?? 0) === 1 &&
      isSameImIdentity(
        data.message.sender_organization,
        data.message.sender_id,
        organization,
        userId
      ) &&
      deepEqual(data.message.content, data.content)
    )
  }
  return data.scope === expected.scope && isPositiveSequence(data.change_seq)
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => deepEqual(item, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] && deepEqual(left[key], right[key])
    )
}

function containsExpectedContent(actual: unknown, expected: unknown): boolean {
  if (!isRecord(expected)) return deepEqual(actual, expected)
  if (!isRecord(actual)) return false
  return Object.entries(expected).every(([key, value]) =>
    containsExpectedContent(actual[key], value)
  )
}

export function classifyMutationChangeSequence(
  lastConversationSequence: number,
  lastMessageSequence: number,
  incomingSequence: unknown
): ChangeSequenceDecision {
  const incoming = Number(incomingSequence ?? 0)
  if (!Number.isSafeInteger(incoming) || incoming <= 0) return 'invalid'
  if (incoming <= lastConversationSequence || incoming <= lastMessageSequence) return 'stale'
  return incoming === lastConversationSequence + 1 ? 'apply' : 'gap'
}

export function isPendingImRequestExpired(
  request: Pick<PendingImControlRequest, 'createdAt'>,
  now: number,
  timeoutMs: number
) {
  return !Number.isFinite(request.createdAt) || now - request.createdAt >= timeoutMs
}

export function reusablePendingScreenshotClientMsgId(
  request: PendingImControlRequest | null | undefined,
  conversationId: string,
  now: number,
  timeoutMs: number
) {
  return request?.command === 'screenshot' &&
    request.conversationId === conversationId &&
    !isPendingImRequestExpired(request, now, timeoutMs)
    ? request.clientMsgId
    : ''
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
  if (!normalizeImOrganization(data.from_organization)) return false
  if (String(data.to_organization ?? '') !== organization) return false
  if (typeof data.to_user_id !== 'string' || data.to_user_id !== userId) return false
  if (typeof data.message !== 'string' || typeof data.create_time !== 'string' || data.create_time.trim() === '') {
    return false
  }

  if (data.from_user === null || data.from_user === undefined) return true
  return (
    isRecord(data.from_user) &&
    isSameImIdentity(
      data.from_user.organization,
      data.from_user.user_id,
      data.from_organization,
      data.from_user_id
    )
  )
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

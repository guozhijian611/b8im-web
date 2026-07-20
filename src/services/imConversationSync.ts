import { isSameImIdentity, normalizeImOrganization } from './imIdentity.ts'
import {
  isConversationParticipantIdentity,
  type ImConversationIdentityContext,
  type ImMessageEventContext
} from './realtimeEventDedup.ts'

type ConversationSyncChangeBase = {
  conversation_id: string
  change_seq: number
  message_id: string
  message_seq: number
  actor_organization: string
  actor_user_id: string
  create_time?: string
}

export type ConversationSyncChange =
  | ConversationSyncChangeBase & {
      change_type: 'recall'
      target_organization: null
      target_user_id: null
      payload: Record<string, unknown> & { status: 'recalled' }
    }
  | ConversationSyncChangeBase & {
      change_type: 'edit'
      target_organization: null
      target_user_id: null
      payload: Record<string, unknown> & {
        content: Record<string, unknown> & { text: string }
        edit_time: string
        edit_count: number
      }
    }
  | ConversationSyncChangeBase & {
      change_type: 'delete_both'
      target_organization: null
      target_user_id: null
      payload: Record<string, unknown> & {
        scope: 'both'
        status: 'deleted_both'
      }
    }
  | ConversationSyncChangeBase & {
      change_type: 'delete_self'
      target_organization: string
      target_user_id: string
      payload: Record<string, unknown> & { scope: 'self' }
    }

export interface ConversationSyncChangeContext {
  organization: string
  userId: string
  conversation: ImConversationIdentityContext
}

export interface ConversationSyncChangeParseContext
  extends ConversationSyncChangeContext {
  conversationId: string
  previousChangeSeq: number
  nextAfterChangeSeq: number
  original?: ImMessageEventContext | null
}

export interface ConversationSyncProjectedMessage
  extends ImMessageEventContext {
  messageType: number | string
  contentSemantic: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(value: object, key: PropertyKey) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

export function isCanonicalConversationSyncMessageId(
  value: unknown
): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim()
}

function hasCurrentHomeIdentity(
  organization: unknown,
  userId: unknown,
  context: ConversationSyncChangeContext
) {
  return isSameImIdentity(
    organization,
    userId,
    context.organization,
    context.userId
  )
}

function hasBroadcastActorIdentity(
  change: ConversationSyncChange,
  original?: ImMessageEventContext | null
) {
  return !original || isSameImIdentity(
    change.actor_organization,
    change.actor_user_id,
    original.senderOrganization,
    original.senderUserId
  )
}

export function isConversationSyncChangeValidForOriginal(
  change: ConversationSyncChange,
  context: ConversationSyncChangeContext,
  original?: ImMessageEventContext | null
) {
  if (
    change.conversation_id !== context.conversation.conversationId ||
    !isConversationParticipantIdentity(
      change.actor_organization,
      change.actor_user_id,
      context.organization,
      context.userId,
      context.conversation
    )
  ) {
    return false
  }
  if (
    original &&
    (
      original.conversationId !== change.conversation_id ||
      original.messageId !== change.message_id ||
      original.messageSeq !== change.message_seq
    )
  ) {
    return false
  }

  if (change.change_type === 'delete_self') {
    return hasCurrentHomeIdentity(
      change.actor_organization,
      change.actor_user_id,
      context
    ) && hasCurrentHomeIdentity(
      change.target_organization,
      change.target_user_id,
      context
    ) && change.payload.scope === 'self'
  }

  if (
    change.target_organization !== null ||
    change.target_user_id !== null ||
    !hasBroadcastActorIdentity(change, original)
  ) {
    return false
  }
  if (change.change_type === 'recall') {
    return change.payload.status === 'recalled'
  }
  if (change.change_type === 'delete_both') {
    return change.payload.scope === 'both' &&
      change.payload.status === 'deleted_both'
  }
  return (!original || Number(original.messageType ?? 0) === 1) &&
    change.payload.content.text.trim() !== '' &&
    change.payload.edit_time.trim() !== '' &&
    Number.isSafeInteger(change.payload.edit_count) &&
    change.payload.edit_count > 0
}

export function normalizeConversationSyncChange(
  value: unknown,
  context: ConversationSyncChangeParseContext
): ConversationSyncChange | null {
  if (!isRecord(value) || !isRecord(value.payload)) return null
  const conversationId = String(value.conversation_id ?? '').trim()
  if (!isCanonicalConversationSyncMessageId(value.message_id)) return null
  const messageId = value.message_id
  const changeSeq = Number(value.change_seq ?? 0)
  const messageSeq = Number(value.message_seq ?? 0)
  const changeType = String(value.change_type ?? '')
  const actorOrganization = normalizeImOrganization(value.actor_organization)
  const actorUserId = typeof value.actor_user_id === 'string'
    ? value.actor_user_id.trim()
    : ''
  const createTime = typeof value.create_time === 'string'
    ? value.create_time.trim()
    : ''
  if (
    conversationId !== context.conversationId ||
    !messageId ||
    !Number.isSafeInteger(changeSeq) ||
    changeSeq <= context.previousChangeSeq ||
    changeSeq > context.nextAfterChangeSeq ||
    !Number.isSafeInteger(messageSeq) ||
    messageSeq <= 0 ||
    !actorOrganization ||
    !actorUserId ||
    !isConversationParticipantIdentity(
      actorOrganization,
      actorUserId,
      context.organization,
      context.userId,
      context.conversation
    )
  ) {
    return null
  }

  if (
    !hasOwn(value, 'target_organization') ||
    !hasOwn(value, 'target_user_id')
  ) {
    return null
  }
  const rawTargetOrganization = value.target_organization
  const rawTargetUserId = value.target_user_id
  const isBroadcastTarget =
    rawTargetOrganization === null &&
    rawTargetUserId === null
  const isExplicitCompositeTarget =
    rawTargetOrganization !== null &&
    rawTargetOrganization !== undefined &&
    rawTargetUserId !== null &&
    rawTargetUserId !== undefined
  if (!isBroadcastTarget && !isExplicitCompositeTarget) {
    return null
  }
  const targetOrganization = isBroadcastTarget
    ? null
    : normalizeImOrganization(rawTargetOrganization)
  const targetUserId = isBroadcastTarget
    ? null
    : typeof rawTargetUserId === 'string'
      ? rawTargetUserId.trim()
      : ''
  if (
    targetOrganization !== null &&
    (
      !targetOrganization ||
      !targetUserId ||
      !hasCurrentHomeIdentity(targetOrganization, targetUserId, context)
    )
  ) {
    return null
  }

  const base = {
    conversation_id: conversationId,
    change_seq: changeSeq,
    message_id: messageId,
    message_seq: messageSeq,
    actor_organization: actorOrganization,
    actor_user_id: actorUserId,
    ...(createTime ? { create_time: createTime } : {})
  }
  let normalized: ConversationSyncChange
  if (
    changeType === 'recall' &&
    targetOrganization === null &&
    targetUserId === null &&
    value.payload.status === 'recalled'
  ) {
    normalized = {
      ...base,
      change_type: 'recall',
      target_organization: null,
      target_user_id: null,
      payload: { ...value.payload, status: 'recalled' }
    }
  } else if (
    changeType === 'edit' &&
    targetOrganization === null &&
    targetUserId === null &&
    isRecord(value.payload.content) &&
    typeof value.payload.content.text === 'string' &&
    value.payload.content.text.trim() !== '' &&
    typeof value.payload.edit_time === 'string' &&
    value.payload.edit_time.trim() !== '' &&
    typeof value.payload.edit_count === 'number' &&
    Number.isSafeInteger(value.payload.edit_count) &&
    value.payload.edit_count > 0
  ) {
    normalized = {
      ...base,
      change_type: 'edit',
      target_organization: null,
      target_user_id: null,
      payload: {
        ...value.payload,
        content: {
          ...value.payload.content,
          text: value.payload.content.text
        },
        edit_time: value.payload.edit_time.trim(),
        edit_count: value.payload.edit_count
      }
    }
  } else if (
    changeType === 'delete_both' &&
    targetOrganization === null &&
    targetUserId === null &&
    value.payload.scope === 'both' &&
    value.payload.status === 'deleted_both'
  ) {
    normalized = {
      ...base,
      change_type: 'delete_both',
      target_organization: null,
      target_user_id: null,
      payload: {
        ...value.payload,
        scope: 'both',
        status: 'deleted_both'
      }
    }
  } else if (
    changeType === 'delete_self' &&
    targetOrganization !== null &&
    targetUserId !== null &&
    value.payload.scope === 'self' &&
    hasCurrentHomeIdentity(actorOrganization, actorUserId, context)
  ) {
    normalized = {
      ...base,
      change_type: 'delete_self',
      target_organization: targetOrganization,
      target_user_id: targetUserId,
      payload: { ...value.payload, scope: 'self' }
    }
  } else {
    return null
  }

  return isConversationSyncChangeValidForOriginal(
    normalized,
    context,
    context.original
  )
    ? normalized
    : null
}

export function isConversationSyncChangeBatchValid(
  changes: readonly ConversationSyncChange[],
  context: ConversationSyncChangeContext,
  resolveOriginal: (
    change: ConversationSyncChange
  ) => ImMessageEventContext | null | undefined
) {
  return changes.every((change) =>
    isConversationSyncChangeValidForOriginal(
      change,
      context,
      resolveOriginal(change)
    )
  )
}

export function commitConversationSyncChangeBatch(
  changes: readonly ConversationSyncChange[],
  context: ConversationSyncChangeContext,
  resolveOriginal: (
    change: ConversationSyncChange
  ) => ImMessageEventContext | null | undefined,
  commit: () => void
) {
  if (!isConversationSyncChangeBatchValid(
    changes,
    context,
    resolveOriginal
  )) {
    return false
  }
  commit()
  return true
}

function isSameProjectedMessage(
  left: ConversationSyncProjectedMessage,
  right: ConversationSyncProjectedMessage
) {
  return left.conversationId === right.conversationId &&
    left.messageId === right.messageId &&
    left.messageSeq === right.messageSeq &&
    Number(left.messageType) === Number(right.messageType) &&
    isSameImIdentity(
      left.senderOrganization,
      left.senderUserId,
      right.senderOrganization,
      right.senderUserId
    ) &&
    left.contentSemantic === right.contentSemantic
}

/**
 * Builds the exact message-id projection that a page commit would expose.
 * Page messages replace only byte-for-byte compatible local projections;
 * duplicate or conflicting identities fail closed before state can mutate.
 */
export function buildConversationSyncMessageProjection(
  localMessages: readonly ConversationSyncProjectedMessage[],
  pageMessages: readonly ConversationSyncProjectedMessage[]
) {
  const projection =
    new Map<string, ConversationSyncProjectedMessage>()
  for (const message of localMessages) {
    if (
      !isCanonicalConversationSyncMessageId(message.messageId) ||
      projection.has(message.messageId)
    ) {
      return null
    }
    projection.set(message.messageId, message)
  }

  const pageMessageIds = new Set<string>()
  for (const message of pageMessages) {
    if (
      !isCanonicalConversationSyncMessageId(message.messageId) ||
      pageMessageIds.has(message.messageId)
    ) {
      return null
    }
    pageMessageIds.add(message.messageId)
    const localMessage = projection.get(message.messageId)
    if (localMessage && !isSameProjectedMessage(localMessage, message)) {
      return null
    }
    projection.set(message.messageId, message)
  }
  return projection
}

export function commitConversationSyncPageBatch(
  localMessages: readonly ConversationSyncProjectedMessage[],
  pageMessages: readonly ConversationSyncProjectedMessage[],
  changes: readonly ConversationSyncChange[],
  context: ConversationSyncChangeContext,
  commit: () => void
) {
  const projection = buildConversationSyncMessageProjection(
    localMessages,
    pageMessages
  )
  if (
    !projection ||
    !isConversationSyncChangeBatchValid(
      changes,
      context,
      (change) => projection.get(change.message_id)
    )
  ) {
    return false
  }
  commit()
  return true
}

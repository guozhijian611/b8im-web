import type { ImPacketMessage } from '../types.ts'
import {
  compareAccessSnapshotIds,
  normalizeAccessSnapshotId,
  type AccessSnapshotObservation
} from './conversationAccess.ts'
import { normalizeImOrganization } from './imIdentity.ts'

const GLOBAL_SEQUENCE_PATTERN = /^(0|[1-9]\d{0,19})$/

export interface GlobalSyncPage {
  scope: 'global'
  messages: ImPacketMessage[]
  nextAfterGlobalSeq: string
  hasMore: boolean
  accessSnapshotId: string
}

export interface GlobalSyncPageContext {
  organization: string
  afterGlobalSeq: string
}

export function canRecoverGlobalSyncConversation(
  failClosed: boolean,
  homeOrganization: string,
  conversation: {
    conversationType: 'single' | 'group'
    peerOrganization?: string
  }
) {
  return !failClosed ||
    conversation.conversationType !== 'single' ||
    normalizeImOrganization(conversation.peerOrganization) ===
      normalizeImOrganization(homeOrganization)
}

export function isExpectedStaleGlobalSyncSnapshot(
  observation: AccessSnapshotObservation,
  pageSnapshotId: unknown,
  authenticatedStaleSnapshotId: unknown
) {
  const page = normalizeAccessSnapshotId(pageSnapshotId)
  const authenticated = normalizeAccessSnapshotId(
    authenticatedStaleSnapshotId
  )
  return observation === 'stale' &&
    page !== '' &&
    page !== '0' &&
    authenticated !== '' &&
    authenticated !== '0' &&
    compareAccessSnapshotIds(page, authenticated) >= 0
}

export function normalizeGlobalSequence(value: unknown): string {
  return typeof value === 'string' && GLOBAL_SEQUENCE_PATTERN.test(value)
    ? value
    : ''
}

export function compareGlobalSequences(left: string, right: string) {
  const normalizedLeft = normalizeGlobalSequence(left)
  const normalizedRight = normalizeGlobalSequence(right)
  if (!normalizedLeft || !normalizedRight) {
    throw new Error('global_seq 格式无效')
  }
  const leftValue = BigInt(normalizedLeft)
  const rightValue = BigInt(normalizedRight)
  return leftValue === rightValue ? 0 : leftValue > rightValue ? 1 : -1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function validateGlobalSyncPage(
  value: unknown,
  context: GlobalSyncPageContext
): GlobalSyncPage | null {
  if (!isRecord(value) || value.scope !== 'global' ||
    !Array.isArray(value.messages) || typeof value.has_more !== 'boolean') {
    return null
  }
  const afterGlobalSeq = normalizeGlobalSequence(context.afterGlobalSeq)
  const nextAfterGlobalSeq = normalizeGlobalSequence(value.next_after_global_seq)
  const accessSnapshotId = normalizeAccessSnapshotId(
    value.cross_org_access_snapshot_id
  )
  if (!afterGlobalSeq || !nextAfterGlobalSeq || !accessSnapshotId ||
    compareGlobalSequences(nextAfterGlobalSeq, afterGlobalSeq) < 0 ||
    (value.has_more && compareGlobalSequences(nextAfterGlobalSeq, afterGlobalSeq) <= 0)) {
    return null
  }

  let previousGlobalSeq = afterGlobalSeq
  const messageIds = new Set<string>()
  const messages: ImPacketMessage[] = []
  for (const message of value.messages) {
    if (!isRecord(message)) return null
    const globalSeq = normalizeGlobalSequence(message.global_seq)
    const messageId = String(message.message_id ?? '').trim()
    const conversationId = String(message.conversation_id ?? '').trim()
    const messageSeq = Number(message.message_seq ?? 0)
    const senderOrganization = normalizeImOrganization(
      message.sender_organization
    )
    const senderId = String(message.sender_id ?? '').trim()
    const conversationType = Number(message.conversation_type ?? 0)
    if (!globalSeq || !messageId || messageIds.has(messageId) ||
      !conversationId || !Number.isSafeInteger(messageSeq) || messageSeq <= 0 ||
      !senderOrganization || !senderId ||
      (conversationType !== 1 && conversationType !== 2) ||
      String(message.organization ?? '') !== context.organization ||
      compareGlobalSequences(globalSeq, previousGlobalSeq) <= 0 ||
      compareGlobalSequences(globalSeq, nextAfterGlobalSeq) > 0) {
      return null
    }
    previousGlobalSeq = globalSeq
    messageIds.add(messageId)
    messages.push(message as unknown as ImPacketMessage)
  }

  return {
    scope: 'global',
    messages,
    nextAfterGlobalSeq,
    hasMore: value.has_more,
    accessSnapshotId
  }
}

/**
 * This cursor deliberately lives only as long as the current Vue runtime.
 * Messages are not durably materialized in the browser, so a cursor surviving
 * reload (or shared by another tab) could skip messages this runtime cannot
 * recover. A fresh runtime therefore always starts at zero and replays safely.
 */
export class GlobalSyncCursorStore {
  private memoryCursor = '0'

  read() {
    return this.memoryCursor
  }

  write(cursor: string) {
    const normalized = normalizeGlobalSequence(cursor)
    if (!normalized) throw new Error('global_seq 游标格式无效')
    const current = this.read()
    if (compareGlobalSequences(normalized, current) < 0) {
      throw new Error('global_seq 游标禁止回退')
    }
    this.memoryCursor = normalized
  }
}

export async function commitGlobalSyncRecoveryCursor(
  store: GlobalSyncCursorStore,
  cursor: string,
  makeRuntimeRecoverable: () => Promise<boolean>
) {
  if (!await makeRuntimeRecoverable()) return false
  store.write(cursor)
  return true
}

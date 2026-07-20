import { computed, nextTick, onScopeDispose, ref, watch } from 'vue'
import { layer } from '../services/layer'
import { playNotificationSound } from '../services/notification'
import {
  classifyConversationReadEventDirection,
  classifyMutationChangeSequence,
  classifyReceiptEventDirection,
  isControlAckResponseValid,
  isCanonicalRealtimeCommand,
  isCanonicalRealtimeEventPacketValid,
  isConversationParticipantIdentity,
  isDurableMutationValidForContext,
  isFriendRequestRealtimeEventPacketValid,
  isMessageValidForConversation,
  isPendingImRequestExpired,
  RealtimeEventDedupWindow,
  reusablePendingScreenshotClientMsgId
} from '../services/realtimeEventDedup'
import type { PendingImControlRequest } from '../services/realtimeEventDedup'
import {
  advanceConversationAccessEpoch,
  assertConversationAccessEpochCurrent,
  captureConversationAccessEpoch,
  classifyAuthAccessSnapshot,
  CONVERSATION_ACCESS_BROWSER_EVENT,
  CONVERSATION_ACCESS_CHANGED_COMMAND,
  ConversationAccessEpochChangedError,
  currentConversationAccessSnapshot,
  CrossOrgAccessSnapshotStore,
  isAccessSnapshotFailClosed,
  isConversationAccessEpochCurrent,
  isConversationAccessRecoveryRequired,
  normalizeAccessSnapshotId,
  observeConversationAccessSnapshot,
  parseConversationAccessChanged,
  reconcileRevokedConversationIds,
  setConversationAccessRecoveryRequired,
  shouldProcessAccessSnapshotEvent
} from '../services/conversationAccess'
import type { ConversationAccessEpochToken } from '../services/conversationAccess'
import type { TenantBrandConfig } from '../services/tenantConfig'
import { activeServiceCandidate, promoteServiceCandidate } from '../services/routing'
import { notifyTitleIncomingMessage } from '../services/titleNotifier'
import { formatImMessageTime, formatImTime, parseImTimestamp } from '../services/time'
import { attachTraceContext, PendingSendTraceRegistry } from '../services/imTelemetry'
import { isSameImIdentity, normalizeImOrganization } from '../services/imIdentity'
import {
  canRecoverGlobalSyncConversation,
  commitGlobalSyncRecoveryCursor,
  GlobalSyncCursorStore,
  isExpectedStaleGlobalSyncSnapshot,
  type GlobalSyncPage,
  validateGlobalSyncPage
} from '../services/imGlobalSync'
import {
  buildConversationSyncMessageProjection,
  commitConversationSyncPageBatch,
  isCanonicalConversationSyncMessageId,
  isConversationSyncChangeBatchValid,
  normalizeConversationSyncChange,
  type ConversationSyncChange,
  type ConversationSyncProjectedMessage
} from '../services/imConversationSync'
import { resolveCapturedUploadConversation } from '../services/imUploadTarget'
import {
  parseTraceContext,
  tryStartTelemetrySpan,
  type TelemetrySpan,
  type TraceContext
} from '../services/telemetry'
import {
  createMessageGroup as createMessageGroupApi,
  createGroupConversation,
  createVirtualConversation,
  deriveForwardAsset as deriveForwardAssetApi,
  fetchConversations,
  fetchMessageGroups,
  fetchMessageConfig,
  fetchMessages,
  getWebDeviceId,
  issueImChallengeToken,
  markConversationRead as markConversationReadApi,
  mapWebImUser,
  normalizeConversationPreview,
  resolveImAssetUrl,
  searchConversationMessages,
  updateConversationGroup as updateConversationGroupApi,
  updateGroupProfile as updateGroupProfileApi,
  updateConversationSetting as updateConversationSettingApi,
  uploadImAsset
} from '../services/webIm'
import type {
  Contact,
  FriendRequestPushEvent,
  ImConnectionState,
  ImConversation,
  ImMessageSender,
  ImPacketMessage,
  Message,
  MessageForwardBundle,
  MessageForwardItem,
  MessageQuote,
  MessageMention,
  MessageGroup,
  NotificationSettings,
  UploadedAsset,
  WebImSession
} from '../types'

type ImPacket = {
  cmd: string
  organization?: number | string
  data?: Record<string, any>
  client_msg_id?: string
  traceparent?: string
  tracestate?: string
}

type AuthChallengeState = {
  socket: WebSocket
  sequence: number
  clientId: string
  deviceId: string
  credentialSessionId: string
  authSent: boolean
  traceSpan: TelemetrySpan | null
}

type AuthenticatedConnectionState = {
  socket: WebSocket
  clientId: string
  deviceId: string
  credentialSessionId: string
  sessionId: string
}

type ConversationSyncPage = {
  scope: 'conversation'
  conversation_id: string
  messages: ImPacketMessage[]
  changes: ConversationSyncChange[]
  next_after_seq: number
  next_after_change_seq: number
  messages_has_more: boolean
  changes_has_more: boolean
  cross_org_access_snapshot_id: string
  access_snapshot_behind_high_water: boolean
}

type PendingConversationSyncRequest = {
  clientMsgId: string
  conversationId: string
  afterSeq: number
  afterChangeSeq: number
  epoch: ConversationAccessEpochToken
  snapshotId: string
  resolve: (page: ConversationSyncPage) => void
  reject: (error: Error) => void
  timer: number
}

type PendingGlobalSyncRequest = {
  clientMsgId: string
  afterGlobalSeq: string
  resolve: (page: GlobalSyncPage) => void
  reject: (error: Error) => void
  timer: number
}

type PendingAuthoritativeControlAck = {
  resolve: () => void
  reject: (error: Error) => void
}

type StableGlobalSyncBatch = {
  previousCursor: string
  nextCursor: string
  accessSnapshotId: string
  accessSnapshotBehindHighWater: boolean
  epoch: ConversationAccessEpochToken
  messages: ImPacketMessage[]
}

type ForwardMode = 'separate' | 'merged'
type SerializedForwardItem = {
  sender: string
  time: string
  type: Message['type']
  content: string
  url?: string
  file_name?: string
  size?: number
  forward_bundle?: {
    forward_mode: 'merged'
    forward_title: string
    forward_count: number
    forward_items: SerializedForwardItem[]
  }
}

const MESSAGE_TYPE_TEXT = 1
const MESSAGE_TYPE_IMAGE = 2
const MESSAGE_TYPE_FILE = 3
const MESSAGE_TYPE_VOICE = 4
const MESSAGE_TYPE_SYSTEM = 5
const MESSAGE_TYPE_VIDEO = 11
const SEND_TRACE_TIMEOUT_MS = 30000
const CONTROL_REQUEST_TIMEOUT_MS = 30000
const CONVERSATION_SYNC_PAGE_LIMIT = 50
const GLOBAL_SYNC_PAGE_LIMIT = 100
const GLOBAL_SYNC_MAX_PAGES = 100
const GLOBAL_SYNC_MAX_RESTARTS = 5
const AUTH_RECOVERY_BUFFER_LIMIT = 2048
const DELIVERY_STATE_RANK: Record<'sent' | 'delivered' | 'read', number> = {
  sent: 1,
  delivered: 2,
  read: 3
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function firstText(value: string) {
  return (value.trim().slice(0, 1) || '用').toUpperCase()
}

function senderDisplayName(sender?: ImMessageSender | null) {
  if (!sender) return ''
  const serverDisplayName = String(sender.display_name ?? '').trim()
  if (serverDisplayName) return serverDisplayName
  const base = String(sender.nickname || sender.account || sender.user_id || '')
  const isCrossOrganization =
    sender.is_cross_organization === true ||
    Number(sender.is_cross_organization ?? 0) === 1
  const companyName = String(sender.company_name ?? sender.organization_name ?? '').trim()
  return isCrossOrganization && companyName ? `${base} · ${companyName}` : base
}

function senderAvatarUrl(sender?: ImMessageSender | null) {
  return String(sender?.avatar_url ?? '')
}

function systemNoticeText(
  content: Record<string, unknown>,
  currentOrganization: string,
  currentUserId: string,
  conversationType: ImConversation['conversationType']
) {
  const event = String(content?.event ?? '')
  const actorOrganization = normalizeImOrganization(content?.actor_organization)
  const actorUserId = String(content?.actor_user_id ?? '')
  const actorName = String(content?.actor_name ?? '').trim() || '有人'
  const isSelf = isSameImIdentity(
    actorOrganization,
    actorUserId,
    currentOrganization,
    currentUserId
  )
  const actor = isSelf ? '你' : (conversationType === 'group' ? actorName : '对方')

  if (event === 'recall') return `${actor}撤回了一条消息`
  if (event === 'screenshot') return `${actor}截屏了`
  return String(content?.text ?? '[系统通知]')
}

function messageText(
  message: ImPacketMessage,
  currentOrganization = '',
  currentUserId = '',
  conversationType: ImConversation['conversationType'] = 'single'
) {
  if (String(message.content?.forward_mode ?? '') === 'merged') {
    return String(message.content?.forward_title ?? '合并转发的聊天记录')
  }
  if (message.message_type === MESSAGE_TYPE_TEXT) {
    return String(message.content?.text ?? '')
  }
  if (message.message_type === MESSAGE_TYPE_IMAGE) return '[图片]'
  if (message.message_type === MESSAGE_TYPE_FILE) return '[文件]'
  if (message.message_type === MESSAGE_TYPE_VOICE) return '[语音]'
  if (message.message_type === MESSAGE_TYPE_VIDEO) return '[视频]'
  if (message.message_type === MESSAGE_TYPE_SYSTEM) {
    return systemNoticeText(
      message.content ?? {}, currentOrganization, currentUserId, conversationType
    )
  }
  return '[消息]'
}

function messageTypeName(messageType: number): Message['type'] {
  if (messageType === MESSAGE_TYPE_IMAGE) return 'image'
  if (messageType === MESSAGE_TYPE_FILE) return 'file'
  if (messageType === MESSAGE_TYPE_VOICE) return 'voice'
  if (messageType === MESSAGE_TYPE_VIDEO) return 'video'
  if (messageType === MESSAGE_TYPE_SYSTEM) return 'notice'
  return 'text'
}

function formatFileSize(value?: number) {
  const size = Number(value ?? 0)
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${size || 0} B`
}

function assetPreview(kind: UploadedAsset['kind']) {
  if (kind === 'image') return '[图片]'
  if (kind === 'voice') return '[语音]'
  if (kind === 'video') return '[视频]'
  return '[文件]'
}

function messageContentPreview(message: Message) {
  if (message.forwardBundle) return message.forwardBundle.title
  if (message.type === 'image') return '[图片]'
  if (message.type === 'file') return message.fileName ? `[文件] ${message.fileName}` : '[文件]'
  if (message.type === 'voice') return '[语音]'
  if (message.type === 'video') return message.fileName ? `[视频] ${message.fileName}` : '[视频]'
  return message.content
}

function createMessageQuote(message?: Message | null): MessageQuote | undefined {
  if (!message || !message.messageId || message.type === 'notice') return undefined

  return {
    messageId: message.messageId,
    messageSeq: Number(message.messageSeq ?? 0),
    sender: message.sender,
    senderUserId: String(message.senderUserId ?? ''),
    type: message.type,
    content: messageContentPreview(message).slice(0, 180)
  }
}

function normalizeMessageQuote(value: unknown): MessageQuote | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const type = String(item.type ?? 'text') as Message['type']

  return {
    messageId: String(item.message_id ?? item.messageId ?? ''),
    messageSeq: Number(item.message_seq ?? item.messageSeq ?? 0),
    sender: String(item.sender_name ?? item.sender ?? ''),
    senderUserId: String(item.sender_user_id ?? item.senderUserId ?? ''),
    type: ['text', 'image', 'file', 'voice', 'video', 'notice'].includes(type) ? type : 'text',
    content: String(item.content ?? '')
  }
}

function normalizeMentions(value: unknown): MessageMention[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item): MessageMention | null => {
      if (!item || typeof item !== 'object') return null
      const row = item as Record<string, unknown>
      const userId = String(row.user_id ?? row.userId ?? '')
      if (!userId) return null
      return {
        userId,
        nickname: String(row.nickname ?? row.name ?? ''),
        account: String(row.account ?? ''),
        avatarUrl: String(row.avatar_url ?? row.avatarUrl ?? '')
      }
    })
    .filter((item): item is MessageMention => Boolean(item))
}

function serializeMessageQuote(quote?: MessageQuote | null) {
  if (!quote?.messageId) return undefined

  return {
    message_id: quote.messageId,
    message_seq: quote.messageSeq,
    sender_name: quote.sender,
    sender_user_id: quote.senderUserId,
    type: quote.type,
    content: quote.content
  }
}

function normalizeForwardItem(value: unknown): MessageForwardItem | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const type = String(item.type ?? 'text') as Message['type']
  const nestedBundle = item.forward_bundle && typeof item.forward_bundle === 'object'
    ? normalizeForwardBundle(item.forward_bundle as Record<string, unknown>)
    : null

  return {
    sender: String(item.sender ?? ''),
    time: String(item.time ?? ''),
    type: ['text', 'image', 'file', 'voice', 'video', 'notice'].includes(type) ? type : 'text',
    content: String(item.content ?? ''),
    url: String(item.url ?? ''),
    fileName: String(item.file_name ?? item.fileName ?? item.name ?? ''),
    fileSize: Number(item.size ?? item.file_size ?? item.fileSize ?? 0),
    forwardBundle: nestedBundle
  }
}

function normalizeForwardBundle(content: Record<string, unknown>): MessageForwardBundle | null {
  if (String(content.forward_mode ?? '') !== 'merged') return null

  const items = Array.isArray(content.forward_items)
    ? content.forward_items.map(normalizeForwardItem).filter((item): item is MessageForwardItem => Boolean(item))
    : []
  const count = Number(content.forward_count ?? items.length)

  return {
    title: String(content.forward_title ?? '合并转发的聊天记录'),
    count: count > 0 ? count : items.length,
    items
  }
}

function createClientMsgId() {
  return `web-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function mapPacketMessage(message: ImPacketMessage, currentSession: WebImSession, conversation: ImConversation): Message {
  const currentUserId = currentSession.user.userId
  const senderId = String(message.sender_id ?? '').trim()
  const senderOrganization = normalizeImOrganization(message.sender_organization)
  if (!isMessageValidForConversation(
    message as unknown as Record<string, unknown>,
    currentSession.organization,
    currentUserId,
    conversation
  )) {
    throw new Error('消息会话归属或参与者复合身份无效')
  }
  const isOut = isSameImIdentity(
    senderOrganization,
    message.sender_id,
    currentSession.organization,
    currentUserId
  )
  const isSystem = Number(message.message_type ?? 0) === MESSAGE_TYPE_SYSTEM
  const peerUser = conversation.peerUser ?? null
  const senderUser = message.sender_user ?? null
  const forwardBundle = normalizeForwardBundle(message.content ?? {})
  const displayName = senderDisplayName(senderUser)
  const senderName = isOut
    ? '我'
    : displayName !== ''
      ? displayName
      : isSameImIdentity(
          peerUser?.organization,
          peerUser?.userId,
          senderOrganization,
          message.sender_id
        )
      ? peerUser?.nickname || message.sender_id
      : message.sender_id
  const avatarText = isOut
    ? firstText(currentSession.user.nickname || currentSession.user.account || '我')
    : firstText(displayName || peerUser?.nickname || peerUser?.account || message.sender_id)

  return {
    id: message.message_id || String(message.id),
    messageId: message.message_id,
    conversationId: message.conversation_id,
    fileId: String(message.content?.file_id ?? ''),
    sender: senderName,
    avatar: avatarText,
    avatarUrl: isOut ? currentSession.user.avatarUrl : senderAvatarUrl(senderUser) || peerUser?.avatarUrl,
    side: isSystem ? 'system' : (isOut ? 'out' : 'in'),
    type: messageTypeName(Number(message.message_type ?? 1)),
    content: forwardBundle?.title ?? messageText(
      message, currentSession.organization, currentUserId, conversation.conversationType
    ),
    url: [MESSAGE_TYPE_IMAGE, MESSAGE_TYPE_FILE, MESSAGE_TYPE_VOICE, MESSAGE_TYPE_VIDEO].includes(Number(message.message_type ?? 0))
      ? ''
      : String(message.content?.url ?? ''),
    fileName: String(message.content?.name ?? message.content?.file_name ?? ''),
    fileSize: Number(message.content?.size ?? 0),
    messageSeq: Number(message.message_seq ?? 0),
    createTime: message.create_time,
    time: formatImMessageTime(message.create_time),
    state: isOut ? (message.delivery_status ?? 'sent') : undefined,
    editTime: String(message.edit_time ?? ''),
    editCount: Number(message.edit_count ?? 0),
    senderUserId: message.sender_id,
    senderOrganization,
    quote: normalizeMessageQuote(message.content?.reply),
    mentions: normalizeMentions(message.content?.mentions),
    forwardBundle,
    meta: message.message_type === MESSAGE_TYPE_FILE || message.message_type === MESSAGE_TYPE_IMAGE || message.message_type === MESSAGE_TYPE_VOICE || message.message_type === MESSAGE_TYPE_VIDEO
      ? formatFileSize(Number(message.content?.size ?? 0))
      : undefined
  }
}

function messageTypeNumber(type: Message['type']) {
  if (type === 'image') return MESSAGE_TYPE_IMAGE
  if (type === 'file') return MESSAGE_TYPE_FILE
  if (type === 'voice') return MESSAGE_TYPE_VOICE
  if (type === 'video') return MESSAGE_TYPE_VIDEO
  if (type === 'notice') return MESSAGE_TYPE_SYSTEM
  return MESSAGE_TYPE_TEXT
}

function canonicalConversationSyncSemantic(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalConversationSyncSemantic)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [
          key,
          canonicalConversationSyncSemantic(item)
        ])
    )
  }
  return value
}

function conversationSyncContentSemantic(message: Message) {
  return JSON.stringify(canonicalConversationSyncSemantic({
    content: message.content,
    edit_count: Number(message.editCount ?? 0),
    edit_time: String(message.editTime ?? ''),
    file_id: String(message.fileId ?? ''),
    file_name: String(message.fileName ?? ''),
    file_size: Number(message.fileSize ?? 0),
    forward_bundle: message.forwardBundle ?? null,
    mentions: message.mentions ?? [],
    quote: message.quote ?? null
  }))
}

function conversationSyncProjectedMessage(
  conversation: ImConversation,
  message: Message,
  messageType = messageTypeNumber(message.type)
): ConversationSyncProjectedMessage {
  return {
    conversationId: String(
      message.conversationId ?? conversation.conversationId
    ),
    messageId: String(message.messageId ?? ''),
    messageSeq: Number(message.messageSeq ?? 0),
    senderOrganization: message.senderOrganization,
    senderUserId: message.senderUserId,
    messageType,
    side: message.side,
    contentSemantic: conversationSyncContentSemantic(message)
  }
}

function messageCreateTimeValue(message: Message) {
  if (!message.createTime) return 0
  const value = parseImTimestamp(message.createTime).getTime()
  return Number.isNaN(value) ? 0 : value
}

function sortMessagesByTimeline(messages: Message[]) {
  return [...messages].sort((left, right) => {
    const leftSeq = Number(left.messageSeq ?? 0)
    const rightSeq = Number(right.messageSeq ?? 0)
    if (leftSeq > 0 || rightSeq > 0) {
      if (leftSeq > 0 && rightSeq > 0 && leftSeq !== rightSeq) return leftSeq - rightSeq
      if (leftSeq > 0 && rightSeq <= 0) return -1
      if (leftSeq <= 0 && rightSeq > 0) return 1
    }

    const timeDiff = messageCreateTimeValue(left) - messageCreateTimeValue(right)
    if (timeDiff !== 0) return timeDiff

    const orderDiff = Number(left.localOrder ?? 0) - Number(right.localOrder ?? 0)
    if (orderDiff !== 0) return orderDiff

    return left.id.localeCompare(right.id)
  })
}

function maxMessageSeq(messages: ImPacketMessage[]) {
  return messages.reduce((maxSeq, message) => Math.max(maxSeq, Number(message.message_seq ?? 0)), 0)
}

export function useImRuntime(
  config: () => TenantBrandConfig,
  session: () => WebImSession,
  notificationSettings: () => NotificationSettings,
  onFriendRequestEvent?: (event: FriendRequestPushEvent) => void
) {
  const connectionState = ref<ImConnectionState>('idle')
  const heartbeatPulse = ref(0)
  const messageGroups = ref<MessageGroup[]>([])
  const conversations = ref<ImConversation[]>([])
  const activeConversationId = ref('')
  const messages = ref<Record<string, Message[]>>({})
  const typingByConversation = ref<Record<string, string>>({})
  const messageCursors = new Map<string, number>()
  const messageBeforeCursors = new Map<string, number>()
  const messageHasMoreBefore = new Map<string, boolean>()
  const pendingControlRequests = new Map<string, PendingImControlRequest>()
  const pendingControlTimers = new Map<string, number>()
  const completedControlRequests = new Map<string, PendingImControlRequest>()
  const completedControlTimers = new Map<string, number>()
  const pendingAuthoritativeControlAcks =
    new Map<string, PendingAuthoritativeControlAck>()
  const pendingConversationSyncRequests =
    new Map<string, PendingConversationSyncRequest>()
  const pendingGlobalSyncRequests = new Map<string, PendingGlobalSyncRequest>()
  const pendingScreenshotRequests = new Map<string, string>()
  const conversationChangeCursors = new Map<string, number>()
  const messageChangeCursors = new Map<string, number>()
  const conversationReadCursors = new Map<string, number>()
  const changeRefreshInFlight = new Map<string, Promise<void>>()
  const revokedConversationIds = new Set<string>()
  const restorableConversationIds = new Set<string>()
  const typingTimers = new Map<string, number>()
  const lastTypingSentAt = new Map<string, number>()
  const loadingOlderMessages = ref(false)
  const messageDeleteConfig = ref({
    deleteSingleEnabled: false,
    deleteBothEnabled: false
  })

  let socket: WebSocket | null = null
  const socketRouteIds = new WeakMap<WebSocket, string>()
  let authChallengeSequence = 0
  let pendingAuthChallenge: AuthChallengeState | null = null
  let authenticatedConnection: AuthenticatedConnectionState | null = null
  let pingTimer = 0
  let reconnectTimer = 0
  let localMessageOrder = 0
  let localConversationSortOrder = 0
  let recentRealtimeEvents: RealtimeEventDedupWindow | null = null
  let crossOrgAccessSnapshotStore: CrossOrgAccessSnapshotStore | null = null
  let crossOrgAccessSnapshotScope = ''
  let globalSyncCursorStore: GlobalSyncCursorStore | null = null
  let globalSyncCursorScope = ''
  let crossOrgAccessRecoveryRequired = false
  let authenticatedRecoverySequence = 0
  let authenticatedRecoveryPackets: ImPacket[] = []
  let authenticatedAccessSnapshotBehindHighWater = false
  let authenticatedStaleAccessSnapshotId = ''
  let accessSnapshotRebuild: {
    snapshotId: string
    epoch: ConversationAccessEpochToken
    full: boolean
    promise: Promise<void>
  } | null = null
  const pendingSendTraces = new PendingSendTraceRegistry(
    SEND_TRACE_TIMEOUT_MS,
    (clientMsgId) => markLocalMessageFailed(clientMsgId)
  )

  function realtimeEventWindow() {
    const organization = String(session().organization ?? '').trim()
    const userId = String(session().user.userId ?? '').trim()
    if (!recentRealtimeEvents?.matches(organization, userId)) {
      recentRealtimeEvents = new RealtimeEventDedupWindow(organization, userId)
    }
    return recentRealtimeEvents
  }

  function accessSnapshotStore() {
    const organization = String(session().organization ?? '').trim()
    const userId = String(session().user.userId ?? '').trim()
    const scope = `${organization}\u0000${userId}`
    if (!crossOrgAccessSnapshotStore || crossOrgAccessSnapshotScope !== scope) {
      crossOrgAccessSnapshotStore = new CrossOrgAccessSnapshotStore(organization, userId)
      crossOrgAccessSnapshotScope = scope
      if (crossOrgAccessSnapshotStore.highWater) {
        observeConversationAccessSnapshot(
          organization,
          userId,
          crossOrgAccessSnapshotStore.highWater
        )
      }
      if (crossOrgAccessSnapshotStore.current === '0') {
        observeConversationAccessSnapshot(organization, userId, '0')
      }
    }
    return crossOrgAccessSnapshotStore
  }

  function currentAccessSnapshotId() {
    return currentConversationAccessSnapshot(
      session().organization,
      session().user.userId
    )
  }

  function syncCursorStore() {
    const organization = String(session().organization ?? '').trim()
    const userId = String(session().user.userId ?? '').trim()
    const scope = `${organization}\u0000${userId}`
    if (!globalSyncCursorStore || globalSyncCursorScope !== scope) {
      globalSyncCursorStore = new GlobalSyncCursorStore()
      globalSyncCursorScope = scope
    }
    return globalSyncCursorStore
  }

  function captureAccessEpoch() {
    return captureConversationAccessEpoch(
      session().organization,
      session().user.userId
    )
  }

  function observeAccessSnapshot(snapshotId: unknown) {
    const normalized = normalizeAccessSnapshotId(snapshotId)
    if (!normalized) return 'invalid' as const
    const stored = accessSnapshotStore().observe(normalized)
    if (stored === 'invalid' || stored === 'stale') return stored
    return observeConversationAccessSnapshot(
      session().organization,
      session().user.userId,
      normalized
    )
  }

  function isCrossOrgSingle(conversation: ImConversation) {
    return conversation.conversationType === 'single' &&
      normalizeImOrganization(conversation.peerOrganization) !==
        session().organization
  }

  function isCrossOrgAccessFailClosed() {
    return crossOrgAccessRecoveryRequired ||
      isConversationAccessRecoveryRequired(
        session().organization,
        session().user.userId
      ) ||
      isAccessSnapshotFailClosed(currentAccessSnapshotId())
  }

  function setCrossOrgAccessRecoveryRequired(required: boolean) {
    crossOrgAccessRecoveryRequired = required
    setConversationAccessRecoveryRequired(
      session().organization,
      session().user.userId,
      required
    )
  }

  const activeConversation = computed(() => {
    return conversations.value.find((item) => item.id === activeConversationId.value) ?? null
  })

  const activeMessages = computed(() => {
    const active = activeConversation.value
    return active ? messages.value[active.id] ?? [] : []
  })
  const activeTypingText = computed(() => {
    const active = activeConversation.value
    return active ? typingByConversation.value[active.conversationId] ?? '' : ''
  })

  const totalUnread = computed(() => {
    return conversations.value.reduce((total, conversation) => total + Number(conversation.unread || 0), 0)
  })
  const notifiableUnread = computed(() => {
    return conversations.value.reduce((total, conversation) => {
      return conversation.isMuted ? total : total + Number(conversation.unread || 0)
    }, 0)
  })
  const activeCanLoadOlder = computed(() => {
    const active = activeConversation.value
    return active ? messageHasMoreBefore.get(active.id) === true : false
  })

  function logWsStatus(status: string, detail: Record<string, unknown> = {}) {
    console.info('[b8im:ws]', status, {
      organization: session().organization,
      state: connectionState.value,
      ...detail
    })
  }

  function packetTraceContext(packet: ImPacket) {
    return parseTraceContext(packet.traceparent, packet.tracestate)
  }

  function startWsSpan(command: string, parent?: TraceContext | null, clientMsgId?: string) {
    return tryStartTelemetrySpan({
      name: `web.websocket.${command}`,
      kind: command === 'send' ? 'producer' : 'client',
      parent,
      fields: {
        organization: session().organization,
        command,
        ...(clientMsgId ? { clientMsgId } : {})
      }
    })
  }

  function trackSendTrace(clientMsgId: string, span: TelemetrySpan) {
    pendingSendTraces.track(clientMsgId, span)
  }

  function finishSendTrace(clientMsgId: string, errorCode = '') {
    pendingSendTraces.finish(clientMsgId, errorCode)
  }

  function failPendingSendTraces(code: string, type: string) {
    pendingSendTraces.failAll(code, type)
  }

  function resolvePendingControlRequest(clientMsgId: string) {
    const expected = pendingControlRequests.get(clientMsgId)
    window.clearTimeout(pendingControlTimers.get(clientMsgId) ?? 0)
    pendingControlTimers.delete(clientMsgId)
    pendingControlRequests.delete(clientMsgId)
    if (
      expected?.command === 'screenshot' &&
      pendingScreenshotRequests.get(expected.conversationId) === clientMsgId
    ) {
      pendingScreenshotRequests.delete(expected.conversationId)
    }
    return expected
  }

  function rejectAuthoritativeControlAck(
    clientMsgId: string,
    error: Error
  ) {
    const waiter = pendingAuthoritativeControlAcks.get(clientMsgId)
    if (!waiter) return
    pendingAuthoritativeControlAcks.delete(clientMsgId)
    waiter.reject(error)
  }

  function waitForAuthoritativeControlAck(clientMsgId: string) {
    return new Promise<void>((resolve, reject) => {
      pendingAuthoritativeControlAcks.set(clientMsgId, {
        resolve,
        reject
      })
    })
  }

  function registerPendingControlRequest(
    request: Omit<PendingImControlRequest, 'createdAt'>
  ) {
    resolvePendingControlRequest(request.clientMsgId)
    window.clearTimeout(completedControlTimers.get(request.clientMsgId) ?? 0)
    completedControlTimers.delete(request.clientMsgId)
    completedControlRequests.delete(request.clientMsgId)
    const pending: PendingImControlRequest = {
      ...request,
      createdAt: Date.now()
    }
    pendingControlRequests.set(request.clientMsgId, pending)
    pendingControlTimers.set(request.clientMsgId, window.setTimeout(() => {
      const current = pendingControlRequests.get(request.clientMsgId)
      if (
        !current ||
        !isPendingImRequestExpired(current, Date.now(), CONTROL_REQUEST_TIMEOUT_MS)
      ) {
        return
      }
      resolvePendingControlRequest(request.clientMsgId)
      rejectAuthoritativeControlAck(
        request.clientMsgId,
        new Error('IM 控制回执权威确认超时')
      )
      if (current.command === 'send') {
        finishSendTrace(request.clientMsgId, 'IM_SEND_ACK_TIMEOUT')
        markLocalMessageFailed(request.clientMsgId)
      }
    }, CONTROL_REQUEST_TIMEOUT_MS))
    return pending
  }

  function completePendingControlRequest(clientMsgId: string) {
    const expected = resolvePendingControlRequest(clientMsgId)
    if (!expected) return null
    const authoritativeAck = pendingAuthoritativeControlAcks.get(clientMsgId)
    if (authoritativeAck) {
      pendingAuthoritativeControlAcks.delete(clientMsgId)
      authoritativeAck.resolve()
    }
    const completed = { ...expected, createdAt: Date.now() }
    completedControlRequests.set(clientMsgId, completed)
    completedControlTimers.set(clientMsgId, window.setTimeout(() => {
      completedControlRequests.delete(clientMsgId)
      completedControlTimers.delete(clientMsgId)
    }, CONTROL_REQUEST_TIMEOUT_MS))
    return completed
  }

  function clearPendingControlRequests() {
    for (const [clientMsgId, waiter] of pendingAuthoritativeControlAcks) {
      waiter.reject(new Error('IM 连接已关闭，权威控制回执已取消'))
      pendingAuthoritativeControlAcks.delete(clientMsgId)
    }
    for (const timer of pendingControlTimers.values()) window.clearTimeout(timer)
    pendingControlTimers.clear()
    pendingControlRequests.clear()
    pendingScreenshotRequests.clear()
    for (const timer of completedControlTimers.values()) window.clearTimeout(timer)
    completedControlTimers.clear()
    completedControlRequests.clear()
    for (const request of pendingConversationSyncRequests.values()) {
      window.clearTimeout(request.timer)
      request.reject(new Error('IM 连接已关闭，会话同步已取消'))
    }
    pendingConversationSyncRequests.clear()
    for (const request of pendingGlobalSyncRequests.values()) {
      window.clearTimeout(request.timer)
      request.reject(new Error('IM 连接已关闭，全局同步已取消'))
    }
    pendingGlobalSyncRequests.clear()
  }

  async function boot() {
    const accessObservation = observeAccessSnapshot(
      session().crossOrgAccessSnapshotId
    )
    if (accessObservation === 'invalid') {
      throw new Error('登录会话的跨机构访问快照无效')
    }
    // Login is only a seed. No cross-organization write is allowed until the
    // authenticated connection completes its authoritative rebuild.
    setCrossOrgAccessRecoveryRequired(true)
    if (isCrossOrgAccessFailClosed()) {
      failCloseCrossOrgAccess(false)
    }
    await loadMessageConfig()
    await loadMessageGroups()
    await loadConversations()
    connect()
  }

  async function loadMessageGroups() {
    messageGroups.value = await fetchMessageGroups(config(), session())
  }

  async function loadMessageConfig() {
    try {
      messageDeleteConfig.value = await fetchMessageConfig(config(), session())
    } catch {
      messageDeleteConfig.value = {
        deleteSingleEnabled: false,
        deleteBothEnabled: false
      }
    }
  }

  async function loadConversations() {
    const loaded = (await fetchConversations(config(), session())).filter(
      (conversation) =>
        !revokedConversationIds.has(conversation.conversationId) &&
        !(isCrossOrgAccessFailClosed() && isCrossOrgSingle(conversation))
    )
    const activeVirtual = activeConversation.value?.virtual ? activeConversation.value : null
    conversations.value =
      activeVirtual && !loaded.some((item) => item.id === activeVirtual.id)
        ? [activeVirtual, ...loaded]
        : sortConversations(loaded)
    if (!activeConversationId.value && conversations.value.length > 0) {
      activeConversationId.value = conversations.value[0].id
      await syncActiveConversation()
    } else if (
      activeConversationId.value &&
      conversations.value.length > 0 &&
      !conversations.value.some((item) => item.id === activeConversationId.value)
    ) {
      activeConversationId.value = conversations.value[0].id
      await syncActiveConversation()
    }
    const active = activeConversation.value
    if (active) {
      setConversationReadLocal(active.id)
      void persistConversationRead(active)
    }
  }

  async function startSingleChat(contact: Contact) {
    if (
      isCrossOrgAccessFailClosed() &&
      normalizeImOrganization(contact.organization) !== session().organization
    ) {
      layer.warning('跨机构访问尚未初始化，暂不能发起跨机构单聊')
      return
    }
    const existing = conversations.value.find((item) =>
      isSameImIdentity(
        item.peerOrganization,
        item.peerUserId,
        contact.organization,
        contact.userId
      )
    )
    const conversation = existing ?? createVirtualConversation(contact)
    if (!existing) {
      conversations.value = [conversation, ...conversations.value]
    }
    activeConversationId.value = conversation.id
    if (!messages.value[conversation.id]) {
      messages.value[conversation.id] = []
    }
    await syncActiveConversation()
  }

  async function createGroup(title: string, contacts: Contact[]) {
    if (contacts.length < 2) {
      layer.warning('群聊至少选择 2 个好友')
      return null
    }
    if (
      contacts.some((contact) =>
        !isSameImIdentity(
          contact.organization,
          contact.userId,
          session().organization,
          contact.userId
        )
      )
    ) {
      layer.warning('群聊不支持跨机构成员')
      return null
    }
    const group = await createGroupConversation(config(), session(), {
      title,
      memberIds: contacts.map((contact) => contact.userId)
    })
    conversations.value = sortConversations([group, ...conversations.value.filter((item) => item.id !== group.id)])
    activeConversationId.value = group.id
    messages.value[group.id] = []
    return group
  }

  async function createMessageGroup(name: string) {
    const value = name.trim()
    if (!value) {
      layer.warning('分组名称必须填写')
      return null
    }
    const group = await createMessageGroupApi(config(), session(), value)
    messageGroups.value = [...messageGroups.value, group].sort((left, right) => left.sort - right.sort || left.id - right.id)
    return group
  }

  async function updateConversationGroup(conversationId: string, messageGroupId: number) {
    const conversation = conversations.value.find((item) => item.id === conversationId)
    if (!conversation || conversation.virtual || !conversation.conversationId) {
      layer.warning('请选择已有会话')
      return false
    }
    const result = await updateConversationGroupApi(config(), session(), {
      conversationId: conversation.conversationId,
      messageGroupId,
      conversationType: conversation.conversationType,
      peerOrganization: conversation.peerOrganization
    })
    conversations.value = conversations.value.map((item) =>
      item.id === conversationId
        ? {
            ...item,
            messageGroupId: Number(result.message_group_id ?? messageGroupId),
            messageGroupName: String(result.message_group_name ?? '')
          }
        : item
    )
    return true
  }

  async function syncActiveConversation() {
    const conversation = activeConversation.value
    if (!conversation) {
      void loadConversations()
      return
    }

    const currentMessages = messages.value[conversation.id] ?? []
    if (currentMessages.length === 0) {
      await loadRecentConversation(conversation)
      return
    }

    const cursor = messageCursors.get(conversation.id) ?? maxLocalMessageSeq(currentMessages)
    const result = await fetchMessages(config(), session(), {
      conversationId: conversation.conversationId,
      peerOrganization: conversation.peerOrganization,
      peerUserId: conversation.peerUserId,
      afterSeq: cursor,
      limit: 50
    })
    if (result.messages.length > 0) {
      mergeMessages(conversation, result.messages)
      messageCursors.set(
        conversation.id,
        Math.max(cursor, Number(result.next_after_seq ?? 0), maxMessageSeq(result.messages))
      )
      await nextTick()
      scrollMessagesToBottom()
    }
  }

  async function loadRecentConversation(conversation: ImConversation) {
    const result = await fetchMessages(config(), session(), {
      conversationId: conversation.conversationId,
      peerOrganization: conversation.peerOrganization,
      peerUserId: conversation.peerUserId,
      beforeSeq: 0,
      limit: 50
    })
    if (result.messages.length > 0) {
      let targetConversation = conversation
      if (conversation.virtual) {
        const conversationId = String(
          result.messages[0]?.conversation_id ?? ''
        ).trim()
        if (!conversationId) {
          throw new Error('虚拟单聊历史缺少权威 conversation_id')
        }
        const materialized: ImConversation = {
          ...conversation,
          id: conversationId,
          conversationId,
          virtual: false
        }
        // Validate the whole page against the virtual peer before mutating
        // the local conversation identity.
        result.messages.forEach((message) =>
          mapPacketMessage(message, session(), materialized)
        )
        conversations.value = conversations.value.map((item) =>
          item.id === conversation.id ? materialized : item
        )
        messages.value = {
          ...messages.value,
          [conversationId]: messages.value[conversation.id] ?? []
        }
        delete messages.value[conversation.id]
        if (activeConversationId.value === conversation.id) {
          activeConversationId.value = conversationId
        }
        targetConversation = materialized
      }
      mergeMessages(targetConversation, result.messages)
      updateConversationMessageBounds(
        targetConversation.id,
        result.messages,
        result
      )
      await nextTick()
      scrollMessagesToBottom()
      return
    }

    messageHasMoreBefore.set(conversation.id, false)
  }

  async function loadOlderActiveMessages() {
    const conversation = activeConversation.value
    if (!conversation || conversation.virtual || loadingOlderMessages.value) return false
    if (messageHasMoreBefore.get(conversation.id) === false) return false

    const beforeSeq = messageBeforeCursors.get(conversation.id) ?? minLocalMessageSeq(messages.value[conversation.id] ?? [])
    if (!beforeSeq || beforeSeq <= 1) {
      messageHasMoreBefore.set(conversation.id, false)
      return false
    }

    loadingOlderMessages.value = true
    try {
      const result = await fetchMessages(config(), session(), {
        conversationId: conversation.conversationId,
        peerOrganization: conversation.peerOrganization,
        peerUserId: conversation.peerUserId,
        beforeSeq,
        limit: 50
      })
      if (revokedConversationIds.has(conversation.conversationId)) return false
      if (result.messages.length === 0) {
        messageHasMoreBefore.set(conversation.id, false)
        return false
      }

      mergeMessages(conversation, result.messages)
      updateConversationMessageBounds(conversation.id, result.messages, result)
      return true
    } finally {
      loadingOlderMessages.value = false
    }
  }

  function connect() {
    clearReconnect()
    closeSocket()
    const routeCandidate = activeServiceCandidate(config(), 'im')
    const wsUrl = routeCandidate.url
    if (!wsUrl) {
      connectionState.value = 'offline'
      logWsStatus('offline:no-im-server-url')
      return
    }

    connectionState.value = 'connecting'
    logWsStatus('connecting', { url: wsUrl })
    const current = new WebSocket(wsUrl)
    socketRouteIds.set(current, routeCandidate.routeId)
    socket = current
    current.addEventListener('open', () => {
      if (socket !== current) return
      logWsStatus('open:awaiting-auth-challenge', {
        url: wsUrl,
        readyState: current.readyState
      })
    })
    current.addEventListener('message', (event) => handleSocketMessage(current, event))
    current.addEventListener('close', (event) => {
      if (socket !== current) return
      window.clearInterval(pingTimer)
      pingTimer = 0
      failPendingSendTraces('IM_WEBSOCKET_CLOSED', 'connection_closed')
      failCloseCrossOrgAccess(false)
      clearSocketAuthState(current)
      socket = null
      connectionState.value = 'offline'
      logWsStatus('offline:closed', {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean
      })
      if ([1006, 1011, 1012, 1013].includes(event.code)) {
        const failedRouteId = socketRouteIds.get(current) ?? routeCandidate.routeId
        const next = promoteServiceCandidate(config(), 'im', failedRouteId)
        if (next.routeId !== failedRouteId) {
          logWsStatus('routing:failover', {
            failedRouteId,
            nextRouteId: next.routeId,
            closeCode: event.code
          })
        }
      }
      scheduleReconnect()
    })
    current.addEventListener('error', () => {
      if (socket !== current) return
      connectionState.value = 'error'
      logWsStatus('error', { readyState: current.readyState })
    })
  }

  function handleAuthChallenge(current: WebSocket, packet: ImPacket) {
    if (socket !== current || current.readyState !== WebSocket.OPEN) return
    if (authenticatedConnection?.socket === current) {
      failSocketAuthentication(current, 'auth:duplicate-challenge', 'IM 连接重复下发鉴权 challenge')
      return
    }
    const clientId =
      typeof packet.data?.client_id === 'string' ? packet.data.client_id.trim() : ''
    if (!clientId) {
      failSocketAuthentication(current, 'auth:invalid-challenge', 'IM 鉴权 challenge 缺少 client_id')
      return
    }

    const challenge: AuthChallengeState = {
      socket: current,
      sequence: ++authChallengeSequence,
      clientId,
      deviceId: getWebDeviceId(),
      credentialSessionId: '',
      authSent: false,
      traceSpan: startWsSpan('auth', packetTraceContext(packet))
    }
    pendingAuthChallenge = challenge
    logWsStatus('auth:challenge-received', {
      hasClientId: true,
      challengeSequence: challenge.sequence
    })
    void authenticateChallenge(challenge)
  }

  async function authenticateChallenge(challenge: AuthChallengeState) {
    try {
      const credential = await issueImChallengeToken(
        config(),
        session(),
        challenge.clientId,
        challenge.traceSpan?.context
      )
      if (!isCurrentChallenge(challenge)) return

      pendingAuthChallenge = {
        ...challenge,
        deviceId: credential.deviceId,
        credentialSessionId: credential.credentialSessionId,
        authSent: true,
        traceSpan: challenge.traceSpan
      }
      if (
        !sendPacketToSocket(challenge.socket, {
          cmd: 'auth',
          data: {
            token: credential.token,
            device_id: credential.deviceId,
            platform: 'web'
          }
        }, challenge.traceSpan?.context)
      ) {
        throw new Error('IM 连接已关闭，无法发送鉴权凭证')
      }
      logWsStatus('auth:sent', {
        hasClientId: true,
        challengeSequence: challenge.sequence,
        expireAt: credential.expireAt
      })
    } catch (error) {
      if (!isCurrentChallenge(challenge)) return
      challenge.traceSpan?.fail({
        code: 'IM_AUTH_CREDENTIAL_ERROR',
        type: 'credential_error'
      })
      failSocketAuthentication(
        challenge.socket,
        'auth:credential-error',
        error instanceof Error ? error.message : 'IM token 签发失败'
      )
    }
  }

  async function sendText(text: string, replyTo?: Message | null, mentions: MessageMention[] = []) {
    const conversation = activeConversation.value
    const value = text.trim()
    if (!conversation || !value) return false
    if (!socket || socket.readyState !== WebSocket.OPEN || connectionState.value !== 'connected') {
      layer.warning('IM连接未就绪，稍后再试')
      return false
    }

    const reply = createMessageQuote(replyTo)
    return sendMessage(MESSAGE_TYPE_TEXT, {
      text: value,
      ...(mentions.length > 0 ? { mentions: mentions.map((mention) => ({
        user_id: mention.userId,
        nickname: mention.nickname,
        account: mention.account,
        avatar: mention.avatarUrl
      })) } : {}),
      ...(reply ? { reply: serializeMessageQuote(reply) } : {})
    }, value, 'text', { reply, mentions })
  }

  async function sendAsset(file: File, kind: UploadedAsset['kind']) {
    const conversation = activeConversation.value
    if (!conversation) return false
    const accessEpoch = captureAccessEpoch()
    if (isCrossOrgAccessFailClosed() && isCrossOrgSingle(conversation)) {
      layer.warning('当前跨机构访问已关闭')
      return false
    }
    if (!socket || socket.readyState !== WebSocket.OPEN || connectionState.value !== 'connected') {
      layer.warning('IM连接未就绪，稍后再试')
      return false
    }

    const clientMsgId = createClientMsgId()
    const localUrl = kind === 'image' || kind === 'voice' || kind === 'video' ? URL.createObjectURL(file) : ''
    const preview = assetPreview(kind)
    appendMessage(conversation.id, {
      id: clientMsgId,
      sender: '我',
      avatar: firstText(session().user.nickname || session().user.account || '我'),
      avatarUrl: session().user.avatarUrl,
      side: 'out',
      type: kind,
      content: preview,
      url: localUrl,
      fileName: file.name,
      fileSize: file.size,
      createTime: new Date().toISOString(),
      time: formatImTime(),
      state: 'uploading',
      uploadProgress: 1,
      meta: formatFileSize(file.size)
    })
    updateConversationPreview(conversation.id, preview)
    await nextTick()
    scrollMessagesToBottom()

    let uploaded: UploadedAsset
    try {
      uploaded = await uploadImAsset(config(), session(), file, kind, {
        conversationType: conversation.conversationType,
        onProgress: (progress) => {
          if (!isConversationAccessEpochCurrent(accessEpoch)) return
          updateLocalMessage(conversation.id, clientMsgId, {
            uploadProgress: Math.max(1, Math.min(99, progress)),
            state: 'uploading'
          })
        }
      })
      assertConversationAccessEpochCurrent(accessEpoch)
    } catch (error) {
      updateLocalMessage(conversation.id, clientMsgId, {
        state: 'failed',
        uploadProgress: undefined
      })
      if (localUrl) URL.revokeObjectURL(localUrl)
      layer.error(error instanceof Error ? error.message : '文件上传失败')
      return false
    }

    const type = kind === 'image'
      ? MESSAGE_TYPE_IMAGE
      : kind === 'voice'
        ? MESSAGE_TYPE_VOICE
        : kind === 'video'
          ? MESSAGE_TYPE_VIDEO
          : MESSAGE_TYPE_FILE
    updateLocalMessage(conversation.id, clientMsgId, {
      fileId: uploaded.fileId,
      conversationId: conversation.conversationId,
      url: uploaded.url,
      fileName: uploaded.name,
      fileSize: uploaded.size,
      meta: formatFileSize(uploaded.size),
      uploadProgress: 100
    })
    if (localUrl) URL.revokeObjectURL(localUrl)
    let sent = false
    try {
      assertConversationAccessEpochCurrent(accessEpoch)
      const sendConversation = resolveCapturedUploadConversation(
        conversation,
        conversations.value
      )
      if (!sendConversation) {
        throw new Error('上传期间原会话已失效，附件未发送')
      }
      if (
        isCrossOrgAccessFailClosed() &&
        isCrossOrgSingle(sendConversation)
      ) {
        throw new Error('当前跨机构访问已关闭')
      }
      sent = await sendMessageToConversation(
        sendConversation,
        type,
        { file_id: uploaded.fileId },
        preview,
        kind,
        { clientMsgId, appendLocal: false }
      )
    } catch (error) {
      layer.error(error instanceof Error ? error.message : '附件发送失败')
    }
    if (!sent) {
      updateLocalMessage(conversation.id, clientMsgId, {
        state: 'failed',
        uploadProgress: undefined
      })
    }
    return sent
  }

  async function sendMessage(
    messageType: number,
    content: Record<string, unknown>,
    preview: string,
    localType: Message['type'],
    options: { clientMsgId?: string; appendLocal?: boolean; reply?: MessageQuote | null; mentions?: MessageMention[]; localAsset?: UploadedAsset } = {}
  ) {
    const conversation = activeConversation.value
    if (!conversation) return false
    return sendMessageToConversation(conversation, messageType, content, preview, localType, options)
  }

  async function sendMessageToConversation(
    conversation: ImConversation,
    messageType: number,
    content: Record<string, unknown>,
    preview: string,
    localType: Message['type'],
    options: { clientMsgId?: string; appendLocal?: boolean; reply?: MessageQuote | null; mentions?: MessageMention[]; localAsset?: UploadedAsset } = {}
  ) {
    if (isCrossOrgAccessFailClosed() && isCrossOrgSingle(conversation)) {
      layer.warning('当前跨机构访问已关闭')
      return false
    }
    if (!socket || socket.readyState !== WebSocket.OPEN || connectionState.value !== 'connected') {
      layer.warning('IM连接未就绪，稍后再试')
      return false
    }
    if (
      conversation.conversationType === 'single' &&
      (!normalizeImOrganization(conversation.peerOrganization) ||
        conversation.peerUserId.trim() === '')
    ) {
      layer.warning('单聊缺少目标复合身份')
      return false
    }

    const clientMsgId = options.clientMsgId ?? createClientMsgId()
    if (options.appendLocal !== false) {
      appendMessage(conversation.id, {
        id: clientMsgId,
        sender: '我',
        avatar: firstText(session().user.nickname || session().user.account || '我'),
        avatarUrl: session().user.avatarUrl,
        side: 'out',
        type: localType,
        content: preview,
        conversationId: conversation.conversationId,
        fileId: String(content.file_id ?? ''),
        url: options.localAsset?.url ?? String(content.url ?? ''),
        fileName: options.localAsset?.name ?? String(content.name ?? ''),
        fileSize: options.localAsset?.size ?? Number(content.size ?? 0),
        createTime: new Date().toISOString(),
        time: formatImTime(),
        state: 'sent',
        senderUserId: session().user.userId,
        senderOrganization: session().organization,
        quote: options.reply ?? null,
        mentions: options.mentions ?? [],
        meta: options.localAsset
          ? formatFileSize(options.localAsset.size)
          : content.size
            ? formatFileSize(Number(content.size))
            : undefined
      })
    } else {
      updateLocalMessage(conversation.id, clientMsgId, {
        state: 'sent',
        uploadProgress: undefined
      })
    }
    updateConversationPreview(conversation.id, preview)
    const sendTrace = startWsSpan('send', null, clientMsgId)
    registerPendingControlRequest({
      command: 'send',
      clientMsgId,
      conversationId: conversation.conversationId,
      conversationType: conversation.conversationType,
      peerOrganization: conversation.peerOrganization,
      peerUserId: conversation.peerUserId,
      messageType,
      content: structuredClone(content)
    })
    const sent = sendPacket({
      cmd: 'send',
      client_msg_id: clientMsgId,
      data: {
        conversation_type: conversation.conversationType,
        conversation_id: conversation.conversationId || undefined,
        to_organization: conversation.conversationType === 'single'
          ? Number(conversation.peerOrganization)
          : undefined,
        to_user_id: conversation.conversationType === 'single' ? conversation.peerUserId : undefined,
        message_type: messageType,
        content
      }
    }, sendTrace)
    if (!sent) {
      sendTrace?.fail({
        code: 'IM_SEND_SOCKET_UNAVAILABLE',
        type: 'connection_unavailable',
        clientMsgId
      })
      resolvePendingControlRequest(clientMsgId)
      markLocalMessageFailed(clientMsgId)
      return false
    }
    if (sendTrace) trackSendTrace(clientMsgId, sendTrace)
    await nextTick()
    scrollMessagesToBottom()
    return true
  }

  async function forwardContent(message: Message) {
    if (message.forwardBundle) {
      return {
        messageType: MESSAGE_TYPE_TEXT,
        content: {
          text: message.forwardBundle.title,
          forward_mode: 'merged',
          forward_title: message.forwardBundle.title,
          forward_count: message.forwardBundle.count,
          forward_items: serializeForwardItems(message.forwardBundle.items)
        },
        preview: message.forwardBundle.title,
        localType: 'text' as const
      }
    }
    if (['image', 'file', 'voice', 'video'].includes(message.type)) {
      if (!message.fileId || !message.messageId || !message.conversationId) {
        throw new Error('原附件消息缺少可信转发上下文')
      }
      const accessEpoch = captureAccessEpoch()
      const kind = message.type as UploadedAsset['kind']
      const asset = await deriveForwardAssetApi(config(), session(), {
        conversationId: message.conversationId,
        messageId: message.messageId,
        fileId: message.fileId,
        kind
      })
      assertConversationAccessEpochCurrent(accessEpoch)
      const messageType = kind === 'image'
        ? MESSAGE_TYPE_IMAGE
        : kind === 'voice'
          ? MESSAGE_TYPE_VOICE
          : kind === 'video'
            ? MESSAGE_TYPE_VIDEO
            : MESSAGE_TYPE_FILE
      return {
        messageType,
        content: {
          file_id: asset.fileId
        },
        preview: assetPreview(kind),
        localType: kind,
        localAsset: asset
      }
    }

    return {
      messageType: MESSAGE_TYPE_TEXT,
      content: { text: message.content },
      preview: message.content,
      localType: 'text' as const
    }
  }

  function serializeForwardItems(items: MessageForwardItem[]): SerializedForwardItem[] {
    return items.map((item) => ({
      sender: item.sender,
      time: item.time ?? '',
      type: item.type,
      content: item.content,
      // Private signed URLs are display credentials and must never be persisted
      // inside merged-forward message bodies.
      url: undefined,
      file_name: item.fileName || undefined,
      size: item.fileSize ? Number(item.fileSize) : undefined,
      forward_bundle: item.forwardBundle
        ? {
            forward_mode: 'merged',
            forward_title: item.forwardBundle.title,
            forward_count: item.forwardBundle.count,
            forward_items: serializeForwardItems(item.forwardBundle.items)
          }
        : undefined
    }))
  }

  function mergedForwardItems(messages: Message[]) {
    return messages.map((message) => ({
      sender: message.sender,
      time: message.time ?? '',
      type: message.type,
      content: messageContentPreview(message),
      url: '',
      fileName: message.fileName ?? '',
      fileSize: message.fileSize ?? 0,
      forwardBundle: message.forwardBundle ?? null
    }))
  }

  async function forwardMessages(
    targetConversationIds: string[] | string,
    sourceMessages: Message[],
    mode: ForwardMode = 'separate'
  ) {
    const targetIds = Array.isArray(targetConversationIds) ? targetConversationIds : [targetConversationIds]
    const targetConversations = targetIds
      .map((id) => conversations.value.find((item) => item.id === id))
      .filter((item): item is ImConversation => Boolean(item && !item.virtual && item.conversationId))
    const list = sourceMessages.filter((message) => message.type !== 'notice')
    if (targetConversations.length === 0) {
      layer.warning('请选择已有会话')
      return false
    }
    if (list.length === 0) {
      layer.warning('请选择可转发的消息')
      return false
    }
    if (!socket || socket.readyState !== WebSocket.OPEN || connectionState.value !== 'connected') {
      layer.warning('IM连接未就绪，稍后再试')
      return false
    }

    let separatePayloads: Awaited<ReturnType<typeof forwardContent>>[] = []
    if (mode === 'separate') {
      try {
        for (const message of list) {
          separatePayloads.push(await forwardContent(message))
        }
      } catch (error) {
        layer.error(error instanceof Error ? error.message : '附件转发授权失败')
        return false
      }
    }

    for (const conversation of targetConversations) {
      if (mode === 'merged') {
        const items = mergedForwardItems(list)
        await sendMessageToConversation(
          conversation,
          MESSAGE_TYPE_TEXT,
          {
            text: '合并转发的聊天记录',
            forward_mode: 'merged',
            forward_title: '合并转发的聊天记录',
            forward_count: list.length,
            forward_items: serializeForwardItems(items)
          },
          '合并转发的聊天记录',
          'text'
        )
        continue
      }

      for (const payload of separatePayloads) {
        await sendMessageToConversation(
          conversation,
          payload.messageType,
          payload.content,
          payload.preview,
          payload.localType,
          { localAsset: 'localAsset' in payload ? payload.localAsset : undefined }
        )
      }
    }
    layer.success(targetConversations.length > 1 ? `已转发到 ${targetConversations.length} 个会话` : '已转发')
    return true
  }

  async function resolveMessageAssetUrl(message: Message, force = false) {
    if (!['image', 'file', 'voice', 'video'].includes(message.type) || !message.fileId) {
      throw new Error('消息不包含可信附件')
    }
    const needsMessageProof = message.side !== 'out'
    if (needsMessageProof && (!message.conversationId || !message.messageId)) {
      throw new Error('附件消息缺少可见性上下文')
    }
    const accessEpoch = captureAccessEpoch()
    const url = await resolveImAssetUrl(
      config(),
      session(),
      {
        fileId: message.fileId,
        ...(needsMessageProof
          ? { conversationId: message.conversationId, messageId: message.messageId }
          : {})
      },
      force
    )
    assertConversationAccessEpochCurrent(accessEpoch)
    if (message.conversationId) {
      updateLocalMessage(message.conversationId, message.id, { url })
    }

    return url
  }

  async function recallMessage(message: Message) {
    const conversation = activeConversation.value
    if (!conversation || !message.messageId || !message.conversationId) return false
    if (message.side !== 'out') {
      layer.warning('只能撤回自己发送的消息')
      return false
    }
    const clientMsgId = createClientMsgId()
    registerPendingControlRequest({
      command: 'recall',
      clientMsgId,
      conversationId: message.conversationId,
      messageId: message.messageId
    })
    const sent = sendPacket({
      cmd: 'recall',
      client_msg_id: clientMsgId,
      data: { message_id: message.messageId }
    })
    if (!sent) resolvePendingControlRequest(clientMsgId)
    return sent
  }

  async function sendScreenshotNotice() {
    const conversation = activeConversation.value
    if (!conversation || conversation.virtual || !conversation.conversationId) {
      layer.warning('请选择已有会话')
      return false
    }
    if (!socket || socket.readyState !== WebSocket.OPEN || connectionState.value !== 'connected') {
      layer.warning('IM连接未就绪，稍后再试')
      return false
    }

    const existingClientMsgId = pendingScreenshotRequests.get(conversation.conversationId)
    const existing = existingClientMsgId
      ? pendingControlRequests.get(existingClientMsgId)
      : null
    const reusableClientMsgId = reusablePendingScreenshotClientMsgId(
      existing,
      conversation.conversationId,
      Date.now(),
      CONTROL_REQUEST_TIMEOUT_MS
    )
    const clientMsgId = reusableClientMsgId || createClientMsgId()
    if (!reusableClientMsgId) {
      registerPendingControlRequest({
        command: 'screenshot',
        clientMsgId,
        conversationId: conversation.conversationId
      })
      pendingScreenshotRequests.set(conversation.conversationId, clientMsgId)
    }
    const sent = sendPacket({
      cmd: 'screenshot',
      client_msg_id: clientMsgId,
      data: { conversation_id: conversation.conversationId }
    })
    if (!sent) resolvePendingControlRequest(clientMsgId)
    return sent
  }

  function sendTyping() {
    const conversation = activeConversation.value
    if (!conversation || conversation.virtual || !conversation.conversationId) return false
    if (!socket || socket.readyState !== WebSocket.OPEN || connectionState.value !== 'connected') {
      return false
    }
    const now = Date.now()
    if (now - (lastTypingSentAt.get(conversation.conversationId) ?? 0) < 1500) {
      return true
    }
    const sent = sendPacket({
      cmd: 'typing',
      data: { conversation_id: conversation.conversationId }
    })
    if (sent) lastTypingSentAt.set(conversation.conversationId, now)
    return sent
  }

  async function editMessage(message: Message, text: string) {
    const value = text.trim()
    if (!message.messageId || message.side !== 'out') {
      layer.warning('只能编辑自己发送的消息')
      return false
    }
    if (message.type !== 'text') {
      layer.warning('只能编辑文本消息')
      return false
    }
    if (!value) {
      layer.warning('消息内容不能为空')
      return false
    }
    if (!socket || socket.readyState !== WebSocket.OPEN || connectionState.value !== 'connected') {
      layer.warning('IM连接未就绪，稍后再试')
      return false
    }

    const conversationId = String(message.conversationId ?? '').trim()
    if (!conversationId) return false
    const clientMsgId = createClientMsgId()
    const content = { text: value }
    registerPendingControlRequest({
      command: 'edit',
      clientMsgId,
      conversationId,
      messageId: message.messageId,
      content
    })
    const sent = sendPacket({
      cmd: 'edit',
      client_msg_id: clientMsgId,
      data: {
        message_id: message.messageId,
        content
      }
    })
    if (!sent) resolvePendingControlRequest(clientMsgId)
    return sent
  }

  async function deleteMessage(message: Message, scope: 'self' | 'both') {
    if (!message.messageId || message.type === 'notice') return false
    if (scope === 'self' && !messageDeleteConfig.value.deleteSingleEnabled) {
      layer.warning('当前租户未开启单向删除消息')
      return false
    }
    if (scope === 'both') {
      if (!messageDeleteConfig.value.deleteBothEnabled) {
        layer.warning('当前租户未开启双向删除消息')
        return false
      }
      if (message.side !== 'out') {
        layer.warning('只能双向删除自己发送的消息')
        return false
      }
    }
    if (!socket || socket.readyState !== WebSocket.OPEN || connectionState.value !== 'connected') {
      layer.warning('IM连接未就绪，稍后再试')
      return false
    }

    const conversationId = String(message.conversationId ?? '').trim()
    if (!conversationId) return false
    const clientMsgId = createClientMsgId()
    registerPendingControlRequest({
      command: 'delete',
      clientMsgId,
      conversationId,
      messageId: message.messageId,
      scope
    })
    const sent = sendPacket({
      cmd: 'delete',
      client_msg_id: clientMsgId,
      data: {
        message_id: message.messageId,
        scope
      }
    })
    if (!sent) resolvePendingControlRequest(clientMsgId)
    return sent
  }

  async function deleteMessages(sourceMessages: Message[], scope: 'self' | 'both') {
    const list = sourceMessages.filter((message) => message.messageId && message.type !== 'notice')
    if (list.length === 0) {
      layer.warning('请选择可删除的消息')
      return false
    }
    for (const message of list) {
      await deleteMessage(message, scope)
    }
    return true
  }

  function mutationCursorKey(conversationId: string, messageId = '') {
    return `${session().organization}\u0000${conversationId}\u0000${messageId}`
  }

  function rejectGlobalSyncRequest(clientMsgId: string, error: Error) {
    const request = pendingGlobalSyncRequests.get(clientMsgId)
    if (!request) return
    window.clearTimeout(request.timer)
    pendingGlobalSyncRequests.delete(clientMsgId)
    request.reject(error)
  }

  function requestGlobalSyncPage(current: WebSocket, afterGlobalSeq: string) {
    return new Promise<GlobalSyncPage>((resolve, reject) => {
      const clientMsgId = createClientMsgId()
      const request: PendingGlobalSyncRequest = {
        clientMsgId,
        afterGlobalSeq,
        resolve,
        reject,
        timer: 0
      }
      request.timer = window.setTimeout(() => {
        rejectGlobalSyncRequest(
          clientMsgId,
          new Error('全局 SYNC 响应超时')
        )
      }, CONTROL_REQUEST_TIMEOUT_MS)
      pendingGlobalSyncRequests.set(clientMsgId, request)
      if (!sendPacketToSocket(current, {
        cmd: 'sync',
        client_msg_id: clientMsgId,
        data: {
          after_global_seq: afterGlobalSeq,
          limit: GLOBAL_SYNC_PAGE_LIMIT
        }
      })) {
        rejectGlobalSyncRequest(
          clientMsgId,
          new Error('IM 连接未就绪，无法执行全局同步')
        )
      }
    })
  }

  async function collectStableGlobalSync(
    current: WebSocket,
    staleServerSnapshotId = ''
  ): Promise<StableGlobalSyncBatch> {
    const previousCursor = syncCursorStore().read()
    for (let attempt = 0; attempt < GLOBAL_SYNC_MAX_RESTARTS; attempt += 1) {
      const epoch = captureAccessEpoch()
      let cursor = previousCursor
      let batchSnapshotId = ''
      let batchBehindHighWater = false
      let restart = false
      const messages = new Map<string, ImPacketMessage>()
      for (let pageCount = 0; pageCount < GLOBAL_SYNC_MAX_PAGES; pageCount += 1) {
        const page = await requestGlobalSyncPage(current, cursor)
        const snapshotObservation = observeAccessSnapshot(page.accessSnapshotId)
        const expectedStalePage = isExpectedStaleGlobalSyncSnapshot(
          snapshotObservation,
          page.accessSnapshotId,
          staleServerSnapshotId
        )
        if (
          snapshotObservation === 'invalid' ||
          (snapshotObservation === 'stale' && !expectedStalePage)
        ) {
          throw new Error('全局 SYNC 返回了无效或回滚的访问快照')
        }
        if (snapshotObservation === 'new') {
          failCloseCrossOrgAccess(false)
          restart = true
          break
        }
        if (!batchSnapshotId) {
          batchSnapshotId = page.accessSnapshotId
          batchBehindHighWater = expectedStalePage
        }
        if (
          page.accessSnapshotId !== batchSnapshotId ||
          expectedStalePage !== batchBehindHighWater ||
          (
            !batchBehindHighWater &&
            page.accessSnapshotId !== epoch.snapshotId
          ) ||
          !isConversationAccessEpochCurrent(epoch)
        ) {
          restart = true
          break
        }
        for (const message of page.messages) {
          const existing = messages.get(message.message_id)
          if (existing && existing.global_seq !== message.global_seq) {
            throw new Error('全局 SYNC 同一 message_id 对应多个 global_seq')
          }
          messages.set(message.message_id, message)
        }
        cursor = page.nextAfterGlobalSeq
        if (!page.hasMore) {
          assertConversationAccessEpochCurrent(epoch)
          return {
            previousCursor,
            nextCursor: cursor,
            accessSnapshotId: batchSnapshotId,
            accessSnapshotBehindHighWater: batchBehindHighWater,
            epoch,
            messages: [...messages.values()]
          }
        }
      }
      if (!restart) throw new Error('全局 SYNC 分页超过安全上限')
    }
    throw new Error('全局 SYNC 期间跨机构访问快照持续变化')
  }

  function applyGlobalSyncMessages(batch: StableGlobalSyncBatch) {
    assertConversationAccessEpochCurrent(batch.epoch)
    const applied: ImPacketMessage[] = []
    for (const message of batch.messages) {
      const conversation = conversations.value.find(
        (item) => item.conversationId === message.conversation_id
      )
      if (!conversation) {
        if (
          batch.accessSnapshotBehindHighWater ||
          revokedConversationIds.has(message.conversation_id)
        ) {
          continue
        }
        throw new Error('全局 SYNC 消息缺少权威会话，拒绝推进游标')
      }
      if (revokedConversationIds.has(message.conversation_id) ||
        !canRecoverGlobalSyncConversation(
          batch.accessSnapshotBehindHighWater ||
            batch.accessSnapshotId === '0',
          session().organization,
          conversation
        )) {
        continue
      }
      if (!isMessageValidForConversation(
        message as unknown as Record<string, unknown>,
        session().organization,
        session().user.userId,
        conversation
      )) {
        throw new Error('全局 SYNC 消息复合身份或会话归属无效')
      }
      appendPacketMessage(
        conversation,
        message,
        isSameImIdentity(
          message.sender_organization,
          message.sender_id,
          session().organization,
          session().user.userId
        )
          ? message.client_msg_id
          : ''
      )
      messageCursors.set(
        conversation.id,
        Math.max(
          messageCursors.get(conversation.id) ?? 0,
          Number(message.message_seq ?? 0)
        )
      )
      applied.push(message)
    }
    assertConversationAccessEpochCurrent(batch.epoch)
    return applied
  }

  async function syncCachedConversationGaps(cachedConversationIds: Set<string>) {
    for (const conversation of [...conversations.value]) {
      if (!cachedConversationIds.has(conversation.conversationId) ||
        revokedConversationIds.has(conversation.conversationId) ||
        (isCrossOrgAccessFailClosed() && isCrossOrgSingle(conversation))) {
        continue
      }
      const messageCursor = messageCursors.get(conversation.id) ??
        maxLocalMessageSeq(messages.value[conversation.id] ?? [])
      const changeCursor = conversationChangeCursors.get(
        mutationCursorKey(conversation.conversationId)
      ) ?? 0
      if (
        Number(conversation.lastMessageSeq ?? 0) <= messageCursor &&
        Number(conversation.lastChangeSeq ?? 0) <= changeCursor
      ) {
        continue
      }
      await syncConversationFromCursors(conversation)
      if (
        (messageCursors.get(conversation.id) ?? 0) <
          Number(conversation.lastMessageSeq ?? 0) ||
        (conversationChangeCursors.get(
          mutationCursorKey(conversation.conversationId)
        ) ?? 0) < Number(conversation.lastChangeSeq ?? 0)
      ) {
        throw new Error('会话 SYNC 未追平 AUTH 会话摘要水位')
      }
    }
  }

  function rejectConversationSyncRequest(clientMsgId: string, error: Error) {
    const request = pendingConversationSyncRequests.get(clientMsgId)
    if (!request) return
    window.clearTimeout(request.timer)
    pendingConversationSyncRequests.delete(clientMsgId)
    request.reject(error)
  }

  function requestConversationSyncPage(
    conversation: ImConversation,
    afterSeq: number,
    afterChangeSeq: number
  ) {
    const epoch = captureAccessEpoch()
    const snapshotId = epoch.snapshotId
    if (!snapshotId) {
      return Promise.reject(new Error('跨机构访问快照尚未建立'))
    }
    if (snapshotId === '0' && isCrossOrgSingle(conversation)) {
      return Promise.reject(new Error('跨机构访问已关闭'))
    }
    const current = socket
    if (
      !current ||
      current.readyState !== WebSocket.OPEN ||
      authenticatedConnection?.socket !== current
    ) {
      return Promise.reject(new Error('IM 连接未就绪，无法同步会话'))
    }
    return new Promise<ConversationSyncPage>((resolve, reject) => {
      const clientMsgId = createClientMsgId()
      const request: PendingConversationSyncRequest = {
        clientMsgId,
        conversationId: conversation.conversationId,
        afterSeq,
        afterChangeSeq,
        epoch,
        snapshotId,
        resolve,
        reject,
        timer: 0
      }
      request.timer = window.setTimeout(() => {
        rejectConversationSyncRequest(
          clientMsgId,
          new Error('会话 SYNC 响应超时')
        )
      }, CONTROL_REQUEST_TIMEOUT_MS)
      pendingConversationSyncRequests.set(clientMsgId, request)
      if (!sendPacketToSocket(current, {
        cmd: 'sync',
        client_msg_id: clientMsgId,
        data: {
          conversation_id: conversation.conversationId,
          after_seq: afterSeq,
          after_change_seq: afterChangeSeq,
          limit: CONVERSATION_SYNC_PAGE_LIMIT
        }
      })) {
        rejectConversationSyncRequest(
          clientMsgId,
          new Error('IM 连接未就绪，无法同步会话')
        )
      }
    })
  }

  function validateConversationSyncPage(
    data: Record<string, any>,
    request: PendingConversationSyncRequest,
    conversation: ImConversation
  ): ConversationSyncPage | null {
    const nextAfterSeq = Number(data.next_after_seq ?? -1)
    const nextAfterChangeSeq = Number(data.next_after_change_seq ?? -1)
    const snapshotId = normalizeAccessSnapshotId(
      data.cross_org_access_snapshot_id
    )
    if (
      data.scope !== 'conversation' ||
      String(data.conversation_id ?? '').trim() !== request.conversationId ||
      !Array.isArray(data.messages) ||
      !Array.isArray(data.changes) ||
      !Number.isSafeInteger(nextAfterSeq) ||
      nextAfterSeq < request.afterSeq ||
      !Number.isSafeInteger(nextAfterChangeSeq) ||
      nextAfterChangeSeq < request.afterChangeSeq ||
      typeof data.messages_has_more !== 'boolean' ||
      typeof data.changes_has_more !== 'boolean' ||
      !snapshotId ||
      (data.messages_has_more && nextAfterSeq <= request.afterSeq) ||
      (data.changes_has_more &&
        nextAfterChangeSeq <= request.afterChangeSeq)
    ) {
      return null
    }

    let previousMessageSequence = request.afterSeq
    const packetMessages: ImPacketMessage[] = []
    const pageMessageIds = new Set<string>()
    for (const value of data.messages) {
      if (!isRecord(value)) return null
      const messageSequence = Number(value.message_seq ?? 0)
      if (
        !isCanonicalConversationSyncMessageId(value.message_id) ||
        pageMessageIds.has(value.message_id) ||
        !isMessageValidForConversation(
          value,
          session().organization,
          session().user.userId,
          conversation
        ) ||
        messageSequence <= previousMessageSequence ||
        messageSequence > nextAfterSeq
      ) {
        return null
      }
      previousMessageSequence = messageSequence
      pageMessageIds.add(value.message_id)
      packetMessages.push(value as ImPacketMessage)
    }

    let mappedMessages: Message[]
    try {
      mappedMessages = packetMessages.map((message) =>
        mapPacketMessage(message, session(), conversation)
      )
    } catch {
      return null
    }
    const localProjectedMessages = (messages.value[conversation.id] ?? [])
      .filter(
        (message) =>
          typeof message.messageId === 'string' &&
          message.messageId.length > 0
      )
      .map((message) =>
        conversationSyncProjectedMessage(conversation, message)
      )
    const pageProjectedMessages = mappedMessages.map((message, index) =>
      conversationSyncProjectedMessage(
        conversation,
        message,
        Number(packetMessages[index]?.message_type ?? 0)
      )
    )
    const projectedMessages = buildConversationSyncMessageProjection(
      localProjectedMessages,
      pageProjectedMessages
    )
    if (!projectedMessages) return null

    let previousChangeSequence = request.afterChangeSeq
    const changes: ConversationSyncChange[] = []
    for (const value of data.changes) {
      if (
        !isRecord(value) ||
        !isCanonicalConversationSyncMessageId(value.message_id)
      ) {
        return null
      }
      const messageId = value.message_id
      const normalized = normalizeConversationSyncChange(value, {
        organization: session().organization,
        userId: session().user.userId,
        conversation,
        conversationId: request.conversationId,
        previousChangeSeq: previousChangeSequence,
        nextAfterChangeSeq,
        original: projectedMessages.get(messageId) ?? null
      })
      if (!normalized) return null
      previousChangeSequence = normalized.change_seq
      changes.push(normalized)
    }
    if (!isConversationSyncChangeBatchValid(
      changes,
      {
        organization: session().organization,
        userId: session().user.userId,
        conversation
      },
      (change) => projectedMessages.get(change.message_id)
    )) {
      return null
    }

    return {
      scope: 'conversation',
      conversation_id: request.conversationId,
      messages: packetMessages,
      changes,
      next_after_seq: nextAfterSeq,
      next_after_change_seq: nextAfterChangeSeq,
      messages_has_more: data.messages_has_more,
      changes_has_more: data.changes_has_more,
      cross_org_access_snapshot_id: snapshotId,
      access_snapshot_behind_high_water: false
    }
  }

  function applyConversationSyncChange(
    conversation: ImConversation,
    change: ConversationSyncChange
  ) {
    const original = (messages.value[conversation.id] ?? []).find(
      (message) => message.messageId === change.message_id
    )
    if (original) {
      if (
        change.change_type === 'recall' ||
        change.change_type === 'delete_both' ||
        change.change_type === 'delete_self'
      ) {
        removeDeletedMessage(
          conversation.conversationId,
          change.message_id,
          {}
        )
      } else {
        updateLocalMessage(conversation.id, original.id, {
          content: change.payload.content.text,
          editTime: change.payload.edit_time,
          editCount: change.payload.edit_count
        })
      }
    }
    messageChangeCursors.set(
      mutationCursorKey(conversation.conversationId, change.message_id),
      change.change_seq
    )
  }

  function applyConversationSyncPage(
    conversation: ImConversation,
    page: ConversationSyncPage,
    epoch: ConversationAccessEpochToken
  ) {
    assertConversationAccessEpochCurrent(epoch)
    const mappedMessages = page.messages.map((message) =>
      mapPacketMessage(message, session(), conversation)
    )
    const localProjectedMessages = (messages.value[conversation.id] ?? [])
      .filter(
        (message) =>
          typeof message.messageId === 'string' &&
          message.messageId.length > 0
      )
      .map((message) =>
        conversationSyncProjectedMessage(conversation, message)
      )
    const pageProjectedMessages = mappedMessages.map((message, index) =>
      conversationSyncProjectedMessage(
        conversation,
        message,
        Number(page.messages[index]?.message_type ?? 0)
      )
    )
    const committed = commitConversationSyncPageBatch(
      localProjectedMessages,
      pageProjectedMessages,
      page.changes,
      {
        organization: session().organization,
        userId: session().user.userId,
        conversation
      },
      () => {
        for (const message of mappedMessages) {
          appendMessage(conversation.id, message)
        }
        for (const change of page.changes) {
          applyConversationSyncChange(conversation, change)
        }
        messageCursors.set(conversation.id, page.next_after_seq)
        conversationChangeCursors.set(
          mutationCursorKey(conversation.conversationId),
          page.next_after_change_seq
        )
        conversations.value = conversations.value.map((item) =>
          item.id === conversation.id
            ? {
                ...item,
                lastChangeSeq: Math.max(
                  Number(item.lastChangeSeq ?? 0),
                  page.next_after_change_seq
                )
              }
            : item
        )
      }
    )
    if (!committed) {
      throw new Error('会话 SYNC 变更 actor、target 或原消息归属无效')
    }
  }

  async function syncConversationFromCursors(conversation: ImConversation) {
    let afterSeq = messageCursors.get(conversation.id) ??
      maxLocalMessageSeq(messages.value[conversation.id] ?? [])
    let afterChangeSeq = conversationChangeCursors.get(
      mutationCursorKey(conversation.conversationId)
    ) ?? 0
    for (let pageCount = 0; pageCount < 1000; pageCount += 1) {
      let page: ConversationSyncPage
      try {
        page = await requestConversationSyncPage(
          conversation,
          afterSeq,
          afterChangeSeq
        )
      } catch (error) {
        if (
          error instanceof ConversationAccessEpochChangedError &&
          !isCrossOrgSingle(conversation)
        ) {
          page = await requestConversationSyncPage(
            conversation,
            afterSeq,
            afterChangeSeq
          )
        } else {
          throw error
        }
      }
      const epoch = captureAccessEpoch()
      if (
        (
          epoch.snapshotId !== page.cross_org_access_snapshot_id &&
          !page.access_snapshot_behind_high_water
        ) ||
        (epoch.snapshotId === '0' && isCrossOrgSingle(conversation))
      ) {
        throw new Error('会话 SYNC 快照已变化')
      }
      applyConversationSyncPage(conversation, page, epoch)
      afterSeq = page.next_after_seq
      afterChangeSeq = page.next_after_change_seq
      if (!page.messages_has_more && !page.changes_has_more) return
    }
    throw new Error('会话 SYNC 分页超过安全上限')
  }

  async function refreshConversationHistoryForChange(
    conversation: ImConversation,
    incomingChangeSequence: number,
    messageId: string
  ) {
    const key = mutationCursorKey(conversation.conversationId)
    const currentRefresh = changeRefreshInFlight.get(key)
    if (currentRefresh) return currentRefresh
    const refreshSocket = socket
    const refreshEpoch = captureAccessEpoch()
    let refresh: Promise<void>
    refresh = (async () => {
      await syncConversationFromCursors(conversation)
      if (
        (conversationChangeCursors.get(key) ?? 0) < incomingChangeSequence
      ) {
        throw new Error('会话 SYNC 尚未追平变更水位')
      }
      await loadConversations()
    })().catch((error) => {
      if (
        error instanceof ConversationAccessEpochChangedError ||
        !isConversationAccessEpochCurrent(refreshEpoch) ||
        !refreshSocket ||
        socket !== refreshSocket ||
        authenticatedConnection?.socket !== refreshSocket
      ) {
        return
      }
      logWsStatus('mutation:authoritative-refresh-failed', {
        conversationId: conversation.conversationId,
        messageId,
        error: error instanceof Error ? error.message : String(error)
      })
      failCloseCrossOrgAccess(false)
      failSocketAuthentication(
        refreshSocket,
        'mutation:authoritative-refresh-failed',
        '消息变更缺口的权威同步失败，正在重新连接'
      )
      scheduleReconnect()
    }).finally(() => {
      if (changeRefreshInFlight.get(key) === refresh) {
        changeRefreshInFlight.delete(key)
      }
    })
    changeRefreshInFlight.set(key, refresh)
    return refresh
  }

  function applyDurableMutation(
    command: 'recall' | 'edit' | 'delete',
    data: Record<string, any>
  ) {
    const conversationId = String(data.conversation_id ?? '').trim()
    const messageId = String(data.message_id ?? '').trim()
    const incomingChangeSequence = Number(data.change_seq ?? 0)
    const conversation = conversations.value.find(
      (item) => item.conversationId === conversationId
    )
    if (!conversation || !messageId) return false
    const conversationCursorKey = mutationCursorKey(conversationId)
    const messageCursorKey = mutationCursorKey(conversationId, messageId)
    const decision = classifyMutationChangeSequence(
      conversationChangeCursors.get(conversationCursorKey) ?? 0,
      messageChangeCursors.get(messageCursorKey) ?? 0,
      incomingChangeSequence
    )
    if (decision === 'invalid') return false
    if (decision === 'stale') return true
    const original = (messages.value[conversation.id] ?? []).find(
      (message) => message.messageId === messageId
    )
    if (decision === 'gap' || !original) {
      void refreshConversationHistoryForChange(
        conversation,
        incomingChangeSequence,
        messageId
      )
      return true
    }
    if (!isDurableMutationValidForContext(
      command,
      data,
      session().organization,
      session().user.userId,
      conversation,
      {
        conversationId,
        messageId,
        messageSeq: Number(original.messageSeq ?? 0),
        senderOrganization: original.senderOrganization,
        senderUserId: original.senderUserId,
        messageType: original.type === 'text' ? MESSAGE_TYPE_TEXT : 0,
        side: original.side
      }
    )) {
      return false
    }

    if (command === 'recall') {
      const noticeMessage = data.notice_message as ImPacketMessage | undefined
      if (noticeMessage && (
        noticeMessage.conversation_id !== conversationId ||
        normalizeImOrganization(noticeMessage.organization) !== session().organization ||
        !isMessageValidForConversation(
          noticeMessage as unknown as Record<string, unknown>,
          session().organization,
          session().user.userId,
          conversation
        ) ||
        !isSameImIdentity(
          noticeMessage.content?.actor_organization,
          noticeMessage.content?.actor_user_id,
          data.actor_organization,
          data.actor_user_id
        )
      )) {
        return false
      }
      removeRecalledMessage(conversationId, messageId)
      if (noticeMessage) applyNoticeMessage(noticeMessage, data)
    } else if (command === 'edit') {
      applyEditedMessage(data.message as ImPacketMessage, data)
    } else {
      removeDeletedMessage(conversationId, messageId, data)
    }
    conversationChangeCursors.set(conversationCursorKey, incomingChangeSequence)
    messageChangeCursors.set(messageCursorKey, incomingChangeSequence)
    void loadConversations()
    return true
  }

  function applyMutationAck(
    expected: PendingImControlRequest,
    data: Record<string, any>
  ) {
    if (
      expected.command !== 'recall' &&
      expected.command !== 'edit' &&
      expected.command !== 'delete'
    ) return false
    const conversation = conversations.value.find(
      (item) => item.conversationId === expected.conversationId
    )
    if (!conversation || !expected.messageId) return false
    const incomingChangeSequence = Number(data.change_seq ?? 0)
    const conversationCursorKey = mutationCursorKey(expected.conversationId)
    const messageCursorKey = mutationCursorKey(
      expected.conversationId,
      expected.messageId
    )
    const decision = classifyMutationChangeSequence(
      conversationChangeCursors.get(conversationCursorKey) ?? 0,
      messageChangeCursors.get(messageCursorKey) ?? 0,
      incomingChangeSequence
    )
    if (decision === 'invalid') return false
    if (decision === 'stale') return true
    const original = (messages.value[conversation.id] ?? []).find(
      (message) => message.messageId === expected.messageId
    )
    if (decision === 'gap' || !original) {
      void refreshConversationHistoryForChange(
        conversation,
        incomingChangeSequence,
        expected.messageId
      )
      return true
    }
    const currentIsSender = isSameImIdentity(
      original.senderOrganization,
      original.senderUserId,
      session().organization,
      session().user.userId
    )
    if (
      (expected.command === 'recall' || expected.command === 'edit' ||
        (expected.command === 'delete' && expected.scope === 'both')) &&
      !currentIsSender
    ) {
      return false
    }

    if (expected.command === 'recall') {
      const noticeMessage = data.notice_message as ImPacketMessage | undefined
      if (noticeMessage && (
        noticeMessage.conversation_id !== expected.conversationId ||
        normalizeImOrganization(noticeMessage.organization) !== session().organization ||
        !isMessageValidForConversation(
          noticeMessage as unknown as Record<string, unknown>,
          session().organization,
          session().user.userId,
          conversation
        ) ||
        !isSameImIdentity(
          noticeMessage.content?.actor_organization,
          noticeMessage.content?.actor_user_id,
          session().organization,
          session().user.userId
        )
      )) return false
      removeRecalledMessage(expected.conversationId, expected.messageId)
      if (noticeMessage) applyNoticeMessage(noticeMessage, data)
    } else if (expected.command === 'edit') {
      const message = data.message as ImPacketMessage | undefined
      if (
        !message ||
        !isRecord(data.content) ||
        typeof data.content.text !== 'string' ||
        data.content.text.trim() === '' ||
        message.conversation_id !== expected.conversationId ||
        normalizeImOrganization(message.organization) !== session().organization ||
        message.message_id !== expected.messageId ||
        Number(message.message_seq ?? 0) !== Number(original.messageSeq ?? 0) ||
        Number(message.message_type ?? 0) !== MESSAGE_TYPE_TEXT ||
        String(message.content?.text ?? '') !== data.content.text ||
        !isSameImIdentity(
          message.sender_organization,
          message.sender_id,
          original.senderOrganization,
          original.senderUserId
        ) ||
        !isMessageValidForConversation(
          message as unknown as Record<string, unknown>,
          session().organization,
          session().user.userId,
          conversation
        )
      ) return false
      applyEditedMessage(message, data)
    } else {
      removeDeletedMessage(expected.conversationId, expected.messageId, data)
    }
    conversationChangeCursors.set(conversationCursorKey, incomingChangeSequence)
    messageChangeCursors.set(messageCursorKey, incomingChangeSequence)
    void loadConversations()
    return true
  }

  function applyScreenshotAck(
    expected: PendingImControlRequest,
    data: Record<string, any>
  ) {
    if (expected.command !== 'screenshot') return false
    const conversation = conversations.value.find(
      (item) => item.conversationId === expected.conversationId
    )
    if (!conversation) return false
    const noticeMessage = data.notice_message as ImPacketMessage | undefined
    if (data.enabled === false) return noticeMessage === undefined || noticeMessage === null
    if (
      data.enabled !== true ||
      !noticeMessage ||
      noticeMessage.conversation_id !== expected.conversationId ||
      normalizeImOrganization(noticeMessage.organization) !== session().organization ||
      !isMessageValidForConversation(
        noticeMessage as unknown as Record<string, unknown>,
        session().organization,
        session().user.userId,
        conversation
      ) ||
      !isSameImIdentity(
        noticeMessage.content?.actor_organization,
        noticeMessage.content?.actor_user_id,
        session().organization,
        session().user.userId
      )
    ) return false
    applyNoticeMessage(noticeMessage, data)
    return true
  }

  function clearConversationRuntime(conversation: ImConversation) {
    const conversationId = conversation.conversationId
    const nextMessages = { ...messages.value }
    delete nextMessages[conversation.id]
    messages.value = nextMessages
    messageCursors.delete(conversation.id)
    messageBeforeCursors.delete(conversation.id)
    messageHasMoreBefore.delete(conversation.id)
    conversationReadCursors.delete(mutationCursorKey(conversationId))
    conversationChangeCursors.delete(mutationCursorKey(conversationId))
    for (const key of messageChangeCursors.keys()) {
      if (key.startsWith(mutationCursorKey(conversationId))) {
        messageChangeCursors.delete(key)
      }
    }
    for (const request of [...pendingControlRequests.values()]) {
      if (request.conversationId === conversationId) {
        resolvePendingControlRequest(request.clientMsgId)
        rejectAuthoritativeControlAck(
          request.clientMsgId,
          new Error('会话已失效，权威控制回执已取消')
        )
      }
    }
    const nextTyping = { ...typingByConversation.value }
    delete nextTyping[conversationId]
    typingByConversation.value = nextTyping
    window.clearTimeout(typingTimers.get(conversationId) ?? 0)
    typingTimers.delete(conversationId)
  }

  function clearCrossOrgPendingControlRequests() {
    for (const request of [...pendingControlRequests.values()]) {
      const conversation = conversations.value.find(
        (item) => item.conversationId === request.conversationId
      )
      const isCrossOrg =
        normalizeImOrganization(request.peerOrganization) !== '' &&
        normalizeImOrganization(request.peerOrganization) !== session().organization ||
        (
          conversation?.conversationType === 'single' &&
          normalizeImOrganization(conversation.peerOrganization) !== session().organization
        )
      if (!isCrossOrg) continue
      resolvePendingControlRequest(request.clientMsgId)
      rejectAuthoritativeControlAck(
        request.clientMsgId,
        new Error('跨机构访问已变化，权威控制回执已取消')
      )
      if (request.command === 'send') {
        finishSendTrace(request.clientMsgId, 'IM_CROSS_ORG_ACCESS_REVOKED')
        markLocalMessageFailed(request.clientMsgId)
      }
    }
  }

  function failCloseCrossOrgAccess(refresh = true) {
    setCrossOrgAccessRecoveryRequired(true)
    advanceConversationAccessEpoch(
      session().organization,
      session().user.userId
    )
    clearCrossOrgPendingControlRequests()
    for (const request of [...pendingConversationSyncRequests.values()]) {
      rejectConversationSyncRequest(
        request.clientMsgId,
        new ConversationAccessEpochChangedError()
      )
    }
    accessSnapshotRebuild = null
    restorableConversationIds.clear()
    const retained: ImConversation[] = []
    let removedActive = false
    for (const conversation of conversations.value) {
      if (!isCrossOrgSingle(conversation)) {
        retained.push(conversation)
        continue
      }
      if (conversation.conversationId) {
        revokedConversationIds.add(conversation.conversationId)
      }
      clearConversationRuntime(conversation)
      dispatchConversationAccessChanged(false, conversation, '', '', false)
      if (conversation.id === activeConversationId.value) removedActive = true
    }
    dispatchConversationAccessChanged(false, null, '', '', refresh)
    conversations.value = sortConversations(retained)
    if (removedActive) {
      activeConversationId.value = retained[0]?.id ?? ''
      if (activeConversationId.value) void syncActiveConversation()
    }
  }

  function dispatchConversationAccessChanged(
    allowed: boolean,
    conversation?: ImConversation | null,
    peerOrganization = '',
    peerUserId = '',
    refresh = true
  ) {
    window.dispatchEvent(new CustomEvent(CONVERSATION_ACCESS_BROWSER_EVENT, {
      detail: {
        allowed,
        refresh,
        organization: conversation?.peerOrganization ?? peerOrganization,
        userId: conversation?.peerUserId ?? peerUserId
      }
    }))
  }

  function revokeCrossOrgConversation(
    conversationId: string,
    peerOrganization: string,
    peerUserId: string
  ) {
    revokedConversationIds.add(conversationId)
    const conversation = conversations.value.find(
      (item) =>
        item.conversationId === conversationId ||
        (
          item.conversationType === 'single' &&
          isSameImIdentity(
            item.peerOrganization,
            item.peerUserId,
            peerOrganization,
            peerUserId
          )
        )
    )
    if (!conversation) {
      dispatchConversationAccessChanged(
        false,
        null,
        peerOrganization,
        peerUserId
      )
      return 'missing' as const
    }
    if (
      conversation.conversationType !== 'single' ||
      normalizeImOrganization(conversation.peerOrganization) === session().organization ||
      !isSameImIdentity(
        conversation.peerOrganization,
        conversation.peerUserId,
        peerOrganization,
        peerUserId
      )
    ) {
      return 'invalid' as const
    }
    if (conversation.conversationId) {
      revokedConversationIds.add(conversation.conversationId)
    }
    clearConversationRuntime(conversation)
    conversations.value = conversations.value.filter((item) => item.id !== conversation.id)
    dispatchConversationAccessChanged(false, conversation)
    if (activeConversationId.value === conversation.id) {
      activeConversationId.value = conversations.value[0]?.id ?? ''
      if (activeConversationId.value) void syncActiveConversation()
    }
    return 'removed' as const
  }

  async function reconcileCrossOrgAccessSnapshot(
    snapshotId: string,
    preserveRevokedConversationId = '',
    _force = false,
    restoreConversationId = ''
  ): Promise<void> {
    if (snapshotId === '0') {
      failCloseCrossOrgAccess()
      return
    }
    const epoch = captureAccessEpoch()
    if (epoch.snapshotId !== snapshotId) return
    if (restoreConversationId) {
      restorableConversationIds.add(restoreConversationId)
    }
    if (
      accessSnapshotRebuild &&
      accessSnapshotRebuild.snapshotId === snapshotId &&
      accessSnapshotRebuild.epoch.epoch === epoch.epoch
    ) {
      if (accessSnapshotRebuild.full || _force) {
        return accessSnapshotRebuild.promise
      }
      const partialRebuild = accessSnapshotRebuild.promise
      return partialRebuild.then(
        () => reconcileCrossOrgAccessSnapshot(snapshotId),
        (error: unknown) => {
          if (error instanceof ConversationAccessEpochChangedError) {
            return reconcileCrossOrgAccessSnapshot(snapshotId)
          }
          throw error
        }
      )
    }
    const rebuild = (async () => {
      const fetched = await fetchConversations(
        config(),
        session(),
        { authoritativeRecovery: true }
      )
      assertConversationAccessEpochCurrent(epoch)
      if (currentAccessSnapshotId() !== snapshotId) {
        throw new ConversationAccessEpochChangedError()
      }
      const acceptedIds = new Set(reconcileRevokedConversationIds(
        revokedConversationIds,
        fetched.map((conversation) => conversation.conversationId),
        {
          preserveRevokedConversationId,
          restorableConversationIds,
          restoreAllAuthoritative: !_force
        }
      ))
      const loaded = fetched.filter((conversation) =>
        acceptedIds.has(conversation.conversationId)
      )
      for (const conversationId of acceptedIds) {
        restorableConversationIds.delete(conversationId)
      }
      const loadedById = new Map(loaded.map((conversation) => [
        conversation.conversationId,
        conversation
      ]))
      const next: ImConversation[] = []
      for (const conversation of conversations.value) {
        const replacement = loadedById.get(conversation.conversationId)
        if (replacement) {
          next.push(replacement)
          loadedById.delete(conversation.conversationId)
          continue
        }
        if (isCrossOrgSingle(conversation)) {
          clearConversationRuntime(conversation)
          dispatchConversationAccessChanged(
            false,
            conversation,
            '',
            '',
            false
          )
        } else {
          next.push(conversation)
        }
      }
      next.push(...loadedById.values())
      assertConversationAccessEpochCurrent(epoch)
      conversations.value = sortConversations(next)
      if (
        activeConversationId.value &&
        !conversations.value.some(
          (item) => item.id === activeConversationId.value
        )
      ) {
        activeConversationId.value = conversations.value[0]?.id ?? ''
        if (activeConversationId.value) await syncActiveConversation()
      }
    })().finally(() => {
      if (accessSnapshotRebuild?.promise === rebuild) {
        accessSnapshotRebuild = null
      }
    })
    accessSnapshotRebuild = {
      snapshotId,
      epoch,
      full: !_force,
      promise: rebuild
    }
    return rebuild
  }

  function handleConversationAccessChanged(current: WebSocket, packet: ImPacket) {
    const event = parseConversationAccessChanged(
      packet,
      session().organization,
      session().user.userId
    )
    if (!event) {
      failSocketAuthentication(
        current,
        'protocol:invalid-conversation-access-event',
        '跨机构会话访问变更事件协议或目标复合身份无效'
      )
      return
    }
    const observation = realtimeEventWindow().observe(event.eventId)
    if (observation === 'duplicate') return
    if (observation !== 'new') {
      failSocketAuthentication(
        current,
        'protocol:invalid-conversation-access-event',
        '跨机构会话访问变更事件幂等标识无效'
      )
      return
    }
    const snapshotObservation = observeAccessSnapshot(event.snapshotId)
    if (snapshotObservation === 'stale') return
    if (!shouldProcessAccessSnapshotEvent(snapshotObservation)) {
      failSocketAuthentication(
        current,
        'protocol:invalid-conversation-access-snapshot',
        '跨机构访问变更快照无效'
      )
      return
    }
    if (snapshotObservation === 'duplicate') {
      advanceConversationAccessEpoch(
        session().organization,
        session().user.userId
      )
    }
    if (authenticatedAccessSnapshotBehindHighWater) {
      failSocketAuthentication(
        current,
        'access-snapshot:server-caught-up',
        '跨机构访问快照已收敛，正在执行权威重建',
        true
      )
      return
    }
    if (!event.allowed) {
      restorableConversationIds.delete(event.conversationId)
      clearCrossOrgPendingControlRequests()
      const revokeResult = revokeCrossOrgConversation(
        event.conversationId,
        event.peerOrganization,
        event.peerUserId
      )
      if (revokeResult === 'invalid') {
        failSocketAuthentication(
          current,
          'protocol:invalid-conversation-access-target',
          '跨机构会话访问撤销指向了非跨机构单聊'
        )
        return
      }
      void reconcileCrossOrgAccessSnapshot(
        event.snapshotId,
        event.conversationId,
        true
      ).then(() => {
        if (
          socket === current &&
          connectionState.value === 'connected' &&
          currentAccessSnapshotId() === event.snapshotId
        ) {
          setCrossOrgAccessRecoveryRequired(false)
        }
      }).catch((error) => {
        if (
          socket !== current ||
          authenticatedConnection?.socket !== current ||
          error instanceof ConversationAccessEpochChangedError
        ) {
          return
        }
        failCloseCrossOrgAccess(false)
        logWsStatus('access-snapshot:revoke-refresh-failed', {
          snapshotId: event.snapshotId,
          error: error instanceof Error ? error.message : String(error)
        })
        failSocketAuthentication(
          current,
          'access-snapshot:revoke-refresh-failed',
          '跨机构访问撤销后的权威重建失败'
        )
        scheduleReconnect()
      })
      return
    }
    void reconcileCrossOrgAccessSnapshot(
      event.snapshotId,
      '',
      true,
      event.conversationId
    ).then(() => {
      if (
        socket === current &&
        connectionState.value === 'connected' &&
        currentAccessSnapshotId() === event.snapshotId &&
        conversations.value.some(
          (conversation) =>
            conversation.conversationId === event.conversationId
        )
      ) {
        setCrossOrgAccessRecoveryRequired(false)
        dispatchConversationAccessChanged(
          true,
          null,
          event.peerOrganization,
          event.peerUserId
        )
      }
    }).catch((error) => {
      if (
        socket !== current ||
        authenticatedConnection?.socket !== current ||
        error instanceof ConversationAccessEpochChangedError
      ) {
        return
      }
      failCloseCrossOrgAccess(false)
      logWsStatus('access-snapshot:refresh-failed', {
        snapshotId: event.snapshotId,
        error: error instanceof Error ? error.message : String(error)
      })
      failSocketAuthentication(
        current,
        'access-snapshot:refresh-failed',
        '跨机构访问授权后的权威重建失败'
      )
      scheduleReconnect()
    })
  }

  function handleConversationSyncAck(current: WebSocket, packet: ImPacket) {
    const clientMsgId = typeof packet.client_msg_id === 'string'
      ? packet.client_msg_id.trim()
      : ''
    const request = pendingConversationSyncRequests.get(clientMsgId)
    const conversation = request
      ? conversations.value.find(
          (item) => item.conversationId === request.conversationId
        )
      : null
    if (!clientMsgId || !request || !conversation || !isRecord(packet.data)) {
      failSocketAuthentication(
        current,
        'protocol:invalid-sync-ack-binding',
        '会话 SYNC_ACK 未严格绑定当前请求',
        true
      )
      return
    }
    const page = validateConversationSyncPage(
      packet.data,
      request,
      conversation
    )
    if (!page) {
      rejectConversationSyncRequest(
        clientMsgId,
        new Error('会话 SYNC_ACK 协议无效')
      )
      failSocketAuthentication(
        current,
        'protocol:invalid-sync-ack',
        '会话 SYNC_ACK 游标、消息或变更流无效',
        true
      )
      return
    }

    if (page.cross_org_access_snapshot_id !== request.snapshotId) {
      const observation = observeAccessSnapshot(
        page.cross_org_access_snapshot_id
      )
      const acceptedStaleSameOrgPage =
        authenticatedAccessSnapshotBehindHighWater &&
        !isCrossOrgSingle(conversation) &&
        isExpectedStaleGlobalSyncSnapshot(
          observation,
          page.cross_org_access_snapshot_id,
          authenticatedStaleAccessSnapshotId
        )
      if (acceptedStaleSameOrgPage) {
        page.access_snapshot_behind_high_water = true
      } else {
      rejectConversationSyncRequest(
        clientMsgId,
        new ConversationAccessEpochChangedError()
      )
      if (observation === 'invalid' || observation === 'stale') {
        failSocketAuthentication(
          current,
          'protocol:stale-sync-access-snapshot',
          '会话 SYNC_ACK 的跨机构访问快照无效或已回滚',
          true
        )
        return
      }
      if (
        authenticatedAccessSnapshotBehindHighWater &&
        shouldProcessAccessSnapshotEvent(observation)
      ) {
        failSocketAuthentication(
          current,
          'access-snapshot:server-caught-up',
          '跨机构访问快照已收敛，正在执行权威重建',
          true
        )
        return
      }
      if (observation === 'new') {
        if (page.cross_org_access_snapshot_id === '0') {
          failCloseCrossOrgAccess()
        } else {
          void reconcileCrossOrgAccessSnapshot(
            page.cross_org_access_snapshot_id
          ).then(() => {
            if (
              socket !== current ||
              authenticatedConnection?.socket !== current ||
              connectionState.value !== 'connected' ||
              currentAccessSnapshotId() !==
                page.cross_org_access_snapshot_id
            ) {
              return
            }
            setCrossOrgAccessRecoveryRequired(false)
            dispatchConversationAccessChanged(true)
          }).catch((error) => {
            if (
              socket !== current ||
              authenticatedConnection?.socket !== current ||
              error instanceof ConversationAccessEpochChangedError
            ) {
              return
            }
            failCloseCrossOrgAccess(false)
            logWsStatus('access-snapshot:sync-refresh-failed', {
              snapshotId: page.cross_org_access_snapshot_id,
              error: error instanceof Error ? error.message : String(error)
            })
            failSocketAuthentication(
              current,
              'access-snapshot:sync-refresh-failed',
              '会话同步后的跨机构访问权威重建失败'
            )
            scheduleReconnect()
          })
        }
      }
      return
      }
    }
    if (
      !isConversationAccessEpochCurrent(request.epoch) ||
      (request.snapshotId === '0' && isCrossOrgSingle(conversation))
    ) {
      rejectConversationSyncRequest(
        clientMsgId,
        new ConversationAccessEpochChangedError()
      )
      return
    }
    window.clearTimeout(request.timer)
    pendingConversationSyncRequests.delete(clientMsgId)
    request.resolve(page)
  }

  function handleGlobalSyncAck(current: WebSocket, packet: ImPacket) {
    const clientMsgId = typeof packet.client_msg_id === 'string'
      ? packet.client_msg_id.trim()
      : ''
    const request = pendingGlobalSyncRequests.get(clientMsgId)
    if (!clientMsgId || !request) return false
    const page = validateGlobalSyncPage(packet.data, {
      organization: session().organization,
      afterGlobalSeq: request.afterGlobalSeq
    })
    if (!page) {
      rejectGlobalSyncRequest(
        clientMsgId,
        new Error('全局 SYNC_ACK 协议、游标或消息流无效')
      )
      failSocketAuthentication(
        current,
        'protocol:invalid-global-sync-ack',
        '全局 SYNC_ACK 未严格绑定请求或消息流无效',
        true
      )
      return true
    }
    window.clearTimeout(request.timer)
    pendingGlobalSyncRequests.delete(clientMsgId)
    request.resolve(page)
    return true
  }

  function handleSocketMessage(current: WebSocket, event: MessageEvent<string>) {
    if (socket !== current) return
    let packet: ImPacket | null = null
    try {
      packet = JSON.parse(event.data) as ImPacket
    } catch {
      return
    }
    if (!packet) return

    handleSocketPacket(current, packet)
  }

  function handleSocketPacket(
    current: WebSocket,
    packet: ImPacket,
    authoritativeConversationStateLoaded = false
  ) {
    if (socket !== current) return

    if (packet.cmd === 'auth') {
      handleAuthChallenge(current, packet)
      return
    }
    if (packet.cmd === 'auth_ack') {
      handleAuthAck(current, packet)
      return
    }
    if (packet.cmd === 'error' && authenticatedConnection?.socket !== current) {
      const message = String(packet.data?.msg ?? 'IM 鉴权失败')
      failSocketAuthentication(current, 'auth:error-packet', message)
      return
    }
    if (authenticatedConnection?.socket !== current) {
      failSocketAuthentication(
        current,
        'auth:packet-before-ack',
        'IM 连接在 AUTH_ACK 前返回了业务数据'
      )
      return
    }
    if (packet.cmd !== 'error' && String(packet.organization ?? '') !== session().organization) {
      logWsStatus('error:organization-mismatch', { packetOrganization: packet.organization ?? null })
      failSocketAuthentication(
        current,
        'protocol:organization-mismatch',
        'IM 响应 organization 与认证会话不一致'
      )
      return
    }
    if (packet.cmd === CONVERSATION_ACCESS_CHANGED_COMMAND) {
      handleConversationAccessChanged(current, packet)
      return
    }
    if (packet.cmd === 'sync_ack') {
      if (handleGlobalSyncAck(current, packet)) return
      handleConversationSyncAck(current, packet)
      return
    }
    if (packet.cmd === 'error' && connectionState.value !== 'connected') {
      handleErrorPacket(packet)
      return
    }
    if (connectionState.value !== 'connected') {
      if (authenticatedRecoveryPackets.length >= AUTH_RECOVERY_BUFFER_LIMIT) {
        failSocketAuthentication(
          current,
          'auth-recovery:buffer-overflow',
          'IM 恢复期间实时事件超过安全上限',
          true
        )
        return
      }
      authenticatedRecoveryPackets.push(packet)
      return
    }
    if (packet.cmd === 'friend_request') {
      if (!isFriendRequestRealtimeEventPacketValid(
        packet,
        session().organization,
        session().user.userId
      )) {
        failSocketAuthentication(
          current,
          'protocol:invalid-friend-request-event',
          '好友申请实时事件协议或幂等标识无效'
        )
        return
      }
      const realtimeEventId = packet.data?.event_id
      const observation = realtimeEventWindow().observe(realtimeEventId)
      if (observation === 'duplicate') {
        logWsStatus('realtime:friend-request-duplicate-skipped', { eventId: realtimeEventId })
        return
      }
      if (observation !== 'new') {
        failSocketAuthentication(
          current,
          'protocol:invalid-friend-request-event',
          '好友申请实时事件幂等标识无效'
        )
        return
      }
    }
    if (isCanonicalRealtimeCommand(packet.cmd)) {
      // Canonical Rabbit events are state-changing broadcasts. Missing or
      // malformed event ids and schemas fail closed before any local mutation;
      // ack_ack/SYNC and other point-to-point responses stay outside this gate.
      const canonicalConversation =
        packet.cmd === 'conversation_read' || packet.cmd === 'ack'
        ? conversations.value.find(
            (item) =>
              item.conversationId ===
                String(packet.data?.conversation_id ?? '').trim()
          ) ?? null
        : null
      const canonicalReceiptMessage = packet.cmd === 'ack' && canonicalConversation
        ? (messages.value[canonicalConversation.id] ?? []).find(
            (item) =>
              item.messageId === String(packet.data?.message_id ?? '').trim()
          ) ?? null
        : null
      if (!isCanonicalRealtimeEventPacketValid(
        packet,
        session().organization,
        session().user.userId,
        {
          conversation: canonicalConversation,
          message: canonicalReceiptMessage
            ? {
                conversationId: canonicalConversation!.conversationId,
                messageId: String(canonicalReceiptMessage.messageId ?? '').trim(),
                messageSeq: Number(canonicalReceiptMessage.messageSeq ?? 0),
                senderOrganization: canonicalReceiptMessage.senderOrganization,
                senderUserId: canonicalReceiptMessage.senderUserId,
                side: canonicalReceiptMessage.side
              }
            : null,
          currentAccessSnapshotId: currentAccessSnapshotId()
        }
      )) {
        failSocketAuthentication(
          current,
          'protocol:invalid-event-id',
          'IM 实时事件协议或幂等标识无效'
        )
        return
      }
      const realtimeEventId = packet.data?.event_id
      const observation = realtimeEventWindow().observe(realtimeEventId)
      if (observation === 'duplicate') {
        logWsStatus('realtime:duplicate-skipped', { eventId: realtimeEventId })
        return
      }
      if (observation !== 'new') {
        failSocketAuthentication(
          current,
          'protocol:invalid-event-id',
          'IM 实时事件幂等标识无效'
        )
        return
      }
    }
    if (packet.cmd === 'send_ack') {
      const message = packet.data?.message as ImPacketMessage | undefined
      const clientMsgId = String(packet.client_msg_id ?? '').trim()
      const pending = pendingControlRequests.get(clientMsgId)
      const completed = completedControlRequests.get(clientMsgId)
      const expected = pending ?? completed
      if (
        !expected ||
        expected.command !== 'send' ||
        !isControlAckResponseValid(
          packet,
          expected,
          session().organization,
          session().user.userId
        )
      ) {
        failSocketAuthentication(
          current,
          'protocol:invalid-send-ack',
          'SEND_ACK 未绑定当前发送请求或消息元数据不一致'
        )
        return
      }
      if (completed) return
      finishSendTrace(clientMsgId)
      if (!message || !upsertIncomingMessage(message, 'send_ack', expected)) {
        failSocketAuthentication(
          current,
          'protocol:invalid-send-ack-message',
          'SEND_ACK 消息发送者不属于当前会话'
        )
        return
      }
      completePendingControlRequest(clientMsgId)
      return
    }
    if (packet.cmd === 'push') {
      const message = packet.data?.message as ImPacketMessage | undefined
      if (message && !upsertIncomingMessage(
        message,
        'push',
        undefined,
        true,
        authoritativeConversationStateLoaded
      )) {
        failSocketAuthentication(
          current,
          'protocol:invalid-push-sender',
          'PUSH 消息发送者不属于当前会话'
        )
      }
      return
    }
    if (packet.cmd === 'typing') {
      if (!applyTypingEvent(packet.data ?? {})) {
        failSocketAuthentication(
          current,
          'protocol:invalid-typing-event',
          'IM 输入状态复合身份无效'
        )
      }
      return
    }
    if (packet.cmd === 'ack') {
      if (!applyReceiptEvent(packet.data ?? {})) {
        failSocketAuthentication(
          current,
          'protocol:invalid-receipt-event',
          'IM 回执复合身份或状态无效'
        )
      }
      return
    }
    if (packet.cmd === 'conversation_read') {
      if (!applyConversationReadEvent(packet.data ?? {})) {
        failSocketAuthentication(
          current,
          'protocol:invalid-conversation-read-event',
          'IM 会话已读复合身份或游标无效'
        )
      }
      return
    }
    if (packet.cmd === 'ack_ack' || packet.cmd === 'conversation_read_ack') {
      const clientMsgId = String(packet.client_msg_id ?? '').trim()
      const pending = pendingControlRequests.get(clientMsgId)
      const completed = completedControlRequests.get(clientMsgId)
      const expected = pending ?? completed
      if (!expected || !isControlAckResponseValid(
        packet,
        expected,
        session().organization,
        session().user.userId
      )) {
        failSocketAuthentication(
          current,
          'protocol:invalid-control-ack',
          'IM 控制回执未绑定当前请求或复合身份无效'
        )
        return
      }
      if (!completed) completePendingControlRequest(clientMsgId)
      return
    }
    if (packet.cmd === 'friend_request') {
      handleFriendRequestEvent(packet.data ?? {})
      return
    }
    if (
      packet.cmd === 'recall_ack' ||
      packet.cmd === 'edit_ack' ||
      packet.cmd === 'delete_ack' ||
      packet.cmd === 'screenshot_ack'
    ) {
      const clientMsgId = String(packet.client_msg_id ?? '').trim()
      const pending = pendingControlRequests.get(clientMsgId)
      const completed = completedControlRequests.get(clientMsgId)
      const expected = pending ?? completed
      if (
        !expected ||
        !isControlAckResponseValid(
          packet,
          expected,
          session().organization,
          session().user.userId
        )
      ) {
        failSocketAuthentication(
          current,
          'protocol:invalid-mutation-ack',
          'IM 变更确认未绑定当前请求或确认元数据不一致'
        )
        return
      }
      if (completed) return
      const applied = expected.command === 'screenshot'
        ? applyScreenshotAck(expected, packet.data ?? {})
        : applyMutationAck(expected, packet.data ?? {})
      if (!applied) {
        failSocketAuthentication(
          current,
          'protocol:invalid-mutation-ack-state',
          'IM 变更确认与本机原消息或系统提示不一致'
        )
        return
      }
      completePendingControlRequest(clientMsgId)
      return
    }
    if (packet.cmd === 'recall' || packet.cmd === 'edit' || packet.cmd === 'delete') {
      if (!applyDurableMutation(packet.cmd, packet.data ?? {})) {
        failSocketAuthentication(
          current,
          'protocol:invalid-mutation-event',
          'IM 持久变更的参与者、原消息或变更序列无效'
        )
      }
      return
    }
    if (packet.cmd === 'screenshot') {
      const data = packet.data ?? {}
      const conversationId = String(data.conversation_id ?? '').trim()
      const conversation = conversations.value.find(
        (item) => item.conversationId === conversationId
      )
      if (!conversation || !isConversationParticipantIdentity(
        data.actor_organization,
        data.actor_user_id,
        session().organization,
        session().user.userId,
        conversation
      )) {
        failSocketAuthentication(
          current,
          'protocol:invalid-screenshot-event',
          '截屏通知参与者复合身份无效'
        )
        return
      }
      const noticeMessage = packet.data?.notice_message as ImPacketMessage | undefined
      if (noticeMessage && (
        noticeMessage.conversation_id !== conversationId ||
        normalizeImOrganization(noticeMessage.organization) !== session().organization ||
        !isMessageValidForConversation(
          noticeMessage as unknown as Record<string, unknown>,
          session().organization,
          session().user.userId,
          conversation
        ) ||
        !isSameImIdentity(
          noticeMessage.content?.actor_organization,
          noticeMessage.content?.actor_user_id,
          data.actor_organization,
          data.actor_user_id
        )
      )) {
        failSocketAuthentication(
          current,
          'protocol:invalid-screenshot-notice',
          '截屏系统提示发送者或 actor 复合身份无效'
        )
        return
      }
      if (noticeMessage) {
        applyNoticeMessage(noticeMessage, packet.data ?? {})
      }
      return
    }
    if (packet.cmd === 'error') {
      handleErrorPacket(packet)
    }
  }

  async function recoverAuthenticatedConnection(
    current: WebSocket,
    recoverySequence: number,
    staleServerSnapshotId = ''
  ) {
    const cachedConversationIds = new Set(
      conversations.value
        .filter((conversation) =>
          !isCrossOrgSingle(conversation) &&
          (messages.value[conversation.id] ?? []).length > 0
        )
        .map((conversation) => conversation.conversationId)
    )
    failCloseCrossOrgAccess(false)
    for (let attempt = 0; attempt < GLOBAL_SYNC_MAX_RESTARTS; attempt += 1) {
      const attemptEpoch = captureAccessEpoch()
      try {
        const batch = await collectStableGlobalSync(
          current,
          staleServerSnapshotId
        )
        if (
          socket !== current ||
          authenticatedConnection?.socket !== current ||
          recoverySequence !== authenticatedRecoverySequence
        ) return
        if (batch.accessSnapshotBehindHighWater) {
          authenticatedStaleAccessSnapshotId = batch.accessSnapshotId
        }
        if (batch.accessSnapshotBehindHighWater) {
          setCrossOrgAccessRecoveryRequired(true)
          await loadConversations()
        } else if (batch.accessSnapshotId === '0') {
          failCloseCrossOrgAccess(false)
          await loadConversations()
        } else {
          await reconcileCrossOrgAccessSnapshot(batch.accessSnapshotId)
        }
        assertConversationAccessEpochCurrent(batch.epoch)
        const recoveredMessages = applyGlobalSyncMessages(batch)
        await syncCachedConversationGaps(cachedConversationIds)
        assertConversationAccessEpochCurrent(batch.epoch)
        if (
          socket !== current ||
          authenticatedConnection?.socket !== current ||
          recoverySequence !== authenticatedRecoverySequence
        ) return
        setCrossOrgAccessRecoveryRequired(
          batch.accessSnapshotBehindHighWater ||
          batch.accessSnapshotId === '0'
        )
        authenticatedAccessSnapshotBehindHighWater =
          batch.accessSnapshotBehindHighWater
        authenticatedStaleAccessSnapshotId =
          batch.accessSnapshotBehindHighWater
            ? batch.accessSnapshotId
            : ''
        const recoveredMessageIds = new Set(
          recoveredMessages.map((message) => message.message_id)
        )
        const bufferedPackets = authenticatedRecoveryPackets
        authenticatedRecoveryPackets = []
        connectionState.value = 'connected'
        const recoveredAckPromises: Promise<void>[] = []
        for (const message of recoveredMessages) {
          if (isSameImIdentity(
            message.sender_organization,
            message.sender_id,
            session().organization,
            session().user.userId
          )) {
            continue
          }
          const conversation = conversations.value.find(
            (item) => item.conversationId === message.conversation_id
          )
          if (!conversation) continue
          recoveredAckPromises.push(
            acknowledgeRecoveredIncomingMessage(message, conversation)
          )
        }
        await Promise.all(recoveredAckPromises)
        assertConversationAccessEpochCurrent(batch.epoch)
        for (const bufferedPacket of bufferedPackets) {
          const bufferedMessage = bufferedPacket.cmd === 'push'
            ? bufferedPacket.data?.message as ImPacketMessage | undefined
            : undefined
          const bufferedConversation = bufferedMessage
            ? conversations.value.find(
                (item) =>
                  item.conversationId === bufferedMessage.conversation_id
              )
            : undefined
          const bufferedMessageCovered = Boolean(
            bufferedMessage?.message_id &&
            (
              recoveredMessageIds.has(bufferedMessage.message_id) ||
              revokedConversationIds.has(bufferedMessage.conversation_id) ||
              (
                bufferedConversation &&
                (messageCursors.get(bufferedConversation.id) ?? 0) >=
                  Number(bufferedMessage.message_seq ?? 0)
              )
            )
          )
          if (
            bufferedMessage &&
            bufferedMessageCovered
          ) {
            if (!isCanonicalRealtimeEventPacketValid(
              bufferedPacket,
              session().organization,
              session().user.userId
            )) {
              failSocketAuthentication(
                current,
                'protocol:invalid-recovered-push',
                '恢复期间收到的 PUSH 协议或幂等标识无效'
              )
              scheduleReconnect()
              return
            }
            const observation = realtimeEventWindow().observe(
              bufferedPacket.data?.event_id
            )
            if (observation !== 'new' && observation !== 'duplicate') {
              failSocketAuthentication(
                current,
                'protocol:invalid-recovered-push-event-id',
                '恢复期间收到的 PUSH 幂等标识无效'
              )
              scheduleReconnect()
              return
            }
            if (
              !recoveredMessageIds.has(bufferedMessage.message_id) &&
              bufferedConversation &&
              !revokedConversationIds.has(bufferedMessage.conversation_id) &&
              canRecoverGlobalSyncConversation(
                batch.accessSnapshotBehindHighWater ||
                  batch.accessSnapshotId === '0',
                session().organization,
                bufferedConversation
              )
            ) {
              if (!isMessageValidForConversation(
                bufferedMessage as unknown as Record<string, unknown>,
                session().organization,
                session().user.userId,
                bufferedConversation
              )) {
                failSocketAuthentication(
                  current,
                  'protocol:invalid-recovered-push-context',
                  '恢复期间收到的 PUSH 会话归属或复合身份无效',
                  true
                )
                return
              }
              await acknowledgeRecoveredIncomingMessage(
                bufferedMessage,
                bufferedConversation
              )
            }
            continue
          }
          handleSocketPacket(
            current,
            bufferedPacket,
            Boolean(
              bufferedMessage &&
              bufferedConversation &&
              Number(bufferedConversation.lastMessageSeq ?? 0) >=
                Number(bufferedMessage.message_seq ?? 0)
            )
          )
          if (
            socket !== current ||
            authenticatedConnection?.socket !== current ||
            recoverySequence !== authenticatedRecoverySequence
          ) {
            scheduleReconnect()
            return
          }
        }
        if (!batch.accessSnapshotBehindHighWater) {
          const cursorCommitted = await commitGlobalSyncRecoveryCursor(
            syncCursorStore(),
            batch.nextCursor,
            async () => {
              assertConversationAccessEpochCurrent(batch.epoch)
              return socket === current &&
                authenticatedConnection?.socket === current &&
                recoverySequence === authenticatedRecoverySequence
            }
          )
          if (!cursorCommitted) return
        }
        startPing()
        dispatchConversationAccessChanged(
          !batch.accessSnapshotBehindHighWater &&
          batch.accessSnapshotId !== '0'
        )
        logWsStatus('connected:recovery-complete', {
          previousGlobalSeq: batch.previousCursor,
          nextGlobalSeq: batch.nextCursor,
          recoveredMessages: batch.messages.length,
          accessSnapshotId: batch.accessSnapshotId,
          accessSnapshotBehindHighWater:
            batch.accessSnapshotBehindHighWater
        })
        return
      } catch (error) {
        if (
          socket === current &&
          authenticatedConnection?.socket === current &&
          recoverySequence === authenticatedRecoverySequence &&
          (
            error instanceof ConversationAccessEpochChangedError ||
            !isConversationAccessEpochCurrent(attemptEpoch)
          )
        ) {
          failCloseCrossOrgAccess(false)
          continue
        }
        throw error
      }
    }
    throw new Error('AUTH 恢复期间访问快照持续变化')
  }

  function handleAuthAck(current: WebSocket, packet: ImPacket) {
    const challenge = pendingAuthChallenge
    const data = packet.data ?? {}
    const clientId = typeof data.client_id === 'string' ? data.client_id.trim() : ''
    const deviceId = typeof data.device_id === 'string' ? data.device_id.trim() : ''
    const credentialSessionId =
      typeof data.credential_session_id === 'string' ? data.credential_session_id.trim() : ''
    const sessionId = typeof data.session_id === 'string' ? data.session_id.trim() : ''
    const accessSnapshotId = normalizeAccessSnapshotId(
      data.cross_org_access_snapshot_id
    )
    const valid = Boolean(
      challenge &&
        challenge.socket === current &&
        challenge.authSent &&
        socket === current &&
        current.readyState === WebSocket.OPEN &&
        data.ok === true &&
        String(packet.organization ?? '') === session().organization &&
        clientId === challenge.clientId &&
        deviceId === challenge.deviceId &&
        credentialSessionId !== '' &&
        credentialSessionId === challenge.credentialSessionId &&
        sessionId !== '' &&
        accessSnapshotId !== ''
    )
    if (!valid || !challenge) {
      challenge?.traceSpan?.fail({
        code: 'IM_AUTH_ACK_REJECTED',
        type: 'protocol_error'
      })
      logWsStatus('auth-ack:invalid', {
        packetOrganization: packet.organization ?? null,
        hasClientId: clientId !== '',
        challengeHasClientId: Boolean(challenge?.clientId),
        hasCredentialSessionId: credentialSessionId !== '',
        hasSessionId: sessionId !== ''
      })
      failSocketAuthentication(
        current,
        'auth-ack:rejected',
        'IM AUTH_ACK 与当前机构、设备或连接 challenge 不一致'
      )
      return
    }
    const accessSnapshotObservation = observeAccessSnapshot(accessSnapshotId)
    const accessSnapshotDecision = classifyAuthAccessSnapshot(
      accessSnapshotObservation,
      accessSnapshotId,
      currentAccessSnapshotId()
    )
    if (accessSnapshotDecision === 'invalid') {
      challenge.traceSpan?.fail({
        code: 'IM_AUTH_ACCESS_SNAPSHOT_INVALID',
        type: 'protocol_error'
      })
      failSocketAuthentication(
        current,
        'auth-ack:invalid-access-snapshot',
        'IM AUTH_ACK 的跨机构访问快照无效',
        true
      )
      return
    }
    const accessSnapshotBehindHighWater =
      accessSnapshotDecision === 'behind_high_water'
    setCrossOrgAccessRecoveryRequired(true)
    authenticatedConnection = {
      socket: current,
      clientId,
      deviceId,
      credentialSessionId,
      sessionId
    }
    authenticatedAccessSnapshotBehindHighWater =
      accessSnapshotBehindHighWater
    authenticatedStaleAccessSnapshotId =
      accessSnapshotBehindHighWater ? accessSnapshotId : ''
    pendingAuthChallenge = null
    challenge.traceSpan?.end()
    logWsStatus('authenticated:recovering', {
      hasClientId: true,
      hasSessionId: true,
      accessSnapshotBehindHighWater
    })
    authenticatedRecoveryPackets = []
    const recoverySequence = ++authenticatedRecoverySequence
    void recoverAuthenticatedConnection(
      current,
      recoverySequence,
      accessSnapshotBehindHighWater ? accessSnapshotId : ''
    ).catch((error) => {
      if (
        socket !== current ||
        authenticatedConnection?.socket !== current ||
        recoverySequence !== authenticatedRecoverySequence
      ) return
      failCloseCrossOrgAccess(false)
      logWsStatus('auth-recovery:failed', {
        snapshotId: accessSnapshotId,
        error: error instanceof Error ? error.message : String(error)
      })
      failSocketAuthentication(
        current,
        'auth-recovery:failed',
        error instanceof Error ? error.message : 'IM 重连同步失败'
      )
      scheduleReconnect()
    })
  }

  function handleErrorPacket(packet: ImPacket) {
    const message = String(packet.data?.msg ?? 'IM服务错误')
    const code = String(packet.data?.code ?? '')
    const clientMsgId = String(packet.client_msg_id ?? '').trim()
    if (clientMsgId !== '') {
      if (pendingGlobalSyncRequests.has(clientMsgId)) {
        rejectGlobalSyncRequest(clientMsgId, new Error(message))
        layer.error(message)
        return
      }
      if (pendingConversationSyncRequests.has(clientMsgId)) {
        rejectConversationSyncRequest(
          clientMsgId,
          new Error(message)
        )
        layer.error(message)
        return
      }
      if (completedControlRequests.has(clientMsgId)) return
      resolvePendingControlRequest(clientMsgId)
      rejectAuthoritativeControlAck(
        clientMsgId,
        new Error(message)
      )
      finishSendTrace(clientMsgId, code || 'IM_COMMAND_ERROR')
      markLocalMessageFailed(clientMsgId)
    }
    if (code === 'CONVERSATION_MEMBER_MUTED') {
      layer.warning(message)
      return
    }
    layer.error(message)
  }

  function handleFriendRequestEvent(data: Record<string, any>) {
    if (data.event !== 'created') {
      return
    }

    onFriendRequestEvent?.({
      event: 'created',
      requestId: Number(data.request_id ?? 0),
      pendingCount: Number(data.pending_count ?? 0),
      fromUser: data.from_user ? mapWebImUser(data.from_user) : null,
      message: String(data.message ?? ''),
      createTime: String(data.create_time ?? '')
    })
  }

  function applyTypingEvent(data: Record<string, any>) {
    const conversationId = String(data.conversation_id ?? '').trim()
    const actorOrganization = normalizeImOrganization(data.actor_organization)
    const actorUserId = String(data.actor_user_id ?? '').trim()
    const conversation = conversations.value.find(
      (item) => item.conversationId === conversationId
    )
    if (!conversation || !actorOrganization || !actorUserId ||
      isSameImIdentity(actorOrganization, actorUserId,
        session().organization, session().user.userId)) return false
    if (!isConversationParticipantIdentity(
      actorOrganization,
      actorUserId,
      session().organization,
      session().user.userId,
      conversation
    )) return false

    const username = String(data.username ?? '').trim() || '对方'
    typingByConversation.value = {
      ...typingByConversation.value,
      [conversationId]: `${username}正在输入…`
    }
    window.clearTimeout(typingTimers.get(conversationId) ?? 0)
    typingTimers.set(conversationId, window.setTimeout(() => {
      const next = { ...typingByConversation.value }
      delete next[conversationId]
      typingByConversation.value = next
      typingTimers.delete(conversationId)
    }, 3000))
    return true
  }

  function sendMessageReceipt(
    message: {
      conversationId: string
      messageId: string
      messageSeq: number
      senderOrganization: unknown
      senderUserId: unknown
    },
    status: 'delivered' | 'read'
  ) {
    const clientMsgId = createClientMsgId()
    registerPendingControlRequest({
      command: 'ack',
      clientMsgId,
      conversationId: message.conversationId,
      messageId: message.messageId,
      messageSeq: message.messageSeq,
      status,
      senderOrganization: normalizeImOrganization(message.senderOrganization),
      senderUserId: String(message.senderUserId ?? '').trim()
    })
    if (!sendPacket({
      cmd: 'ack',
      client_msg_id: clientMsgId,
      data: { message_id: message.messageId, status }
    })) {
      resolvePendingControlRequest(clientMsgId)
      return ''
    }
    return clientMsgId
  }

  function sendConversationReadReceipt(
    conversationId: string,
    messageId: string,
    messageSeq: number
  ) {
    const clientMsgId = createClientMsgId()
    registerPendingControlRequest({
      command: 'conversation_read',
      clientMsgId,
      conversationId,
      messageId,
      messageSeq
    })
    if (!sendPacket({
      cmd: 'conversation_read',
      client_msg_id: clientMsgId,
      data: { conversation_id: conversationId, last_read_message_id: messageId }
    })) {
      resolvePendingControlRequest(clientMsgId)
      return ''
    }
    return clientMsgId
  }

  async function acknowledgeRecoveredIncomingMessage(
    message: ImPacketMessage,
    conversation: ImConversation
  ) {
    if (
      isSameImIdentity(
        message.sender_organization,
        message.sender_id,
        session().organization,
        session().user.userId
      ) ||
      !(messages.value[conversation.id] ?? []).some(
        (localMessage) => localMessage.messageId === message.message_id
      )
    ) {
      return
    }
    const activeVisible = isActiveConversationVisible(conversation.id)
    const receiptClientMsgId = sendMessageReceipt({
      conversationId: message.conversation_id,
      messageId: message.message_id,
      messageSeq: Number(message.message_seq ?? 0),
      senderOrganization: message.sender_organization,
      senderUserId: message.sender_id
    }, activeVisible ? 'read' : 'delivered')
    if (!receiptClientMsgId) {
      throw new Error('恢复消息回执未能加入 WebSocket 发送队列')
    }
    await waitForAuthoritativeControlAck(receiptClientMsgId)
    if (activeVisible) {
      setConversationReadLocal(conversation.id)
      const readClientMsgId = sendConversationReadReceipt(
        message.conversation_id,
        message.message_id,
        Number(message.message_seq ?? 0)
      )
      if (!readClientMsgId) {
        throw new Error('恢复会话已读回执未能加入 WebSocket 发送队列')
      }
      await waitForAuthoritativeControlAck(readClientMsgId)
    }
  }

  function upsertIncomingMessage(
    message: ImPacketMessage,
    source: 'send_ack' | 'push',
    expectedSend?: PendingImControlRequest,
    allowAuthoritativeReload = true,
    authoritativeConversationStateLoaded = false
  ) {
    if (revokedConversationIds.has(message.conversation_id)) return true
    if (
      source === 'push' &&
      isCrossOrgAccessFailClosed() &&
      Number(message.conversation_type ?? 0) === 1 &&
      normalizeImOrganization(message.sender_organization) !==
        session().organization
    ) {
      return true
    }
    let conversation: ImConversation | null | undefined = conversations.value.find(
      (item) => item.conversationId === message.conversation_id
    )
    if (!conversation) {
      const virtualConversation = source === 'send_ack'
        ? conversations.value.find((item) =>
            item.virtual &&
            isSameImIdentity(
              item.peerOrganization,
              item.peerUserId,
              expectedSend?.peerOrganization,
              expectedSend?.peerUserId
            ) &&
            (messages.value[item.id] ?? []).some(
              (localMessage) => localMessage.id === message.client_msg_id
            )
          )
        : activeConversation.value?.virtual
          ? activeConversation.value
          : null
      conversation = virtualConversation
      if (conversation) {
        const fromVirtualPeer = isSameImIdentity(
          message.sender_organization,
          message.sender_id,
          conversation.peerOrganization,
          conversation.peerUserId
        )
        const currentIdentity = isSameImIdentity(
          message.sender_organization,
          message.sender_id,
          session().organization,
          session().user.userId
        )
        const matchesPendingSend =
          source === 'send_ack' &&
          currentIdentity &&
          (messages.value[conversation.id] ?? []).some(
            (item) => item.id === message.client_msg_id
          )
        if (!fromVirtualPeer && !matchesPendingSend) {
          void loadConversations()
          return false
        }
        const virtualId = conversation.id
        const materialized = {
          ...conversation,
          conversationId: message.conversation_id,
          id: message.conversation_id,
          virtual: false
        }
        conversations.value = conversations.value.map((item) =>
          item.id === virtualId ? materialized : item
        )
        messages.value[message.conversation_id] = messages.value[virtualId] ?? []
        delete messages.value[virtualId]
        messageCursors.set(message.conversation_id, messageCursors.get(virtualId) ?? 0)
        messageBeforeCursors.set(message.conversation_id, messageBeforeCursors.get(virtualId) ?? 0)
        messageHasMoreBefore.set(message.conversation_id, messageHasMoreBefore.get(virtualId) ?? false)
        messageCursors.delete(virtualId)
        messageBeforeCursors.delete(virtualId)
        messageHasMoreBefore.delete(virtualId)
        if (activeConversationId.value === virtualId) {
          activeConversationId.value = message.conversation_id
        }
        conversation = materialized
      }
    }
    if (!conversation) {
      if (!allowAuthoritativeReload) return false
      const epoch = captureAccessEpoch()
      const sourceSocket = socket
      void loadConversations().then(() => {
        assertConversationAccessEpochCurrent(epoch)
        if (
          !sourceSocket ||
          socket !== sourceSocket ||
          authenticatedConnection?.socket !== sourceSocket ||
          revokedConversationIds.has(message.conversation_id)
        ) {
          return
        }
        if (!upsertIncomingMessage(
          message,
          source,
          expectedSend,
          false,
          true
        )) {
          throw new Error('权威会话列表未包含 PUSH/SEND_ACK 对应会话')
        }
      }).catch((error) => {
        if (
          error instanceof ConversationAccessEpochChangedError ||
          !isConversationAccessEpochCurrent(epoch)
        ) {
          return
        }
        logWsStatus('message:authoritative-conversation-refresh-failed', {
          conversationId: message.conversation_id,
          messageId: message.message_id,
          error: error instanceof Error ? error.message : String(error)
        })
        if (sourceSocket && socket === sourceSocket) {
          failCloseCrossOrgAccess(false)
          failSocketAuthentication(
            sourceSocket,
            'message:authoritative-conversation-refresh-failed',
            '新消息对应会话的权威刷新失败，正在重新连接'
          )
          scheduleReconnect()
        }
      })
      return true
    }
    if (!isMessageValidForConversation(
      message as unknown as Record<string, unknown>,
      session().organization,
      session().user.userId,
      conversation
    )) {
      return false
    }

    const isIncoming = !isSameImIdentity(
      message.sender_organization,
      message.sender_id,
      session().organization,
      session().user.userId
    )
    const activeVisible = isActiveConversationVisible(conversation.id)
    const shouldCountUnread = isIncoming && !activeVisible &&
      !authoritativeConversationStateLoaded
    const shouldShowNotice = isIncoming && !activeVisible &&
      !conversation.isMuted
    appendPacketMessage(
      conversation,
      message,
      source === 'send_ack' ? message.client_msg_id : ''
    )
    messageCursors.set(
      conversation.id,
      Math.max(messageCursors.get(conversation.id) ?? 0, Number(message.message_seq ?? 0))
    )
    const preview = messageText(
      message, session().organization, session().user.userId, conversation.conversationType
    )
    updateConversationPreview(conversation.id, preview, formatImTime(message.create_time), shouldCountUnread ? 1 : 0, message.create_time)
    if (isIncoming) {
      const receiptStatus = activeVisible ? 'read' : 'delivered'
      sendMessageReceipt({
        conversationId: message.conversation_id,
        messageId: message.message_id,
        messageSeq: Number(message.message_seq ?? 0),
        senderOrganization: message.sender_organization,
        senderUserId: message.sender_id
      }, receiptStatus)
      if (activeVisible) {
        sendConversationReadReceipt(
          message.conversation_id,
          message.message_id,
          Number(message.message_seq ?? 0)
        )
      }
      notifyIncomingMessage(conversation.title, preview, shouldShowNotice)
      if (shouldShowNotice) {
        notifyTitleIncomingMessage(conversation.title, preview)
      }
    }
    void nextTick().then(scrollMessagesToBottom)
    return true
  }

  function advanceMessageDelivery(
    conversationId: string,
    messageId: string,
    status: 'delivered' | 'read'
  ) {
    const conversation = conversations.value.find(
      (item) => item.conversationId === conversationId
    )
    if (!conversation) return
    const target = (messages.value[conversation.id] ?? []).find(
      (message) => message.messageId === messageId
    )
    if (!target || target.side !== 'out') return
    const current = target.state
    const currentRank =
      current === 'sent' || current === 'delivered' || current === 'read'
        ? DELIVERY_STATE_RANK[current]
        : 0
    if (DELIVERY_STATE_RANK[status] <= currentRank) return
    updateLocalMessage(conversation.id, target.id, { state: status })
  }

  function applyReceiptEvent(data: Record<string, any>) {
    const messageId = String(data.message_id ?? '').trim()
    const conversationId = String(data.conversation_id ?? '').trim()
    const conversation = conversations.value.find(
      (item) => item.conversationId === conversationId
    )
    if (!conversation) return false
    const target = (messages.value[conversation.id] ?? []).find(
      (message) => message.messageId === messageId
    )
    if (!target) return false
    const direction = classifyReceiptEventDirection(
      data,
      session().organization,
      session().user.userId,
      conversation,
      {
        conversationId,
        messageId,
        messageSeq: Number(target.messageSeq ?? 0),
        senderOrganization: target.senderOrganization,
        senderUserId: target.senderUserId,
        side: target.side
      }
    )
    if (direction === 'invalid') return false
    if (
      Number(target.messageSeq ?? 0) !== Number(data.message_seq ?? 0) ||
      !isSameImIdentity(
        target.senderOrganization,
        target.senderUserId,
        data.sender_organization,
        data.sender_id
      )
    ) return false
    if (direction === 'peer_reads_current') {
      if (target.side !== 'out') return false
      advanceMessageDelivery(conversationId, messageId, data.status)
    } else if (direction === 'current_reads_peer') {
      if (target.side !== 'in' && target.side !== 'system') return false
      if (data.status === 'read') {
        const cursorKey = mutationCursorKey(conversationId)
        const messageSeq = Number(data.message_seq ?? 0)
        if (messageSeq > (conversationReadCursors.get(cursorKey) ?? 0)) {
          conversationReadCursors.set(cursorKey, messageSeq)
          setConversationReadLocal(conversation.id)
        }
      }
    } else if (
      isSameImIdentity(
        data.user_organization,
        data.user_id,
        session().organization,
        session().user.userId
      ) &&
      data.status === 'read'
    ) {
      const cursorKey = mutationCursorKey(conversationId)
      const messageSeq = Number(data.message_seq ?? 0)
      if (messageSeq > (conversationReadCursors.get(cursorKey) ?? 0)) {
        conversationReadCursors.set(cursorKey, messageSeq)
        setConversationReadLocal(conversation.id)
      }
    }
    return true
  }

  function applyConversationReadEvent(data: Record<string, any>) {
    const conversationId = String(data.conversation_id ?? '').trim()
    const lastReadSeq = Number(data.last_read_seq ?? 0)
    const conversation = conversations.value.find(
      (item) => item.conversationId === conversationId
    )
    if (!conversation) return false
    const direction = classifyConversationReadEventDirection(
      data,
      session().organization,
      session().user.userId,
      conversation
    )
    if (direction === 'invalid') return false
    const lastReadMessageId = String(data.last_read_message_id ?? '').trim()
    if (lastReadMessageId) {
      const knownLastReadMessage = (messages.value[conversation.id] ?? []).find(
        (message) => message.messageId === lastReadMessageId
      )
      if (
        knownLastReadMessage &&
        Number(knownLastReadMessage.messageSeq ?? 0) !== lastReadSeq
      ) return false
    }
    if (
      direction === 'current_reads_peer' ||
      (
        direction === 'group_member' &&
        isSameImIdentity(
          data.user_organization,
          data.user_id,
          session().organization,
          session().user.userId
        )
      )
    ) {
      const cursorKey = mutationCursorKey(conversationId)
      if (lastReadSeq > (conversationReadCursors.get(cursorKey) ?? 0)) {
        conversationReadCursors.set(cursorKey, lastReadSeq)
        setConversationReadLocal(conversation.id)
      }
      return true
    }
    if (direction === 'group_member') return true
    for (const message of messages.value[conversation.id] ?? []) {
      if (
        message.side === 'out' &&
        Number(message.messageSeq ?? 0) > 0 &&
        Number(message.messageSeq ?? 0) <= lastReadSeq
      ) {
        advanceMessageDelivery(conversationId, String(message.messageId ?? ''), 'read')
      }
    }
    return true
  }

  function removeRecalledMessage(conversationId: string, messageId: string) {
    removeDeletedMessage(conversationId, messageId, {})
  }

  function removeDeletedMessage(conversationId: string, messageId: string, data: Record<string, any>) {
    const conversation = conversations.value.find((item) => item.conversationId === conversationId)
    if (!conversation) return
    const list = messages.value[conversation.id] ?? []
    messages.value = {
      ...messages.value,
      [conversation.id]: list.filter((message) => message.messageId !== messageId)
    }
    const lastMessageId = String(data.last_message_id ?? '')
    if (lastMessageId !== '') {
      updateConversationPreview(
        conversation.id,
        String(data.last_message_summary ?? conversation.preview),
        formatImTime(String(data.last_message_time ?? '')),
        0,
        String(data.last_message_time ?? '')
      )
    }
  }

  function applyEditedMessage(packetMessage: ImPacketMessage, data: Record<string, any>) {
    const conversation = conversations.value.find((item) => item.conversationId === packetMessage.conversation_id)
    if (!conversation) return

    appendPacketMessage(conversation, packetMessage)
    if (String(data.last_message_id ?? '') === packetMessage.message_id) {
      updateConversationPreview(
        conversation.id,
        String(data.last_message_summary ?? messageText(packetMessage)),
        formatImTime(String(data.last_message_time ?? packetMessage.create_time)),
        0,
        String(data.last_message_time ?? packetMessage.create_time)
      )
    }
  }

  function applyNoticeMessage(packetMessage: ImPacketMessage, data: Record<string, any>) {
    const conversation = conversations.value.find((item) => item.conversationId === packetMessage.conversation_id)
    if (!conversation) return

    appendPacketMessage(conversation, packetMessage)
    if (String(data.last_message_id ?? packetMessage.message_id) === packetMessage.message_id) {
      updateConversationPreview(
        conversation.id,
        messageText(
          packetMessage,
          session().organization,
          session().user.userId,
          conversation.conversationType
        ),
        formatImTime(String(data.last_message_time ?? packetMessage.create_time)),
        0,
        String(data.last_message_time ?? packetMessage.create_time)
      )
    }
  }

  function mergeMessages(conversation: ImConversation, packetMessages: ImPacketMessage[]) {
    const mappedMessages = packetMessages.map((message) =>
      mapPacketMessage(message, session(), conversation)
    )
    mappedMessages.forEach((message) => appendMessage(conversation.id, message))
  }

  function appendPacketMessage(
    conversation: ImConversation,
    packetMessage: ImPacketMessage,
    optimisticClientMsgId = ''
  ) {
    const mapped = mapPacketMessage(packetMessage, session(), conversation)
    if (optimisticClientMsgId) {
      const list = messages.value[conversation.id] ?? []
      const optimistic = list.find(
        (message) => message.id === optimisticClientMsgId
      )
      if (optimistic) {
        messages.value = {
          ...messages.value,
          [conversation.id]: sortMessagesByTimeline([
            ...list.filter(
              (message) =>
                message.id !== optimisticClientMsgId &&
                message.id !== mapped.id
            ),
            {
              ...optimistic,
              ...mapped,
              localOrder: optimistic.localOrder ?? mapped.localOrder
            }
          ])
        }
        return
      }
    }
    appendMessage(conversation.id, mapped)
  }

  function updateConversationMessageBounds(
    conversationId: string,
    packetMessages: ImPacketMessage[],
    result: { next_after_seq?: number; next_before_seq?: number; has_more_before?: boolean }
  ) {
    const seqs = packetMessages.map((message) => Number(message.message_seq ?? 0)).filter((seq) => seq > 0)
    if (seqs.length > 0) {
      messageCursors.set(conversationId, Math.max(messageCursors.get(conversationId) ?? 0, Number(result.next_after_seq ?? 0), ...seqs))
      const minSeq = Math.min(...seqs, Number(result.next_before_seq ?? Number.MAX_SAFE_INTEGER))
      messageBeforeCursors.set(conversationId, Math.min(messageBeforeCursors.get(conversationId) || minSeq, minSeq))
    }
    messageHasMoreBefore.set(conversationId, result.has_more_before === true)
  }

  function appendMessage(conversationId: string, message: Message) {
    const list = messages.value[conversationId] ?? []
    const existingIndex = list.findIndex((item) => item.id === message.id)
    const normalizedMessage = {
      ...message,
      localOrder: message.localOrder ?? ++localMessageOrder
    }
    if (existingIndex >= 0) {
      messages.value = {
        ...messages.value,
        [conversationId]: sortMessagesByTimeline(
          list.map((item, index) =>
            index === existingIndex
              ? {
                  ...item,
                  ...normalizedMessage,
                  localOrder: item.localOrder ?? normalizedMessage.localOrder
                }
              : item
          )
        )
      }
      return
    }
    messages.value = {
      ...messages.value,
      [conversationId]: sortMessagesByTimeline([...list, normalizedMessage])
    }
  }

  function updateLocalMessage(conversationId: string, id: string, patch: Partial<Message>) {
    const list = messages.value[conversationId] ?? []
    if (!list.some((item) => item.id === id)) return
    messages.value = {
      ...messages.value,
      [conversationId]: sortMessagesByTimeline(
        list.map((item) => (item.id === id ? { ...item, ...patch } : item))
      )
    }
  }

  function markLocalMessageFailed(id: string) {
    for (const conversationId of Object.keys(messages.value)) {
      const list = messages.value[conversationId] ?? []
      const target = list.find((item) => item.id === id)
      if (!target || target.state === 'failed' || target.state === 'delivered') continue
      updateLocalMessage(conversationId, id, {
        state: 'failed',
        uploadProgress: undefined
      })
      return
    }
  }

  function updateConversationPreview(
    conversationId: string,
    preview: string,
    time = formatImTime(),
    unreadIncrement = 0,
    lastMessageTime = new Date().toISOString()
  ) {
    conversations.value = sortConversations(conversations.value.map((item) =>
      item.id === conversationId
        ? {
            ...item,
            preview: normalizeConversationPreview(preview),
            time,
            lastMessageTime,
            sortTime: lastMessageTime,
            localSortOrder: ++localConversationSortOrder,
            unread: Number(item.unread || 0) + unreadIncrement
          }
        : item
    ))
  }

  function setConversationReadLocal(conversationId: string) {
    conversations.value = conversations.value.map((item) =>
      item.id === conversationId ? { ...item, unread: 0 } : item
    )
  }

  function persistConversationRead(conversation: ImConversation) {
    if (conversation.virtual || !conversation.conversationId) return
    if (isCrossOrgAccessFailClosed() && isCrossOrgSingle(conversation)) return
    const latestIncoming = [...(messages.value[conversation.id] ?? [])]
      .filter((message) => message.side === 'in' && message.messageId)
      .sort((left, right) => Number(right.messageSeq ?? 0) - Number(left.messageSeq ?? 0))[0]
    if (latestIncoming?.messageId) {
      sendMessageReceipt({
        conversationId: conversation.conversationId,
        messageId: latestIncoming.messageId,
        messageSeq: Number(latestIncoming.messageSeq ?? 0),
        senderOrganization: latestIncoming.senderOrganization,
        senderUserId: latestIncoming.senderUserId
      }, 'read')
      sendConversationReadReceipt(
        conversation.conversationId,
        latestIncoming.messageId,
        Number(latestIncoming.messageSeq ?? 0)
      )
    }
    return markConversationReadApi(config(), session(), {
      conversationId: conversation.conversationId,
      conversationType: conversation.conversationType,
      peerOrganization: conversation.peerOrganization
    }).catch(() => {
      // 已读落库失败不能影响聊天主链路，下次刷新会用后端未读数兜底。
    })
  }

  function markConversationRead(conversationId: string) {
    const conversation = conversations.value.find((item) => item.id === conversationId)
    setConversationReadLocal(conversationId)
    if (conversation) {
      void persistConversationRead(conversation)
    }
  }

  function markAllConversationsRead() {
    conversations.value = conversations.value.map((item) => ({ ...item, unread: 0 }))
    if (isCrossOrgAccessFailClosed()) {
      layer.warning('跨机构访问尚未初始化，已读状态暂未批量同步')
      return Promise.resolve()
    }
    return markConversationReadApi(config(), session(), { all: true }).catch(() => {
      layer.warning('已读状态同步失败，请稍后重试')
    })
  }

  async function updateConversationSetting(conversationId: string, settings: { isPinned?: boolean; isMuted?: boolean }) {
    const conversation = conversations.value.find((item) => item.id === conversationId)
    if (!conversation || conversation.virtual) return
    if (isCrossOrgAccessFailClosed() && isCrossOrgSingle(conversation)) {
      layer.warning('当前跨机构访问已关闭')
      return
    }
    await updateConversationSettingApi(config(), session(), {
      conversationId: conversation.conversationId,
      conversationType: conversation.conversationType,
      peerOrganization: conversation.peerOrganization,
      ...settings
    })
    conversations.value = sortConversations(conversations.value.map((item) =>
      item.id === conversationId
        ? {
            ...item,
            isPinned: settings.isPinned ?? item.isPinned,
            isMuted: settings.isMuted ?? item.isMuted
          }
        : item
    ))
  }

  async function updateGroupProfile(
    conversationId: string,
    profile: {
      title?: string
      avatarFileId?: string
      description?: string
      notifyAll?: boolean
    }
  ) {
    const conversation = conversations.value.find((item) => item.id === conversationId)
    if (!conversation || conversation.virtual || !conversation.conversationId || conversation.conversationType !== 'group') {
      layer.warning('请选择群聊')
      return null
    }

    const result = await updateGroupProfileApi(config(), session(), {
      conversationId: conversation.conversationId,
      ...profile
    })
    const updated = result.conversation
    conversations.value = sortConversations(conversations.value.map((item) =>
      item.id === conversationId
        ? {
            ...item,
            title: updated.title,
            avatar: updated.avatar,
            avatarFileId: updated.avatarFileId,
            avatarExpiresAt: updated.avatarExpiresAt,
            description: updated.description,
            avatarMembers: updated.avatarMembers,
            preview: updated.preview,
            time: updated.time,
            lastMessageId: updated.lastMessageId,
            lastMessageSeq: updated.lastMessageSeq,
            lastChangeSeq: updated.lastChangeSeq,
            lastMessageIndexId: updated.lastMessageIndexId,
            lastMessageTime: updated.lastMessageTime,
            sortTime: updated.sortTime
          }
        : item
    ))
    if (result.noticeMessage) {
      const latestConversation = conversations.value.find((item) => item.id === conversationId) ?? updated
      mergeMessages(latestConversation, [result.noticeMessage])
    }
    return updated
  }

  async function searchActiveMessages(keyword: string, messageType?: number) {
    const conversation = activeConversation.value
    if (!conversation || conversation.virtual || !conversation.conversationId) return []
    const rows = await searchConversationMessages(config(), session(), {
      conversationId: conversation.conversationId,
      keyword,
      messageType,
      limit: 80
    })
    return rows.map((message) => mapPacketMessage(message, session(), conversation))
  }

  function notifyIncomingMessage(title: string, body: string, showNotice: boolean) {
    const settings = notificationSettings()
    if (!showNotice) {
      return
    }
    if (settings.soundEnabled) {
      playNotificationSound()
    }
    layer.info(`${title}：${body}`, 3200)
    if (
      settings.browserEnabled &&
      shouldShowBrowserSystemNotification() &&
      'Notification' in window &&
      Notification.permission === 'granted'
    ) {
      new Notification(title, { body })
    }
  }

  function sortConversations(list: ImConversation[]) {
    return [...list].sort((left, right) => {
      if (left.isPinned !== right.isPinned) return left.isPinned ? -1 : 1

      const leftHasMessage = hasConversationMessage(left)
      const rightHasMessage = hasConversationMessage(right)
      if (leftHasMessage !== rightHasMessage) return leftHasMessage ? -1 : 1

      const timeDiff = conversationTimeValue(right) - conversationTimeValue(left)
      if (timeDiff !== 0) return timeDiff

      const indexDiff = Number(right.lastMessageIndexId || 0) - Number(left.lastMessageIndexId || 0)
      if (indexDiff !== 0) return indexDiff

      const localDiff = Number(right.localSortOrder || 0) - Number(left.localSortOrder || 0)
      if (localDiff !== 0) return localDiff

      return Number(right.conversationSortId || 0) - Number(left.conversationSortId || 0)
    })
  }

  function hasConversationMessage(conversation: ImConversation) {
    return Boolean(conversation.lastMessageTime || conversation.lastMessageId || Number(conversation.lastMessageSeq || 0) > 0)
  }

  function conversationTimeValue(conversation: ImConversation) {
    const rawValue = conversation.sortTime || conversation.lastMessageTime
    if (!rawValue) return 0
    const value = parseImTimestamp(rawValue).getTime()
    return Number.isNaN(value) ? 0 : value
  }

  function isActiveConversationVisible(conversationId: string) {
    return conversationId === activeConversationId.value && !document.hidden && document.hasFocus()
  }

  function markActiveConversationReadWhenVisible() {
    if (document.hidden || !document.hasFocus()) return
    const active = activeConversation.value
    if (active) {
      markConversationRead(active.id)
    }
  }

  function shouldShowBrowserSystemNotification() {
    return document.hidden || !document.hasFocus()
  }

  function sendPacketToSocket(target: WebSocket, packet: ImPacket, traceContext?: TraceContext) {
    if (target.readyState !== WebSocket.OPEN) return false
    target.send(JSON.stringify(attachTraceContext({ ...packet, ts: Date.now() }, traceContext)))
    return true
  }

  function sendPacket(packet: ImPacket, retainedSpan?: TelemetrySpan | null) {
    const current = socket
    if (
      !current ||
      current.readyState !== WebSocket.OPEN ||
      connectionState.value !== 'connected' ||
      authenticatedConnection?.socket !== current
    ) {
      return false
    }
    if (packet.cmd === 'ping') return sendPacketToSocket(current, packet)

    const ownedSpan = retainedSpan === undefined
      ? startWsSpan(packet.cmd, packetTraceContext(packet), packet.client_msg_id)
      : null
    const span = retainedSpan ?? ownedSpan
    const sent = sendPacketToSocket(current, packet, span?.context)
    if (ownedSpan) {
      if (sent) ownedSpan.end()
      else ownedSpan.fail({
        code: 'IM_WEBSOCKET_SEND_FAILED',
        type: 'connection_unavailable',
        ...(packet.client_msg_id ? { clientMsgId: packet.client_msg_id } : {})
      })
    }
    return sent
  }

  function isCurrentChallenge(challenge: AuthChallengeState) {
    return Boolean(
      socket === challenge.socket &&
        challenge.socket.readyState === WebSocket.OPEN &&
        pendingAuthChallenge?.socket === challenge.socket &&
        pendingAuthChallenge.sequence === challenge.sequence &&
        pendingAuthChallenge.clientId === challenge.clientId
    )
  }

  function clearSocketAuthState(target?: WebSocket) {
    if (!target || pendingAuthChallenge?.socket === target) {
      pendingAuthChallenge?.traceSpan?.fail({
        code: 'IM_AUTH_CONNECTION_CLOSED',
        type: 'connection_closed'
      })
      pendingAuthChallenge = null
    }
    if (!target || authenticatedConnection?.socket === target) {
      authenticatedConnection = null
      authenticatedAccessSnapshotBehindHighWater = false
      authenticatedStaleAccessSnapshotId = ''
      authenticatedRecoverySequence += 1
      authenticatedRecoveryPackets = []
    }
  }

  function failSocketAuthentication(
    target: WebSocket,
    status: string,
    message: string,
    reconnect = false
  ) {
    if (socket !== target) return
    pendingAuthChallenge?.traceSpan?.fail({
      code: status,
      type: 'authentication_error'
    })
    logWsStatus(status)
    connectionState.value = 'error'
    layer.error(message)
    closeSocket()
    if (reconnect) scheduleReconnect()
  }

  function startPing() {
    window.clearInterval(pingTimer)
    pingTimer = window.setInterval(() => {
      if (sendPacket({ cmd: 'ping', data: {} })) {
        heartbeatPulse.value += 1
        logWsStatus('heartbeat:ping-sent', { pulse: heartbeatPulse.value })
      }
    }, 25000)
  }

  function scheduleReconnect() {
    clearReconnect()
    logWsStatus('reconnect:scheduled', { delay: 3000 })
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = 0
      connect()
    }, 3000)
  }

  function clearReconnect() {
    window.clearTimeout(reconnectTimer)
    reconnectTimer = 0
  }

  function closeSocket() {
    clearReconnect()
    window.clearInterval(pingTimer)
    pingTimer = 0
    failPendingSendTraces('IM_WEBSOCKET_CLOSED', 'connection_closed')
    clearPendingControlRequests()
    typingTimers.forEach((timer) => window.clearTimeout(timer))
    typingTimers.clear()
    typingByConversation.value = {}
    changeRefreshInFlight.clear()
    failCloseCrossOrgAccess(false)
    clearSocketAuthState()
    if (socket) {
      const current = socket
      socket = null
      current.close()
    }
  }

  function scrollMessagesToBottom() {
    document.querySelector('.message-stream')?.scrollTo({ top: 999999, behavior: 'smooth' })
  }

  function maxLocalMessageSeq(list: Message[]) {
    return list.reduce((maxSeq, message) => Math.max(maxSeq, Number(message.messageSeq ?? 0)), 0)
  }

  function minLocalMessageSeq(list: Message[]) {
    return list.reduce((minSeq, message) => {
      const seq = Number(message.messageSeq ?? 0)
      return seq > 0 ? Math.min(minSeq, seq) : minSeq
    }, Number.MAX_SAFE_INTEGER)
  }

  watch(activeConversationId, (conversationId) => {
    if (!conversationId) return
    markConversationRead(conversationId)
    void syncActiveConversation()
  })

  window.addEventListener('focus', markActiveConversationReadWhenVisible)
  document.addEventListener('visibilitychange', markActiveConversationReadWhenVisible)
  onScopeDispose(() => {
    window.removeEventListener('focus', markActiveConversationReadWhenVisible)
    document.removeEventListener('visibilitychange', markActiveConversationReadWhenVisible)
    closeSocket()
  })

  return {
    connectionState,
    heartbeatPulse,
    messageGroups,
    conversations,
    totalUnread,
    notifiableUnread,
    activeCanLoadOlder,
    loadingOlderMessages,
    messageDeleteConfig,
    activeConversationId,
    activeConversation,
    activeMessages,
    activeTypingText,
    boot,
    loadConversations,
    startSingleChat,
    createGroup,
    createMessageGroup,
    updateConversationGroup,
    syncActiveConversation,
    loadOlderActiveMessages,
    sendText,
    sendAsset,
    recallMessage,
    sendScreenshotNotice,
    sendTyping,
    editMessage,
    deleteMessage,
    deleteMessages,
    forwardMessages,
    resolveMessageAssetUrl,
    updateConversationSetting,
    updateGroupProfile,
    searchActiveMessages,
    markAllConversationsRead,
    connect,
    closeSocket
  }
}

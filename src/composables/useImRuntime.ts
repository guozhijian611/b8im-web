import { computed, nextTick, onScopeDispose, ref, watch } from 'vue'
import { layer } from '../services/layer'
import { playNotificationSound } from '../services/notification'
import {
  isCanonicalRealtimeCommand,
  isCanonicalRealtimeEventPacketValid,
  isFriendRequestRealtimeEventPacketValid,
  RealtimeEventDedupWindow
} from '../services/realtimeEventDedup'
import type { TenantBrandConfig } from '../services/tenantConfig'
import { notifyTitleIncomingMessage } from '../services/titleNotifier'
import { formatImMessageTime, formatImTime, parseImTimestamp } from '../services/time'
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
}

type AuthChallengeState = {
  socket: WebSocket
  sequence: number
  clientId: string
  deviceId: string
  credentialSessionId: string
  authSent: boolean
}

type AuthenticatedConnectionState = {
  socket: WebSocket
  clientId: string
  deviceId: string
  credentialSessionId: string
  sessionId: string
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

function firstText(value: string) {
  return (value.trim().slice(0, 1) || '用').toUpperCase()
}

function senderDisplayName(sender?: ImMessageSender | null) {
  if (!sender) return ''
  return String(sender.nickname || sender.account || sender.user_id || '')
}

function senderAvatarUrl(sender?: ImMessageSender | null) {
  return String(sender?.avatar_url ?? '')
}

function systemNoticeText(content: Record<string, unknown>, currentUserId: string, conversationType: ImConversation['conversationType']) {
  const event = String(content?.event ?? '')
  const actorUserId = String(content?.actor_user_id ?? '')
  const actorName = String(content?.actor_name ?? '').trim() || '有人'
  const isSelf = actorUserId !== '' && actorUserId === currentUserId
  const actor = isSelf ? '你' : (conversationType === 'group' ? actorName : '对方')

  if (event === 'recall') return `${actor}撤回了一条消息`
  if (event === 'screenshot') return `${actor}截屏了`
  return String(content?.text ?? '[系统通知]')
}

function messageText(
  message: ImPacketMessage,
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
    return systemNoticeText(message.content ?? {}, currentUserId, conversationType)
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
  const isOut = message.sender_id === currentUserId
  const isSystem = Number(message.message_type ?? 0) === MESSAGE_TYPE_SYSTEM
  const peerUser = conversation.peerUser ?? null
  const senderUser = message.sender_user ?? null
  const forwardBundle = normalizeForwardBundle(message.content ?? {})
  const displayName = senderDisplayName(senderUser)
  const senderName = isOut
    ? '我'
    : displayName !== ''
      ? displayName
      : peerUser?.userId === message.sender_id
      ? peerUser.nickname
      : message.sender_id
  const avatarText = isOut
    ? firstText(currentSession.user.nickname || currentSession.user.account || '我')
    : firstText(displayName || peerUser?.nickname || peerUser?.account || message.sender_id)

  return {
    id: message.client_msg_id || message.message_id || String(message.id),
    messageId: message.message_id,
    conversationId: message.conversation_id,
    fileId: String(message.content?.file_id ?? ''),
    sender: senderName,
    avatar: avatarText,
    avatarUrl: isOut ? currentSession.user.avatarUrl : senderAvatarUrl(senderUser) || peerUser?.avatarUrl,
    side: isSystem ? 'system' : (isOut ? 'out' : 'in'),
    type: messageTypeName(Number(message.message_type ?? 1)),
    content: forwardBundle?.title ?? messageText(message, currentUserId, conversation.conversationType),
    url: [MESSAGE_TYPE_IMAGE, MESSAGE_TYPE_FILE, MESSAGE_TYPE_VOICE, MESSAGE_TYPE_VIDEO].includes(Number(message.message_type ?? 0))
      ? ''
      : String(message.content?.url ?? ''),
    fileName: String(message.content?.name ?? message.content?.file_name ?? ''),
    fileSize: Number(message.content?.size ?? 0),
    messageSeq: Number(message.message_seq ?? 0),
    createTime: message.create_time,
    time: formatImMessageTime(message.create_time),
    state: isOut ? 'delivered' : undefined,
    editTime: String(message.edit_time ?? ''),
    editCount: Number(message.edit_count ?? 0),
    senderUserId: message.sender_id,
    quote: normalizeMessageQuote(message.content?.reply),
    mentions: normalizeMentions(message.content?.mentions),
    forwardBundle,
    meta: message.message_type === MESSAGE_TYPE_FILE || message.message_type === MESSAGE_TYPE_IMAGE || message.message_type === MESSAGE_TYPE_VOICE || message.message_type === MESSAGE_TYPE_VIDEO
      ? formatFileSize(Number(message.content?.size ?? 0))
      : undefined
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
  const messageCursors = new Map<string, number>()
  const messageBeforeCursors = new Map<string, number>()
  const messageHasMoreBefore = new Map<string, boolean>()
  const loadingOlderMessages = ref(false)
  const messageDeleteConfig = ref({
    deleteSingleEnabled: false,
    deleteBothEnabled: false
  })

  let socket: WebSocket | null = null
  let authChallengeSequence = 0
  let pendingAuthChallenge: AuthChallengeState | null = null
  let authenticatedConnection: AuthenticatedConnectionState | null = null
  let pingTimer = 0
  let reconnectTimer = 0
  let localMessageOrder = 0
  let localConversationSortOrder = 0
  let recentRealtimeEvents: RealtimeEventDedupWindow | null = null

  function realtimeEventWindow() {
    const organization = String(session().organization ?? '').trim()
    const userId = String(session().user.userId ?? '').trim()
    if (!recentRealtimeEvents?.matches(organization, userId)) {
      recentRealtimeEvents = new RealtimeEventDedupWindow(organization, userId)
    }
    return recentRealtimeEvents
  }

  const activeConversation = computed(() => {
    return conversations.value.find((item) => item.id === activeConversationId.value) ?? null
  })

  const activeMessages = computed(() => {
    const active = activeConversation.value
    return active ? messages.value[active.id] ?? [] : []
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

  async function boot() {
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
    const loaded = await fetchConversations(config(), session())
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
    const existing = conversations.value.find((item) => item.peerUserId === contact.userId)
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
      messageGroupId
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
      peerUserId: conversation.peerUserId,
      beforeSeq: 0,
      limit: 50
    })
    if (result.messages.length > 0) {
      mergeMessages(conversation, result.messages)
      updateConversationMessageBounds(conversation.id, result.messages, result)
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
        peerUserId: conversation.peerUserId,
        beforeSeq,
        limit: 50
      })
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
    const wsUrl = config().serverInfo.imServerUrl
    if (!wsUrl) {
      connectionState.value = 'offline'
      logWsStatus('offline:no-im-server-url')
      return
    }

    connectionState.value = 'connecting'
    logWsStatus('connecting', { url: wsUrl })
    const current = new WebSocket(wsUrl)
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
      clearSocketAuthState(current)
      socket = null
      connectionState.value = 'offline'
      logWsStatus('offline:closed', {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean
      })
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
      authSent: false
    }
    pendingAuthChallenge = challenge
    logWsStatus('auth:challenge-received', {
      clientId,
      challengeSequence: challenge.sequence
    })
    void authenticateChallenge(challenge)
  }

  async function authenticateChallenge(challenge: AuthChallengeState) {
    try {
      const credential = await issueImChallengeToken(config(), session(), challenge.clientId)
      if (!isCurrentChallenge(challenge)) return

      pendingAuthChallenge = {
        ...challenge,
        deviceId: credential.deviceId,
        credentialSessionId: credential.credentialSessionId,
        authSent: true
      }
      if (
        !sendPacketToSocket(challenge.socket, {
          cmd: 'auth',
          data: {
            token: credential.token,
            device_id: credential.deviceId,
            platform: 'web'
          }
        })
      ) {
        throw new Error('IM 连接已关闭，无法发送鉴权凭证')
      }
      logWsStatus('auth:sent', {
        clientId: challenge.clientId,
        challengeSequence: challenge.sequence,
        expireAt: credential.expireAt
      })
    } catch (error) {
      if (!isCurrentChallenge(challenge)) return
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
        onProgress: (progress) => updateLocalMessage(conversation.id, clientMsgId, {
          uploadProgress: Math.max(1, Math.min(99, progress)),
          state: 'uploading'
        })
      })
    } catch (error) {
      updateLocalMessage(conversation.id, clientMsgId, {
        state: 'failed',
        uploadProgress: undefined
      })
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
    const sent = await sendMessage(type, {
      file_id: uploaded.fileId
    }, preview, kind, { clientMsgId, appendLocal: false })
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
    if (!socket || socket.readyState !== WebSocket.OPEN || connectionState.value !== 'connected') {
      layer.warning('IM连接未就绪，稍后再试')
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
    sendPacket({
      cmd: 'send',
      client_msg_id: clientMsgId,
      data: {
        conversation_type: conversation.conversationType,
        conversation_id: conversation.conversationId || undefined,
        to_user_id: conversation.conversationType === 'single' ? conversation.peerUserId : undefined,
        message_type: messageType,
        content
      }
    })
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
      const kind = message.type as UploadedAsset['kind']
      const asset = await deriveForwardAssetApi(config(), session(), {
        conversationId: message.conversationId,
        messageId: message.messageId,
        fileId: message.fileId,
        kind
      })
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
    if (message.conversationId) {
      updateLocalMessage(message.conversationId, message.id, { url })
    }

    return url
  }

  async function recallMessage(message: Message) {
    const conversation = activeConversation.value
    if (!conversation || !message.messageId) return false
    if (message.side !== 'out') {
      layer.warning('只能撤回自己发送的消息')
      return false
    }
    sendPacket({
      cmd: 'recall',
      data: { message_id: message.messageId }
    })
    return true
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

    sendPacket({
      cmd: 'screenshot',
      data: { conversation_id: conversation.conversationId }
    })
    return true
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

    sendPacket({
      cmd: 'edit',
      data: {
        message_id: message.messageId,
        content: { text: value }
      }
    })
    return true
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

    sendPacket({
      cmd: 'delete',
      data: {
        message_id: message.messageId,
        scope
      }
    })
    return true
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

  function handleSocketMessage(current: WebSocket, event: MessageEvent<string>) {
    if (socket !== current) return
    let packet: ImPacket | null = null
    try {
      packet = JSON.parse(event.data) as ImPacket
    } catch {
      return
    }
    if (!packet) return

    if (packet.cmd === 'auth') {
      handleAuthChallenge(current, packet)
      return
    }
    if (packet.cmd === 'auth_ack') {
      handleAuthAck(current, packet)
      return
    }
    if (packet.cmd === 'error' && connectionState.value !== 'connected') {
      const message = String(packet.data?.msg ?? 'IM 鉴权失败')
      failSocketAuthentication(current, 'auth:error-packet', message)
      return
    }
    if (
      connectionState.value !== 'connected' ||
      authenticatedConnection?.socket !== current
    ) {
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
      // ACK/SYNC and other point-to-point commands are not subject to this gate.
      if (!isCanonicalRealtimeEventPacketValid(packet, session().organization)) {
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
      if (message) {
        upsertIncomingMessage(message)
      }
      return
    }
    if (packet.cmd === 'push') {
      const message = packet.data?.message as ImPacketMessage | undefined
      if (message) {
        upsertIncomingMessage(message)
      }
      return
    }
    if (packet.cmd === 'friend_request') {
      handleFriendRequestEvent(packet.data ?? {})
      return
    }
    if (packet.cmd === 'recall' || packet.cmd === 'recall_ack') {
      const messageId = String(packet.data?.message_id ?? '')
      const conversationId = String(packet.data?.conversation_id ?? '')
      if (messageId && conversationId) {
        removeRecalledMessage(conversationId, messageId)
        const noticeMessage = packet.data?.notice_message as ImPacketMessage | undefined
        if (noticeMessage) {
          applyNoticeMessage(noticeMessage, packet.data ?? {})
        }
        void loadConversations()
      }
      return
    }
    if (packet.cmd === 'screenshot' || packet.cmd === 'screenshot_ack') {
      const noticeMessage = packet.data?.notice_message as ImPacketMessage | undefined
      if (noticeMessage) {
        applyNoticeMessage(noticeMessage, packet.data ?? {})
      }
      return
    }
    if (packet.cmd === 'edit' || packet.cmd === 'edit_ack') {
      const message = packet.data?.message as ImPacketMessage | undefined
      if (message) {
        applyEditedMessage(message, packet.data ?? {})
      }
      return
    }
    if (packet.cmd === 'delete' || packet.cmd === 'delete_ack') {
      const messageId = String(packet.data?.message_id ?? '')
      const conversationId = String(packet.data?.conversation_id ?? '')
      if (messageId && conversationId) {
        removeDeletedMessage(conversationId, messageId, packet.data ?? {})
        void loadConversations()
      }
      return
    }
    if (packet.cmd === 'error') {
      handleErrorPacket(packet)
    }
  }

  function handleAuthAck(current: WebSocket, packet: ImPacket) {
    const challenge = pendingAuthChallenge
    const data = packet.data ?? {}
    const clientId = typeof data.client_id === 'string' ? data.client_id.trim() : ''
    const deviceId = typeof data.device_id === 'string' ? data.device_id.trim() : ''
    const credentialSessionId =
      typeof data.credential_session_id === 'string' ? data.credential_session_id.trim() : ''
    const sessionId = typeof data.session_id === 'string' ? data.session_id.trim() : ''
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
        sessionId !== ''
    )
    if (!valid || !challenge) {
      logWsStatus('auth-ack:invalid', {
        packetOrganization: packet.organization ?? null,
        clientId,
        challengeClientId: challenge?.clientId ?? '',
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

    authenticatedConnection = {
      socket: current,
      clientId,
      deviceId,
      credentialSessionId,
      sessionId
    }
    pendingAuthChallenge = null
    connectionState.value = 'connected'
    logWsStatus('connected:auth-ack', {
      clientId,
      sessionId
    })
    startPing()
    void loadConversations()
  }

  function handleErrorPacket(packet: ImPacket) {
    const message = String(packet.data?.msg ?? 'IM服务错误')
    const code = String(packet.data?.code ?? '')
    const clientMsgId = String(packet.client_msg_id ?? packet.data?.client_msg_id ?? '')
    if (clientMsgId !== '') {
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

  function upsertIncomingMessage(message: ImPacketMessage) {
    let conversation: ImConversation | null | undefined = conversations.value.find(
      (item) => item.conversationId === message.conversation_id
    )
    if (!conversation) {
      conversation = activeConversation.value
      if (conversation && conversation.virtual) {
        conversation.conversationId = message.conversation_id
        conversation.id = message.conversation_id
        conversation.virtual = false
        messages.value[message.conversation_id] = messages.value[activeConversationId.value] ?? []
        delete messages.value[activeConversationId.value]
        messageCursors.set(message.conversation_id, messageCursors.get(activeConversationId.value) ?? 0)
        messageBeforeCursors.set(message.conversation_id, messageBeforeCursors.get(activeConversationId.value) ?? 0)
        messageHasMoreBefore.set(message.conversation_id, messageHasMoreBefore.get(activeConversationId.value) ?? false)
        messageCursors.delete(activeConversationId.value)
        messageBeforeCursors.delete(activeConversationId.value)
        messageHasMoreBefore.delete(activeConversationId.value)
        activeConversationId.value = message.conversation_id
      }
    }
    if (!conversation) return

    const isIncoming = message.sender_id !== session().user.userId
    const activeVisible = isActiveConversationVisible(conversation.id)
    const shouldCountUnread = isIncoming && !activeVisible
    const shouldShowNotice = shouldCountUnread && !conversation.isMuted
    appendPacketMessage(conversation, message)
    messageCursors.set(
      conversation.id,
      Math.max(messageCursors.get(conversation.id) ?? 0, Number(message.message_seq ?? 0))
    )
    const preview = messageText(message, session().user.userId, conversation.conversationType)
    updateConversationPreview(conversation.id, preview, formatImTime(message.create_time), shouldCountUnread ? 1 : 0, message.create_time)
    if (isIncoming) {
      notifyIncomingMessage(conversation.title, preview, shouldShowNotice)
      if (shouldShowNotice) {
        notifyTitleIncomingMessage(conversation.title, preview)
      }
    }
    void nextTick().then(scrollMessagesToBottom)
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
        messageText(packetMessage, session().user.userId, conversation.conversationType),
        formatImTime(String(data.last_message_time ?? packetMessage.create_time)),
        0,
        String(data.last_message_time ?? packetMessage.create_time)
      )
    }
  }

  function mergeMessages(conversation: ImConversation, packetMessages: ImPacketMessage[]) {
    packetMessages.forEach((message) => appendPacketMessage(conversation, message))
  }

  function appendPacketMessage(conversation: ImConversation, packetMessage: ImPacketMessage) {
    appendMessage(conversation.id, mapPacketMessage(packetMessage, session(), conversation))
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
    return markConversationReadApi(config(), session(), { conversationId: conversation.conversationId }).catch(() => {
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
    return markConversationReadApi(config(), session(), { all: true }).catch(() => {
      layer.warning('已读状态同步失败，请稍后重试')
    })
  }

  async function updateConversationSetting(conversationId: string, settings: { isPinned?: boolean; isMuted?: boolean }) {
    const conversation = conversations.value.find((item) => item.id === conversationId)
    if (!conversation || conversation.virtual) return
    await updateConversationSettingApi(config(), session(), {
      conversationId: conversation.conversationId,
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

  function sendPacketToSocket(target: WebSocket, packet: ImPacket) {
    if (target.readyState !== WebSocket.OPEN) return false
    target.send(JSON.stringify({ ...packet, ts: Date.now() }))
    return true
  }

  function sendPacket(packet: ImPacket) {
    const current = socket
    if (
      !current ||
      current.readyState !== WebSocket.OPEN ||
      connectionState.value !== 'connected' ||
      authenticatedConnection?.socket !== current
    ) {
      return false
    }
    return sendPacketToSocket(current, packet)
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
      pendingAuthChallenge = null
    }
    if (!target || authenticatedConnection?.socket === target) {
      authenticatedConnection = null
    }
  }

  function failSocketAuthentication(target: WebSocket, status: string, message: string) {
    if (socket !== target) return
    logWsStatus(status, { message })
    connectionState.value = 'error'
    layer.error(message)
    closeSocket()
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

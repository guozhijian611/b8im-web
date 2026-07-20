<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ArrowDownToLine,
  AtSign,
  CheckSquare,
  ChevronRight,
  FilePlus2,
  Forward,
  Image,
  Mic,
  MoreHorizontal,
  Pause,
  Play,
  Scissors,
  Search,
  Send,
  SmilePlus,
  Trash2,
  Video,
  X
} from '@lucide/vue'
import ConversationAvatar from './ConversationAvatar.vue'
import { CONTEXT_MENU_CLOSE_EVENT, emitCloseContextMenus, isCloseFromSource } from '../services/contextMenu'
import { GROUP_ACCESS_BROWSER_EVENT } from '../services/groupMemberAccess'
import { layer } from '../services/layer'
import type { GroupMember, ImConnectionState, ImConversation, Message, MessageForwardBundle, MessageForwardItem, MessageGroup, MessageMention } from '../types'

type PastedAssetKind = 'image' | 'file' | 'voice' | 'video'
type ForwardMode = 'separate' | 'merged'
type VoicePlaybackState = {
  playing: boolean
  currentTime: number
  duration: number
}
type MediaPreviewState = {
  visible: boolean
  type: 'image' | 'video'
  url: string
  title: string
}
type AssetVisibilityElement = HTMLElement & {
  __b8imAssetObserver?: IntersectionObserver
  __b8imAssetKey?: string
}
type TextMessagePart = {
  text: string
  mention: boolean
}

interface PendingPasteAsset {
  id: string
  file: File
  kind: PastedAssetKind
  name: string
  sizeText: string
  previewUrl: string
}

interface PendingPastePayload {
  text: string
  assets: PendingPasteAsset[]
}

const props = defineProps<{
  conversation: ImConversation | null
  messages: Message[]
  conversations: ImConversation[]
  messageGroups: MessageGroup[]
  connectionState: ImConnectionState
  typingText: string
  showInfo: boolean
  openSearchToken: number
  searchMessages: (keyword: string, messageType?: number) => Promise<Message[]>
  loadMentionMembers: () => Promise<GroupMember[]>
  canLoadOlder: boolean
  loadingOlder: boolean
  loadOlderMessages: () => Promise<boolean>
  canDeleteSelf: boolean
  canDeleteBoth: boolean
  resolveAssetUrl: (message: Message, force?: boolean) => Promise<string>
}>()

function observePrivateAsset(element: AssetVisibilityElement, message: Message) {
  element.__b8imAssetObserver?.disconnect()
  element.__b8imAssetObserver = undefined
  const assetKey = `${message.conversationId ?? ''}:${message.messageId ?? ''}:${message.fileId ?? ''}`
  element.__b8imAssetKey = assetKey
  if (!message.fileId || message.url || !['image', 'file', 'voice', 'video'].includes(message.type)) return

  const resolve = () => {
    if (element.__b8imAssetKey !== assetKey) return
    element.__b8imAssetObserver?.disconnect()
    element.__b8imAssetObserver = undefined
    void props.resolveAssetUrl(message).catch((error) => {
      console.warn('[b8im:asset] visible URL resolution failed', error)
    })
  }
  if (typeof IntersectionObserver === 'undefined') {
    resolve()
    return
  }
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) resolve()
  }, { rootMargin: '120px' })
  element.__b8imAssetObserver = observer
  observer.observe(element)
}

const vAssetVisible = {
  mounted(element: AssetVisibilityElement, binding: { value: Message }) {
    observePrivateAsset(element, binding.value)
  },
  updated(element: AssetVisibilityElement, binding: { value: Message }) {
    observePrivateAsset(element, binding.value)
  },
  beforeUnmount(element: AssetVisibilityElement) {
    element.__b8imAssetObserver?.disconnect()
  }
}

const emit = defineEmits<{
  'toggle-info': []
  'send-text': [string, Message | null, MessageMention[]]
  'send-asset': [File, 'image' | 'file' | 'voice' | 'video']
  'recall-message': [Message]
  screenshot: []
  typing: []
  'edit-message': [Message, string]
  'delete-message': [Message, 'self' | 'both']
  'delete-messages': [Message[], 'self' | 'both']
  'forward-messages': [string[], Message[], ForwardMode]
}>()

const draft = ref('')
const showEmoji = ref(false)
const showSearch = ref(false)
const searchKeyword = ref('')
const searchMessageType = ref(0)
const searchResults = ref<Message[]>([])
const searching = ref(false)
const searchInput = ref<HTMLInputElement | null>(null)
const imageInput = ref<HTMLInputElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const voiceInput = ref<HTMLInputElement | null>(null)
const videoInput = ref<HTMLInputElement | null>(null)
const composerInput = ref<HTMLTextAreaElement | null>(null)
const mentionMembers = ref<GroupMember[]>([])
const mentionLoading = ref(false)
const mentionPanelOpen = ref(false)
const mentionQuery = ref('')
const mentionStartIndex = ref(-1)
const activeMentionIndex = ref(0)
const selectedMentions = ref<MessageMention[]>([])
const messageMenu = ref({
  visible: false,
  x: 0,
  y: 0,
  message: null as Message | null
})
const editingMessage = ref<Message | null>(null)
const replyMessage = ref<Message | null>(null)
const forwardPreviewMessage = ref<Message | null>(null)
const forwardPreviewStack = ref<MessageForwardBundle[]>([])
const selectionMode = ref(false)
const selectedMessageIds = ref<string[]>([])
const voiceAudioElements = new Map<string, HTMLAudioElement>()
const voicePlayback = ref<Record<string, VoicePlaybackState>>({})
const mediaPreview = ref<MediaPreviewState>({
  visible: false,
  type: 'image',
  url: '',
  title: ''
})
const forwardDialog = ref({
  visible: false,
  keyword: '',
  activeGroupId: -1,
  targetConversationIds: [] as string[],
  mode: 'separate' as ForwardMode,
  messages: [] as Message[]
})
const emojis = [
  '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '🙂', '🙃', '😉',
  '😍', '🥰', '😘', '😋', '😜', '🤪', '🤔', '🤨', '😎', '🥳', '😏', '😴',
  '😢', '😭', '😤', '😡', '🤯', '😳', '🥺', '😇', '🤗', '🤫', '🤭', '🙄',
  '👍', '👎', '👌', '🤌', '🤝', '🙏', '👏', '🙌', '💪', '👊', '✌️', '🤘',
  '❤️', '🧡', '💛', '💚', '💙', '💜', '🤍', '💔', '💕', '💞', '💯', '💢',
  '🎉', '🎊', '✨', '🌟', '⭐', '🔥', '💥', '💫', '☀️', '🌙', '🌈', '⚡',
  '🍎', '🍓', '🍉', '🍔', '🍟', '🍕', '🍜', '☕', '🍺', '🍻', '🎂', '🍰',
  '🐶', '🐱', '🐼', '🐯', '🦊', '🐵', '🐷', '🐸', '🐥', '🦄', '🐢', '🐟',
  '🎁', '🏆', '🎮', '🎧', '📷', '📌', '📎', '💡', '✅', '❌', '❗', '❓'
]
const COMPOSER_MIN_HEIGHT = 52
const COMPOSER_MAX_HEIGHT = 128
const MAX_PASTE_TEXT_PREVIEW_LENGTH = 600
const BOTTOM_VISIBLE_THRESHOLD = 120
const FORWARD_FILTER_ALL = -1
const FORWARD_FILTER_SINGLE = -2
const FORWARD_FILTER_GROUP = -3
const FORWARD_FILTER_UNGROUPED = 0

const onlineText = computed(() => {
  if (!props.conversation) return '请选择会话'
  if (props.typingText) return props.typingText
  if (props.conversation.conversationType === 'group') return '群聊'
  if (props.connectionState === 'connected') return 'IM 已连接'
  if (props.connectionState === 'connecting') return 'IM 连接中'
  if (props.connectionState === 'error') return 'IM 连接异常'
  return 'IM 离线'
})

const canSend = computed(() => Boolean(props.conversation) &&
  props.conversation?.groupAccessBlocked !== true &&
  props.conversation?.groupAccessState !== 'history_only' &&
  props.connectionState === 'connected')
const activeMenuMessage = computed(() => messageMenu.value.message)
const canCopyMenuMessage = computed(() => Boolean(activeMenuMessage.value?.content.trim()))
const canOpenMenuMessage = computed(() => Boolean(activeMenuMessage.value?.url))
const canEditMenuMessage = computed(() => Boolean(activeMenuMessage.value && canEditMessage(activeMenuMessage.value)))
const canReplyMenuMessage = computed(() => Boolean(activeMenuMessage.value && canReplyMessage(activeMenuMessage.value)))
const canForwardMenuMessage = computed(() => Boolean(activeMenuMessage.value && canForwardMessage(activeMenuMessage.value)))
const canRecallMenuMessage = computed(() => Boolean(activeMenuMessage.value && canRecallMessage(activeMenuMessage.value)))
const canDeleteSelfMenuMessage = computed(() => Boolean(activeMenuMessage.value && canDeleteSelfMessage(activeMenuMessage.value)))
const canDeleteBothMenuMessage = computed(() => Boolean(activeMenuMessage.value && canDeleteBothMessage(activeMenuMessage.value)))
const selectedMessages = computed(() => {
  const selected = new Set(selectedMessageIds.value)
  return props.messages.filter((message) => selected.has(message.id))
})
const selectedCount = computed(() => selectedMessages.value.length)
const canForwardSelected = computed(() => selectedMessages.value.some(canForwardMessage))
const canDeleteSelectedSelf = computed(() => selectedMessages.value.length > 0 && selectedMessages.value.every(canDeleteSelfMessage))
const canDeleteSelectedBoth = computed(() => selectedMessages.value.length > 0 && selectedMessages.value.every(canDeleteBothMessage))
const forwardGroupFilters = computed(() => [
  { id: FORWARD_FILTER_ALL, name: '全部' },
  { id: FORWARD_FILTER_SINGLE, name: '好友消息' },
  { id: FORWARD_FILTER_GROUP, name: '群消息' },
  ...props.messageGroups.map((item) => ({ id: item.id, name: item.name })),
  { id: FORWARD_FILTER_UNGROUPED, name: '未分组' }
])
const filteredForwardConversations = computed(() => {
  const keyword = forwardDialog.value.keyword.trim().toLowerCase()
  const groupId = forwardDialog.value.activeGroupId
  const list = props.conversations.filter((conversation) => {
    if (conversation.virtual || !conversation.conversationId) return false
    if (groupId === FORWARD_FILTER_SINGLE && conversation.conversationType !== 'single') return false
    if (groupId === FORWARD_FILTER_GROUP && conversation.conversationType !== 'group') return false
    if (groupId === FORWARD_FILTER_UNGROUPED && conversation.messageGroupId !== 0) return false
    if (groupId > 0 && conversation.messageGroupId !== groupId) return false
    return true
  })
  if (!keyword) return list
  return list.filter((conversation) =>
    [conversation.title, conversation.preview, conversation.peerUser?.account, conversation.peerUser?.imShortNo]
      .filter(Boolean)
      .some((text) => String(text).toLowerCase().includes(keyword))
  )
})
const selectedForwardTargetCount = computed(() => forwardDialog.value.targetConversationIds.length)
const forwardSubmitText = computed(() => {
  return selectedForwardTargetCount.value > 0 ? `确认转发(${selectedForwardTargetCount.value})` : '确认转发'
})
const canSelectForwardMode = computed(() => forwardDialog.value.messages.length > 1)
const activeForwardBundle = computed(() => {
  return forwardPreviewStack.value[forwardPreviewStack.value.length - 1] ?? forwardPreviewMessage.value?.forwardBundle ?? null
})
const canBackForwardPreview = computed(() => forwardPreviewStack.value.length > 1)
const isEditing = computed(() => Boolean(editingMessage.value))
const canMentionMembers = computed(() => props.conversation?.conversationType === 'group' &&
  props.conversation.groupAccessState !== 'history_only' && !isEditing.value)
const composerPlaceholder = computed(() => {
  if (!props.conversation) return '先选择一个会话'
  if (props.conversation.groupAccessState === 'history_only') return '当前群仅可查看授权历史'
  if (isEditing.value) return '编辑消息'
  if (replyMessage.value) return `回复 ${replyMessage.value.sender}`
  return canSend.value ? '发送消息' : 'IM 连接后可发送'
})
const composerSubmitText = computed(() => (isEditing.value ? '保存' : '发送'))
const mentionCandidates = computed(() => {
  if (!canMentionMembers.value) return []
  const keyword = mentionQuery.value.trim().toLowerCase()
  const rows = mentionMembers.value.filter((member) => !member.user.isSystem)
  const matched = keyword
    ? rows.filter((member) =>
        [member.user.nickname, member.user.account, member.user.imShortNo, member.user.remark]
          .filter(Boolean)
          .some((text) => String(text).toLowerCase().includes(keyword))
      )
    : rows
  return matched.slice(0, 8)
})
const showMentionPanel = computed(() => mentionPanelOpen.value && canMentionMembers.value)
const visibleSelectedMentions = computed(() => activeMentionsForText(draft.value))
const pendingPaste = ref<PendingPastePayload | null>(null)
const hasPendingPasteAsset = computed(() => Boolean(pendingPaste.value?.assets.length))
const pendingPasteTitle = computed(() => {
  const payload = pendingPaste.value
  if (!payload) return ''
  if (payload.assets.length > 0) {
    return payload.assets.length > 1 ? `发送 ${payload.assets.length} 个文件？` : '发送粘贴内容？'
  }
  return '发送粘贴文本？'
})
const pendingPasteTextPreview = computed(() => {
  const text = pendingPaste.value?.text ?? ''
  if (text.length <= MAX_PASTE_TEXT_PREVIEW_LENGTH) return text
  return `${text.slice(0, MAX_PASTE_TEXT_PREVIEW_LENGTH)}...`
})

const messageStreamRef = ref<HTMLElement | null>(null)
const showScrollToBottom = ref(false)
let shouldScrollActiveConversationToBottom = false
let mentionMembersConversationId = ''
const searchTypeFilters = [
  { label: '全部', value: 0 },
  { label: '文字', value: 1 },
  { label: '图片', value: 2 },
  { label: '文件', value: 3 },
  { label: '语音', value: 4 },
  { label: '视频', value: 11 }
]

function isNearMessageBottom(stream: HTMLElement) {
  return stream.scrollHeight - stream.scrollTop - stream.clientHeight <= BOTTOM_VISIBLE_THRESHOLD
}

function updateScrollToBottomState(stream = messageStreamRef.value) {
  showScrollToBottom.value = Boolean(props.conversation && stream && !isNearMessageBottom(stream))
}

function scrollMessagesToBottom(behavior: ScrollBehavior = 'smooth') {
  const stream = messageStreamRef.value
  if (!stream) return
  stream.scrollTo({ top: stream.scrollHeight, behavior })
  showScrollToBottom.value = false
}

function scrollMessagesToBottomAfterRender(behavior: ScrollBehavior = 'auto') {
  void nextTick(() => {
    window.requestAnimationFrame(() => {
      scrollMessagesToBottom(behavior)
      window.requestAnimationFrame(() => scrollMessagesToBottom(behavior))
    })
  })
}

function mentionDisplayName(member: GroupMember) {
  return member.user.remark || member.user.nickname || member.user.account || member.user.imShortNo || '成员'
}

function mentionPayload(member: GroupMember): MessageMention {
  return {
    userId: member.user.userId,
    nickname: mentionDisplayName(member),
    account: member.user.account,
    avatarUrl: member.user.avatarUrl
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function textMessageParts(message: Message): TextMessagePart[] {
  const mentions = message.mentions ?? []
  if (!message.content || mentions.length === 0) {
    return [{ text: message.content, mention: false }]
  }

  const names = [...new Set(mentions.map((mention) => mention.nickname).filter(Boolean))]
    .sort((left, right) => right.length - left.length)
  if (names.length === 0) return [{ text: message.content, mention: false }]

  const pattern = new RegExp(`@(${names.map(escapeRegExp).join('|')})`, 'g')
  const parts: TextMessagePart[] = []
  let cursor = 0
  for (const match of message.content.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > cursor) {
      parts.push({ text: message.content.slice(cursor, index), mention: false })
    }
    parts.push({ text: match[0], mention: true })
    cursor = index + match[0].length
  }
  if (cursor < message.content.length) {
    parts.push({ text: message.content.slice(cursor), mention: false })
  }
  return parts.length > 0 ? parts : [{ text: message.content, mention: false }]
}

function closeMentionPanel() {
  mentionPanelOpen.value = false
  mentionQuery.value = ''
  mentionStartIndex.value = -1
  activeMentionIndex.value = 0
}

function moveActiveMention(delta: number) {
  const total = mentionCandidates.value.length
  if (total <= 0) {
    activeMentionIndex.value = 0
    return
  }
  activeMentionIndex.value = (activeMentionIndex.value + delta + total) % total
}

async function ensureMentionMembers() {
  if (!canMentionMembers.value) return
  const conversationId = props.conversation?.conversationId ?? ''
  if (conversationId && mentionMembersConversationId === conversationId && mentionMembers.value.length > 0) return
  mentionLoading.value = true
  try {
    mentionMembers.value = await props.loadMentionMembers()
    mentionMembersConversationId = conversationId
  } catch (error) {
    mentionMembers.value = []
    mentionMembersConversationId = ''
    layer.error(error instanceof Error ? error.message : '群成员加载失败')
  } finally {
    mentionLoading.value = false
  }
}

function syncMentionPanelFromCaret() {
  if (!canMentionMembers.value) {
    closeMentionPanel()
    return
  }
  const input = composerInput.value
  const caret = input?.selectionStart ?? draft.value.length
  const beforeCaret = draft.value.slice(0, caret)
  const atIndex = beforeCaret.lastIndexOf('@')
  if (atIndex < 0) {
    closeMentionPanel()
    return
  }
  const query = beforeCaret.slice(atIndex + 1)
  if (query.length > 24 || /[\s@]/.test(query)) {
    closeMentionPanel()
    return
  }

  mentionStartIndex.value = atIndex
  mentionQuery.value = query
  mentionPanelOpen.value = true
  activeMentionIndex.value = 0
  void ensureMentionMembers()
}

function onComposerInput() {
  resizeComposerInput()
  syncMentionPanelFromCaret()
  if (!isEditing.value && draft.value.trim()) emit('typing')
}

async function openMentionFromButton() {
  if (!canMentionMembers.value) {
    layer.warning('只有群聊支持 @ 成员')
    return
  }
  const input = composerInput.value
  const caret = input?.selectionStart ?? draft.value.length
  const beforeCaret = draft.value.slice(0, caret)
  const afterCaret = draft.value.slice(caret)
  const prefix = beforeCaret && !/\s$/.test(beforeCaret) ? ' @' : '@'
  draft.value = `${beforeCaret}${prefix}${afterCaret}`
  const nextCaret = beforeCaret.length + prefix.length
  await nextTick()
  composerInput.value?.focus()
  composerInput.value?.setSelectionRange(nextCaret, nextCaret)
  resizeComposerInput()
  syncMentionPanelFromCaret()
}

async function selectMention(member: GroupMember) {
  const input = composerInput.value
  const caret = input?.selectionStart ?? draft.value.length
  const start = mentionStartIndex.value >= 0 ? mentionStartIndex.value : caret
  const mention = mentionPayload(member)
  const insertText = `@${mention.nickname} `
  draft.value = `${draft.value.slice(0, start)}${insertText}${draft.value.slice(caret)}`
  selectedMentions.value = [
    ...selectedMentions.value.filter((item) => item.userId !== mention.userId),
    mention
  ]
  closeMentionPanel()
  const nextCaret = start + insertText.length
  await nextTick()
  composerInput.value?.focus()
  composerInput.value?.setSelectionRange(nextCaret, nextCaret)
  resizeComposerInput()
}

async function removeSelectedMention(mention: MessageMention) {
  selectedMentions.value = selectedMentions.value.filter((item) => item.userId !== mention.userId)
  const tokenWithSpace = `@${mention.nickname} `
  const token = `@${mention.nickname}`
  let index = draft.value.indexOf(tokenWithSpace)
  let length = tokenWithSpace.length
  if (index < 0) {
    index = draft.value.indexOf(token)
    length = token.length
  }
  if (index >= 0) {
    draft.value = `${draft.value.slice(0, index)}${draft.value.slice(index + length)}`
  }
  await nextTick()
  resizeComposerInput()
  composerInput.value?.focus()
}

function activeMentionsForText(text: string) {
  const seen = new Set<string>()
  return selectedMentions.value.filter((mention) => {
    if (seen.has(mention.userId) || !text.includes(`@${mention.nickname}`)) return false
    seen.add(mention.userId)
    return true
  })
}

async function sendMessage() {
  const value = draft.value.trim()
  if (!value || !props.conversation) return

  if (editingMessage.value) {
    emit('edit-message', editingMessage.value, value)
    clearEditingState()
  } else {
    emit('send-text', value, replyMessage.value, activeMentionsForText(value))
    draft.value = ''
    selectedMentions.value = []
    closeMentionPanel()
    clearReplyState()
  }
  await nextTick()
  resizeComposerInput()
  scrollMessagesToBottomAfterRender('smooth')
}

function onKeydown(event: KeyboardEvent) {
  if (showMentionPanel.value) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveActiveMention(1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveActiveMention(-1)
      return
    }
    if (((event.key === 'Enter' && !event.ctrlKey && !event.metaKey) || event.key === 'Tab') && mentionCandidates.value.length > 0) {
      event.preventDefault()
      void selectMention(mentionCandidates.value[activeMentionIndex.value] ?? mentionCandidates.value[0])
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      closeMentionPanel()
      return
    }
  }
  if (event.key !== 'Enter') return
  if (event.ctrlKey || event.metaKey) {
    draft.value += '\n'
    return
  }
  event.preventDefault()
  void sendMessage()
}

function stateText(state?: Message['state']) {
  if (state === 'read') return '已读'
  if (state === 'delivered') return '已送达'
  if (state === 'sent') return '发送中'
  if (state === 'uploading') return '上传中'
  if (state === 'failed') return '发送失败'
  return ''
}

function canRecallMessage(message: Message) {
  return message.side === 'out' && Boolean(message.messageId) && message.type !== 'notice'
}

function canEditMessage(message: Message) {
  return message.side === 'out' && Boolean(message.messageId) && message.type === 'text'
}

function canReplyMessage(message: Message) {
  return Boolean(message.messageId) && message.type !== 'notice'
}

function canForwardMessage(message: Message) {
  if (!message.messageId) return false
  if (message.type === 'notice') return false
  if (message.type === 'text') return Boolean(message.content.trim())
  return Boolean(message.fileId && message.messageId && message.conversationId)
}

function getVoicePlayback(id: string): VoicePlaybackState {
  return voicePlayback.value[id] ?? { playing: false, currentTime: 0, duration: 0 }
}

function setVoicePlayback(id: string, patch: Partial<VoicePlaybackState>) {
  voicePlayback.value = {
    ...voicePlayback.value,
    [id]: {
      ...getVoicePlayback(id),
      ...patch
    }
  }
}

function setVoiceAudioRef(id: string, el: unknown) {
  if (el instanceof HTMLAudioElement) {
    voiceAudioElements.set(id, el)
    return
  }

  voiceAudioElements.delete(id)
}

function syncVoicePlayback(id: string, audio: HTMLAudioElement) {
  setVoicePlayback(id, {
    playing: !audio.paused && !audio.ended,
    currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
    duration: Number.isFinite(audio.duration) ? audio.duration : 0
  })
}

async function toggleVoicePlayback(message: Message) {
  let url = ''
  try {
    url = await props.resolveAssetUrl(message)
  } catch (error) {
    layer.warning(error instanceof Error ? error.message : '语音访问授权失败')
    return
  }
  await nextTick()
  const id = message.id
  const audio = voiceAudioElements.get(id)
  if (!audio) return
  if (audio.src !== url) {
    audio.src = url
    audio.load()
  }

  if (!audio.paused) {
    audio.pause()
    return
  }

  voiceAudioElements.forEach((item, itemId) => {
    if (itemId !== id && !item.paused) item.pause()
  })

  try {
    await audio.play()
  } catch (error) {
    console.warn('[VoicePlayback] play failed', error)
    layer.warning('音频播放失败')
  }
}

function voiceProgress(id: string) {
  const state = getVoicePlayback(id)
  if (!state.duration) return 0
  return Math.min(100, Math.max(0, (state.currentTime / state.duration) * 100))
}

function formatVoiceTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const totalSeconds = Math.floor(seconds)
  const minutes = Math.floor(totalSeconds / 60)
  const restSeconds = totalSeconds % 60
  return `${minutes}:${String(restSeconds).padStart(2, '0')}`
}

async function openMediaPreview(message: Message, type: 'image' | 'video') {
  let url = ''
  try {
    url = await props.resolveAssetUrl(message)
  } catch (error) {
    layer.warning(error instanceof Error ? error.message : '附件访问授权失败')
    return
  }
  mediaPreview.value = {
    visible: true,
    type,
    url,
    title: message.fileName || (type === 'image' ? '图片' : '视频')
  }
}

async function openPrivateAsset(message: Message) {
  const target = window.open('about:blank', '_blank')
  if (target) target.opener = null
  try {
    const url = await props.resolveAssetUrl(message)
    if (target) {
      target.location.replace(url)
    } else {
      window.location.assign(url)
    }
  } catch (error) {
    target?.close()
    layer.warning(error instanceof Error ? error.message : '附件访问授权失败')
  }
}

function refreshPrivateAsset(message: Message) {
  void props.resolveAssetUrl(message, true).catch((error) => {
    console.warn('[b8im:asset] URL refresh failed', error)
  })
}

function closeMediaPreview() {
  mediaPreview.value = {
    ...mediaPreview.value,
    visible: false
  }
}

function canDeleteSelfMessage(message: Message) {
  return props.canDeleteSelf && Boolean(message.messageId) && message.type !== 'notice'
}

function canDeleteBothMessage(message: Message) {
  return props.canDeleteBoth && message.side === 'out' && Boolean(message.messageId) && message.type !== 'notice'
}

function closeMessageMenu() {
  messageMenu.value.visible = false
}

function openMessageMenu(event: MouseEvent, message: Message) {
  event.preventDefault()
  event.stopPropagation()

  const hasAction = Boolean(message.content.trim()) || Boolean(message.url) || canRecallMessage(message) || canDeleteSelfMessage(message) || canDeleteBothMessage(message)
  if (!hasAction) {
    closeMessageMenu()
    return
  }

  emitCloseContextMenus('message')
  const menuWidth = 156
  const menuHeight = 256
  messageMenu.value = {
    visible: true,
    x: Math.min(event.clientX, window.innerWidth - menuWidth - 8),
    y: Math.min(event.clientY, window.innerHeight - menuHeight - 8),
    message
  }
}

function handleContextMenuClose(event: Event) {
  if (!isCloseFromSource(event, 'message')) {
    closeMessageMenu()
  }
}

function handleWindowKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && mediaPreview.value.visible) {
    closeMediaPreview()
  }
}

async function copyMenuMessage() {
  const message = activeMenuMessage.value
  const content = message?.content.trim()
  if (!content) return

  try {
    await navigator.clipboard.writeText(content)
    layer.success('已复制')
  } catch {
    layer.error('复制失败')
  } finally {
    closeMessageMenu()
  }
}

function openMenuMessageUrl() {
  const url = activeMenuMessage.value?.url
  if (!url) return
  window.open(url, '_blank', 'noopener,noreferrer')
  closeMessageMenu()
}

function recallMenuMessage() {
  const message = activeMenuMessage.value
  if (!message || !canRecallMessage(message)) return
  emit('recall-message', message)
  closeMessageMenu()
}

function deleteMenuMessage(scope: 'self' | 'both') {
  const message = activeMenuMessage.value
  if (!message) return
  if (scope === 'self' && !canDeleteSelfMessage(message)) return
  if (scope === 'both' && !canDeleteBothMessage(message)) return
  emit('delete-message', message, scope)
  closeMessageMenu()
}

async function startReplyMenuMessage() {
  const message = activeMenuMessage.value
  if (!message || !canReplyMessage(message)) return
  replyMessage.value = message
  editingMessage.value = null
  showEmoji.value = false
  closeMessageMenu()
  await nextTick()
  composerInput.value?.focus()
}

function startForwardMenuMessage() {
  const message = activeMenuMessage.value
  if (!message || !canForwardMessage(message)) return
  openForwardDialog([message])
  closeMessageMenu()
}

function startSelectMenuMessage() {
  const message = activeMenuMessage.value
  if (!message || message.type === 'notice') return
  selectionMode.value = true
  selectedMessageIds.value = [message.id]
  closeMessageMenu()
}

async function startEditMenuMessage() {
  const message = activeMenuMessage.value
  if (!message || !canEditMessage(message)) return
  editingMessage.value = message
  clearReplyState()
  draft.value = message.content
  showEmoji.value = false
  closeMessageMenu()
  await nextTick()
  composerInput.value?.focus()
}

function clearEditingState() {
  editingMessage.value = null
  draft.value = ''
  void nextTick(resizeComposerInput)
}

function clearReplyState() {
  replyMessage.value = null
}

function isMessageSelected(message: Message) {
  return selectedMessageIds.value.includes(message.id)
}

function toggleMessageSelection(message: Message) {
  if (!selectionMode.value || message.type === 'notice') return
  selectedMessageIds.value = isMessageSelected(message)
    ? selectedMessageIds.value.filter((id) => id !== message.id)
    : [...selectedMessageIds.value, message.id]
}

function handleMessageLineClick(message: Message) {
  if (selectionMode.value) {
    toggleMessageSelection(message)
    return
  }
  closeMessageMenu()
}

function exitSelectionMode() {
  selectionMode.value = false
  selectedMessageIds.value = []
}

function openForwardDialog(messages: Message[]) {
  const candidates = messages.filter(canForwardMessage)
  if (candidates.length === 0) {
    layer.warning('请选择可转发的消息')
    return
  }

  const firstConversation = props.conversations.find((conversation) => !conversation.virtual && conversation.conversationId)
  if (!firstConversation) {
    layer.warning('暂无可转发的会话')
    return
  }

  forwardDialog.value = {
    visible: true,
    keyword: '',
    activeGroupId: FORWARD_FILTER_ALL,
    targetConversationIds: [firstConversation.id],
    mode: 'separate',
    messages: candidates
  }
}

function closeForwardDialog() {
  forwardDialog.value.visible = false
}

function isForwardTargetSelected(conversationId: string) {
  return forwardDialog.value.targetConversationIds.includes(conversationId)
}

function toggleForwardTarget(conversationId: string) {
  forwardDialog.value.targetConversationIds = isForwardTargetSelected(conversationId)
    ? forwardDialog.value.targetConversationIds.filter((id) => id !== conversationId)
    : [...forwardDialog.value.targetConversationIds, conversationId]
}

function forwardSelectedMessages() {
  if (!canForwardSelected.value) return
  openForwardDialog(selectedMessages.value)
}

function confirmForwardMessages() {
  const targetConversationIds = forwardDialog.value.targetConversationIds
  if (targetConversationIds.length === 0) {
    layer.warning('请选择转发会话')
    return
  }
  emit('forward-messages', targetConversationIds, forwardDialog.value.messages, forwardDialog.value.mode)
  closeForwardDialog()
  exitSelectionMode()
}

function deleteSelectedMessages(scope: 'self' | 'both') {
  if (scope === 'self' && !canDeleteSelectedSelf.value) return
  if (scope === 'both' && !canDeleteSelectedBoth.value) return
  emit('delete-messages', selectedMessages.value, scope)
  exitSelectionMode()
}

function forwardItemTypeText(type: Message['type']) {
  if (type === 'image') return '[图片]'
  if (type === 'file') return '[文件]'
  if (type === 'voice') return '[语音]'
  if (type === 'video') return '[视频]'
  return ''
}

function forwardItemContentText(item: MessageForwardItem) {
  const marker = forwardItemTypeText(item.type)
  const content = String(item.content ?? '').trim()
  return marker && content.startsWith(marker) ? content.slice(marker.length).trim() : content
}

function forwardItemSummary(item: MessageForwardItem) {
  const marker = forwardItemTypeText(item.type)
  const content = forwardItemContentText(item)
  return `${marker}${content ? ` ${content}` : ''}`
}

function forwardItemFileName(item: MessageForwardItem, fallback: string) {
  return String(item.fileName || forwardItemContentText(item) || fallback)
}

function forwardItemMeta(item: MessageForwardItem) {
  return item.fileSize ? formatFileSize(Number(item.fileSize)) : ''
}

function openForwardItemMediaPreview(item: MessageForwardItem, type: 'image' | 'video') {
  if (!item.url) return
  mediaPreview.value = {
    visible: true,
    type,
    url: item.url,
    title: forwardItemFileName(item, type === 'image' ? '图片' : '视频')
  }
}

function openForwardPreview(message: Message) {
  if (selectionMode.value || !message.forwardBundle) return
  forwardPreviewMessage.value = message
  forwardPreviewStack.value = [message.forwardBundle]
  closeMessageMenu()
}

function openNestedForwardPreview(bundle?: MessageForwardBundle | null) {
  if (!bundle) return
  forwardPreviewStack.value = [...forwardPreviewStack.value, bundle]
}

function backForwardPreview() {
  if (!canBackForwardPreview.value) return
  forwardPreviewStack.value = forwardPreviewStack.value.slice(0, -1)
}

function closeForwardPreview() {
  forwardPreviewMessage.value = null
  forwardPreviewStack.value = []
}

function appendEmoji(emoji: string) {
  draft.value += emoji
  showEmoji.value = false
  void nextTick(() => {
    resizeComposerInput()
    composerInput.value?.focus()
  })
}

function resizeComposerInput() {
  const input = composerInput.value
  if (!input) return

  input.style.height = 'auto'
  const nextHeight = Math.min(
    COMPOSER_MAX_HEIGHT,
    Math.max(COMPOSER_MIN_HEIGHT, input.scrollHeight)
  )
  input.style.height = `${nextHeight}px`
  input.style.overflowY = input.scrollHeight > COMPOSER_MAX_HEIGHT ? 'auto' : 'hidden'
}

function pickFile(kind: 'image' | 'file' | 'voice' | 'video') {
  if (kind === 'image') imageInput.value?.click()
  else if (kind === 'voice') voiceInput.value?.click()
  else if (kind === 'video') videoInput.value?.click()
  else fileInput.value?.click()
}

function normalizeSelectedAssetKind(file: File, fallback: PastedAssetKind): PastedAssetKind {
  if (fallback === 'file' && file.type.startsWith('video/')) return 'video'
  return fallback
}

function onFileSelected(event: Event, kind: PastedAssetKind) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  emit('send-asset', file, normalizeSelectedAssetKind(file, kind))
}

function formatFileSize(value: number) {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  if (value >= 1024) return `${Math.ceil(value / 1024)} KB`
  return `${value} B`
}

function pasteAssetKind(file: File): PastedAssetKind {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('audio/')) return 'voice'
  if (file.type.startsWith('video/')) return 'video'
  return 'file'
}

function pasteAssetLabel(kind: PastedAssetKind) {
  if (kind === 'image') return '图片'
  if (kind === 'voice') return '语音文件'
  if (kind === 'video') return '视频'
  return '文件'
}

function createPendingPasteAsset(file: File, index: number): PendingPasteAsset {
  const kind = pasteAssetKind(file)
  const previewUrl = kind === 'image' ? URL.createObjectURL(file) : ''

  return {
    id: `${Date.now()}-${index}-${file.name || file.type || 'clipboard'}`,
    file,
    kind,
    name: file.name || (kind === 'image' ? '粘贴图片' : '粘贴文件'),
    sizeText: formatFileSize(file.size),
    previewUrl
  }
}

function clearPendingPaste() {
  pendingPaste.value?.assets.forEach((item) => {
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
  })
  pendingPaste.value = null
}

function clipboardFiles(data: DataTransfer) {
  const files = Array.from(data.files ?? [])
  if (files.length > 0) return files

  return Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file))
}

function canCapturePaste(event: ClipboardEvent) {
  if (!props.conversation || props.connectionState !== 'connected') {
    layer.warning(props.conversation ? 'IM连接未就绪，稍后再试' : '请先选择会话')
    return false
  }

  const target = event.target as HTMLElement | null
  if (target?.closest('.chat-search-dialog') || isEditing.value) return false

  return true
}

function onPaste(event: ClipboardEvent) {
  if (!canCapturePaste(event)) return

  const data = event.clipboardData
  if (!data) return

  const files = clipboardFiles(data)
  const text = files.length > 0 ? '' : data.getData('text/plain').trim()
  if (files.length === 0 && !text) return

  event.preventDefault()
  showEmoji.value = false
  clearPendingPaste()
  pendingPaste.value = {
    text,
    assets: files.map(createPendingPasteAsset)
  }
}

function confirmPendingPaste() {
  const payload = pendingPaste.value
  if (!payload || !props.conversation || props.connectionState !== 'connected') return

  payload.assets.forEach((item) => {
    emit('send-asset', item.file, item.kind)
  })

  if (payload.text) {
    emit('send-text', payload.text, null, [])
  }

  clearPendingPaste()
}

async function runSearch() {
  const value = searchKeyword.value.trim()
  if (!value) {
    searchResults.value = []
    return
  }
  searching.value = true
  try {
    searchResults.value = await props.searchMessages(value, searchMessageType.value || undefined)
  } finally {
    searching.value = false
  }
}

function openSearchPanel() {
  showSearch.value = true
  void nextTick(() => searchInput.value?.focus())
}

function closeSearchPanel() {
  showSearch.value = false
}

function toggleSearchPanel() {
  if (showSearch.value) {
    closeSearchPanel()
    return
  }
  openSearchPanel()
}

function selectSearchType(value: number) {
  searchMessageType.value = value
  if (searchKeyword.value.trim()) {
    void runSearch()
  }
}

function focusSearchResult(message: Message) {
  const stream = messageStreamRef.value
  if (!stream) return
  const node = stream.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(message.id)}"]`)
  if (!node) {
    layer.warning('该消息未在当前聊天窗口加载，可继续上拉加载历史后再定位')
    return
  }
  closeSearchPanel()
  node.scrollIntoView({ block: 'center', behavior: 'smooth' })
  node.classList.add('search-hit')
  window.setTimeout(() => node.classList.remove('search-hit'), 1600)
}

async function onMessageStreamScroll() {
  closeMessageMenu()
  const stream = messageStreamRef.value
  updateScrollToBottomState(stream)
  if (!stream || !props.conversation || !props.canLoadOlder || props.loadingOlder) return
  if (stream.scrollTop > 24) return

  const previousHeight = stream.scrollHeight
  const previousTop = stream.scrollTop
  const loaded = await props.loadOlderMessages()
  if (!loaded) return

  await nextTick()
  stream.scrollTop = stream.scrollHeight - previousHeight + previousTop
  updateScrollToBottomState(stream)
}

watch(
  () => props.conversation?.id,
  (conversationId) => {
    // Drafts are runtime-only and must never cross a conversation identity;
    // revocation removes the active identity through this same path.
    draft.value = ''
    shouldScrollActiveConversationToBottom = Boolean(conversationId)
    if (editingMessage.value) {
      clearEditingState()
    }
    clearReplyState()
    exitSelectionMode()
    closeForwardDialog()
    closeForwardPreview()
    closeMentionPanel()
    showEmoji.value = false
    selectedMentions.value = []
    mentionMembers.value = []
    mentionMembersConversationId = ''
    searchResults.value = []
    showScrollToBottom.value = false
    void nextTick(resizeComposerInput)
    if (conversationId && props.messages.length > 0) {
      shouldScrollActiveConversationToBottom = false
      scrollMessagesToBottomAfterRender()
    }
  }
)

function clearGroupAccessDerivedState() {
  draft.value = ''
  clearPendingPaste()
  clearEditingState()
  clearReplyState()
  exitSelectionMode()
  closeForwardDialog()
  closeForwardPreview()
  closeMentionPanel()
  closeMessageMenu()
  mediaPreview.value = { visible: false, type: 'image', url: '', title: '' }
  showSearch.value = false
  searchKeyword.value = ''
  searchResults.value = []
  mentionMembers.value = []
  selectedMentions.value = []
  voiceAudioElements.forEach((audio) => audio.pause())
  voicePlayback.value = {}
}

watch(() => props.openSearchToken, (token) => {
  if (token > 0) {
    openSearchPanel()
  }
})

watch(draft, () => {
  void nextTick(resizeComposerInput)
})

watch(mentionCandidates, (items) => {
  activeMentionIndex.value = Math.min(activeMentionIndex.value, Math.max(items.length - 1, 0))
})

watch(
  () => props.messages.length,
  (messageCount, previousMessageCount = 0) => {
    const stream = messageStreamRef.value
    const addedMessages = messageCount > previousMessageCount
    const shouldKeepAtBottom =
      Boolean(props.conversation) &&
      addedMessages &&
      (
        shouldScrollActiveConversationToBottom ||
        previousMessageCount === 0 ||
        (stream ? isNearMessageBottom(stream) : false)
      )

    if (shouldKeepAtBottom) {
      shouldScrollActiveConversationToBottom = false
      scrollMessagesToBottomAfterRender()
      return
    }

    void nextTick(updateScrollToBottomState)
  }
)

onMounted(() => {
  resizeComposerInput()
  window.addEventListener(CONTEXT_MENU_CLOSE_EVENT, handleContextMenuClose)
  window.addEventListener('keydown', handleWindowKeydown)
  window.addEventListener(GROUP_ACCESS_BROWSER_EVENT, clearGroupAccessDerivedState)
  if (props.conversation && props.messages.length > 0) {
    scrollMessagesToBottomAfterRender()
  }
})

onBeforeUnmount(() => {
  window.removeEventListener(CONTEXT_MENU_CLOSE_EVENT, handleContextMenuClose)
  window.removeEventListener('keydown', handleWindowKeydown)
  window.removeEventListener(GROUP_ACCESS_BROWSER_EVENT, clearGroupAccessDerivedState)
  voiceAudioElements.forEach((audio) => audio.pause())
  voiceAudioElements.clear()
  clearPendingPaste()
})
</script>

<template>
  <main class="chat-shell" @click="closeMessageMenu" @paste="onPaste">
    <header class="chat-header">
      <div>
        <h2>{{ conversation?.title || '消息' }}</h2>
        <p>{{ onlineText }} · {{ conversation?.isMuted ? '免打扰' : '通知开启' }}</p>
      </div>
      <div class="chat-actions">
        <button class="icon-button" :class="{ active: showSearch }" title="搜索" @click="toggleSearchPanel"><Search :size="18" /></button>
        <button
          class="icon-button"
          :class="{ active: showInfo }"
          title="聊天详情"
          @click="emit('toggle-info')"
        >
          <MoreHorizontal :size="20" />
        </button>
      </div>
    </header>

    <div class="message-stream-wrap">
      <section ref="messageStreamRef" class="message-stream" aria-label="消息列表" @scroll="onMessageStreamScroll">
        <div v-if="conversation" class="history-loader" :class="{ active: loadingOlder }">
          {{ loadingOlder ? '加载中...' : (canLoadOlder ? '上拉加载更多' : '没有更多聊天记录') }}
        </div>
        <div v-if="!conversation" class="chat-empty-state">
          <strong>选择一个会话开始聊天</strong>
          <span>也可以从联系人里向好友发起聊天。</span>
        </div>
        <div v-else-if="messages.length === 0" class="chat-empty-state">
          <strong>还没有消息</strong>
          <span>发送第一条消息后，会同步到 IM 长连接服务。</span>
        </div>
        <article
          v-for="message in messages"
          v-asset-visible="message"
          :key="message.id"
          :data-message-id="message.id"
          class="message-line"
          :class="[
            message.side,
            message.type,
            {
              selecting: selectionMode,
              selected: isMessageSelected(message),
              forwarded: message.forwardBundle,
              media: ['image', 'voice', 'video'].includes(message.type)
            }
          ]"
          @click.stop="handleMessageLineClick(message)"
          @contextmenu="openMessageMenu($event, message)"
        >
          <template v-if="message.side === 'system'">
            <span class="system-pill">{{ message.content }}</span>
          </template>
          <template v-else>
            <span class="avatar mini">
              <img v-if="message.avatarUrl" :src="message.avatarUrl" :alt="message.sender" />
              <template v-else>{{ message.avatar }}</template>
            </span>
            <label v-if="selectionMode && message.type !== 'notice'" class="message-select-control" @click.stop>
              <input
                type="checkbox"
                :checked="isMessageSelected(message)"
                @change="toggleMessageSelection(message)"
              />
            </label>
            <div class="message-pack">
              <span v-if="message.side === 'in'" class="sender-name">{{ message.sender }}</span>
              <div class="bubble">
                <div v-if="message.quote" class="message-quote">
                  <strong>{{ message.quote.sender }}</strong>
                  <span>{{ message.quote.content }}</span>
                </div>
                <button
                  v-if="message.forwardBundle"
                  class="forward-message-card"
                  type="button"
                  @click.stop="openForwardPreview(message)"
                >
                  <span class="forward-card-head">
                    <span class="forward-card-icon">
                      <Forward :size="18" />
                    </span>
                    <span class="forward-card-title">
                      <strong>{{ message.forwardBundle.title }}</strong>
                      <span>{{ message.forwardBundle.count }} 条消息</span>
                    </span>
                  </span>
                  <span class="forward-card-list">
                    <small v-for="(item, index) in message.forwardBundle.items.slice(0, 3)" :key="`${item.sender}-${index}`">
                      <b>{{ item.sender }}</b>
                      <i>{{ forwardItemSummary(item) }}</i>
                    </small>
                  </span>
                  <em>
                    查看聊天记录
                    <ChevronRight :size="15" />
                  </em>
                </button>
                <template v-else-if="message.type === 'text'">
                  <template v-for="(part, partIndex) in textMessageParts(message)" :key="`${message.id}-part-${partIndex}`">
                    <span v-if="part.mention" class="mention-token">{{ part.text }}</span>
                    <template v-else>{{ part.text }}</template>
                  </template>
                </template>
                <div v-else-if="message.type === 'image'" class="image-message">
                  <button
                    v-if="message.url"
                    class="image-preview-button"
                    type="button"
                    :aria-label="`查看图片：${message.fileName || message.content || '图片'}`"
                    @click.stop="openMediaPreview(message, 'image')"
                  >
                    <img
                      :src="message.url"
                      :alt="message.fileName || message.content"
                      @error="refreshPrivateAsset(message)"
                    />
                  </button>
                  <span v-else class="image-thumb">IMG</span>
                  <div v-if="message.state === 'uploading'" class="upload-progress">
                    <span :style="{ width: `${message.uploadProgress ?? 1}%` }"></span>
                  </div>
                </div>
                <div v-else-if="message.type === 'file'" class="file-message">
                  <FilePlus2 :size="24" />
                  <span>
                    <a
                      v-if="message.url"
                      :href="message.url"
                      target="_blank"
                      rel="noreferrer"
                      @click.prevent.stop="openPrivateAsset(message)"
                    >
                      {{ message.fileName || '打开文件' }}
                    </a>
                    <strong v-else>{{ message.fileName || '文件' }}</strong>
                    <small>{{ message.meta }}</small>
                    <div v-if="message.state === 'uploading'" class="upload-progress">
                      <span :style="{ width: `${message.uploadProgress ?? 1}%` }"></span>
                    </div>
                  </span>
                </div>
                <div v-else-if="message.type === 'video'" class="video-message">
                  <button
                    v-if="message.url"
                    class="video-preview-button"
                    type="button"
                    :aria-label="`查看视频：${message.fileName || '视频'}`"
                    @click.stop="openMediaPreview(message, 'video')"
                  >
                    <video
                      :src="message.url"
                      muted
                      preload="metadata"
                      playsinline
                      @error="refreshPrivateAsset(message)"
                    ></video>
                    <span class="video-preview-play">
                      <Play :size="20" />
                    </span>
                  </button>
                  <span v-else class="video-file-card">
                    <Video :size="24" />
                    <strong>{{ message.fileName || '视频' }}</strong>
                    <small>{{ message.meta }}</small>
                  </span>
                  <div v-if="message.state === 'uploading'" class="upload-progress">
                    <span :style="{ width: `${message.uploadProgress ?? 1}%` }"></span>
                  </div>
                </div>
                <div v-else-if="message.type === 'voice'" class="voice-message">
                  <span class="voice-message-icon">
                    <Mic :size="18" />
                  </span>
                  <span class="voice-message-player">
                    <template v-if="message.url">
                      <audio
                        :ref="(el) => setVoiceAudioRef(message.id, el)"
                        class="voice-native-audio"
                        :src="message.url"
                        preload="metadata"
                        @error="refreshPrivateAsset(message)"
                        @loadedmetadata="syncVoicePlayback(message.id, $event.currentTarget as HTMLAudioElement)"
                        @timeupdate="syncVoicePlayback(message.id, $event.currentTarget as HTMLAudioElement)"
                        @play="syncVoicePlayback(message.id, $event.currentTarget as HTMLAudioElement)"
                        @pause="syncVoicePlayback(message.id, $event.currentTarget as HTMLAudioElement)"
                        @ended="syncVoicePlayback(message.id, $event.currentTarget as HTMLAudioElement)"
                      ></audio>
                      <span class="voice-control">
                        <button type="button" title="播放语音" @click.stop="toggleVoicePlayback(message)">
                          <Pause v-if="getVoicePlayback(message.id).playing" :size="14" />
                          <Play v-else :size="14" />
                        </button>
                        <span class="voice-progress">
                          <i :style="{ width: `${voiceProgress(message.id)}%` }"></i>
                        </span>
                        <small>
                          {{ formatVoiceTime(getVoicePlayback(message.id).duration || getVoicePlayback(message.id).currentTime) }}
                        </small>
                      </span>
                    </template>
                    <span v-else class="voice-message-text">{{ message.content }}</span>
                  </span>
                  <div v-if="message.state === 'uploading'" class="upload-progress">
                    <span :style="{ width: `${message.uploadProgress ?? 1}%` }"></span>
                  </div>
                </div>
                <template v-else>{{ message.content }}</template>
              </div>
              <span v-if="message.time" class="message-meta">
                <span>{{ message.time }}</span>
                <span v-if="message.state">· {{ stateText(message.state) }}</span>
                <span v-if="message.editCount">· 已编辑</span>
                <button
                  v-if="canRecallMessage(message)"
                  class="message-action"
                  type="button"
                  title="撤回消息"
                  @click="emit('recall-message', message)"
                >
                  撤回
                </button>
              </span>
            </div>
          </template>
        </article>
      </section>
      <button
        v-if="showScrollToBottom"
        class="scroll-bottom-button"
        type="button"
        title="返回底部"
        aria-label="返回底部"
        @click.stop="scrollMessagesToBottom()"
      >
        <ArrowDownToLine :size="20" />
      </button>
    </div>

    <div v-if="showSearch" class="chat-search-overlay" @click.self="closeSearchPanel">
      <section class="chat-search-dialog" role="dialog" aria-modal="true" aria-label="查找聊天内容">
        <header>
          <div>
            <h3>查找聊天内容</h3>
            <p>{{ conversation?.title || '当前会话' }}</p>
          </div>
          <button type="button" title="关闭" @click="closeSearchPanel">
            <X :size="19" />
          </button>
        </header>
        <form class="chat-search-row" @submit.prevent="runSearch">
          <input ref="searchInput" v-model="searchKeyword" placeholder="搜索当前聊天记录" />
          <button class="send-button" type="submit">{{ searching ? '搜索中...' : '搜索' }}</button>
        </form>
        <div class="chat-search-filters">
          <button
            v-for="filter in searchTypeFilters"
            :key="filter.value"
            type="button"
            :class="{ active: searchMessageType === filter.value }"
            @click="selectSearchType(filter.value)"
          >
            {{ filter.label }}
          </button>
        </div>
        <div v-if="searchResults.length" class="chat-search-results">
          <button v-for="message in searchResults" :key="message.id" type="button" @click="focusSearchResult(message)">
            <strong>{{ message.sender }}</strong>
            <span>{{ message.content }}</span>
            <small>{{ message.time }}</small>
          </button>
        </div>
        <div v-else class="chat-search-empty">
          {{ searchKeyword.trim() ? (searching ? '正在搜索...' : '没有找到相关聊天记录') : '输入关键词后搜索文字、文件、图片等记录' }}
        </div>
      </section>
    </div>

    <div
      v-if="messageMenu.visible && activeMenuMessage"
      class="message-context-menu"
      :style="{ left: `${messageMenu.x}px`, top: `${messageMenu.y}px` }"
      @click.stop
      @contextmenu.prevent
    >
      <button v-if="canCopyMenuMessage" type="button" @click="copyMenuMessage">复制</button>
      <button v-if="canOpenMenuMessage" type="button" @click="openMenuMessageUrl">打开</button>
      <button v-if="canReplyMenuMessage" type="button" @click="startReplyMenuMessage">回复</button>
      <button v-if="canForwardMenuMessage" type="button" @click="startForwardMenuMessage">转发</button>
      <button type="button" @click="startSelectMenuMessage">多选</button>
      <button v-if="canEditMenuMessage" type="button" @click="startEditMenuMessage">编辑</button>
      <button v-if="canDeleteSelfMenuMessage" type="button" @click="deleteMenuMessage('self')">仅自己删除</button>
      <button v-if="canDeleteBothMenuMessage" class="danger" type="button" @click="deleteMenuMessage('both')">双方删除</button>
      <button v-if="canRecallMenuMessage" class="danger" type="button" @click="recallMenuMessage">撤回</button>
    </div>

    <div v-if="selectionMode" class="selection-action-bar">
      <span>已选择 {{ selectedCount }} 条</span>
      <button type="button" :disabled="!canForwardSelected" @click="forwardSelectedMessages">
        <Forward :size="16" />
        转发
      </button>
      <button type="button" :disabled="!canDeleteSelectedSelf" @click="deleteSelectedMessages('self')">
        <Trash2 :size="16" />
        删除
      </button>
      <button type="button" :disabled="!canDeleteSelectedBoth" @click="deleteSelectedMessages('both')">
        <Trash2 :size="16" />
        双方删除
      </button>
      <button type="button" @click="exitSelectionMode">
        <X :size="16" />
        取消
      </button>
    </div>

    <footer class="composer">
      <div v-if="editingMessage" class="composer-edit-bar">
        <span>正在编辑：{{ editingMessage.content }}</span>
        <button type="button" @click="clearEditingState">取消</button>
      </div>
      <div v-else-if="replyMessage" class="composer-edit-bar reply">
        <span>回复 {{ replyMessage.sender }}：{{ replyMessage.content }}</span>
        <button type="button" @click="clearReplyState">取消</button>
      </div>
      <div v-if="!isEditing" class="composer-tools">
        <button
          v-if="canMentionMembers"
          type="button"
          aria-label="@成员"
          data-tooltip="@成员"
          @click="openMentionFromButton"
        >
          <AtSign :size="20" />
        </button>
        <button type="button" aria-label="表情" data-tooltip="表情" @click="showEmoji = !showEmoji">
          <SmilePlus :size="20" />
        </button>
        <button type="button" aria-label="截图" data-tooltip="截图" @click="emit('screenshot')">
          <Scissors :size="20" />
        </button>
        <button type="button" aria-label="图片" data-tooltip="图片" @click="pickFile('image')">
          <Image :size="20" />
        </button>
        <button type="button" aria-label="视频" data-tooltip="视频" @click="pickFile('video')">
          <Video :size="20" />
        </button>
        <button type="button" aria-label="文件" data-tooltip="文件" @click="pickFile('file')">
          <FilePlus2 :size="20" />
        </button>
        <button type="button" aria-label="语音文件" data-tooltip="语音文件" @click="pickFile('voice')">
          <Mic :size="20" />
        </button>
      </div>
      <div v-if="showEmoji" class="emoji-panel" aria-label="选择表情">
        <button v-for="emoji in emojis" :key="emoji" type="button" @click="appendEmoji(emoji)">{{ emoji }}</button>
      </div>
      <div v-if="showMentionPanel" class="mention-panel" aria-label="@成员">
        <div v-if="mentionLoading" class="mention-empty">加载群成员...</div>
        <template v-else-if="mentionCandidates.length > 0">
          <button
            v-for="(member, index) in mentionCandidates"
            :key="member.user.userId"
            type="button"
            :class="{ active: index === activeMentionIndex }"
            :aria-selected="index === activeMentionIndex"
            @mousedown.prevent="selectMention(member)"
          >
            <span class="avatar mini">
              <img v-if="member.user.avatarUrl" :src="member.user.avatarUrl" :alt="mentionDisplayName(member)" />
              <template v-else>{{ mentionDisplayName(member).slice(0, 1) }}</template>
            </span>
            <span>
              <strong>{{ mentionDisplayName(member) }}</strong>
              <small>{{ member.user.account || member.user.imShortNo }}</small>
            </span>
          </button>
        </template>
        <div v-else class="mention-empty">没有匹配的群成员</div>
      </div>
      <div v-if="visibleSelectedMentions.length" class="mention-chip-row" aria-label="已@成员">
        <span v-for="mention in visibleSelectedMentions" :key="mention.userId" class="mention-chip">
          @{{ mention.nickname }}
          <button type="button" title="移除@成员" @click="removeSelectedMention(mention)">
            <X :size="12" />
          </button>
        </span>
      </div>
      <input ref="imageInput" class="hidden-file-input" type="file" accept="image/*" @change="onFileSelected($event, 'image')" />
      <input ref="fileInput" class="hidden-file-input" type="file" @change="onFileSelected($event, 'file')" />
      <input ref="voiceInput" class="hidden-file-input" type="file" accept="audio/*" @change="onFileSelected($event, 'voice')" />
      <input ref="videoInput" class="hidden-file-input" type="file" accept="video/*" @change="onFileSelected($event, 'video')" />
      <div class="composer-input-row">
        <textarea
          ref="composerInput"
          v-model="draft"
          :placeholder="composerPlaceholder"
          rows="2"
          :disabled="!canSend"
          @input="onComposerInput"
          @click="syncMentionPanelFromCaret"
          @keydown="onKeydown"
        />
        <button class="send-button" type="button" :disabled="!canSend" @click="sendMessage">
          <Send :size="17" />
          {{ composerSubmitText }}
        </button>
      </div>
      <p>{{ isEditing ? 'Enter 保存，Ctrl + Enter 换行' : 'Enter 发送，Ctrl + Enter 换行' }}</p>
    </footer>

    <div v-if="forwardDialog.visible" class="forward-dialog-overlay" @click.self="closeForwardDialog">
      <section class="forward-dialog" role="dialog" aria-modal="true" aria-label="转发消息">
        <header>
          <div>
            <h3>转发消息</h3>
            <p>{{ forwardDialog.messages.length }} 条消息</p>
          </div>
          <button type="button" title="关闭" @click="closeForwardDialog">×</button>
        </header>
        <div v-if="canSelectForwardMode" class="forward-mode-tabs" aria-label="转发方式">
          <button
            type="button"
            :class="{ active: forwardDialog.mode === 'separate' }"
            @click="forwardDialog.mode = 'separate'"
          >
            逐条转发
          </button>
          <button
            type="button"
            :class="{ active: forwardDialog.mode === 'merged' }"
            @click="forwardDialog.mode = 'merged'"
          >
            合并转发
          </button>
        </div>
        <input v-model="forwardDialog.keyword" class="forward-search" placeholder="搜索会话" />
        <div class="forward-group-tabs" aria-label="转发会话分组">
          <button
            v-for="group in forwardGroupFilters"
            :key="group.id"
            type="button"
            :class="{ active: forwardDialog.activeGroupId === group.id }"
            @click="forwardDialog.activeGroupId = group.id"
          >
            {{ group.name }}
          </button>
        </div>
        <div class="forward-conversation-list">
          <button
            v-for="item in filteredForwardConversations"
            :key="item.id"
            type="button"
            :class="{ active: isForwardTargetSelected(item.id) }"
            @click="toggleForwardTarget(item.id)"
          >
            <ConversationAvatar
              :title="item.title"
              :avatar="item.avatar"
              :peer-avatar-url="item.peerUser?.avatarUrl"
              :avatar-members="item.avatarMembers"
              :conversation-type="item.conversationType"
              mini
            />
            <span>{{ item.title }}</span>
            <CheckSquare v-if="isForwardTargetSelected(item.id)" :size="16" />
          </button>
          <p v-if="filteredForwardConversations.length === 0">没有匹配的会话</p>
        </div>
        <footer>
          <button type="button" class="ghost-button" @click="closeForwardDialog">取消</button>
          <button type="button" class="send-button" :disabled="selectedForwardTargetCount === 0" @click="confirmForwardMessages">
            <Forward :size="17" />
            {{ forwardSubmitText }}
          </button>
        </footer>
      </section>
    </div>

    <div v-if="activeForwardBundle" class="forward-preview-overlay" @click.self="closeForwardPreview">
      <section class="forward-preview-dialog" role="dialog" aria-modal="true" aria-label="合并转发详情">
        <header>
          <button
            v-if="canBackForwardPreview"
            type="button"
            class="forward-preview-back"
            @click="backForwardPreview"
          >
            返回
          </button>
          <div class="forward-preview-title">
            <h3>{{ activeForwardBundle.title }}</h3>
            <p>{{ activeForwardBundle.count }} 条消息</p>
          </div>
          <button type="button" title="关闭" @click="closeForwardPreview">×</button>
        </header>
        <div class="forward-preview-list">
          <article v-for="(item, index) in activeForwardBundle.items" :key="`${item.sender}-${index}`">
            <div>
              <strong>{{ item.sender }}</strong>
              <span>{{ item.time }}</span>
            </div>
            <button
              v-if="item.forwardBundle"
              type="button"
              class="forward-preview-nested"
              @click="openNestedForwardPreview(item.forwardBundle)"
            >
              <span class="forward-card-icon">
                <Forward :size="17" />
              </span>
              <span>
                <strong>{{ item.forwardBundle.title }}</strong>
                <small>{{ item.forwardBundle.count }} 条消息</small>
              </span>
              <ChevronRight :size="16" />
            </button>
            <button
              v-else-if="item.type === 'image' && item.url"
              type="button"
              class="forward-preview-media forward-preview-image"
              :aria-label="`查看图片：${forwardItemFileName(item, '图片')}`"
              @click="openForwardItemMediaPreview(item, 'image')"
            >
              <img :src="item.url" :alt="forwardItemFileName(item, '图片')" />
            </button>
            <a
              v-else-if="item.type === 'file' && item.url"
              class="forward-preview-file"
              :href="item.url"
              target="_blank"
              rel="noreferrer"
            >
              <FilePlus2 :size="22" />
              <span>
                <strong>{{ forwardItemFileName(item, '文件') }}</strong>
                <small v-if="forwardItemMeta(item)">{{ forwardItemMeta(item) }}</small>
              </span>
            </a>
            <button
              v-else-if="item.type === 'video' && item.url"
              type="button"
              class="forward-preview-media forward-preview-video"
              :aria-label="`查看视频：${forwardItemFileName(item, '视频')}`"
              @click="openForwardItemMediaPreview(item, 'video')"
            >
              <video :src="item.url" muted preload="metadata" playsinline></video>
              <span>
                <Play :size="18" />
              </span>
            </button>
            <div v-else-if="item.type === 'voice' && item.url" class="forward-preview-file forward-preview-voice">
              <Mic :size="22" />
              <span>
                <strong>{{ forwardItemFileName(item, '语音') }}</strong>
                <small v-if="forwardItemMeta(item)">{{ forwardItemMeta(item) }}</small>
                <audio :src="item.url" controls preload="metadata"></audio>
              </span>
            </div>
            <p v-else>{{ forwardItemSummary(item) }}</p>
          </article>
          <p v-if="activeForwardBundle.items.length === 0" class="forward-preview-empty">暂无可预览内容</p>
        </div>
        <footer>
          <button type="button" class="send-button" @click="closeForwardPreview">关闭</button>
        </footer>
      </section>
    </div>

    <div v-if="mediaPreview.visible" class="media-preview-overlay" @click.self="closeMediaPreview">
      <section class="media-preview-dialog" role="dialog" aria-modal="true" :aria-label="mediaPreview.title">
        <header>
          <h3>{{ mediaPreview.title }}</h3>
          <button type="button" title="关闭" @click="closeMediaPreview">
            <X :size="20" />
          </button>
        </header>
        <div class="media-preview-body">
          <img
            v-if="mediaPreview.type === 'image'"
            :src="mediaPreview.url"
            :alt="mediaPreview.title"
          />
          <video
            v-else
            :key="mediaPreview.url"
            :src="mediaPreview.url"
            controls
            autoplay
            preload="metadata"
          ></video>
        </div>
      </section>
    </div>

    <div v-if="pendingPaste" class="paste-confirm-overlay" @click.self="clearPendingPaste">
      <section class="paste-confirm-dialog" role="dialog" aria-modal="true" :aria-label="pendingPasteTitle">
        <header>
          <div>
            <h3>{{ pendingPasteTitle }}</h3>
            <p>{{ conversation?.title }}</p>
          </div>
          <button type="button" title="关闭" @click="clearPendingPaste">×</button>
        </header>

        <div class="paste-confirm-body">
          <div v-if="hasPendingPasteAsset" class="paste-asset-list">
            <article v-for="item in pendingPaste.assets" :key="item.id" class="paste-asset-item">
              <img v-if="item.previewUrl" :src="item.previewUrl" :alt="item.name" />
              <span v-else class="paste-file-mark">{{ pasteAssetLabel(item.kind) }}</span>
              <div>
                <strong>{{ item.name }}</strong>
                <small>{{ pasteAssetLabel(item.kind) }} · {{ item.sizeText }}</small>
              </div>
            </article>
          </div>

          <p v-if="pendingPaste.text" class="paste-text-preview">{{ pendingPasteTextPreview }}</p>
        </div>

        <footer>
          <button type="button" class="ghost-button" @click="clearPendingPaste">取消</button>
          <button type="button" class="send-button" @click="confirmPendingPaste">
            <Send :size="17" />
            确认发送
          </button>
        </footer>
      </section>
    </div>
  </main>
</template>

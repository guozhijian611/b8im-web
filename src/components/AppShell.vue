<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue'
import {
  Bot,
  CircleUserRound,
  ContactRound,
  FolderOpen,
  Headphones,
  Languages,
  Megaphone,
  MessageCircle,
  Search,
  Smile,
  Star
} from '@lucide/vue'
import AnnouncementView from './AnnouncementView.vue'
import AnnouncementPopup from './AnnouncementPopup.vue'
import AvatarCropDialog from './AvatarCropDialog.vue'
import ChatWindow from './ChatWindow.vue'
import ContactsView from './ContactsView.vue'
import ConversationList from './ConversationList.vue'
import InfoPanel from './InfoPanel.vue'
import LockScreenView from './LockScreenView.vue'
import ModuleWorkbenchView from './ModuleWorkbenchView.vue'
import SettingsView from './SettingsView.vue'
import SideRail from './SideRail.vue'
import { useImRuntime } from '../composables/useImRuntime'
import { layer } from '../services/layer'
import { CONVERSATION_ACCESS_BROWSER_EVENT } from '../services/conversationAccess'
import {
  availableClientTabbar,
  clientModuleTitle,
  isClientModuleAvailable,
  type ClientModuleKey,
  type WebClientConfig
} from '../services/clientModules'
import {
  clearLockPassword,
  loadLockScreenState,
  saveLockPassword,
  setLockScreenLocked,
  verifyLockPassword
} from '../services/lockScreen'
import { installNotificationSoundUnlock, playNotificationSound } from '../services/notification'
import type { TenantBrandConfig } from '../services/tenantConfig'
import {
  setTitleNotifierBaseTitle,
  setTitleNotifierUnreadCount
} from '../services/titleNotifier'
import {
  fetchContacts,
  fetchFriendRequests,
  fetchGroupMembers,
  updateWebAvatar,
  uploadImAsset
} from '../services/webIm'
import type {
  Contact,
  FriendRequest,
  FriendRequestPushEvent,
  GroupMember,
  LockScreenSettings,
  MessageGroupLayout,
  NotificationSettings,
  PrimaryView,
  RailItem,
  ThemeMode,
  WatermarkSettings,
  WebImSession
} from '../types'

const WATERMARK_STORAGE_KEY = 'b8im_web_watermark_settings'
const THEME_STORAGE_KEY = 'b8im_web_theme_mode'
const NOTIFICATION_STORAGE_KEY = 'b8im_web_notification_settings'
const MESSAGE_GROUP_LAYOUT_STORAGE_KEY = 'b8im_web_message_group_layout'
const CONVERSATION_PANEL_WIDTH_STORAGE_KEY = 'b8im_web_conversation_panel_width'
const DEFAULT_WATERMARK_OPACITY = 0.12
const DEFAULT_WATERMARK_COLOR = '#1f2a37'
const DEFAULT_CONVERSATION_PANEL_WIDTH = 320
const MIN_CONVERSATION_PANEL_WIDTH = 280
const MAX_CONVERSATION_PANEL_WIDTH = 560
const RAIL_WIDTH = 64
const COMPACT_RAIL_WIDTH = 58
const CHAT_MIN_WIDTH = 520
const COMPACT_CHAT_MIN_WIDTH = 460
const INFO_PANEL_WIDTH = 340
const RESIZER_WIDTH = 1

const props = defineProps<{
  activeView: PrimaryView
  account: {
    org: string
    username: string
  }
  tenantConfig: TenantBrandConfig
  webSession: WebImSession
  clientConfig: WebClientConfig | null
}>()

const emit = defineEmits<{
  'update:activeView': [PrimaryView]
  'session-updated': [WebImSession]
  logout: []
}>()

const showInfo = ref(false)
const showSettings = ref(false)
const showAvatarCrop = ref(false)
const avatarSaving = ref(false)
const openSearchToken = ref(0)
const groupProfileSaving = ref(false)
const watermarkTiles = Array.from({ length: 54 }, (_, index) => index)
const notificationSettings = ref<NotificationSettings>(loadNotificationSettings())
const lockScreenSettings = ref<LockScreenSettings>(loadLockScreenState(props.webSession))
const lockPasswordSaving = ref(false)
const lockUnlocking = ref(false)
const lockUnlockError = ref('')
const windowWidth = ref(window.innerWidth)
const conversationPanelWidth = ref(loadConversationPanelWidth())
const isConversationResizing = ref(false)
const conversationResizeDrag = {
  pointerId: -1,
  startX: 0,
  startWidth: DEFAULT_CONVERSATION_PANEL_WIDTH
}
const {
  connectionState,
  heartbeatPulse,
  messageGroups,
  conversations,
  notifiableUnread,
  activeCanLoadOlder,
  messageDeleteConfig,
  activeConversationId,
  activeConversation,
  activeMessages,
  activeTypingText,
  loadingOlderMessages,
  boot,
  startSingleChat,
  createGroup,
  createMessageGroup,
  updateConversationGroup,
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
  loadOlderActiveMessages,
  markAllConversationsRead,
  closeSocket
} = useImRuntime(
  () => props.tenantConfig,
  () => props.webSession,
  () => notificationSettings.value,
  handleRealtimeFriendRequest
)

const friendRequestCount = ref(0)
const friendContacts = ref<Contact[]>([])
const friendRequests = ref<FriendRequest[]>([])
const friendStateLoading = ref(false)
const friendStateError = ref('')
let friendRequestTimer = 0
let friendStateRefreshPromise: Promise<void> | null = null
let friendStateRefreshQueued = false
let friendRequestNotificationVersion = 0
let pendingCreatedNotification: { version: number; baseline: number } | null = null
let lastNotifiedFriendRequestCount = 0
let friendStateAuthoritativeReady = false
let removeNotificationSoundUnlock: (() => void) | null = null

const railItems = computed<RailItem[]>(() => {
  const items: RailItem[] = [
    { key: 'chats', label: '消息', icon: MessageCircle, badge: notifiableUnread.value },
    { key: 'contacts', label: '联系人', icon: ContactRound, badge: friendRequestCount.value }
  ]
  availableClientTabbar(props.clientConfig).forEach(({ moduleKey }) => items.push({
    key: moduleKey,
    label: clientModuleTitle(props.clientConfig, moduleKey),
    icon: moduleIcons[moduleKey]
  }))
  return items
})

const moduleIcons = {
  announcement: Megaphone,
  i18n: Languages,
  favorite: Star,
  sticker: Smile,
  customer_service: Headphones,
  robot_single: Bot,
  file_media: FolderOpen,
  search: Search,
  moments: CircleUserRound
} satisfies Record<ClientModuleKey, typeof Megaphone>

const announcementAvailable = computed(() => isClientModuleAvailable(props.clientConfig, 'announcement'))
const announcementPopupKey = computed(() => [
  props.webSession.organization,
  props.webSession.user.userId,
  props.clientConfig?.version ?? 0
].join(':'))

function normalizeWatermarkSettings(value: Partial<WatermarkSettings>): WatermarkSettings {
  const opacity = Number(value.opacity)
  const color = String(value.color ?? '').trim()

  return {
    enabled: Boolean(value.enabled),
    text: String(value.text ?? '').slice(0, 40),
    opacity: Number.isFinite(opacity)
      ? Math.min(0.24, Math.max(0.06, opacity))
      : DEFAULT_WATERMARK_OPACITY,
    color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : DEFAULT_WATERMARK_COLOR
  }
}

function loadWatermarkSettings(): WatermarkSettings {
  try {
    const saved = JSON.parse(window.localStorage.getItem(WATERMARK_STORAGE_KEY) || '{}') as Partial<WatermarkSettings>

    return normalizeWatermarkSettings({
      enabled: false,
      text: '',
      opacity: DEFAULT_WATERMARK_OPACITY,
      color: DEFAULT_WATERMARK_COLOR,
      ...saved
    })
  } catch {
    return normalizeWatermarkSettings({
      enabled: false,
      text: '',
      opacity: DEFAULT_WATERMARK_OPACITY,
      color: DEFAULT_WATERMARK_COLOR
    })
  }
}

const watermarkSettings = ref<WatermarkSettings>(loadWatermarkSettings())
const themeMode = ref<ThemeMode>(loadThemeMode())
const messageGroupLayout = ref<MessageGroupLayout>(loadMessageGroupLayout())

const effectiveConversationPanelWidth = computed(() => clampConversationPanelWidth(conversationPanelWidth.value))
const appFrameStyle = computed(() => ({
  '--conversation-panel-width': `${effectiveConversationPanelWidth.value}px`
}))

const watermarkText = computed(() => {
  return watermarkSettings.value.text.trim() || `${props.account.username} ${props.tenantConfig.siteName || props.account.org}`
})

const viewTitle = computed(() => {
  return railItems.value.find((item) => item.key === props.activeView)?.label ?? '消息'
})

const activeRailItem = computed(() => railItems.value.find((item) => item.key === props.activeView))

function setView(view: PrimaryView) {
  emit('update:activeView', view)
}

function updateWatermarkSettings(settings: WatermarkSettings) {
  const normalized = normalizeWatermarkSettings(settings)
  watermarkSettings.value = normalized
  window.localStorage.setItem(WATERMARK_STORAGE_KEY, JSON.stringify(normalized))
}

function normalizeNotificationSettings(value: Partial<NotificationSettings>): NotificationSettings {
  const permission = 'Notification' in window ? Notification.permission : 'denied'

  return {
    browserEnabled: Boolean(value.browserEnabled) && permission === 'granted',
    soundEnabled: Boolean(value.soundEnabled)
  }
}

function loadNotificationSettings(): NotificationSettings {
  try {
    return normalizeNotificationSettings(
      {
        soundEnabled: true,
        ...(JSON.parse(window.localStorage.getItem(NOTIFICATION_STORAGE_KEY) || '{}') as Partial<NotificationSettings>)
      }
    )
  } catch {
    return normalizeNotificationSettings({ soundEnabled: true })
  }
}

function updateNotificationSettings(settings: NotificationSettings) {
  const normalized = normalizeNotificationSettings(settings)
  notificationSettings.value = normalized
  window.localStorage.setItem(NOTIFICATION_STORAGE_KEY, JSON.stringify(normalized))
}

function loadMessageGroupLayout(): MessageGroupLayout {
  return window.localStorage.getItem(MESSAGE_GROUP_LAYOUT_STORAGE_KEY) === 'wrap' ? 'wrap' : 'scroll'
}

function updateMessageGroupLayout(layout: MessageGroupLayout) {
  messageGroupLayout.value = layout
  window.localStorage.setItem(MESSAGE_GROUP_LAYOUT_STORAGE_KEY, layout)
}

function loadConversationPanelWidth() {
  const saved = window.localStorage.getItem(CONVERSATION_PANEL_WIDTH_STORAGE_KEY)
  return clampConversationPanelWidth(saved === null ? Number.NaN : Number(saved))
}

function clampConversationPanelWidth(width: number) {
  const availableWidth =
    windowWidth.value -
    (windowWidth.value <= 1180 ? COMPACT_RAIL_WIDTH : RAIL_WIDTH) -
    RESIZER_WIDTH -
    (windowWidth.value <= 1180 ? COMPACT_CHAT_MIN_WIDTH : CHAT_MIN_WIDTH) -
    (showInfo.value && windowWidth.value > 1180 ? INFO_PANEL_WIDTH : 0)
  const maxWidth = Math.max(MIN_CONVERSATION_PANEL_WIDTH, Math.min(MAX_CONVERSATION_PANEL_WIDTH, availableWidth))

  if (!Number.isFinite(width)) return Math.min(DEFAULT_CONVERSATION_PANEL_WIDTH, maxWidth)
  return Math.min(maxWidth, Math.max(MIN_CONVERSATION_PANEL_WIDTH, Math.round(width)))
}

function saveConversationPanelWidth(width: number) {
  window.localStorage.setItem(CONVERSATION_PANEL_WIDTH_STORAGE_KEY, String(width))
}

function startConversationResize(event: PointerEvent) {
  if (event.button !== 0) return

  isConversationResizing.value = true
  conversationResizeDrag.pointerId = event.pointerId
  conversationResizeDrag.startX = event.clientX
  conversationResizeDrag.startWidth = effectiveConversationPanelWidth.value
  window.addEventListener('pointermove', moveConversationResize)
  window.addEventListener('pointerup', stopConversationResize)
  window.addEventListener('pointercancel', stopConversationResize)
  event.preventDefault()
}

function moveConversationResize(event: PointerEvent) {
  if (!isConversationResizing.value || event.pointerId !== conversationResizeDrag.pointerId) return

  const nextWidth = clampConversationPanelWidth(conversationResizeDrag.startWidth + event.clientX - conversationResizeDrag.startX)
  conversationPanelWidth.value = nextWidth
  saveConversationPanelWidth(nextWidth)
}

function stopConversationResize(event: PointerEvent) {
  if (!isConversationResizing.value || event.pointerId !== conversationResizeDrag.pointerId) return

  isConversationResizing.value = false
  conversationResizeDrag.pointerId = -1
  window.removeEventListener('pointermove', moveConversationResize)
  window.removeEventListener('pointerup', stopConversationResize)
  window.removeEventListener('pointercancel', stopConversationResize)
}

function handleWindowResize() {
  windowWidth.value = window.innerWidth
}

function refreshLockScreenSettings() {
  lockScreenSettings.value = loadLockScreenState(props.webSession)
}

function validateNewLockPassword(password: string, confirmPassword: string) {
  if (password.length < 4) {
    throw new Error('锁屏密码至少 4 位')
  }
  if (password !== confirmPassword) {
    throw new Error('两次输入的锁屏密码不一致')
  }
}

function requestLockScreen() {
  refreshLockScreenSettings()
  if (!lockScreenSettings.value.hasPassword) {
    showSettings.value = true
    layer.warning('请先设置锁屏密码')
    return
  }

  setLockScreenLocked(props.webSession, true)
  showSettings.value = false
  lockUnlockError.value = ''
  refreshLockScreenSettings()
}

async function handleUnlockScreen(password: string) {
  if (lockUnlocking.value) return
  lockUnlocking.value = true
  lockUnlockError.value = ''
  try {
    const passed = await verifyLockPassword(props.webSession, password)
    if (!passed) {
      lockUnlockError.value = '锁屏密码错误'
      return
    }
    setLockScreenLocked(props.webSession, false)
    refreshLockScreenSettings()
  } catch (error) {
    lockUnlockError.value = error instanceof Error ? error.message : '解锁失败'
  } finally {
    lockUnlocking.value = false
  }
}

async function handleSaveLockPassword(payload: {
  currentPassword: string
  password: string
  confirmPassword: string
}) {
  if (lockPasswordSaving.value) return
  lockPasswordSaving.value = true
  try {
    validateNewLockPassword(payload.password, payload.confirmPassword)
    refreshLockScreenSettings()
    if (lockScreenSettings.value.hasPassword) {
      const passed = await verifyLockPassword(props.webSession, payload.currentPassword)
      if (!passed) {
        throw new Error('当前锁屏密码错误')
      }
    }

    await saveLockPassword(props.webSession, payload.password)
    refreshLockScreenSettings()
    layer.success('锁屏密码已保存')
  } catch (error) {
    layer.error(error instanceof Error ? error.message : '锁屏密码保存失败')
  } finally {
    lockPasswordSaving.value = false
  }
}

async function handleClearLockPassword(currentPassword: string) {
  if (lockPasswordSaving.value) return
  lockPasswordSaving.value = true
  try {
    const passed = await verifyLockPassword(props.webSession, currentPassword)
    if (!passed) {
      throw new Error('当前锁屏密码错误')
    }
    clearLockPassword(props.webSession)
    refreshLockScreenSettings()
    layer.success('锁屏密码已关闭')
  } catch (error) {
    layer.error(error instanceof Error ? error.message : '锁屏密码关闭失败')
  } finally {
    lockPasswordSaving.value = false
  }
}

function loadThemeMode(): ThemeMode {
  const saved = window.localStorage.getItem(THEME_STORAGE_KEY)
  return saved === 'dark' || saved === 'light' || saved === 'system' ? saved : 'system'
}

function updateThemeMode(mode: ThemeMode) {
  themeMode.value = mode
  window.localStorage.setItem(THEME_STORAGE_KEY, mode)
}

async function handleStartChat(contact: Contact) {
  await startSingleChat(contact)
  emit('update:activeView', 'chats')
}

async function handleCreateGroup(title: string, contacts: Contact[]) {
  try {
    await createGroup(title, contacts)
    emit('update:activeView', 'chats')
    layer.success('群聊已创建')
  } catch (error) {
    layer.error(error instanceof Error ? error.message : '群聊创建失败')
  }
}

async function handleCreateMessageGroup(name: string, conversationId = '') {
  const value = name.trim()
  if (!value) return

  try {
    const group = await createMessageGroup(value)
    if (group && conversationId) {
      await updateConversationGroup(conversationId, group.id)
    }
    layer.success(conversationId ? '已添加到新分组' : '消息分组已创建')
  } catch (error) {
    layer.error(error instanceof Error ? error.message : '消息分组创建失败')
  }
}

function openChatSearch() {
  openSearchToken.value += 1
}

async function loadMentionMembers(): Promise<GroupMember[]> {
  const conversation = activeConversation.value
  if (!conversation || conversation.conversationType !== 'group' || !conversation.conversationId) return []
  return fetchGroupMembers(props.tenantConfig, props.webSession, conversation.conversationId)
}

async function handleToggleConversationMuted(conversationId: string) {
  const conversation = conversations.value.find((item) => item.id === conversationId)
  if (!conversation) return

  try {
    await updateConversationSetting(conversationId, { isMuted: !conversation.isMuted })
    layer.success(conversation.isMuted ? '已取消消息免打扰' : '已开启消息免打扰')
  } catch (error) {
    layer.error(error instanceof Error ? error.message : '消息免打扰设置失败')
  }
}

async function handleToggleConversationPinned(conversationId: string) {
  const conversation = conversations.value.find((item) => item.id === conversationId)
  if (!conversation) return

  try {
    await updateConversationSetting(conversationId, { isPinned: !conversation.isPinned })
    layer.success(conversation.isPinned ? '已取消置顶' : '已置顶')
  } catch (error) {
    layer.error(error instanceof Error ? error.message : '置顶设置失败')
  }
}

async function handleAssignConversationGroup(conversationId: string, messageGroupId: number) {
  try {
    const updated = await updateConversationGroup(conversationId, messageGroupId)
    if (updated) {
      layer.success(messageGroupId > 0 ? '已添加到分组' : '已移出分组')
    }
  } catch (error) {
    layer.error(error instanceof Error ? error.message : '分组更新失败')
  }
}

function togglePinned() {
  if (!activeConversation.value) return
  void updateConversationSetting(activeConversation.value.id, { isPinned: !activeConversation.value.isPinned })
}

function toggleMuted() {
  if (!activeConversation.value) return
  void updateConversationSetting(activeConversation.value.id, { isMuted: !activeConversation.value.isMuted })
}

function requestLogout() {
  setLockScreenLocked(props.webSession, false)
  emit('logout')
}

async function handleSaveAvatar(file: File) {
  if (avatarSaving.value) return
  avatarSaving.value = true
  try {
    const asset = await uploadImAsset(props.tenantConfig, props.webSession, file, 'image')
    const user = await updateWebAvatar(props.tenantConfig, props.webSession, asset.fileId)
    emit('session-updated', {
      ...props.webSession,
      user
    })
    showAvatarCrop.value = false
    layer.success('头像已更新')
  } catch (error) {
    layer.error(error instanceof Error ? error.message : '头像更新失败')
  } finally {
    avatarSaving.value = false
  }
}

async function handleUpdateGroupName(title: string) {
  const conversation = activeConversation.value
  if (!conversation || conversation.conversationType !== 'group') return
  if (groupProfileSaving.value) return

  groupProfileSaving.value = true
  try {
    await updateGroupProfile(conversation.id, { title })
    layer.success('群聊名称已更新')
  } catch (error) {
    layer.error(error instanceof Error ? error.message : '群聊名称更新失败')
  } finally {
    groupProfileSaving.value = false
  }
}

async function handleUpdateGroupAvatar(file: File) {
  const conversation = activeConversation.value
  if (!conversation || conversation.conversationType !== 'group') return
  if (groupProfileSaving.value) return

  groupProfileSaving.value = true
  try {
    const asset = await uploadImAsset(props.tenantConfig, props.webSession, file, 'image', {
      conversationType: 'group',
      conversationId: conversation.conversationId
    })
    await updateGroupProfile(conversation.id, { avatarFileId: asset.fileId })
    layer.success('群头像已更新')
  } catch (error) {
    layer.error(error instanceof Error ? error.message : '群头像更新失败')
  } finally {
    groupProfileSaving.value = false
  }
}

async function handleUpdateGroupDescription(description: string, notifyAll: boolean) {
  const conversation = activeConversation.value
  if (!conversation || conversation.conversationType !== 'group') return
  if (groupProfileSaving.value) return

  groupProfileSaving.value = true
  try {
    await updateGroupProfile(conversation.id, { description, notifyAll })
    layer.success(notifyAll ? '群简介已发布并 @全体' : '群简介已发布')
  } catch (error) {
    layer.error(error instanceof Error ? error.message : '群简介发布失败')
  } finally {
    groupProfileSaving.value = false
  }
}

function refreshFriendState(): Promise<void> {
  friendStateRefreshQueued = true
  if (friendStateRefreshPromise) return friendStateRefreshPromise

  const refresh = async () => {
    friendStateLoading.value = true
    try {
      while (friendStateRefreshQueued) {
        friendStateRefreshQueued = false
        const createdNotification = pendingCreatedNotification
        const scope = friendRequestScope()
        friendStateError.value = ''
        try {
          const [contacts, requests] = await Promise.all([
            fetchContacts(props.tenantConfig, props.webSession),
            fetchFriendRequests(props.tenantConfig, props.webSession)
          ])
          if (scope !== friendRequestScope()) {
            friendStateRefreshQueued = true
            continue
          }
          const nextCount = requests.filter(
            (item) => item.direction === 'incoming' && item.status === 1
          ).length
          const previousCount = friendRequestCount.value
          const shouldNotifyCreated = Boolean(
            createdNotification &&
            nextCount > createdNotification.baseline &&
            nextCount > lastNotifiedFriendRequestCount
          )
          const shouldNotifyPolling = Boolean(
            !pendingCreatedNotification &&
            friendStateAuthoritativeReady &&
            nextCount > previousCount &&
            nextCount > lastNotifiedFriendRequestCount
          )
          const hasNewerCreatedNotification = Boolean(
            pendingCreatedNotification &&
            pendingCreatedNotification.version !== createdNotification?.version
          )
          if (shouldNotifyCreated || shouldNotifyPolling) {
            notifyFriendRequest(nextCount)
            lastNotifiedFriendRequestCount = nextCount
          } else if (!friendStateAuthoritativeReady && !hasNewerCreatedNotification) {
            lastNotifiedFriendRequestCount = nextCount
          } else if (nextCount < lastNotifiedFriendRequestCount) {
            lastNotifiedFriendRequestCount = nextCount
          }
          if (pendingCreatedNotification?.version === createdNotification?.version) {
            pendingCreatedNotification = null
          }

          // 联系人与好友申请是同一个权威快照；两次读取均成功后才一起提交。
          friendContacts.value = contacts
          friendRequests.value = requests
          friendRequestCount.value = nextCount
          friendStateAuthoritativeReady = true
        } catch (error) {
          if (scope !== friendRequestScope()) {
            friendStateRefreshQueued = true
            continue
          }
          friendStateError.value = error instanceof Error ? error.message : '好友关系刷新失败'
          // 权威读取失败时保留整份既有快照；后续实时事件或轮询会串行重试。
        }
      }
    } finally {
      friendStateLoading.value = false
    }
  }

  friendStateRefreshPromise = refresh().finally(() => {
    friendStateRefreshPromise = null
    if (friendStateRefreshQueued) void refreshFriendState()
  })
  return friendStateRefreshPromise
}

function friendRequestScope() {
  return [
    props.webSession.organization,
    props.webSession.user.userId,
    props.webSession.accessToken
  ].join('\u0000')
}

function handleRealtimeFriendRequest(event: FriendRequestPushEvent) {
  if (event.event === 'created') {
    pendingCreatedNotification = {
      version: ++friendRequestNotificationVersion,
      baseline: Math.min(
        pendingCreatedNotification?.baseline ?? friendRequestCount.value,
        friendRequestCount.value
      )
    }
  }
  void refreshFriendState()
}

function notifyFriendRequest(count: number, fromName = '') {
  const body = count > 1 ? `${count} 条好友申请待确认` : `${fromName || '有人'}申请添加你为好友`
  layer.info('收到新的好友申请', 3200)
  if (notificationSettings.value.soundEnabled) {
    playNotificationSound()
  }
  if (
    notificationSettings.value.browserEnabled &&
    shouldShowBrowserSystemNotification() &&
    'Notification' in window &&
    Notification.permission === 'granted'
  ) {
    new Notification('新的好友申请', { body })
  }
}

function shouldShowBrowserSystemNotification() {
  return document.hidden || !document.hasFocus()
}

function handleConversationAccessSnapshotChanged(event: Event) {
  const detail = (event as CustomEvent<{
    allowed?: boolean
    refresh?: boolean
    organization?: string
    userId?: string
  }>).detail
  if (detail?.allowed === false) {
    const organization = String(detail.organization ?? '')
    const userId = String(detail.userId ?? '')
    const contacts = organization && userId
      ? friendContacts.value.filter(
        (contact) => contact.organization !== organization || contact.userId !== userId
      )
      : friendContacts.value.filter(
        (contact) => contact.organization === props.webSession.organization
      )
    const requests = organization && userId
      ? friendRequests.value.filter((request) => {
        const fromMatches = request.fromOrganization === organization &&
          (!request.fromUser || request.fromUser.userId === userId)
        const toMatches = request.toOrganization === organization &&
          (!request.toUser || request.toUser.userId === userId)
        return !fromMatches && !toMatches
      })
      : friendRequests.value.filter((request) =>
        request.fromOrganization === props.webSession.organization &&
        request.toOrganization === props.webSession.organization
      )
    const nextCount = requests.filter(
      (request) => request.direction === 'incoming' && request.status === 1
    ).length
    friendContacts.value = contacts
    friendRequests.value = requests
    friendRequestCount.value = nextCount
    pendingCreatedNotification = null
  }
  if (detail?.refresh === false) return
  void refreshFriendState()
}

onMounted(() => {
  window.addEventListener('resize', handleWindowResize)
  window.addEventListener(
    CONVERSATION_ACCESS_BROWSER_EVENT,
    handleConversationAccessSnapshotChanged
  )
  removeNotificationSoundUnlock = installNotificationSoundUnlock()
  void boot().catch((error) => {
    layer.error(error instanceof Error ? error.message : 'IM 初始化失败')
  })
  void refreshFriendState()
  friendRequestTimer = window.setInterval(refreshFriendState, 20000)
})

watchEffect((onCleanup) => {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const applyTheme = () => {
    const resolved = themeMode.value === 'system' ? (media.matches ? 'dark' : 'light') : themeMode.value
    document.documentElement.dataset.webTheme = resolved
    document.documentElement.dataset.webThemeMode = themeMode.value
  }

  applyTheme()
  media.addEventListener('change', applyTheme)
  onCleanup(() => media.removeEventListener('change', applyTheme))
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleWindowResize)
  window.removeEventListener(
    CONVERSATION_ACCESS_BROWSER_EVENT,
    handleConversationAccessSnapshotChanged
  )
  window.removeEventListener('pointermove', moveConversationResize)
  window.removeEventListener('pointerup', stopConversationResize)
  window.removeEventListener('pointercancel', stopConversationResize)
  removeNotificationSoundUnlock?.()
  window.clearInterval(friendRequestTimer)
  setTitleNotifierUnreadCount(0)
  closeSocket()
})

watch(
  () => `${props.webSession.organization}:${props.webSession.user.userId}:${props.webSession.user.account}`,
  () => refreshLockScreenSettings(),
  { immediate: true }
)

watch(
  () => friendRequestScope(),
  () => {
    pendingCreatedNotification = null
    lastNotifiedFriendRequestCount = 0
    friendContacts.value = []
    friendRequests.value = []
    friendRequestCount.value = 0
    friendStateAuthoritativeReady = false
    friendStateError.value = ''
    void refreshFriendState()
  }
)

watch(
  () => notifiableUnread.value + friendRequestCount.value,
  (count) => {
    setTitleNotifierUnreadCount(count)
  },
  { immediate: true }
)

watch(
  () => props.tenantConfig.siteName,
  (siteName) => setTitleNotifierBaseTitle(siteName),
  { immediate: true }
)
</script>

<template>
  <div class="app-frame" :class="{ 'info-open': showInfo, resizing: isConversationResizing }" :style="appFrameStyle">
    <AnnouncementPopup
      v-if="announcementAvailable"
      :key="announcementPopupKey"
      :tenant-config="tenantConfig"
      :web-session="webSession"
    />
    <SideRail
      :items="railItems"
      :active-view="activeView"
      :account="account"
      :tenant-config="tenantConfig"
      :web-session="webSession"
      :can-lock-screen="lockScreenSettings.hasPassword"
      @change="setView"
      @change-avatar="showAvatarCrop = true"
      @toggle-settings="showSettings = !showSettings"
      @lock-screen="requestLockScreen"
      @logout="requestLogout"
    />

    <template v-if="activeView === 'chats'">
      <ConversationList
        v-model:active-conversation="activeConversationId"
        :conversations="conversations"
        :message-group-layout="messageGroupLayout"
        :message-groups="messageGroups"
        :connection-state="connectionState"
        :heartbeat-pulse="heartbeatPulse"
        :tenant-config="tenantConfig"
        :web-session="webSession"
        @read-all="markAllConversationsRead"
        @start-chat="handleStartChat"
        @create-group="handleCreateGroup"
        @create-message-group="handleCreateMessageGroup"
        @assign-conversation-group="handleAssignConversationGroup"
        @toggle-conversation-pinned="handleToggleConversationPinned"
        @toggle-conversation-muted="handleToggleConversationMuted"
      />
      <button
        class="conversation-resizer"
        type="button"
        title="拖动调整会话列表宽度"
        aria-label="拖动调整会话列表宽度"
        @pointerdown="startConversationResize"
      ></button>
      <ChatWindow
        :conversation="activeConversation"
        :messages="activeMessages"
        :conversations="conversations"
        :message-groups="messageGroups"
        :connection-state="connectionState"
        :typing-text="activeTypingText"
        :show-info="showInfo"
        :open-search-token="openSearchToken"
        :search-messages="searchActiveMessages"
        :load-mention-members="loadMentionMembers"
        :can-load-older="activeCanLoadOlder"
        :loading-older="loadingOlderMessages"
        :load-older-messages="loadOlderActiveMessages"
        :can-delete-self="messageDeleteConfig.deleteSingleEnabled"
        :can-delete-both="messageDeleteConfig.deleteBothEnabled"
        :resolve-asset-url="resolveMessageAssetUrl"
        @toggle-info="showInfo = !showInfo"
        @send-text="sendText"
        @send-asset="sendAsset"
        @recall-message="recallMessage"
        @screenshot="sendScreenshotNotice"
        @typing="sendTyping"
        @edit-message="editMessage"
        @delete-message="deleteMessage"
        @delete-messages="deleteMessages"
        @forward-messages="forwardMessages"
      />
      <InfoPanel
        v-if="showInfo"
        :conversation="activeConversation"
        :tenant-config="tenantConfig"
        :web-session="webSession"
        :saving-group-profile="groupProfileSaving"
        @toggle-pinned="togglePinned"
        @toggle-muted="toggleMuted"
        @update-group-title="handleUpdateGroupName"
        @update-group-avatar="handleUpdateGroupAvatar"
        @update-group-description="handleUpdateGroupDescription"
        @open-search="openChatSearch"
        @close="showInfo = false"
      />
    </template>

    <template v-else-if="activeView === 'contacts'">
      <ContactsView
        :tenant-config="tenantConfig"
        :web-session="webSession"
        :contacts="friendContacts"
        :friend-requests="friendRequests"
        :friend-state-loading="friendStateLoading"
        :friend-state-error="friendStateError"
        :refresh-friend-state="refreshFriendState"
        @start-chat="handleStartChat"
        @create-group="handleCreateGroup"
      />
    </template>

    <template v-else-if="activeView === 'announcement'">
      <AnnouncementView :tenant-config="tenantConfig" :web-session="webSession" />
    </template>

    <template v-else>
      <ModuleWorkbenchView
        :module-key="activeView"
        :title="clientModuleTitle(clientConfig, activeView)"
        :tenant-config="tenantConfig"
        :web-session="webSession"
      />
    </template>

    <div
      v-if="watermarkSettings.enabled && watermarkText"
      class="app-watermark"
      :style="{ '--watermark-opacity': watermarkSettings.opacity, '--watermark-color': watermarkSettings.color }"
      aria-hidden="true"
    >
      <span v-for="item in watermarkTiles" :key="item">{{ watermarkText }}</span>
    </div>

    <div v-if="showSettings" class="settings-overlay" @click.self="showSettings = false">
      <SettingsView
        :account="account"
        :tenant-config="tenantConfig"
        :web-session="webSession"
        :watermark-settings="watermarkSettings"
        :theme-mode="themeMode"
        :message-group-layout="messageGroupLayout"
        :notification-settings="notificationSettings"
        :lock-screen-settings="lockScreenSettings"
        :lock-password-saving="lockPasswordSaving"
        @update:watermark-settings="updateWatermarkSettings"
        @update:theme-mode="updateThemeMode"
        @update:message-group-layout="updateMessageGroupLayout"
        @update:notification-settings="updateNotificationSettings"
        @request-lock="requestLockScreen"
        @save-lock-password="handleSaveLockPassword"
        @clear-lock-password="handleClearLockPassword"
        @close="showSettings = false"
      />
    </div>

    <LockScreenView
      v-if="lockScreenSettings.locked"
      :tenant-config="tenantConfig"
      :web-session="webSession"
      :unlocking="lockUnlocking"
      :error="lockUnlockError"
      @unlock="handleUnlockScreen"
      @logout="requestLogout"
    />

    <AvatarCropDialog
      v-if="showAvatarCrop"
      :saving="avatarSaving"
      @save="handleSaveAvatar"
      @close="showAvatarCrop = false"
    />

    <div class="top-view-chip" aria-hidden="true">
      <component :is="activeRailItem?.icon || MessageCircle" :size="14" />
      {{ viewTitle }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { BellOff, CheckCheck, FolderPlus, MessageCircle, Pin, Plus, Search, UsersRound, X } from '@lucide/vue'
import ConversationAvatar from './ConversationAvatar.vue'
import { CONTEXT_MENU_CLOSE_EVENT, emitCloseContextMenus, isCloseFromSource } from '../services/contextMenu'
import { layer } from '../services/layer'
import type { TenantBrandConfig } from '../services/tenantConfig'
import { fetchContacts } from '../services/webIm'
import type { Contact, ImConnectionState, ImConversation, MessageGroup, MessageGroupLayout, WebImSession } from '../types'

const props = defineProps<{
  activeConversation: string
  conversations: ImConversation[]
  connectionState: ImConnectionState
  heartbeatPulse: number
  messageGroupLayout: MessageGroupLayout
  messageGroups: MessageGroup[]
  tenantConfig: TenantBrandConfig
  webSession: WebImSession
}>()

const emit = defineEmits<{
  'update:activeConversation': [string]
  'read-all': []
  'start-chat': [Contact]
  'create-group': [string, Contact[]]
  'create-message-group': [string, string?]
  'assign-conversation-group': [string, number]
  'toggle-conversation-pinned': [string]
  'toggle-conversation-muted': [string]
}>()

const keyword = ref('')
const FILTER_ALL = -1
const FILTER_SINGLE = -2
const FILTER_GROUP = -3
const FILTER_UNGROUPED = 0

const activeGroupId = ref(FILTER_ALL)
const groupNameInput = ref<HTMLInputElement | null>(null)
const startDialogSearchInput = ref<HTMLInputElement | null>(null)
const messageGroupBarRef = ref<HTMLElement | null>(null)
const isMessageGroupDragging = ref(false)
const messageGroupDrag = {
  active: false,
  pointerId: -1,
  startX: 0,
  scrollLeft: 0,
  moved: false
}
let ignoreMessageGroupClick = false
let ignoreMessageGroupClickTimer = 0
const groupDialog = ref({
  visible: false,
  name: '',
  conversationId: ''
})
const groupMenu = ref({
  visible: false,
  x: 0,
  y: 0,
  conversation: null as ImConversation | null
})
const startMenu = ref({
  visible: false,
  x: 0,
  y: 0
})
const startDialog = ref({
  visible: false,
  mode: 'single' as 'single' | 'group',
  keyword: '',
  groupTitle: '',
  selectedUserIds: [] as string[],
  loading: false
})
const contacts = ref<Contact[]>([])

const filteredConversations = computed(() => {
  const value = keyword.value.trim().toLowerCase()
  return props.conversations.filter((item) => {
    if (activeGroupId.value === FILTER_SINGLE && item.conversationType !== 'single') return false
    if (activeGroupId.value === FILTER_GROUP && item.conversationType !== 'group') return false
    if (activeGroupId.value === FILTER_UNGROUPED && item.messageGroupId !== 0) return false
    if (activeGroupId.value > 0 && item.messageGroupId !== activeGroupId.value) return false
    if (!value) return true
    return [item.title, item.preview, item.peerUser?.account, item.peerUser?.imShortNo]
      .filter(Boolean)
      .some((text) => String(text).toLowerCase().includes(value))
  })
})

const groupFilters = computed(() => [
  { id: FILTER_ALL, name: '全部' },
  { id: FILTER_SINGLE, name: '好友消息' },
  { id: FILTER_GROUP, name: '群消息' },
  ...props.messageGroups.map((item) => ({ id: item.id, name: item.name })),
  { id: FILTER_UNGROUPED, name: '未分组' }
])
const startDialogTitle = computed(() => startDialog.value.mode === 'single' ? '发起单聊' : '发起群聊')
const filteredStartContacts = computed(() => {
  const keyword = startDialog.value.keyword.trim().toLowerCase()
  const candidates = startDialog.value.mode === 'group'
    ? contacts.value.filter((contact) => !contact.isSystem)
    : contacts.value

  if (!keyword) return candidates
  return candidates.filter((contact) => {
    return [contact.name, contact.account, contact.mobile, contact.imShortNo]
      .filter(Boolean)
      .some((text) => text.toLowerCase().includes(keyword))
  })
})
const selectedStartContacts = computed(() =>
  contacts.value.filter((contact) => startDialog.value.selectedUserIds.includes(contact.userId))
)
const startDialogSubtitle = computed(() => {
  if (startDialog.value.mode === 'single') return '选择一个好友开始聊天'
  return `已选择 ${selectedStartContacts.value.length} 个好友`
})
const canSubmitStartDialog = computed(() =>
  startDialog.value.mode === 'single'
    ? selectedStartContacts.value.length === 1
    : selectedStartContacts.value.length >= 2
)

const connectionLabel = computed(() => {
  if (props.connectionState === 'connected') return '已连接'
  if (props.connectionState === 'connecting') return '连接中'
  if (props.connectionState === 'error') return '连接异常'
  if (props.connectionState === 'offline') return '已离线'
  return '未连接'
})

function openGroupMenu(event: MouseEvent, conversation: ImConversation) {
  event.preventDefault()
  event.stopPropagation()
  emit('update:activeConversation', conversation.id)
  emitCloseContextMenus('conversation')

  const menuWidth = 176
  const menuHeight = 250
  groupMenu.value = {
    visible: true,
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
    conversation
  }
}

function closeGroupMenu() {
  groupMenu.value.visible = false
}

function openStartMenu(event: MouseEvent) {
  event.stopPropagation()
  emitCloseContextMenus('conversation')
  closeGroupMenu()

  const menuWidth = 132
  const menuHeight = 88
  startMenu.value = {
    visible: !startMenu.value.visible,
    x: Math.max(8, Math.min(event.clientX - menuWidth + 32, window.innerWidth - menuWidth - 8)),
    y: Math.max(8, Math.min(event.clientY + 8, window.innerHeight - menuHeight - 8))
  }
}

function closeStartMenu() {
  startMenu.value.visible = false
}

async function openStartDialog(mode: 'single' | 'group') {
  closeStartMenu()
  startDialog.value = {
    visible: true,
    mode,
    keyword: '',
    groupTitle: '',
    selectedUserIds: [],
    loading: true
  }
  try {
    contacts.value = await fetchContacts(props.tenantConfig, props.webSession)
  } catch (error) {
    contacts.value = []
    layer.error(error instanceof Error ? error.message : '联系人加载失败')
  } finally {
    startDialog.value.loading = false
    await nextTick()
    startDialogSearchInput.value?.focus()
  }
}

function closeStartDialog() {
  startDialog.value.visible = false
}

function toggleStartContact(contact: Contact) {
  if (startDialog.value.mode === 'single') {
    startDialog.value.selectedUserIds = [contact.userId]
    return
  }

  startDialog.value.selectedUserIds = startDialog.value.selectedUserIds.includes(contact.userId)
    ? startDialog.value.selectedUserIds.filter((userId) => userId !== contact.userId)
    : [...startDialog.value.selectedUserIds, contact.userId]
}

function submitStartDialog() {
  if (!canSubmitStartDialog.value) return
  if (startDialog.value.mode === 'single') {
    const contact = selectedStartContacts.value[0]
    if (!contact) return
    emit('start-chat', contact)
    closeStartDialog()
    return
  }

  const contacts = selectedStartContacts.value
  const title = startDialog.value.groupTitle.trim() || contacts.slice(0, 3).map((item) => item.name).join('、') || '群聊'
  emit('create-group', title, contacts)
  closeStartDialog()
}

function assignGroup(groupId: number) {
  const conversation = groupMenu.value.conversation
  if (!conversation) return
  emit('assign-conversation-group', conversation.id, groupId)
  closeGroupMenu()
}

function toggleMutedFromMenu() {
  const conversation = groupMenu.value.conversation
  if (!conversation) return
  emit('toggle-conversation-muted', conversation.id)
  closeGroupMenu()
}

function togglePinnedFromMenu() {
  const conversation = groupMenu.value.conversation
  if (!conversation) return
  emit('toggle-conversation-pinned', conversation.id)
  closeGroupMenu()
}

async function openGroupDialog(conversationId = '') {
  groupDialog.value = {
    visible: true,
    name: '',
    conversationId
  }
  closeGroupMenu()
  await nextTick()
  groupNameInput.value?.focus()
}

function closeGroupDialog() {
  groupDialog.value.visible = false
}

function submitGroupDialog() {
  const name = groupDialog.value.name.trim()
  if (!name) return
  emit('create-message-group', name, groupDialog.value.conversationId || undefined)
  closeGroupDialog()
}

function selectGroup(groupId: number) {
  if (ignoreMessageGroupClick) return
  activeGroupId.value = groupId
}

function handleContextMenuClose(event: Event) {
  if (!isCloseFromSource(event, 'conversation')) {
    closeGroupMenu()
    closeStartMenu()
  }
}

function handleWindowClick() {
  closeGroupMenu()
  closeStartMenu()
}

function startMessageGroupDrag(event: PointerEvent) {
  if (props.messageGroupLayout !== 'scroll' || event.button !== 0) return
  const bar = messageGroupBarRef.value
  if (!bar) return

  messageGroupDrag.active = true
  messageGroupDrag.pointerId = event.pointerId
  messageGroupDrag.startX = event.clientX
  messageGroupDrag.scrollLeft = bar.scrollLeft
  messageGroupDrag.moved = false
  window.addEventListener('pointermove', moveMessageGroupDrag)
  window.addEventListener('pointerup', stopMessageGroupDrag)
  window.addEventListener('pointercancel', stopMessageGroupDrag)
}

function moveMessageGroupDrag(event: PointerEvent) {
  if (!messageGroupDrag.active || event.pointerId !== messageGroupDrag.pointerId) return
  const bar = messageGroupBarRef.value
  if (!bar) return

  const deltaX = event.clientX - messageGroupDrag.startX
  if (Math.abs(deltaX) > 4) {
    messageGroupDrag.moved = true
    isMessageGroupDragging.value = true
  }
  if (!messageGroupDrag.moved) return

  bar.scrollLeft = messageGroupDrag.scrollLeft - deltaX
  event.preventDefault()
}

function stopMessageGroupDrag(event: PointerEvent) {
  if (!messageGroupDrag.active || event.pointerId !== messageGroupDrag.pointerId) return
  window.removeEventListener('pointermove', moveMessageGroupDrag)
  window.removeEventListener('pointerup', stopMessageGroupDrag)
  window.removeEventListener('pointercancel', stopMessageGroupDrag)

  if (messageGroupDrag.moved) {
    ignoreMessageGroupClick = true
    window.clearTimeout(ignoreMessageGroupClickTimer)
    ignoreMessageGroupClickTimer = window.setTimeout(() => {
      ignoreMessageGroupClick = false
    }, 80)
  }

  messageGroupDrag.active = false
  messageGroupDrag.pointerId = -1
  messageGroupDrag.moved = false
  isMessageGroupDragging.value = false
}

onMounted(() => {
  window.addEventListener('click', handleWindowClick)
  window.addEventListener(CONTEXT_MENU_CLOSE_EVENT, handleContextMenuClose)
})

onBeforeUnmount(() => {
  window.removeEventListener('click', handleWindowClick)
  window.removeEventListener(CONTEXT_MENU_CLOSE_EVENT, handleContextMenuClose)
  window.removeEventListener('pointermove', moveMessageGroupDrag)
  window.removeEventListener('pointerup', stopMessageGroupDrag)
  window.removeEventListener('pointercancel', stopMessageGroupDrag)
  window.clearTimeout(ignoreMessageGroupClickTimer)
})
</script>

<template>
  <aside class="conversation-panel">
    <header class="conversation-head">
      <div>
        <h1>{{ props.tenantConfig.siteName }}</h1>
        <button class="read-all" type="button" @click="emit('read-all')">
          <CheckCheck :size="14" />
          一键已读
        </button>
      </div>
      <span class="connection-badge" :class="props.connectionState">
        <span
          :key="props.heartbeatPulse"
          class="connection-led"
          :class="{ heartbeat: props.connectionState === 'connected' && props.heartbeatPulse > 0 }"
          aria-hidden="true"
        ></span>
        {{ connectionLabel }}
      </span>
      <button class="round-action" title="发起聊天" type="button" @click.stop="openStartMenu">
        <Plus :size="20" />
      </button>
    </header>

    <label class="search-box">
      <Search :size="17" />
      <input v-model="keyword" placeholder="搜索会话" />
    </label>

    <div
      ref="messageGroupBarRef"
      class="message-group-bar"
      :class="[`layout-${props.messageGroupLayout}`, { dragging: isMessageGroupDragging }]"
      @pointerdown="startMessageGroupDrag"
      @pointermove="moveMessageGroupDrag"
      @pointerup="stopMessageGroupDrag"
      @pointercancel="stopMessageGroupDrag"
    >
      <button
        v-for="group in groupFilters"
        :key="group.id"
        type="button"
        :class="{ active: activeGroupId === group.id }"
        @click="selectGroup(group.id)"
      >
        {{ group.name }}
      </button>
      <button class="message-group-create" title="新建消息分组" type="button" @click="openGroupDialog()">
        <FolderPlus :size="15" />
      </button>
    </div>

    <div class="conversation-scroll">
      <div v-if="filteredConversations.length === 0" class="state-row conversation-empty">
        暂无会话，从联系人里选择好友发起聊天
      </div>
      <button
        v-for="item in filteredConversations"
        :key="item.id"
        class="conversation-row"
        :class="{ active: props.activeConversation === item.id }"
        type="button"
        @click="emit('update:activeConversation', item.id)"
        @contextmenu="openGroupMenu($event, item)"
      >
        <ConversationAvatar
          :title="item.title"
          :avatar="item.avatar"
          :peer-avatar-url="item.peerUser?.avatarUrl"
          :avatar-members="item.avatarMembers"
          :conversation-type="item.conversationType"
        />
        <span class="conversation-main">
          <span class="conversation-topline">
            <strong><Pin v-if="item.isPinned" :size="13" />{{ item.title }}</strong>
            <small>{{ item.time }}</small>
          </span>
          <span v-if="item.messageGroupName" class="conversation-group-name">{{ item.messageGroupName }}</span>
          <span class="conversation-preview">
            <BellOff v-if="item.isMuted" :size="13" />
            <span>{{ item.preview }}</span>
          </span>
        </span>
        <span v-if="item.unread" class="unread-badge">{{ item.unread }}</span>
      </button>
    </div>

    <div
      v-if="startMenu.visible"
      class="conversation-start-menu"
      :style="{ left: `${startMenu.x}px`, top: `${startMenu.y}px` }"
      @click.stop
      @contextmenu.prevent
    >
      <button type="button" @click="openStartDialog('single')">
        <MessageCircle :size="15" />
        发起单聊
      </button>
      <button type="button" @click="openStartDialog('group')">
        <UsersRound :size="15" />
        发起群聊
      </button>
    </div>

    <div
      v-if="groupMenu.visible && groupMenu.conversation"
      class="conversation-context-menu"
      :style="{ left: `${groupMenu.x}px`, top: `${groupMenu.y}px` }"
      @click.stop
      @contextmenu.prevent
    >
      <button type="button" @click="togglePinnedFromMenu">
        {{ groupMenu.conversation.isPinned ? '取消置顶' : '置顶' }}
      </button>
      <button type="button" @click="toggleMutedFromMenu">
        {{ groupMenu.conversation.isMuted ? '取消消息免打扰' : '消息免打扰' }}
      </button>
      <div class="conversation-context-menu-title">添加到分组</div>
      <button
        v-for="group in props.messageGroups"
        :key="group.id"
        type="button"
        :class="{ active: groupMenu.conversation.messageGroupId === group.id }"
        @click="assignGroup(group.id)"
      >
        {{ group.name }}
      </button>
      <div v-if="props.messageGroups.length === 0" class="conversation-context-menu-empty">暂无分组</div>
      <button v-if="groupMenu.conversation.messageGroupId" type="button" @click="assignGroup(0)">移出分组</button>
      <button type="button" @click="openGroupDialog(groupMenu.conversation.id)">新建分组</button>
    </div>

    <div
      v-if="startDialog.visible"
      class="start-chat-dialog-overlay"
      @click.self="closeStartDialog"
      @keydown.esc="closeStartDialog"
    >
      <form class="start-chat-dialog" @submit.prevent="submitStartDialog">
        <header>
          <div>
            <strong>{{ startDialogTitle }}</strong>
            <span>{{ startDialogSubtitle }}</span>
          </div>
          <button type="button" aria-label="关闭" @click="closeStartDialog">
            <X :size="18" />
          </button>
        </header>

        <label v-if="startDialog.mode === 'group'" class="start-chat-title-field">
          <span>群聊名称</span>
          <input v-model="startDialog.groupTitle" maxlength="100" placeholder="可留空，默认使用成员昵称" />
        </label>

        <label class="start-chat-search">
          <Search :size="16" />
          <input ref="startDialogSearchInput" v-model="startDialog.keyword" placeholder="搜索好友" />
        </label>

        <div class="start-chat-list">
          <div v-if="startDialog.loading" class="state-row">正在加载联系人...</div>
          <div v-else-if="filteredStartContacts.length === 0" class="state-row">
            {{ startDialog.mode === 'group' ? '暂无可邀请好友' : '暂无好友' }}
          </div>
          <template v-else>
            <button
              v-for="contact in filteredStartContacts"
              :key="contact.userId"
              type="button"
              class="start-chat-contact"
              :class="{ active: startDialog.selectedUserIds.includes(contact.userId) }"
              @click="toggleStartContact(contact)"
            >
              <span class="start-chat-check" aria-hidden="true"></span>
              <span class="avatar mini">
                <img v-if="contact.avatarUrl" :src="contact.avatarUrl" :alt="contact.name" />
                <template v-else>{{ contact.avatar }}</template>
              </span>
              <span>
                <strong>{{ contact.name }}</strong>
                <small>{{ contact.account }} · {{ contact.imShortNo || '无短号' }}</small>
              </span>
            </button>
          </template>
        </div>

        <footer>
          <button type="button" @click="closeStartDialog">取消</button>
          <button class="primary" type="submit" :disabled="!canSubmitStartDialog">
            {{ startDialog.mode === 'single' ? '开始聊天' : '创建群聊' }}
          </button>
        </footer>
      </form>
    </div>

    <div
      v-if="groupDialog.visible"
      class="message-group-dialog-backdrop"
      @click.self="closeGroupDialog"
      @keydown.esc="closeGroupDialog"
    >
      <form class="message-group-dialog" @submit.prevent="submitGroupDialog">
        <header>
          <strong>{{ groupDialog.conversationId ? '新建分组' : '新建消息分组' }}</strong>
          <button type="button" aria-label="关闭" @click="closeGroupDialog">×</button>
        </header>
        <label>
          <span>分组名称</span>
          <input
            ref="groupNameInput"
            v-model="groupDialog.name"
            maxlength="40"
            placeholder="例如：客户、同事、项目组"
          />
        </label>
        <footer>
          <button type="button" @click="closeGroupDialog">取消</button>
          <button class="primary" type="submit" :disabled="!groupDialog.name.trim()">确定</button>
        </footer>
      </form>
    </div>
  </aside>
</template>

<style scoped>
.message-group-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(18, 24, 31, 0.36);
}

.message-group-dialog {
  width: min(360px, 100%);
  display: grid;
  gap: 18px;
  padding: 18px;
  border: 1px solid rgba(18, 24, 31, 0.08);
  border-radius: 8px;
  background: #fff;
  color: var(--text);
  box-shadow: 0 24px 70px rgba(18, 24, 31, 0.24);
}

.message-group-dialog header,
.message-group-dialog footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.message-group-dialog header button {
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 7px;
  background: #eef1f3;
  color: var(--muted);
  font-size: 20px;
  line-height: 1;
}

.message-group-dialog label {
  display: grid;
  gap: 8px;
  color: var(--muted);
  font-size: 13px;
}

.message-group-dialog input {
  height: 38px;
  padding: 0 11px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: #fff;
  color: var(--text);
  font-size: 14px;
}

.message-group-dialog footer {
  justify-content: flex-end;
}

.message-group-dialog footer button {
  min-width: 72px;
  height: 34px;
  border: 0;
  border-radius: 7px;
  background: #eef1f3;
  color: #4b5563;
}

.message-group-dialog footer button.primary {
  background: var(--green);
  color: #fff;
}

.message-group-dialog footer button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

:global(:root[data-web-theme="dark"]) .message-group-dialog {
  border-color: rgba(255, 255, 255, 0.08);
  background: #18212c;
}

:global(:root[data-web-theme="dark"]) .message-group-dialog input {
  background: #111923;
}

:global(:root[data-web-theme="dark"]) .message-group-dialog header button,
:global(:root[data-web-theme="dark"]) .message-group-dialog footer button {
  background: #233041;
  color: var(--muted);
}

.conversation-start-menu {
  position: fixed;
  z-index: 70;
  min-width: 132px;
  padding: 6px;
  border: 1px solid rgba(31, 42, 55, 0.08);
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 12px 28px rgba(15, 23, 42, 0.16);
}

.conversation-start-menu button {
  width: 100%;
  min-height: 34px;
  display: flex;
  align-items: center;
  gap: 8px;
  border: 0;
  border-radius: 6px;
  padding: 0 10px;
  background: transparent;
  color: var(--text);
  text-align: left;
}

.conversation-start-menu button:hover {
  background: rgba(31, 42, 55, 0.06);
}

.start-chat-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(18, 24, 31, 0.36);
}

.start-chat-dialog {
  width: min(420px, 100%);
  max-height: min(680px, calc(100vh - 48px));
  display: grid;
  grid-template-rows: auto auto auto minmax(0, 1fr) auto;
  overflow: hidden;
  border: 1px solid rgba(18, 24, 31, 0.08);
  border-radius: 8px;
  background: #fff;
  color: var(--text);
  box-shadow: 0 24px 70px rgba(18, 24, 31, 0.24);
}

.start-chat-dialog header,
.start-chat-dialog footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--line);
}

.start-chat-dialog header > div {
  display: grid;
  gap: 3px;
}

.start-chat-dialog header span,
.start-chat-title-field span {
  color: var(--muted);
  font-size: 12px;
}

.start-chat-dialog header button {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 7px;
  background: #eef1f3;
  color: var(--muted);
}

.start-chat-title-field {
  display: grid;
  gap: 8px;
  padding: 12px 16px 0;
}

.start-chat-title-field input,
.start-chat-search input {
  height: 38px;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 0 11px;
  background: #fff;
  color: var(--text);
  outline: none;
}

.start-chat-search {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 16px;
  color: var(--muted);
}

.start-chat-search input {
  flex: 1;
}

.start-chat-list {
  min-height: 220px;
  overflow: auto;
  padding: 0 10px 12px;
}

.start-chat-contact {
  width: 100%;
  display: grid;
  grid-template-columns: 20px 34px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  border: 0;
  border-radius: 8px;
  padding: 8px;
  background: transparent;
  color: var(--text);
  text-align: left;
}

.start-chat-contact:hover,
.start-chat-contact.active {
  background: rgba(37, 192, 109, 0.12);
}

.start-chat-check {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(142, 151, 161, 0.56);
  border-radius: 50%;
}

.start-chat-contact.active .start-chat-check {
  border-color: var(--green);
  background: radial-gradient(circle, var(--green) 46%, transparent 52%);
}

.start-chat-contact strong,
.start-chat-contact small {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.start-chat-contact small {
  margin-top: 2px;
  color: var(--muted);
  font-size: 12px;
}

.start-chat-dialog footer {
  justify-content: flex-end;
  border-top: 1px solid var(--line);
  border-bottom: 0;
}

.start-chat-dialog footer button {
  min-width: 72px;
  height: 34px;
  border: 0;
  border-radius: 7px;
  background: #eef1f3;
  color: #4b5563;
}

.start-chat-dialog footer button.primary {
  background: var(--green);
  color: #fff;
}

.start-chat-dialog footer button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

:global(:root[data-web-theme="dark"]) .conversation-start-menu,
:global(:root[data-web-theme="dark"]) .start-chat-dialog {
  border-color: rgba(255, 255, 255, 0.08);
  background: #18212c;
}

:global(:root[data-web-theme="dark"]) .conversation-start-menu button:hover,
:global(:root[data-web-theme="dark"]) .start-chat-contact:hover,
:global(:root[data-web-theme="dark"]) .start-chat-contact.active {
  background: #233041;
}

:global(:root[data-web-theme="dark"]) .start-chat-dialog header button,
:global(:root[data-web-theme="dark"]) .start-chat-title-field input,
:global(:root[data-web-theme="dark"]) .start-chat-search input,
:global(:root[data-web-theme="dark"]) .start-chat-dialog footer button {
  background: #233041;
  color: var(--muted);
}
</style>

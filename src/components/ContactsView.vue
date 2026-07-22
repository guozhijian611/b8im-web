<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Check, MessageCircle, Phone, Search, UserPlus, Video, X } from '@lucide/vue'
import {
  handleFriendRequest,
  searchUsers,
  sendFriendRequest,
  updateFriendRemark
} from '../services/webIm'
import { layer } from '../services/layer'
import { imIdentityKey } from '../services/imIdentity'
import { CONVERSATION_ACCESS_BROWSER_EVENT } from '../services/conversationAccess'
import type { TenantBrandConfig } from '../services/tenantConfig'
import type { Contact, FriendRequest, WebImSession, WebImUser } from '../types'

const props = defineProps<{
  tenantConfig: TenantBrandConfig
  webSession: WebImSession
  contacts: Contact[]
  friendRequests: FriendRequest[]
  friendStateLoading: boolean
  friendStateError: string
  refreshFriendState: () => Promise<void>
}>()

const emit = defineEmits<{
  'start-chat': [Contact]
  'create-group': [string, Contact[]]
}>()

const activeMode = ref<'friends' | 'requests' | 'add' | 'group'>('friends')
const contacts = computed(() => props.contacts)
const requests = computed(() => props.friendRequests)
const loading = computed(() => props.friendStateLoading)
const errorMessage = computed(() => props.friendStateError)
const searchResults = ref<WebImUser[]>([])
const activeContact = ref<Contact | null>(null)
const keyword = ref('')
const userKeyword = ref('')
const requestMessage = ref('我是 ' + props.webSession.user.nickname)
const groupTitle = ref('')
const selectedGroupUserIds = ref<string[]>([])
const searching = ref(false)
let searchSequence = 0
let accessSearchRefreshTimer = 0

const filteredContacts = computed(() => {
  const value = keyword.value.trim().toLowerCase()
  if (!value) return contacts.value
  return contacts.value.filter((contact) => {
    return [contact.name, contact.account, contact.mobile, contact.imShortNo]
      .filter(Boolean)
      .some((item) => item.toLowerCase().includes(value))
  })
})

const incomingPendingRequests = computed(() =>
  requests.value.filter((item) => item.direction === 'incoming' && item.status === 1)
)

const groupCandidates = computed(() =>
  contacts.value.filter(
    (contact) =>
      !contact.isSystem &&
      contact.organization === props.webSession.organization
  )
)

const selectedGroupContacts = computed(() =>
  groupCandidates.value.filter((contact) =>
    selectedGroupUserIds.value.includes(contactIdentity(contact))
  )
)

function contactIdentity(contact: Pick<Contact, 'organization' | 'userId'>) {
  return imIdentityKey(contact.organization, contact.userId)
}

function userIdentity(user: Pick<WebImUser, 'organization' | 'userId'>) {
  return imIdentityKey(user.organization, user.userId)
}

async function submitSearch() {
  const sequence = ++searchSequence
  const value = userKeyword.value.trim()
  if (!value) {
    searchResults.value = []
    searching.value = false
    return
  }

  searching.value = true
  try {
    const loaded = await searchUsers(props.tenantConfig, props.webSession, value)
    if (sequence !== searchSequence) return
    searchResults.value = loaded
  } catch (error) {
    if (sequence !== searchSequence) return
    layer.error(error instanceof Error ? error.message : '搜索失败')
  } finally {
    if (sequence === searchSequence) searching.value = false
  }
}

async function addFriend(user: WebImUser) {
  try {
    const result = await sendFriendRequest(
      props.tenantConfig,
      props.webSession,
      user.organization,
      user.userId,
      requestMessage.value
    )
    layer.success(result.message)
    await submitSearch()
    await props.refreshFriendState()
  } catch (error) {
    layer.error(error instanceof Error ? error.message : '好友申请发送失败')
  }
}

async function resolveRequest(request: FriendRequest, action: 'accept' | 'reject') {
  try {
    await handleFriendRequest(props.tenantConfig, props.webSession, request, action)
    layer.success(action === 'accept' ? '已通过好友申请' : '已拒绝好友申请')
    await props.refreshFriendState()
  } catch (error) {
    layer.error(error instanceof Error ? error.message : '处理失败')
  }
}

async function editRemark(contact: Contact) {
  const remark = window.prompt('设置好友备注', contact.remark || contact.name)
  if (remark === null) return
  try {
    await updateFriendRemark(
      props.tenantConfig,
      props.webSession,
      contact.organization,
      contact.userId,
      remark.trim()
    )
    layer.success('好友备注已更新')
    await props.refreshFriendState()
  } catch (error) {
    layer.error(error instanceof Error ? error.message : '备注更新失败')
  }
}

function switchMode(mode: 'friends' | 'requests' | 'add' | 'group') {
  activeMode.value = mode
  if (mode === 'requests') void props.refreshFriendState()
}

function submitGroup() {
  emit(
    'create-group',
    groupTitle.value.trim() || selectedGroupContacts.value.slice(0, 3).map((item) => item.name).join('、') || '群聊',
    selectedGroupContacts.value
  )
  groupTitle.value = ''
  selectedGroupUserIds.value = []
}

function relationText(status: WebImUser['relationStatus']) {
  if (status === 'friend') return '已是好友'
  if (status === 'pending_in') return '待你通过'
  if (status === 'pending_out') return '等待验证'
  return '添加'
}

function requestUser(request: FriendRequest) {
  return request.direction === 'incoming' ? request.fromUser : request.toUser
}

function requestAvatarText(request: FriendRequest) {
  const user = requestUser(request)
  return (user?.nickname || user?.account || '友').slice(0, 1)
}

function requestStatusText(request: FriendRequest) {
  if (request.status === 1 && request.direction === 'outgoing') return '等待对方处理'
  return request.statusText
}

function handleConversationAccessChanged(event: Event) {
  const detail = (event as CustomEvent<{
    allowed?: boolean
    refresh?: boolean
    organization?: string
    userId?: string
  }>).detail
  const organization = String(detail?.organization ?? '')
  const userId = String(detail?.userId ?? '')
  searchSequence += 1
  searching.value = false
  if (detail?.allowed === false && organization && userId) {
    const identity = imIdentityKey(organization, userId)
    searchResults.value = searchResults.value.filter(
      (user) => userIdentity(user) !== identity
    )
    selectedGroupUserIds.value = selectedGroupUserIds.value.filter(
      (selected) => selected !== identity
    )
    if (activeContact.value && contactIdentity(activeContact.value) === identity) {
      activeContact.value = contacts.value.find(
        (contact) => contactIdentity(contact) !== identity
      ) ?? null
    }
    searchResults.value = searchResults.value.filter(
      (user) => user.organization === props.webSession.organization
    )
  } else if (detail?.allowed === false) {
    searchResults.value = searchResults.value.filter(
      (user) => user.organization === props.webSession.organization
    )
    selectedGroupUserIds.value = selectedGroupUserIds.value.filter(
      (identity) => identity.startsWith(`${props.webSession.organization}:`)
    )
    if (
      activeContact.value &&
      activeContact.value.organization !== props.webSession.organization
    ) {
      activeContact.value = contacts.value.find(
        (contact) => contact.organization === props.webSession.organization
      ) ?? null
    }
  }
  if (detail?.refresh === false) {
    window.clearTimeout(accessSearchRefreshTimer)
    if (userKeyword.value.trim()) {
      accessSearchRefreshTimer = window.setTimeout(() => {
        void submitSearch()
      }, 0)
    }
    return
  }
  void props.refreshFriendState().then(() => {
    if (userKeyword.value.trim()) {
      void submitSearch()
    } else {
      searchResults.value = []
      searching.value = false
    }
  })
}

onMounted(() => {
  window.addEventListener(
    CONVERSATION_ACCESS_BROWSER_EVENT,
    handleConversationAccessChanged
  )
})

onBeforeUnmount(() => {
  window.clearTimeout(accessSearchRefreshTimer)
  window.removeEventListener(
    CONVERSATION_ACCESS_BROWSER_EVENT,
    handleConversationAccessChanged
  )
})

watch(
  () => props.contacts,
  (loadedContacts) => {
    const activeIdentity = activeContact.value ? contactIdentity(activeContact.value) : ''
    activeContact.value = loadedContacts.find(
      (contact) => contactIdentity(contact) === activeIdentity
    ) ?? loadedContacts[0] ?? null
  },
  { immediate: true }
)
</script>

<template>
  <section class="contacts-layout">
    <aside class="contacts-sidebar">
      <header>
        <h2>联系人</h2>
        <button class="round-action" type="button" @click="switchMode('add')">
          <UserPlus :size="18" />
        </button>
      </header>
      <label class="search-box">
        <Search :size="17" />
        <input v-model="keyword" placeholder="搜索好友" />
      </label>

      <div class="quick-links">
        <button :class="{ active: activeMode === 'requests' }" type="button" @click="switchMode('requests')">
          新的朋友
          <strong v-if="incomingPendingRequests.length">{{ incomingPendingRequests.length }}</strong>
        </button>
        <button :class="{ active: activeMode === 'add' }" type="button" @click="switchMode('add')">添加好友</button>
        <button :class="{ active: activeMode === 'group' }" type="button" @click="switchMode('group')">发起群聊</button>
        <button :class="{ active: activeMode === 'friends' }" type="button" @click="switchMode('friends')">我的好友</button>
      </div>

      <div class="alpha-list">
        <small>好友</small>
        <div v-if="loading && activeMode === 'friends'" class="state-row">正在加载好友...</div>
        <div v-else-if="errorMessage && activeMode === 'friends'" class="state-row error">{{ errorMessage }}</div>
        <div v-else-if="filteredContacts.length === 0" class="state-row">暂无好友</div>
        <button
          v-for="contact in filteredContacts"
          :key="contactIdentity(contact)"
          :class="{
            active: activeMode === 'friends' &&
              activeContact &&
              contactIdentity(activeContact) === contactIdentity(contact)
          }"
          type="button"
          @click="activeMode = 'friends'; activeContact = contact"
        >
          <span class="avatar mini">
            <img v-if="contact.avatarUrl" :src="contact.avatarUrl" :alt="contact.name" />
            <template v-else>{{ contact.avatar }}</template>
            <i v-if="contact.online" class="online-dot" />
          </span>
          <span>
            <strong>{{ contact.name }}</strong>
            <small>{{ contact.title }}</small>
          </span>
        </button>
      </div>
    </aside>

    <main v-if="activeMode === 'friends' && activeContact" class="contact-profile">
      <div class="profile-card">
        <span class="avatar profile-avatar">
          <img v-if="activeContact.avatarUrl" :src="activeContact.avatarUrl" :alt="activeContact.name" />
          <template v-else>{{ activeContact.avatar }}</template>
        </span>
        <div>
          <h2>{{ activeContact.name }}</h2>
          <p>{{ activeContact.status }} · {{ activeContact.isSystem ? '系统联系人' : activeContact.signature || '暂无个性签名' }}</p>
          <span>b8im ID: {{ activeContact.imShortNo || activeContact.userId }}</span>
        </div>
      </div>

      <div class="profile-details">
        <div>
          <span>个性签名</span>
          <strong>{{ activeContact.signature || '暂无个性签名' }}</strong>
        </div>
        <div>
          <span>好友备注</span>
          <strong>{{ activeContact.remark || '未设置' }}</strong>
        </div>
        <div>
          <span>手机号</span>
          <strong>{{ activeContact.mobile || '未填写' }}</strong>
        </div>
        <div>
          <span>账号</span>
          <strong>{{ activeContact.account }}</strong>
        </div>
      </div>

      <div class="profile-actions">
        <button class="send-button" type="button" @click="emit('start-chat', activeContact)">
          <MessageCircle :size="18" /> 发消息
        </button>
        <button type="button"><Phone :size="18" /> 语音通话</button>
        <button type="button"><Video :size="18" /> 视频通话</button>
      </div>

      <div v-if="!activeContact.isSystem" class="profile-links">
        <button @click="editRemark(activeContact)">设置备注</button>
        <button>加入黑名单</button>
        <button class="danger-text">删除联系人</button>
      </div>
    </main>

    <main v-else-if="activeMode === 'requests'" class="contact-profile contact-workspace">
      <header class="contact-workspace-head">
        <h2>新的朋友</h2>
        <span>{{ incomingPendingRequests.length }} 条待处理</span>
      </header>
      <div v-if="loading" class="state-row">正在加载好友申请...</div>
      <div v-else-if="requests.length === 0" class="state-row">暂无好友申请</div>
      <div v-else class="request-list">
        <article v-for="request in requests" :key="request.id" class="request-card">
          <span class="avatar mini">
            <img v-if="requestUser(request)?.avatarUrl" :src="requestUser(request)?.avatarUrl" :alt="requestUser(request)?.nickname || '好友申请'" />
            <template v-else>{{ requestAvatarText(request) }}</template>
          </span>
          <div>
            <strong>
              {{ request.direction === 'incoming' ? request.fromUser?.nickname : request.toUser?.nickname }}
            </strong>
            <small>{{ request.direction === 'incoming' ? '申请添加你为好友' : '你发出的好友申请' }}</small>
            <p>{{ request.message || '无验证信息' }}</p>
          </div>
          <div class="request-actions">
            <span>{{ requestStatusText(request) }}</span>
            <template v-if="request.direction === 'incoming' && request.status === 1">
              <button type="button" @click="resolveRequest(request, 'accept')"><Check :size="16" /> 通过</button>
              <button type="button" @click="resolveRequest(request, 'reject')"><X :size="16" /> 拒绝</button>
            </template>
          </div>
        </article>
      </div>
    </main>

    <main v-else-if="activeMode === 'add'" class="contact-profile contact-workspace">
      <header class="contact-workspace-head">
        <h2>添加好友</h2>
        <span>搜索账号、昵称、手机号或短号</span>
      </header>
      <form class="friend-search" @submit.prevent="submitSearch">
        <input v-model="userKeyword" placeholder="输入关键词" />
        <button class="send-button" type="submit">{{ searching ? '搜索中...' : '搜索' }}</button>
      </form>
      <textarea v-model="requestMessage" class="request-message" maxlength="120" />
      <div v-if="searchResults.length === 0" class="state-row">输入关键词后搜索用户</div>
      <div v-else class="request-list">
        <article v-for="user in searchResults" :key="userIdentity(user)" class="request-card">
          <span class="avatar mini">
            <img v-if="user.avatarUrl" :src="user.avatarUrl" :alt="user.nickname" />
            <template v-else>{{ user.nickname.slice(0, 1) || '友' }}</template>
          </span>
          <div>
            <strong>{{ user.nickname }}</strong>
            <small>{{ user.account }} · {{ user.imShortNo || '无短号' }}</small>
            <p>{{ user.signature || '暂无个性签名' }}</p>
          </div>
          <div class="request-actions">
            <button
              type="button"
              :disabled="user.relationStatus !== 'none'"
              @click="addFriend(user)"
            >
              <UserPlus :size="16" /> {{ relationText(user.relationStatus) }}
            </button>
          </div>
        </article>
      </div>
    </main>

    <main v-else-if="activeMode === 'group'" class="contact-profile contact-workspace">
      <header class="contact-workspace-head">
        <h2>发起群聊</h2>
        <span>已选择 {{ selectedGroupContacts.length }} 个好友</span>
      </header>
      <form class="friend-search" @submit.prevent="submitGroup">
        <input v-model="groupTitle" placeholder="群聊名称，可留空" />
        <button class="send-button" type="submit" :disabled="selectedGroupContacts.length < 2">创建群聊</button>
      </form>
      <div v-if="groupCandidates.length === 0" class="state-row">暂无可邀请好友</div>
      <div v-else class="request-list">
        <label v-for="contact in groupCandidates" :key="contactIdentity(contact)" class="request-card selectable-card">
          <input v-model="selectedGroupUserIds" type="checkbox" :value="contactIdentity(contact)" />
          <span class="avatar mini">
            <img v-if="contact.avatarUrl" :src="contact.avatarUrl" :alt="contact.name" />
            <template v-else>{{ contact.avatar }}</template>
          </span>
          <div>
            <strong>{{ contact.name }}</strong>
            <small>{{ contact.account }} · {{ contact.imShortNo || '无短号' }}</small>
            <p>{{ contact.signature || contact.title }}</p>
          </div>
        </label>
      </div>
    </main>

    <main v-else class="contact-profile empty-profile">
      <strong>请选择好友</strong>
    </main>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Ban, BellOff, Camera, Check, ChevronRight, Crown, FileText, Megaphone, MoreHorizontal, Pencil, Plus, RotateCcw, Search, ShieldCheck, Star, UserMinus, UsersRound, X } from '@lucide/vue'
import AvatarCropDialog from './AvatarCropDialog.vue'
import ConversationAvatar from './ConversationAvatar.vue'
import { layer } from '../services/layer'
import { addGroupMembers, fetchContacts, fetchGroupMembers, removeGroupMember, updateGroupManagers, updateGroupMemberStatus } from '../services/webIm'
import type { TenantBrandConfig } from '../services/tenantConfig'
import type { AvatarMember, Contact, GroupMember, ImConversation, WebImSession } from '../types'
import { GROUP_ACCESS_BROWSER_EVENT } from '../services/groupMemberAccess'

const props = defineProps<{
  conversation: ImConversation | null
  tenantConfig: TenantBrandConfig
  webSession: WebImSession
  savingGroupProfile: boolean
}>()

const emit = defineEmits<{
  close: []
  'toggle-pinned': []
  'toggle-muted': []
  'update-group-title': [string]
  'update-group-avatar': [File]
  'update-group-description': [string, boolean]
  'open-search': []
}>()

const members = ref<GroupMember[]>([])
const contacts = ref<Contact[]>([])
const editingGroupTitle = ref(false)
const groupTitleDraft = ref('')
const groupTitleInput = ref<HTMLInputElement | null>(null)
const showGroupAvatarCrop = ref(false)
const groupDescriptionDraft = ref('')
const groupDescriptionPublished = ref('')
const groupDescriptionConfirm = ref(false)
const managerSaving = ref(false)
const showInviteDialog = ref(false)
const inviteLoading = ref(false)
const inviteKeyword = ref('')
const selectedInviteUserIds = ref<string[]>([])
const selectedMember = ref<GroupMember | null>(null)
const showMuteDialog = ref(false)
const muteUntilDraft = ref('')

const currentMember = computed(() =>
  members.value.find((member) => member.user.userId === props.webSession.user.userId) ?? null
)
const isGroup = computed(() => props.conversation?.conversationType === 'group')
const isGroupOwner = computed(() => isGroup.value && Number(currentMember.value?.role ?? 0) === 2)
const canEditGroupProfile = computed(() =>
  isGroup.value && [2, 3].includes(Number(currentMember.value?.role ?? 0))
)
const groupDescriptionChanged = computed(() => groupDescriptionDraft.value.trim() !== groupDescriptionPublished.value.trim())
const displayAvatarMembers = computed<AvatarMember[]>(() => {
  if (props.conversation?.avatarMembers?.length) return props.conversation.avatarMembers
  return members.value.slice(0, 4).map((member) => ({
    userId: member.user.userId,
    nickname: member.user.nickname,
    account: member.user.account,
    avatarUrl: member.user.avatarUrl
  }))
})
const managerUserIds = computed(() =>
  members.value.filter((member) => Number(member.role) === 3).map((member) => member.user.userId)
)
const visibleMembers = computed(() => members.value.slice(0, 11))
const hiddenMemberCount = computed(() => Math.max(members.value.length - visibleMembers.value.length, 0))
const memberUserIdSet = computed(() => new Set(members.value.map((member) => member.user.userId)))
const availableInviteContacts = computed(() => {
  const keyword = inviteKeyword.value.trim().toLowerCase()
  const rows = contacts.value.filter(
    (contact) =>
      !memberUserIdSet.value.has(contact.userId) &&
      !contact.isSystem &&
      contact.organization === props.webSession.organization
  )
  if (!keyword) return rows
  return rows.filter((contact) =>
    [contact.name, contact.account, contact.imShortNo, contact.remark]
      .filter(Boolean)
      .some((text) => String(text).toLowerCase().includes(keyword))
  )
})

async function loadMembers() {
  if (!props.conversation?.conversationId || props.conversation.conversationType !== 'group') {
    members.value = []
    return
  }
  try {
    members.value = await fetchGroupMembers(props.tenantConfig, props.webSession, props.conversation.conversationId)
  } catch {
    members.value = []
  }
}

function clearGroupAccessDerivedState() {
  members.value = []
  contacts.value = []
  selectedInviteUserIds.value = []
  selectedMember.value = null
  groupTitleDraft.value = ''
  groupDescriptionDraft.value = ''
  groupDescriptionPublished.value = ''
  groupDescriptionConfirm.value = false
  showGroupAvatarCrop.value = false
  showInviteDialog.value = false
  inviteKeyword.value = ''
  showMuteDialog.value = false
  muteUntilDraft.value = ''
  cancelGroupTitleEdit()
}

function syncGroupDescription() {
  const description = props.conversation?.conversationType === 'group' ? props.conversation.description : ''
  groupDescriptionPublished.value = description || ''
  groupDescriptionDraft.value = groupDescriptionPublished.value
}

async function startGroupTitleEdit() {
  if (!props.conversation || !canEditGroupProfile.value) return
  groupTitleDraft.value = props.conversation.title
  editingGroupTitle.value = true
  await nextTick()
  groupTitleInput.value?.focus()
  groupTitleInput.value?.select()
}

function cancelGroupTitleEdit() {
  editingGroupTitle.value = false
  groupTitleDraft.value = ''
}

function submitGroupTitle() {
  const title = groupTitleDraft.value.trim()
  if (!title || title === props.conversation?.title || props.savingGroupProfile) {
    cancelGroupTitleEdit()
    return
  }

  emit('update-group-title', title)
  cancelGroupTitleEdit()
}

function openGroupAvatarCrop() {
  if (!canEditGroupProfile.value || props.savingGroupProfile) return
  showGroupAvatarCrop.value = true
}

function saveGroupAvatar(file: File) {
  emit('update-group-avatar', file)
  showGroupAvatarCrop.value = false
}

function requestPublishGroupDescription() {
  if (!canEditGroupProfile.value || props.savingGroupProfile || !groupDescriptionChanged.value) return
  groupDescriptionConfirm.value = true
}

function publishGroupDescription(notifyAll: boolean) {
  emit('update-group-description', groupDescriptionDraft.value.trim(), notifyAll)
  groupDescriptionConfirm.value = false
}

async function toggleManager(member: GroupMember) {
  if (!props.conversation?.conversationId || !isGroupOwner.value || managerSaving.value) return
  const userId = member.user.userId
  const nextManagerUserIds = Number(member.role) === 3
    ? managerUserIds.value.filter((id) => id !== userId)
    : [...managerUserIds.value, userId]

  managerSaving.value = true
  try {
    members.value = await updateGroupManagers(props.tenantConfig, props.webSession, {
      conversationId: props.conversation.conversationId,
      managerUserIds: nextManagerUserIds
    })
    selectedMember.value = members.value.find((item) => item.user.userId === userId) ?? selectedMember.value
    layer.success(Number(member.role) === 3 ? '已取消管理员' : '已设为管理员')
  } catch (error) {
    layer.error(error instanceof Error ? error.message : '管理员设置失败')
  } finally {
    managerSaving.value = false
  }
}

function memberRoleText(role: number) {
  if (Number(role) === 2) return '群主'
  if (Number(role) === 3) return '管理员'
  return ''
}

function memberStatusText(member: GroupMember) {
  if (Number(member.status) === 2) {
    return member.muteUntil ? `禁言至 ${member.muteUntil}` : '已禁言'
  }
  return '正常'
}

function isMemberMuted(member: GroupMember | null) {
  return Number(member?.status ?? 1) === 2
}

function memberAvatarTitle(member: GroupMember) {
  return [member.user.nickname, memberRoleText(member.role), isMemberMuted(member) ? memberStatusText(member) : '']
    .filter(Boolean)
    .join(' · ')
}

function canManageMember(member: GroupMember | null) {
  if (!member || member.user.userId === props.webSession.user.userId || Number(member.role) === 2) return false
  const currentRole = Number(currentMember.value?.role ?? 0)
  if (currentRole === 2) return true
  return currentRole === 3 && Number(member.role) === 1
}

function canToggleManager(member: GroupMember | null) {
  return Boolean(member && isGroupOwner.value && member.user.userId !== props.webSession.user.userId && Number(member.role) !== 2 && Number(member.status) === 1)
}

function openMemberCard(member: GroupMember) {
  selectedMember.value = member
}

async function openInviteMembers() {
  if (!props.conversation?.conversationId || !canEditGroupProfile.value) return
  showInviteDialog.value = true
  inviteKeyword.value = ''
  selectedInviteUserIds.value = []
  inviteLoading.value = true
  try {
    contacts.value = await fetchContacts(props.tenantConfig, props.webSession)
  } catch (error) {
    contacts.value = []
    layer.error(error instanceof Error ? error.message : '联系人加载失败')
  } finally {
    inviteLoading.value = false
  }
}

function toggleInviteContact(contact: Contact) {
  selectedInviteUserIds.value = selectedInviteUserIds.value.includes(contact.userId)
    ? selectedInviteUserIds.value.filter((userId) => userId !== contact.userId)
    : [...selectedInviteUserIds.value, contact.userId]
}

async function submitInviteMembers() {
  if (!props.conversation?.conversationId || selectedInviteUserIds.value.length === 0) return
  inviteLoading.value = true
  try {
    members.value = await addGroupMembers(props.tenantConfig, props.webSession, {
      conversationId: props.conversation.conversationId,
      memberIds: selectedInviteUserIds.value
    })
    layer.success('已邀请成员入群')
    showInviteDialog.value = false
  } catch (error) {
    layer.error(error instanceof Error ? error.message : '邀请成员失败')
  } finally {
    inviteLoading.value = false
  }
}

function defaultMuteUntil(minutes: number) {
  const date = new Date(Date.now() + minutes * 60 * 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function openMuteMemberDialog() {
  if (!canManageMember(selectedMember.value)) return
  muteUntilDraft.value = defaultMuteUntil(10)
  showMuteDialog.value = true
}

async function saveMuteMember() {
  const member = selectedMember.value
  if (!member || !props.conversation?.conversationId || !muteUntilDraft.value) return
  managerSaving.value = true
  try {
    members.value = await updateGroupMemberStatus(props.tenantConfig, props.webSession, {
      conversationId: props.conversation.conversationId,
      memberUserId: member.user.userId,
      status: 2,
      muteUntil: muteUntilDraft.value.replace('T', ' ') + ':00'
    })
    selectedMember.value = members.value.find((item) => item.user.userId === member.user.userId) ?? null
    showMuteDialog.value = false
    layer.success('已设置禁言')
  } catch (error) {
    layer.error(error instanceof Error ? error.message : '设置禁言失败')
  } finally {
    managerSaving.value = false
  }
}

async function unmuteSelectedMember() {
  const member = selectedMember.value
  if (!member || !props.conversation?.conversationId || !canManageMember(member)) return
  managerSaving.value = true
  try {
    members.value = await updateGroupMemberStatus(props.tenantConfig, props.webSession, {
      conversationId: props.conversation.conversationId,
      memberUserId: member.user.userId,
      status: 1
    })
    selectedMember.value = members.value.find((item) => item.user.userId === member.user.userId) ?? null
    layer.success('已解除禁言')
  } catch (error) {
    layer.error(error instanceof Error ? error.message : '解除禁言失败')
  } finally {
    managerSaving.value = false
  }
}

async function removeSelectedMember() {
  const member = selectedMember.value
  if (!member || !props.conversation?.conversationId || !canManageMember(member)) return
  managerSaving.value = true
  try {
    members.value = await removeGroupMember(props.tenantConfig, props.webSession, {
      conversationId: props.conversation.conversationId,
      memberUserId: member.user.userId
    })
    selectedMember.value = null
    layer.success('已移除成员')
  } catch (error) {
    layer.error(error instanceof Error ? error.message : '移除成员失败')
  } finally {
    managerSaving.value = false
  }
}

onMounted(() => {
  window.addEventListener(GROUP_ACCESS_BROWSER_EVENT, clearGroupAccessDerivedState)
  syncGroupDescription()
  void loadMembers()
})
onBeforeUnmount(() => {
  window.removeEventListener(GROUP_ACCESS_BROWSER_EVENT, clearGroupAccessDerivedState)
})
watch(() => props.conversation?.conversationId, () => {
  cancelGroupTitleEdit()
  showGroupAvatarCrop.value = false
  groupDescriptionConfirm.value = false
  showInviteDialog.value = false
  selectedMember.value = null
  showMuteDialog.value = false
  syncGroupDescription()
  void loadMembers()
})
watch(() => props.conversation?.description, syncGroupDescription)
</script>

<template>
  <aside class="info-panel">
    <header>
      <h3>聊天详情</h3>
      <button class="icon-button" title="关闭聊天详情" @click="emit('close')"><X :size="18" /></button>
    </header>

    <section class="group-card">
      <button
        class="group-profile-avatar"
        type="button"
        :disabled="!canEditGroupProfile || savingGroupProfile"
        :title="canEditGroupProfile ? '更换群头像' : '群头像'"
        @click="openGroupAvatarCrop"
      >
        <ConversationAvatar
          :title="conversation?.title || '未选择会话'"
          :avatar="conversation?.avatar"
          :peer-avatar-url="conversation?.peerUser?.avatarUrl"
          :avatar-members="displayAvatarMembers"
          :conversation-type="conversation?.conversationType"
          profile
        />
        <span v-if="canEditGroupProfile" class="group-avatar-edit">
          <Camera :size="14" />
        </span>
      </button>

      <form v-if="editingGroupTitle" class="group-title-edit" @submit.prevent="submitGroupTitle">
        <input
          ref="groupTitleInput"
          v-model="groupTitleDraft"
          maxlength="100"
          :disabled="savingGroupProfile"
          @keydown.esc.prevent="cancelGroupTitleEdit"
        />
        <button type="submit" :disabled="savingGroupProfile || !groupTitleDraft.trim()" title="保存群聊名称">
          <Check :size="15" />
        </button>
        <button type="button" title="取消" @click="cancelGroupTitleEdit">
          <X :size="15" />
        </button>
      </form>
      <div v-else class="group-title-display">
        <strong>{{ conversation?.title || '未选择会话' }}</strong>
        <button
          v-if="canEditGroupProfile"
          type="button"
          title="修改群聊名称"
          :disabled="savingGroupProfile"
          @click="startGroupTitleEdit"
        >
          <Pencil :size="14" />
        </button>
      </div>
      <span>
        {{
          conversation
            ? conversation.conversationType === 'group'
              ? '群聊'
              : conversation.peerUser?.signature || '暂无个性签名'
            : '请选择会话'
        }}
      </span>
    </section>

    <section v-if="conversation?.conversationType === 'group'" class="group-description-panel">
      <div class="section-title">
        <span><Megaphone :size="16" /> 群简介</span>
        <small>{{ groupDescriptionDraft.length }}/500</small>
      </div>
      <textarea
        v-if="canEditGroupProfile"
        v-model="groupDescriptionDraft"
        maxlength="500"
        :disabled="savingGroupProfile"
        placeholder="暂无群简介"
      />
      <p v-else>{{ conversation.description || '暂无群简介' }}</p>
      <div v-if="canEditGroupProfile" class="description-actions">
        <button
          type="button"
          :disabled="savingGroupProfile || !groupDescriptionChanged"
          @click="requestPublishGroupDescription"
        >
          发布
        </button>
      </div>
    </section>

    <section class="members-strip">
      <div class="section-title">
        <span><UsersRound :size="16" /> {{ conversation?.conversationType === 'group' ? '群成员' : '聊天对象' }}</span>
        <small>{{ conversation?.conversationType === 'group' ? members.length : conversation ? 1 : 0 }}</small>
      </div>
      <div class="member-grid">
        <template v-if="conversation?.conversationType === 'group'">
          <button
            v-for="member in visibleMembers"
            :key="member.user.userId"
            class="member-avatar"
            :class="{ muted: isMemberMuted(member) }"
            type="button"
            :title="memberAvatarTitle(member)"
            @click="openMemberCard(member)"
          >
            <img v-if="member.user.avatarUrl" :src="member.user.avatarUrl" :alt="member.user.nickname" />
            <template v-else>{{ member.user.nickname.slice(0, 1) || '群' }}</template>
            <i v-if="member.role === 2 || member.role === 3" class="role-mark" :class="{ owner: member.role === 2 }">
              <Crown v-if="member.role === 2" :size="10" />
              <ShieldCheck v-else :size="10" />
            </i>
            <i v-if="isMemberMuted(member)" class="mute-mark" aria-hidden="true">禁</i>
          </button>
          <span v-if="hiddenMemberCount > 0" class="member-avatar more-members" :title="`还有 ${hiddenMemberCount} 位成员`">
            <MoreHorizontal :size="18" />
          </span>
          <button
            v-if="canEditGroupProfile"
            class="member-avatar add-member"
            type="button"
            title="邀请成员入群"
            @click="openInviteMembers"
          >
            <Plus :size="19" />
          </button>
        </template>
        <span v-else-if="conversation" class="member-avatar">
          <img v-if="conversation.peerUser?.avatarUrl" :src="conversation.peerUser.avatarUrl" :alt="conversation.title" />
          <template v-else>{{ conversation.avatar || conversation.title.slice(0, 1) }}</template>
        </span>
        <div v-else class="state-row">暂无会话</div>
      </div>
    </section>

    <section class="info-list">
      <button @click="emit('open-search')">
        <span><Search :size="17" /> 查找聊天内容</span>
        <ChevronRight :size="17" />
      </button>
      <button disabled>
        <span><FileText :size="17" /> 共享文件</span>
        <ChevronRight :size="17" />
      </button>
      <button @click="emit('toggle-muted')">
        <span><BellOff :size="17" /> 消息免打扰</span>
        <i class="switch" :class="{ on: conversation?.isMuted }" />
      </button>
      <button @click="emit('toggle-pinned')">
        <span><Star :size="17" /> 聊天置顶</span>
        <i class="switch" :class="{ on: conversation?.isPinned }" />
      </button>
    </section>

    <section class="shared-files">
      <div class="section-title">
        <span>最近文件</span>
        <small>0</small>
      </div>
      <div class="state-row">暂无共享文件</div>
    </section>

    <button class="danger-link">清空聊天记录</button>

    <div v-if="selectedMember" class="confirm-mask">
      <div class="member-dialog">
        <button class="dialog-close" type="button" title="关闭" @click="selectedMember = null">
          <X :size="17" />
        </button>
        <span class="member-dialog-avatar" :class="{ muted: isMemberMuted(selectedMember) }">
          <img v-if="selectedMember.user.avatarUrl" :src="selectedMember.user.avatarUrl" :alt="selectedMember.user.nickname" />
          <template v-else>{{ selectedMember.user.nickname.slice(0, 1) || '员' }}</template>
          <i v-if="isMemberMuted(selectedMember)" class="mute-mark dialog" aria-hidden="true">禁</i>
        </span>
        <h4>{{ selectedMember.user.nickname || selectedMember.user.account }}</h4>
        <p>{{ selectedMember.user.account }} · {{ memberRoleText(selectedMember.role) || '成员' }}</p>
        <dl>
          <div>
            <dt>进群时间</dt>
            <dd>{{ selectedMember.joinTime || '暂无记录' }}</dd>
          </div>
          <div>
            <dt>成员状态</dt>
            <dd>{{ memberStatusText(selectedMember) }}</dd>
          </div>
          <div v-if="selectedMember.user.signature">
            <dt>签名</dt>
            <dd>{{ selectedMember.user.signature }}</dd>
          </div>
        </dl>
        <div v-if="canManageMember(selectedMember) || canToggleManager(selectedMember)" class="member-dialog-actions">
          <button
            v-if="canToggleManager(selectedMember)"
            type="button"
            :disabled="managerSaving"
            @click="toggleManager(selectedMember)"
          >
            <ShieldCheck :size="15" />
            {{ selectedMember.role === 3 ? '取消管理员' : '设为管理员' }}
          </button>
          <button
            v-if="canManageMember(selectedMember) && selectedMember.status === 1"
            type="button"
            :disabled="managerSaving"
            @click="openMuteMemberDialog"
          >
            <Ban :size="15" />
            设置禁言
          </button>
          <button
            v-if="canManageMember(selectedMember) && selectedMember.status === 2"
            type="button"
            :disabled="managerSaving"
            @click="unmuteSelectedMember"
          >
            <RotateCcw :size="15" />
            解除禁言
          </button>
          <button
            v-if="canManageMember(selectedMember)"
            type="button"
            class="danger"
            :disabled="managerSaving"
            @click="removeSelectedMember"
          >
            <UserMinus :size="15" />
            移除成员
          </button>
        </div>
      </div>
    </div>

    <div v-if="showInviteDialog" class="confirm-mask">
      <div class="invite-dialog">
        <header>
          <h4>邀请成员入群</h4>
          <button class="dialog-close" type="button" title="关闭" @click="showInviteDialog = false">
            <X :size="17" />
          </button>
        </header>
        <input v-model="inviteKeyword" placeholder="搜索好友" />
        <div class="invite-list">
          <button
            v-for="contact in availableInviteContacts"
            :key="contact.userId"
            type="button"
            :class="{ selected: selectedInviteUserIds.includes(contact.userId) }"
            @click="toggleInviteContact(contact)"
          >
            <span class="manager-avatar">
              <img v-if="contact.avatarUrl" :src="contact.avatarUrl" :alt="contact.name" />
              <template v-else>{{ contact.name.slice(0, 1) || '友' }}</template>
            </span>
            <span>{{ contact.name }}</span>
            <Check v-if="selectedInviteUserIds.includes(contact.userId)" :size="16" />
          </button>
          <div v-if="!inviteLoading && availableInviteContacts.length === 0" class="state-row">暂无可邀请好友</div>
        </div>
        <footer>
          <button type="button" @click="showInviteDialog = false">取消</button>
          <button
            type="button"
            class="primary"
            :disabled="inviteLoading || selectedInviteUserIds.length === 0"
            @click="submitInviteMembers"
          >
            邀请{{ selectedInviteUserIds.length ? `(${selectedInviteUserIds.length})` : '' }}
          </button>
        </footer>
      </div>
    </div>

    <div v-if="showMuteDialog" class="confirm-mask">
      <div class="confirm-dialog">
        <h4>设置禁言时间</h4>
        <p>选择该成员的禁言截止时间。</p>
        <input v-model="muteUntilDraft" class="mute-time-input" type="datetime-local" />
        <div class="mute-presets">
          <button type="button" @click="muteUntilDraft = defaultMuteUntil(10)">10分钟</button>
          <button type="button" @click="muteUntilDraft = defaultMuteUntil(60)">1小时</button>
          <button type="button" @click="muteUntilDraft = defaultMuteUntil(1440)">1天</button>
        </div>
        <div class="confirm-actions">
          <button type="button" @click="showMuteDialog = false">取消</button>
          <button type="button" class="primary" :disabled="managerSaving || !muteUntilDraft" @click="saveMuteMember">
            确认禁言
          </button>
        </div>
      </div>
    </div>

    <div v-if="groupDescriptionConfirm" class="confirm-mask">
      <div class="confirm-dialog">
        <h4>发布群简介</h4>
        <p>是否需要 @全体 通知群成员？</p>
        <div class="confirm-actions">
          <button type="button" @click="groupDescriptionConfirm = false">取消</button>
          <button type="button" :disabled="savingGroupProfile" @click="publishGroupDescription(false)">仅发布</button>
          <button type="button" class="primary" :disabled="savingGroupProfile" @click="publishGroupDescription(true)">
            @全体发布
          </button>
        </div>
      </div>
    </div>

    <AvatarCropDialog
      v-if="showGroupAvatarCrop"
      :saving="savingGroupProfile"
      @save="saveGroupAvatar"
      @close="showGroupAvatarCrop = false"
    />
  </aside>
</template>

<style scoped>
.group-profile-avatar {
  position: relative;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: inherit;
}

.group-profile-avatar:disabled {
  cursor: default;
}

.group-profile-avatar:not(:disabled):hover .group-avatar-edit {
  opacity: 1;
}

.group-avatar-edit {
  position: absolute;
  right: -4px;
  bottom: -4px;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border: 2px solid var(--panel);
  border-radius: 50%;
  background: var(--green);
  color: #fff;
  opacity: 0.94;
}

.group-title-display,
.group-title-edit {
  width: min(270px, 100%);
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.group-title-display strong {
  min-width: 0;
  overflow: hidden;
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-title-display button,
.group-title-edit button {
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: #eef1f3;
  color: var(--muted);
}

.group-title-display button:hover,
.group-title-edit button:hover {
  color: var(--green);
}

.group-title-edit input {
  min-width: 0;
  height: 32px;
  flex: 1;
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 0 9px;
  background: var(--panel);
  color: var(--text);
  text-align: center;
  outline: none;
}

.group-title-edit input:focus {
  border-color: rgba(37, 192, 109, 0.62);
}

.group-title-display button:disabled,
.group-title-edit button:disabled,
.group-title-edit input:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.group-description-panel {
  padding: 18px 20px;
  border-bottom: 8px solid #f5f6f7;
}

.group-description-panel textarea {
  width: 100%;
  min-height: 92px;
  resize: vertical;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--panel);
  color: var(--text);
  font-size: 14px;
  line-height: 1.55;
  outline: none;
}

.group-description-panel textarea:focus {
  border-color: rgba(37, 192, 109, 0.62);
}

.group-description-panel textarea:disabled {
  cursor: not-allowed;
  opacity: 0.7;
}

.group-description-panel p {
  margin: 8px 0 0;
  color: var(--muted);
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.description-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 10px;
}

.description-actions button {
  height: 32px;
  padding: 0 16px;
  border: 0;
  border-radius: 7px;
  background: var(--green);
  color: #fff;
  font-weight: 700;
}

.description-actions button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.member-avatar {
  position: relative;
  border: 0;
  padding: 0;
  cursor: pointer;
}

.member-avatar.muted,
.member-dialog-avatar.muted {
  box-shadow: inset 0 0 0 2px rgba(239, 68, 68, 0.42);
}

.role-mark {
  position: absolute;
  right: -4px;
  bottom: -4px;
  width: 17px;
  height: 17px;
  display: grid;
  place-items: center;
  border: 2px solid var(--panel);
  border-radius: 50%;
  background: #4b5563;
  color: #fff;
}

.role-mark.owner {
  background: #eab308;
}

.mute-mark {
  position: absolute;
  left: -4px;
  top: -4px;
  width: 17px;
  height: 17px;
  display: grid;
  place-items: center;
  border: 2px solid var(--panel);
  border-radius: 50%;
  background: #ef4444;
  color: #fff;
  font-size: 10px;
  font-style: normal;
  font-weight: 800;
  line-height: 1;
}

.mute-mark.dialog {
  left: -6px;
  top: -6px;
  width: 22px;
  height: 22px;
  font-size: 12px;
}

.more-members,
.add-member {
  color: var(--muted);
  background: #eef1f3;
}

.add-member {
  color: var(--green);
}

.member-avatar:hover,
.add-member:hover {
  box-shadow: 0 0 0 3px rgba(37, 192, 109, 0.12);
}

.manager-list {
  display: grid;
  gap: 8px;
  margin-top: 14px;
}

.manager-list button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  min-height: 42px;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 6px 10px;
  background: var(--panel);
  color: var(--text);
}

.manager-list button:disabled {
  cursor: not-allowed;
  opacity: 0.62;
}

.manager-user {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 9px;
}

.manager-user > span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.manager-avatar {
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  overflow: hidden;
  border-radius: 7px;
  background: var(--green-soft);
  color: var(--green);
  font-size: 13px;
  font-weight: 800;
}

.manager-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.manager-list strong {
  flex: 0 0 auto;
  color: var(--green);
  font-size: 13px;
}

.confirm-mask {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(15, 23, 42, 0.32);
}

.confirm-dialog {
  width: min(320px, 100%);
  border-radius: 10px;
  background: var(--panel);
  box-shadow: 0 18px 48px rgba(15, 23, 42, 0.22);
  padding: 20px;
}

.confirm-dialog h4 {
  margin: 0;
  color: var(--text);
  font-size: 17px;
}

.confirm-dialog p {
  margin: 10px 0 18px;
  color: var(--muted);
  line-height: 1.55;
}

.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.confirm-actions button {
  height: 34px;
  border: 0;
  border-radius: 7px;
  padding: 0 12px;
  background: #eef1f3;
  color: var(--text);
  font-weight: 700;
}

.confirm-actions button.primary {
  background: var(--green);
  color: #fff;
}

.confirm-actions button:disabled {
  cursor: not-allowed;
  opacity: 0.62;
}

.dialog-close {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 7px;
  background: #eef1f3;
  color: var(--muted);
}

.member-dialog,
.invite-dialog {
  position: relative;
  width: min(340px, 100%);
  max-height: min(78vh, 620px);
  overflow: auto;
  border-radius: 10px;
  background: var(--panel);
  box-shadow: 0 18px 48px rgba(15, 23, 42, 0.22);
  padding: 20px;
}

.member-dialog {
  display: grid;
  justify-items: center;
  text-align: center;
}

.member-dialog-avatar {
  position: relative;
  width: 68px;
  height: 68px;
  display: grid;
  place-items: center;
  overflow: hidden;
  border-radius: 14px;
  background: var(--green);
  color: #fff;
  font-size: 28px;
  font-weight: 800;
}

.member-dialog-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.member-dialog h4,
.invite-dialog h4 {
  margin: 12px 0 0;
  color: var(--text);
  font-size: 17px;
}

.member-dialog p {
  margin: 6px 0 14px;
  color: var(--muted);
}

.member-dialog dl {
  width: 100%;
  display: grid;
  gap: 10px;
  margin: 0;
  text-align: left;
}

.member-dialog dl div {
  display: grid;
  gap: 3px;
  border-radius: 8px;
  background: var(--soft);
  padding: 9px 10px;
}

.member-dialog dt {
  color: var(--muted);
  font-size: 12px;
}

.member-dialog dd {
  margin: 0;
  color: var(--text);
  word-break: break-word;
}

.member-dialog-actions {
  width: 100%;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 16px;
}

.member-dialog-actions button {
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 0;
  border-radius: 7px;
  background: #eef1f3;
  color: var(--text);
  font-weight: 700;
}

.member-dialog-actions button.danger {
  color: #ef4444;
}

.member-dialog-actions button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.invite-dialog header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.invite-dialog header h4 {
  margin: 0;
}

.invite-dialog input,
.mute-time-input {
  width: 100%;
  height: 38px;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 0 11px;
  background: var(--soft);
  color: var(--text);
  outline: none;
}

.invite-list {
  display: grid;
  gap: 8px;
  max-height: 310px;
  overflow: auto;
  margin: 12px 0;
}

.invite-list button {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 10px;
  background: var(--panel);
  color: var(--text);
  text-align: left;
}

.invite-list button.selected {
  border-color: rgba(37, 192, 109, 0.45);
  background: var(--green-soft);
}

.invite-dialog footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.invite-dialog footer button {
  height: 34px;
  border: 0;
  border-radius: 7px;
  padding: 0 14px;
  background: #eef1f3;
  color: var(--text);
  font-weight: 700;
}

.invite-dialog footer button.primary {
  background: var(--green);
  color: #fff;
}

.invite-dialog footer button:disabled {
  cursor: not-allowed;
  opacity: 0.62;
}

.mute-presets {
  display: flex;
  gap: 8px;
  margin: 10px 0 16px;
}

.mute-presets button {
  height: 30px;
  flex: 1;
  border: 0;
  border-radius: 7px;
  background: #eef1f3;
  color: var(--text);
}

:global(:root[data-web-theme="dark"]) .group-title-display button,
:global(:root[data-web-theme="dark"]) .group-title-edit button,
:global(:root[data-web-theme="dark"]) .confirm-actions button,
:global(:root[data-web-theme="dark"]) .dialog-close,
:global(:root[data-web-theme="dark"]) .member-dialog-actions button,
:global(:root[data-web-theme="dark"]) .invite-dialog footer button,
:global(:root[data-web-theme="dark"]) .mute-presets button,
:global(:root[data-web-theme="dark"]) .more-members,
:global(:root[data-web-theme="dark"]) .add-member {
  background: #233041;
}

:global(:root[data-web-theme="dark"]) .group-description-panel {
  border-bottom-color: #111827;
}
</style>

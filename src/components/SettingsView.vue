<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  BellRing,
  KeyRound,
  LockKeyhole,
  Monitor,
  Moon,
  Stamp,
  Sun,
  UserRound,
  Volume2,
  X
} from '@lucide/vue'
import { playNotificationSound } from '../services/notification'
import type { TenantBrandConfig } from '../services/tenantConfig'
import type {
  LockScreenSettings,
  MessageGroupLayout,
  NotificationSettings,
  ThemeMode,
  WatermarkSettings,
  WebImSession
} from '../types'

interface LockPasswordPayload {
  currentPassword: string
  password: string
  confirmPassword: string
}

const props = defineProps<{
  account: {
    org: string
    username: string
  }
  tenantConfig: TenantBrandConfig
  webSession: WebImSession
  watermarkSettings: WatermarkSettings
  notificationSettings: NotificationSettings
  lockScreenSettings: LockScreenSettings
  lockPasswordSaving: boolean
  themeMode: ThemeMode
  messageGroupLayout: MessageGroupLayout
}>()

const emit = defineEmits<{
  close: []
  'update:watermarkSettings': [WatermarkSettings]
  'update:notificationSettings': [NotificationSettings]
  'update:themeMode': [ThemeMode]
  'update:messageGroupLayout': [MessageGroupLayout]
  requestLock: []
  saveLockPassword: [LockPasswordPayload]
  clearLockPassword: [string]
}>()

const displayName = computed(() => props.webSession.user.nickname || props.webSession.user.account || props.account.username)
const avatarLetter = computed(() => (displayName.value.trim().slice(0, 1) || '用').toUpperCase())
const avatarUrl = computed(() => props.webSession.user.avatarUrl)
const organizationName = computed(() => props.tenantConfig.siteName || `机构 ${props.account.org}`)
const defaultWatermarkText = computed(() => `${displayName.value} ${organizationName.value}`)
const watermarkOpacityPercent = computed(() => Math.round(props.watermarkSettings.opacity * 100))
const currentLockPassword = ref('')
const newLockPassword = ref('')
const confirmLockPassword = ref('')
const clearLockPasswordValue = ref('')
const lockPasswordError = ref('')
const notificationPermission = ref<'default' | 'denied' | 'granted' | 'unsupported'>(
  'Notification' in window ? Notification.permission : 'unsupported'
)
const notificationPermissionText = computed(() => {
  if (notificationPermission.value === 'granted') {
    return props.notificationSettings.browserEnabled ? '已开启' : '已授权'
  }
  if (notificationPermission.value === 'denied') return '已拒绝'
  if (notificationPermission.value === 'unsupported') return '不支持'
  return '未授权'
})
const themeOptions: Array<{ value: ThemeMode; label: string; icon: typeof Monitor }> = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor }
]
const messageGroupLayoutOptions: Array<{ value: MessageGroupLayout; label: string }> = [
  { value: 'scroll', label: '横向滚动' },
  { value: 'wrap', label: '弹性换行' }
]

watch(
  () => props.lockScreenSettings.hasPassword,
  () => resetLockPasswordInputs()
)

function updateWatermark(partial: Partial<WatermarkSettings>) {
  emit('update:watermarkSettings', {
    ...props.watermarkSettings,
    ...partial
  })
}

function handleWatermarkTextInput(event: Event) {
  updateWatermark({ text: (event.target as HTMLInputElement).value })
}

function handleWatermarkOpacityInput(event: Event) {
  updateWatermark({ opacity: Number((event.target as HTMLInputElement).value) })
}

function handleWatermarkColorInput(event: Event) {
  updateWatermark({ color: (event.target as HTMLInputElement).value })
}

async function toggleBrowserNotification() {
  if (!('Notification' in window)) {
    emit('update:notificationSettings', {
      ...props.notificationSettings,
      browserEnabled: false
    })
    return
  }

  let permission = Notification.permission
  if (permission === 'default') {
    permission = await Notification.requestPermission()
  }
  notificationPermission.value = permission
  emit('update:notificationSettings', {
    ...props.notificationSettings,
    browserEnabled: permission === 'granted' ? !props.notificationSettings.browserEnabled : false
  })
}

function toggleNotificationSound() {
  const enabled = !props.notificationSettings.soundEnabled
  emit('update:notificationSettings', {
    ...props.notificationSettings,
    soundEnabled: enabled
  })
  if (enabled) {
    playNotificationSound()
  }
}

function resetLockPasswordInputs() {
  currentLockPassword.value = ''
  newLockPassword.value = ''
  confirmLockPassword.value = ''
  clearLockPasswordValue.value = ''
  lockPasswordError.value = ''
}

function submitLockPassword() {
  if (props.lockPasswordSaving) return
  lockPasswordError.value = ''

  if (props.lockScreenSettings.hasPassword && !currentLockPassword.value) {
    lockPasswordError.value = '请输入当前锁屏密码'
    return
  }
  if (newLockPassword.value.length < 4) {
    lockPasswordError.value = '锁屏密码至少 4 位'
    return
  }
  if (newLockPassword.value !== confirmLockPassword.value) {
    lockPasswordError.value = '两次输入的锁屏密码不一致'
    return
  }

  emit('saveLockPassword', {
    currentPassword: currentLockPassword.value,
    password: newLockPassword.value,
    confirmPassword: confirmLockPassword.value
  })
  resetLockPasswordInputs()
}

function submitClearLockPassword() {
  if (props.lockPasswordSaving) return
  lockPasswordError.value = ''
  if (!clearLockPasswordValue.value) {
    lockPasswordError.value = '请输入当前锁屏密码'
    return
  }

  emit('clearLockPassword', clearLockPasswordValue.value)
  resetLockPasswordInputs()
}
</script>

<template>
  <section class="settings-layout settings-panel" role="dialog" aria-modal="true" aria-label="设置">
    <main class="settings-main">
      <button class="settings-close-button" title="关闭" @click="emit('close')">
        <X :size="18" />
      </button>

      <header class="settings-main-header">
        <h2>设置</h2>
      </header>

      <section class="profile-card settings-profile">
        <span class="avatar profile-avatar">
          <img v-if="avatarUrl" :src="avatarUrl" :alt="displayName" />
          <template v-else>{{ avatarLetter }}</template>
        </span>
        <div>
          <h2>{{ displayName }}</h2>
          <p>在线 · {{ organizationName }}</p>
          <span>b8im ID: {{ webSession.user.imShortNo || webSession.user.userId || webSession.user.account }}</span>
        </div>
      </section>

      <section class="settings-section">
        <div class="settings-section-title">
          <UserRound :size="17" />
          <span>账号信息</span>
        </div>
        <div class="settings-list">
          <div class="settings-row"><span>账号</span><strong>{{ webSession.user.account }}</strong></div>
          <div class="settings-row"><span>组织</span><strong>{{ organizationName }}</strong></div>
          <div class="settings-row"><span>手机号</span><strong>{{ webSession.user.mobile || '未绑定' }}</strong></div>
        </div>
      </section>

      <section class="settings-section">
        <div class="settings-section-title">
          <Monitor :size="17" />
          <span>主题</span>
        </div>
        <div class="theme-mode-group" role="radiogroup" aria-label="主题">
          <button
            v-for="item in themeOptions"
            :key="item.value"
            type="button"
            :class="{ active: themeMode === item.value }"
            @click="emit('update:themeMode', item.value)"
          >
            <component :is="item.icon" :size="16" />
            {{ item.label }}
          </button>
        </div>
      </section>

      <section class="settings-section">
        <div class="settings-section-title">
          <Monitor :size="17" />
          <span>消息分类</span>
        </div>
        <div class="theme-mode-group" role="radiogroup" aria-label="消息分类布局">
          <button
            v-for="item in messageGroupLayoutOptions"
            :key="item.value"
            type="button"
            :class="{ active: messageGroupLayout === item.value }"
            @click="emit('update:messageGroupLayout', item.value)"
          >
            {{ item.label }}
          </button>
        </div>
      </section>

      <section class="settings-section">
        <div class="settings-section-title">
          <BellRing :size="17" />
          <span>通知</span>
        </div>
        <div class="settings-list">
          <button type="button" class="settings-control-button" @click="toggleBrowserNotification">
            <span>桌面通知</span>
            <strong>{{ notificationPermissionText }}</strong>
            <i class="switch" :class="{ on: notificationSettings.browserEnabled }" />
          </button>
          <button type="button" class="settings-control-button" @click="toggleNotificationSound">
            <span><Volume2 :size="16" /> 新消息提示音</span>
            <i class="switch" :class="{ on: notificationSettings.soundEnabled }" />
          </button>
        </div>
      </section>

      <section class="settings-section">
        <div class="settings-section-title">
          <LockKeyhole :size="17" />
          <span>锁屏</span>
        </div>
        <div class="settings-list">
          <button
            type="button"
            class="settings-control-button"
            :disabled="!lockScreenSettings.hasPassword"
            @click="emit('requestLock')"
          >
            <span><LockKeyhole :size="16" /> 立即锁屏</span>
            <strong>{{ lockScreenSettings.hasPassword ? '已设置密码' : '未设置密码' }}</strong>
          </button>

          <label v-if="lockScreenSettings.hasPassword" class="settings-field-row">
            <span>当前密码</span>
            <input
              v-model="currentLockPassword"
              type="password"
              autocomplete="current-password"
              placeholder="当前锁屏密码"
            />
          </label>

          <label class="settings-field-row">
            <span>新密码</span>
            <input
              v-model="newLockPassword"
              type="password"
              autocomplete="new-password"
              placeholder="至少 4 位"
            />
          </label>

          <label class="settings-field-row">
            <span>确认密码</span>
            <input
              v-model="confirmLockPassword"
              type="password"
              autocomplete="new-password"
              placeholder="再次输入"
            />
          </label>

          <button
            type="button"
            class="settings-action-row"
            :disabled="lockPasswordSaving"
            @click="submitLockPassword"
          >
            <span><KeyRound :size="16" /> {{ lockScreenSettings.hasPassword ? '保存新密码' : '设置锁屏密码' }}</span>
            <strong v-if="lockPasswordSaving">保存中</strong>
          </button>

          <label v-if="lockScreenSettings.hasPassword" class="settings-field-row">
            <span>清除密码</span>
            <input
              v-model="clearLockPasswordValue"
              type="password"
              autocomplete="current-password"
              placeholder="当前锁屏密码"
            />
          </label>

          <button
            v-if="lockScreenSettings.hasPassword"
            type="button"
            class="settings-action-row danger"
            :disabled="lockPasswordSaving"
            @click="submitClearLockPassword"
          >
            <span>关闭锁屏密码</span>
          </button>
        </div>
        <p v-if="lockPasswordError" class="settings-inline-error">{{ lockPasswordError }}</p>
      </section>

      <section class="settings-section">
        <div class="settings-section-title">
          <Stamp :size="17" />
          <span>水印</span>
        </div>
        <div class="settings-list">
          <button type="button" class="settings-control-button" @click="updateWatermark({ enabled: !watermarkSettings.enabled })">
            <span>显示水印</span>
            <i class="switch" :class="{ on: watermarkSettings.enabled }" />
          </button>

          <label class="settings-field-row">
            <span>水印内容</span>
            <input
              :value="watermarkSettings.text"
              :placeholder="defaultWatermarkText"
              maxlength="40"
              @input="handleWatermarkTextInput"
            />
          </label>

          <label class="settings-field-row">
            <span>透明度</span>
            <div class="settings-range-control">
              <input
                type="range"
                min="0.06"
                max="0.24"
                step="0.01"
                :value="watermarkSettings.opacity"
                @input="handleWatermarkOpacityInput"
              />
              <strong>{{ watermarkOpacityPercent }}%</strong>
            </div>
          </label>

          <label class="settings-field-row">
            <span>水印颜色</span>
            <div class="settings-color-control">
              <input
                type="color"
                :value="watermarkSettings.color"
                @input="handleWatermarkColorInput"
              />
              <strong>{{ watermarkSettings.color }}</strong>
            </div>
          </label>
        </div>

        <section
          class="settings-watermark-preview"
          :class="{ muted: !watermarkSettings.enabled }"
          :style="{ '--watermark-color': watermarkSettings.color, '--watermark-opacity': watermarkSettings.opacity }"
        >
          <span>{{ watermarkSettings.text || defaultWatermarkText }}</span>
          <span>{{ watermarkSettings.text || defaultWatermarkText }}</span>
          <span>{{ watermarkSettings.text || defaultWatermarkText }}</span>
        </section>
      </section>
    </main>
  </section>
</template>

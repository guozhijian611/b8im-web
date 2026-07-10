<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { LockKeyhole, LogOut, UnlockKeyhole } from '@lucide/vue'
import type { TenantBrandConfig } from '../services/tenantConfig'
import type { WebImSession } from '../types'

const props = defineProps<{
  tenantConfig: TenantBrandConfig
  webSession: WebImSession
  unlocking: boolean
  error: string
}>()

const emit = defineEmits<{
  unlock: [string]
  logout: []
}>()

const password = ref('')
const passwordInput = ref<HTMLInputElement | null>(null)
const displayName = computed(() => props.webSession.user.nickname || props.webSession.user.account || '用户')
const avatarLetter = computed(() => (displayName.value.trim().slice(0, 1) || '用').toUpperCase())
const avatarUrl = computed(() => props.webSession.user.avatarUrl)
const organizationName = computed(() => props.tenantConfig.siteName || `机构 ${props.webSession.organization}`)

onMounted(() => {
  void nextTick(() => passwordInput.value?.focus())
})

function submit() {
  if (!password.value || props.unlocking) return
  const value = password.value
  password.value = ''
  emit('unlock', value)
}
</script>

<template>
  <section class="lock-screen" role="dialog" aria-modal="true" aria-label="锁屏">
    <div class="lock-screen__card">
      <div class="lock-screen__brand">
        <img v-if="tenantConfig.logoUrl" :src="tenantConfig.logoUrl" :alt="tenantConfig.siteName" />
        <span v-else>{{ tenantConfig.logoText }}</span>
      </div>

      <div class="lock-screen__identity">
        <span class="avatar lock-screen__avatar">
          <img v-if="avatarUrl" :src="avatarUrl" :alt="displayName" />
          <template v-else>{{ avatarLetter }}</template>
        </span>
        <div>
          <h1>{{ displayName }}</h1>
          <p>{{ organizationName }}</p>
        </div>
      </div>

      <form class="lock-screen__form" @submit.prevent="submit">
        <label>
          <span><LockKeyhole :size="16" /> 锁屏密码</span>
          <input
            ref="passwordInput"
            v-model="password"
            type="password"
            autocomplete="current-password"
            placeholder="输入锁屏密码"
          />
        </label>
        <p v-if="error" class="lock-screen__error">{{ error }}</p>
        <button type="submit" :disabled="unlocking || !password">
          <UnlockKeyhole :size="17" />
          {{ unlocking ? '解锁中' : '解锁' }}
        </button>
      </form>

      <button type="button" class="lock-screen__logout" @click="emit('logout')">
        <LogOut :size="16" />
        退出登录
      </button>
    </div>
  </section>
</template>

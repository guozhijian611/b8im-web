<script setup lang="ts">
import { computed } from 'vue'
import { LockKeyhole, LogOut, Menu } from '@lucide/vue'
import type { TenantBrandConfig } from '../services/tenantConfig'
import type { PrimaryView, RailItem, WebImSession } from '../types'

const props = defineProps<{
  items: RailItem[]
  activeView: PrimaryView
  account: {
    org: string
    username: string
  }
  tenantConfig: TenantBrandConfig
  webSession: WebImSession
  canLockScreen: boolean
}>()

const tenantConfig = computed(() => props.tenantConfig)
const displayName = computed(() => props.webSession.user.nickname || props.webSession.user.account || props.account.username)
const avatarLetter = computed(() => (displayName.value.trim().slice(0, 1) || '用').toUpperCase())
const avatarUrl = computed(() => props.webSession.user.avatarUrl)

const emit = defineEmits<{
  change: [PrimaryView]
  changeAvatar: []
  toggleSettings: []
  lockScreen: []
  logout: []
}>()
</script>

<template>
  <aside class="side-rail" aria-label="主导航">
    <div class="rail-logo">
      <img v-if="tenantConfig.logoUrl" :src="tenantConfig.logoUrl" :alt="tenantConfig.siteName" />
      <span v-else>{{ tenantConfig.logoText }}</span>
    </div>

    <nav class="rail-nav">
      <button
        v-for="item in items"
        :key="item.key"
        class="rail-button"
        :class="{ active: activeView === item.key }"
        :title="item.label"
        @click="emit('change', item.key)"
      >
        <component :is="item.icon" :size="22" />
        <span v-if="item.badge" class="rail-badge">
          {{ item.badge > 99 ? '99+' : item.badge }}
        </span>
      </button>
    </nav>

    <div class="rail-bottom">
      <button type="button" class="rail-avatar" :title="`修改头像：${displayName}`" @click="emit('changeAvatar')">
        <img v-if="avatarUrl" :src="avatarUrl" :alt="displayName" />
        <span v-else>{{ avatarLetter }}</span>
      </button>
      <button
        class="rail-button"
        title="锁屏"
        :disabled="!canLockScreen"
        @click="emit('lockScreen')"
      >
        <LockKeyhole :size="20" />
      </button>
      <button class="rail-button" title="退出登录" @click="emit('logout')">
        <LogOut :size="20" />
      </button>
      <button class="rail-button" title="设置" @click="emit('toggleSettings')">
        <Menu :size="22" />
      </button>
    </div>
  </aside>
</template>

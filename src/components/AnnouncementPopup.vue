<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { X } from '@lucide/vue'
import {
  acknowledgeAnnouncement,
  fetchAnnouncementDetail,
  fetchAnnouncements,
  type AnnouncementDetail
} from '../services/announcements'
import type { TenantBrandConfig } from '../services/tenantConfig'
import type { WebImSession } from '../types'

const props = defineProps<{
  tenantConfig: TenantBrandConfig
  webSession: WebImSession
}>()

const visible = ref(false)
const detail = ref<AnnouncementDetail | null>(null)
const saving = ref(false)
const error = ref('')

async function load() {
  try {
    const result = await fetchAnnouncements(props.tenantConfig, props.webSession)
    const unread = result.list.filter((item) => !item.isRead)
    const popup = unread.find((item) => item.displayMode === 'popup' || item.displayMode === 'both')
      ?? (result.config.displayMode === 'popup' || result.config.displayMode === 'both' ? unread[0] : undefined)
    if (!popup) return
    detail.value = await fetchAnnouncementDetail(props.tenantConfig, props.webSession, popup.id)
    visible.value = true
  } catch {
    // 列表入口仍可用；弹窗加载失败不阻断 IM 主界面。
  }
}

function close() {
  if (detail.value?.readAckRequired && !detail.value.isRead) return
  visible.value = false
}

async function confirm() {
  if (!detail.value || saving.value) return
  if (!detail.value.readAckRequired) {
    visible.value = false
    return
  }
  saving.value = true
  error.value = ''
  try {
    const result = await acknowledgeAnnouncement(props.tenantConfig, props.webSession, detail.value.id)
    if (!result.recorded) throw new Error('已读确认未写入')
    detail.value = { ...detail.value, isRead: true }
    visible.value = false
  } catch (value) {
    error.value = value instanceof Error ? value.message : '已读确认失败'
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <div v-if="visible && detail" class="announcement-popup" role="dialog" aria-modal="true" aria-label="公告提醒" @click.self="close">
    <article>
      <button
        v-if="!detail.readAckRequired || detail.isRead"
        class="announcement-popup__close"
        type="button"
        aria-label="关闭公告"
        @click="close"
      >
        <X :size="18" />
      </button>
      <span class="announcement-popup__kicker">重要公告</span>
      <h2>{{ detail.title }}</h2>
      <time>{{ detail.publishedAt }}</time>
      <p v-if="detail.summary" class="announcement-popup__summary">{{ detail.summary }}</p>
      <p class="announcement-popup__content">{{ detail.content }}</p>
      <p v-if="error" class="announcement-popup__error" role="alert">{{ error }}</p>
      <button class="announcement-popup__action" type="button" :disabled="saving" @click="confirm">
        {{ saving ? '正在确认…' : (detail.readAckRequired ? '确认已读' : '知道了') }}
      </button>
    </article>
  </div>
</template>

<style scoped>
.announcement-popup {
  position: fixed;
  inset: 0;
  z-index: 1300;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgb(15 23 42 / 48%);
  backdrop-filter: blur(5px);
}

.announcement-popup article {
  position: relative;
  width: min(560px, 100%);
  max-height: min(720px, calc(100vh - 48px));
  overflow: auto;
  padding: 30px;
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 18px;
  background: var(--panel-bg, #fff);
  color: var(--text-primary, #111827);
  box-shadow: 0 24px 80px rgb(15 23 42 / 24%);
}

.announcement-popup__close {
  position: absolute;
  top: 18px;
  right: 18px;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: 10px;
  background: var(--subtle-bg, #f3f4f6);
  color: inherit;
  cursor: pointer;
}

.announcement-popup__kicker {
  color: #2563eb;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: .08em;
}

.announcement-popup h2 {
  margin: 10px 44px 6px 0;
  font-size: 25px;
  line-height: 1.35;
}

.announcement-popup time {
  color: var(--text-secondary, #6b7280);
  font-size: 13px;
}

.announcement-popup__summary {
  margin: 22px 0 0;
  color: var(--text-secondary, #4b5563);
  font-weight: 600;
}

.announcement-popup__content {
  margin: 14px 0 24px;
  white-space: pre-wrap;
  line-height: 1.8;
}

.announcement-popup__error {
  color: #dc2626;
  font-size: 13px;
}

.announcement-popup__action {
  width: 100%;
  padding: 11px 18px;
  border: 0;
  border-radius: 11px;
  background: #2563eb;
  color: #fff;
  font-weight: 700;
  cursor: pointer;
}

.announcement-popup__action:disabled {
  cursor: wait;
  opacity: .65;
}
</style>

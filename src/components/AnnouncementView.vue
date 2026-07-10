<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Megaphone, RefreshCw } from '@lucide/vue'
import StatePanel from './StatePanel.vue'
import { WebApiError } from '../services/apiClient'
import {
  acknowledgeAnnouncement,
  fetchAnnouncementDetail,
  fetchAnnouncements,
  type AnnouncementDetail,
  type AnnouncementSummary
} from '../services/announcements'
import type { TenantBrandConfig } from '../services/tenantConfig'
import type { WebImSession } from '../types'

const props = defineProps<{
  tenantConfig: TenantBrandConfig
  webSession: WebImSession
}>()

const loading = ref(true)
const forbidden = ref(false)
const error = ref('')
const items = ref<AnnouncementSummary[]>([])
const total = ref(0)
const selectedId = ref('')
const detail = ref<AnnouncementDetail | null>(null)
const detailLoading = ref(false)
const detailError = ref('')
const acknowledgeSaving = ref(false)
const acknowledgeError = ref('')
const selectedSummary = computed(() => items.value.find((item) => item.id === selectedId.value) ?? null)
let detailRequestSeq = 0

function isForbidden(value: unknown) {
  return value instanceof WebApiError &&
    (value.status === 401 || value.status === 403 || value.code === 401 || value.code === 403)
}

async function loadList() {
  loading.value = true
  forbidden.value = false
  error.value = ''
  try {
    const result = await fetchAnnouncements(props.tenantConfig, props.webSession)
    items.value = result.list
    total.value = result.total
    const first = result.list[0]
    if (first) await selectAnnouncement(first.id)
  } catch (value) {
    if (isForbidden(value)) forbidden.value = true
    else error.value = value instanceof Error ? value.message : '公告加载失败'
  } finally {
    loading.value = false
  }
}

async function selectAnnouncement(id: string) {
  const requestSeq = ++detailRequestSeq
  selectedId.value = id
  detail.value = null
  detailError.value = ''
  acknowledgeError.value = ''
  detailLoading.value = true
  try {
    const result = await fetchAnnouncementDetail(props.tenantConfig, props.webSession, id)
    if (requestSeq === detailRequestSeq) detail.value = result
  } catch (value) {
    if (requestSeq !== detailRequestSeq) return
    if (isForbidden(value)) forbidden.value = true
    else detailError.value = value instanceof Error ? value.message : '公告详情加载失败'
  } finally {
    if (requestSeq === detailRequestSeq) detailLoading.value = false
  }
}

async function confirmRead() {
  if (!detail.value || detail.value.isRead || acknowledgeSaving.value) return
  acknowledgeSaving.value = true
  acknowledgeError.value = ''
  try {
    const result = await acknowledgeAnnouncement(
      props.tenantConfig,
      props.webSession,
      detail.value.id
    )
    if (result.required && !result.recorded) throw new Error('公告已读确认未写入')
    detail.value = { ...detail.value, isRead: result.recorded || !result.required }
    items.value = items.value.map((item) => item.id === detail.value?.id
      ? { ...item, isRead: detail.value?.isRead ?? item.isRead }
      : item)
  } catch (value) {
    acknowledgeError.value = value instanceof Error ? value.message : '公告已读确认失败'
  } finally {
    acknowledgeSaving.value = false
  }
}

onMounted(loadList)
</script>

<template>
  <main class="announcement-view" aria-label="公告中心">
    <header class="announcement-header">
      <div>
        <span class="announcement-kicker"><Megaphone :size="16" /> 公告中心</span>
        <h1>最新公告</h1>
        <p>共 {{ total }} 条已发布公告</p>
      </div>
      <button type="button" class="announcement-refresh" :disabled="loading" @click="loadList">
        <RefreshCw :size="16" /> 刷新
      </button>
    </header>

    <StatePanel v-if="loading" kind="loading" title="正在加载公告" />
    <StatePanel
      v-else-if="forbidden"
      kind="forbidden"
      title="暂无访问权限"
      description="当前账号无权访问公告，或该模块已被停用。"
    />
    <StatePanel
      v-else-if="error"
      kind="error"
      title="公告加载失败"
      :description="error"
      action-label="重新加载"
      @action="loadList"
    />
    <StatePanel
      v-else-if="items.length === 0"
      kind="empty"
      title="暂无公告"
      description="当前机构还没有已发布的公告。"
    />

    <section v-else class="announcement-layout">
      <aside class="announcement-list" aria-label="公告列表">
        <button
          v-for="item in items"
          :key="item.id"
          type="button"
          :class="{ active: selectedId === item.id }"
          @click="selectAnnouncement(item.id)"
        >
          <strong>{{ item.title }}</strong>
          <span>{{ item.summary || '暂无摘要' }}</span>
          <time>{{ item.publishedAt }}</time>
        </button>
      </aside>

      <article class="announcement-detail">
        <StatePanel v-if="detailLoading" kind="loading" title="正在加载公告详情" />
        <StatePanel
          v-else-if="detailError"
          kind="error"
          title="公告详情加载失败"
          :description="detailError"
          action-label="重新加载"
          @action="selectedId && selectAnnouncement(selectedId)"
        />
        <template v-else-if="detail">
          <div class="announcement-detail__meta">
            <span>机构公告</span>
            <time>{{ detail.publishedAt }}</time>
          </div>
          <h2>{{ detail.title }}</h2>
          <p v-if="detail.summary" class="announcement-detail__summary">{{ detail.summary }}</p>
          <p class="announcement-detail__body">{{ detail.content }}</p>
          <div v-if="detail.readAckRequired" class="announcement-detail__ack">
            <button
              type="button"
              :disabled="detail.isRead || acknowledgeSaving"
              @click="confirmRead"
            >
              {{ detail.isRead ? '已确认阅读' : (acknowledgeSaving ? '正在确认…' : '确认已读') }}
            </button>
            <span v-if="acknowledgeError" role="alert">{{ acknowledgeError }}</span>
          </div>
        </template>
        <StatePanel
          v-else
          kind="empty"
          title="请选择公告"
          :description="selectedSummary?.title || '从左侧列表选择一条公告查看详情。'"
        />
      </article>
    </section>
  </main>
</template>

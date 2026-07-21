<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Plus, RefreshCw, Search, Trash2 } from '@lucide/vue'
import StatePanel from './StatePanel.vue'
import { createCsConversation, fetchMyCsConversations, type CustomerServiceConversation } from '../services/customerService'
import { createFavorite, deleteFavorites, fetchFavorites, type FavoriteItem } from '../services/favorite'
import {
  createFileMediaFolder,
  fetchFileMediaFolders,
  fetchFileMediaItems,
  fetchFileMediaUsage,
  formatFileMediaByteCount,
  formatFileMediaQuotaByteCount,
  formatFileMediaUsageRatio,
  type FileMediaFolder,
  type FileMediaItem,
  type FileMediaUsage
} from '../services/fileMedia'
import { fetchI18nLocales, fetchI18nMessages, type I18nLocaleItem } from '../services/i18n'
import { createMoment, fetchMomentsFeed, toggleMomentLike, type MomentsPost } from '../services/moments'
import { modulePageError } from '../services/modulePageError'
import { fetchRobots, matchRobotReply, type RobotSingleItem } from '../services/robotSingle'
import { searchMessagesFull, searchSenderLabel, type SearchHit } from '../services/search'
import { fetchStickerItems, fetchStickerPacks, type StickerItem, type StickerPack } from '../services/sticker'
import type { ClientModuleKey } from '../services/clientModules'
import type { TenantBrandConfig } from '../services/tenantConfig'
import type { WebImSession } from '../types'
import { GROUP_ACCESS_BROWSER_EVENT } from '../services/groupMemberAccess'
import {
  createModuleWorkbenchLoadCoordinator,
  createModuleWorkbenchLoadSnapshot,
  isModuleWorkbenchLoadContextCurrent,
  MODULE_WORKBENCH_LOAD_DEPENDENCIES_KEY,
  type ModuleWorkbenchLoadDependencies,
  type ModuleWorkbenchLoadInput,
  type ModuleWorkbenchLoadResult
} from './moduleWorkbenchLoad'

const props = defineProps<{
  moduleKey: Exclude<ClientModuleKey, 'announcement'>
  title: string
  tenantConfig: TenantBrandConfig
  webSession: WebImSession
}>()

const loading = ref(true)
const saving = ref(false)
const forbidden = ref(false)
const error = ref('')
const input = ref('')
const secondaryInput = ref('')
const selectedId = ref(0)
const localeMessages = ref<Record<string, string>>({})
const locales = ref<I18nLocaleItem[]>([])
const favorites = ref<FavoriteItem[]>([])
const stickerPacks = ref<StickerPack[]>([])
const stickerItems = ref<StickerItem[]>([])
const conversations = ref<CustomerServiceConversation[]>([])
const robots = ref<RobotSingleItem[]>([])
const robotReply = ref('')
const fileMediaUsage = ref<FileMediaUsage | null>(null)
const folders = ref<FileMediaFolder[]>([])
const files = ref<FileMediaItem[]>([])
const searchHits = ref<SearchHit[]>([])
const moments = ref<MomentsPost[]>([])
const defaultLoadDependencies: ModuleWorkbenchLoadDependencies = {
  fetchI18nLocales,
  fetchI18nMessages,
  fetchFavorites,
  fetchStickerPacks,
  fetchStickerItems,
  fetchMyCsConversations,
  fetchRobots,
  fetchFileMediaUsage,
  fetchFileMediaFolders,
  fetchFileMediaItems,
  fetchMomentsFeed
}
const loadCoordinator = createModuleWorkbenchLoadCoordinator(
  inject<ModuleWorkbenchLoadDependencies | null>(
    MODULE_WORKBENCH_LOAD_DEPENDENCIES_KEY,
    null
  ) ??
    defaultLoadDependencies
)
let selectionGeneration = 0

function currentLoadInput(): ModuleWorkbenchLoadInput {
  return {
    moduleKey: props.moduleKey,
    title: props.title,
    tenantConfig: props.tenantConfig,
    webSession: props.webSession
  }
}

const empty = computed(() => {
  if (props.moduleKey === 'i18n') return locales.value.length === 0
  if (props.moduleKey === 'favorite') return favorites.value.length === 0
  if (props.moduleKey === 'sticker') return stickerPacks.value.length === 0
  if (props.moduleKey === 'customer_service') return conversations.value.length === 0
  if (props.moduleKey === 'robot_single') return robots.value.length === 0
  if (props.moduleKey === 'file_media') return folders.value.length === 0 && files.value.length === 0
  if (props.moduleKey === 'search') return false
  return moments.value.length === 0
})

function handleError(
  value: unknown,
  fallback: string,
  moduleKey: Exclude<ClientModuleKey, 'announcement'> = props.moduleKey
) {
  const result = modulePageError(value, moduleKey, fallback)
  forbidden.value = result.forbidden
  error.value = result.message
}

function commitLoadResult(result: ModuleWorkbenchLoadResult) {
  switch (result.moduleKey) {
    case 'i18n':
      locales.value = result.locales
      localeMessages.value = result.localeMessages
      selectedId.value = result.selectedId
      break
    case 'favorite':
      favorites.value = result.favorites
      break
    case 'sticker':
      stickerPacks.value = result.stickerPacks
      stickerItems.value = result.stickerItems
      selectedId.value = result.selectedId
      break
    case 'customer_service':
      conversations.value = result.conversations
      break
    case 'robot_single':
      robots.value = result.robots
      selectedId.value = result.selectedId
      break
    case 'file_media':
      fileMediaUsage.value = result.fileMediaUsage
      folders.value = result.folders
      files.value = result.files
      break
    case 'moments':
      moments.value = result.moments
      break
    case 'search':
      break
  }
}

async function load() {
  selectionGeneration += 1
  await loadCoordinator.run(
    currentLoadInput(),
    {
      isContextCurrent(snapshot) {
        return isModuleWorkbenchLoadContextCurrent(snapshot, currentLoadInput())
      },
      onStart() {
        loading.value = true
        forbidden.value = false
        error.value = ''
      },
      onSuccess(result) {
        commitLoadResult(result)
      },
      onError(value, snapshot) {
        handleError(value, `${snapshot.title}加载失败`, snapshot.moduleKey)
      },
      onFinish() {
        loading.value = false
      }
    }
  )
}

async function selectLocale(code: string) {
  const snapshot = createModuleWorkbenchLoadSnapshot(currentLoadInput())
  if (snapshot.moduleKey !== 'i18n') return
  const token = ++selectionGeneration
  const nextSelectedId = locales.value.findIndex((item) => item.code === code) + 1
  try {
    const messages = await fetchI18nMessages(snapshot.tenantConfig, snapshot.webSession, code)
    if (
      token !== selectionGeneration ||
      !isModuleWorkbenchLoadContextCurrent(snapshot, currentLoadInput())
    ) {
      return
    }
    selectedId.value = nextSelectedId
    localeMessages.value = messages.messages
  } catch (value) {
    if (
      token === selectionGeneration &&
      isModuleWorkbenchLoadContextCurrent(snapshot, currentLoadInput())
    ) {
      handleError(value, `${snapshot.title}词条加载失败`, snapshot.moduleKey)
    }
  }
}

async function selectStickerPack(id: number) {
  const snapshot = createModuleWorkbenchLoadSnapshot(currentLoadInput())
  if (snapshot.moduleKey !== 'sticker') return
  const token = ++selectionGeneration
  try {
    const items = await fetchStickerItems(snapshot.tenantConfig, snapshot.webSession, id)
    if (
      token !== selectionGeneration ||
      !isModuleWorkbenchLoadContextCurrent(snapshot, currentLoadInput())
    ) {
      return
    }
    selectedId.value = id
    stickerItems.value = items
  } catch (value) {
    if (
      token === selectionGeneration &&
      isModuleWorkbenchLoadContextCurrent(snapshot, currentLoadInput())
    ) {
      handleError(value, `${snapshot.title}内容加载失败`, snapshot.moduleKey)
    }
  }
}

async function submit() {
  const value = input.value.trim()
  if (!value || saving.value) return
  saving.value = true
  error.value = ''
  try {
    if (props.moduleKey === 'favorite') {
      favorites.value.unshift(await createFavorite(props.tenantConfig, props.webSession, {
        target_type: 'text', title: value, summary: secondaryInput.value.trim(), payload: { text: secondaryInput.value.trim() }
      }))
    } else if (props.moduleKey === 'customer_service') {
      conversations.value.unshift(await createCsConversation(props.tenantConfig, props.webSession, { subject: value }))
    } else if (props.moduleKey === 'robot_single') {
      if (!selectedId.value) throw new Error('请先选择机器人')
      const result = await matchRobotReply(props.tenantConfig, props.webSession, selectedId.value, value)
      robotReply.value = result.replyText
    } else if (props.moduleKey === 'file_media') {
      folders.value.unshift(await createFileMediaFolder(props.tenantConfig, props.webSession, value))
    } else if (props.moduleKey === 'search') {
      searchHits.value = (await searchMessagesFull(props.tenantConfig, props.webSession, { q: value })).items
    } else if (props.moduleKey === 'moments') {
      moments.value.unshift(await createMoment(props.tenantConfig, props.webSession, { content: value }))
    }
    if (props.moduleKey !== 'search' && props.moduleKey !== 'robot_single') input.value = ''
    secondaryInput.value = ''
  } catch (value) {
    handleError(value, '操作失败')
  } finally {
    saving.value = false
  }
}

async function removeFavorite(id: number) {
  try {
    await deleteFavorites(props.tenantConfig, props.webSession, [id])
    favorites.value = favorites.value.filter((item) => item.id !== id)
  } catch (value) {
    handleError(value, '删除收藏失败')
  }
}

async function likeMoment(item: MomentsPost) {
  try {
    const result = await toggleMomentLike(props.tenantConfig, props.webSession, item.id)
    moments.value = moments.value.map((row) => row.id === item.id
      ? { ...row, liked: result.liked, likeCount: result.likeCount }
      : row)
  } catch (value) {
    handleError(value, '点赞失败')
  }
}

watch(
  () => [props.moduleKey, props.title, props.tenantConfig, props.webSession],
  () => void load(),
  { deep: true }
)
function clearAccessControlledSearch() {
  searchHits.value = []
}
onMounted(() => {
  window.addEventListener(GROUP_ACCESS_BROWSER_EVENT, clearAccessControlledSearch)
  void load()
})
onBeforeUnmount(() => {
  selectionGeneration += 1
  loadCoordinator.dispose()
  window.removeEventListener(GROUP_ACCESS_BROWSER_EVENT, clearAccessControlledSearch)
})
</script>

<template>
  <main class="module-page" :aria-label="title">
    <header class="module-header">
      <div><span>企业应用</span><h1>{{ title }}</h1><p>数据来自当前机构已授权的真实模块接口</p></div>
      <button type="button" :disabled="loading" @click="load"><RefreshCw :size="16" /> 刷新</button>
    </header>

    <StatePanel v-if="loading" kind="loading" :title="`正在加载${title}`" />
    <StatePanel v-else-if="forbidden" kind="forbidden" title="模块不可用" description="模块已停用、授权已撤销或当前账号无权访问。" />
    <StatePanel v-else-if="error" kind="error" :title="`${title}操作失败`" :description="error" action-label="重新加载" @action="load" />
    <template v-else>
      <form v-if="['favorite','customer_service','robot_single','file_media','search','moments'].includes(moduleKey)" class="module-form" @submit.prevent="submit">
        <select v-if="moduleKey === 'robot_single'" v-model.number="selectedId">
          <option v-for="item in robots" :key="item.id" :value="item.id">{{ item.name }}</option>
        </select>
        <input v-model="input" :placeholder="moduleKey === 'search' ? '搜索消息内容' : moduleKey === 'file_media' ? '新文件夹名称' : moduleKey === 'moments' ? '分享新动态' : moduleKey === 'customer_service' ? '问题主题' : moduleKey === 'robot_single' ? '向机器人提问' : '收藏标题'" />
        <input v-if="moduleKey === 'favorite'" v-model="secondaryInput" placeholder="收藏内容" />
        <button type="submit" :disabled="saving || !input.trim()"><Search v-if="moduleKey === 'search'" :size="16" /><Plus v-else :size="16" />{{ moduleKey === 'search' ? '搜索' : '提交' }}</button>
      </form>

      <section v-if="moduleKey === 'i18n'" class="module-split">
        <nav><button v-for="item in locales" :key="item.code" @click="selectLocale(item.code)">{{ item.name }} <small>{{ item.code }}</small></button></nav>
        <div class="module-list"><article v-for="(value, key) in localeMessages" :key="key"><strong>{{ key }}</strong><p>{{ value }}</p></article></div>
      </section>

      <section v-else-if="moduleKey === 'favorite'" class="module-list">
        <article v-for="item in favorites" :key="item.id"><div><strong>{{ item.title }}</strong><p>{{ item.summary || '无摘要' }}</p><small>{{ item.createTime }}</small></div><button class="danger" @click="removeFavorite(item.id)"><Trash2 :size="16" /></button></article>
      </section>

      <section v-else-if="moduleKey === 'sticker'" class="module-split">
        <nav><button v-for="pack in stickerPacks" :key="pack.id" @click="selectStickerPack(pack.id)">{{ pack.name }}<small>{{ pack.description }}</small></button></nav>
        <div class="module-grid"><article v-for="item in stickerItems" :key="item.id"><strong>{{ item.name }}</strong><small>{{ item.fileId }}</small></article></div>
      </section>

      <section v-else-if="moduleKey === 'customer_service'" class="module-list"><article v-for="item in conversations" :key="item.id"><div><strong>{{ item.subject }}</strong><p>{{ item.conversationNo }} · {{ item.status }}</p><small>{{ item.createTime }}</small></div></article></section>

      <section v-else-if="moduleKey === 'robot_single'" class="module-list">
        <article v-if="robotReply" class="highlight"><div><strong>机器人回复</strong><p>{{ robotReply }}</p></div></article>
        <article v-for="item in robots" :key="item.id"><div><strong>{{ item.name }}</strong><p>{{ item.description || item.welcomeText }}</p></div></article>
      </section>

      <template v-else-if="moduleKey === 'file_media'">
        <section v-if="fileMediaUsage" class="file-media-sources">
          <section class="file-media-source">
            <header><strong>中央存储容量</strong><small>来源：usage.storage / StorageQuota</small></header>
            <div class="module-stats file-media-stats">
              <article><strong>{{ formatFileMediaQuotaByteCount(fileMediaUsage.storage.quota_value, fileMediaUsage.storage.unlimited) }}</strong><span>容量上限</span></article>
              <article><strong>{{ formatFileMediaByteCount(fileMediaUsage.storage.used_value) }}</strong><span>已确认用量</span></article>
              <article><strong>{{ formatFileMediaByteCount(fileMediaUsage.storage.held_value) }}</strong><span>上传预留</span></article>
              <article><strong>{{ formatFileMediaByteCount(fileMediaUsage.storage.occupancy_value) }}</strong><span>当前占用</span></article>
              <article><strong>{{ fileMediaUsage.storage.remaining_value === null ? '无限' : formatFileMediaByteCount(fileMediaUsage.storage.remaining_value) }}</strong><span>剩余容量</span></article>
              <article><strong>{{ formatFileMediaUsageRatio(fileMediaUsage.storage.usage_ratio) }}</strong><span>占用率</span></article>
              <article><strong>{{ fileMediaUsage.storage.used_file_count }}</strong><span>已确认文件</span></article>
              <article><strong>{{ fileMediaUsage.storage.held_file_count }}</strong><span>预留文件</span></article>
            </div>
          </section>
          <section class="file-media-source">
            <header><strong>file_media 模块策略</strong><small>来源：usage.policy</small></header>
            <div class="module-stats file-media-stats">
              <article><strong>{{ formatFileMediaByteCount(fileMediaUsage.policy.max_file_bytes) }}</strong><span>单文件上限</span></article>
              <article><strong>{{ fileMediaUsage.policy.large_file_enabled === 1 ? '开启' : '关闭' }}</strong><span>大文件</span></article>
              <article><strong>{{ fileMediaUsage.policy.preview_enabled === 1 ? '开启' : '关闭' }}</strong><span>预览</span></article>
              <article><strong>{{ fileMediaUsage.policy.status === 1 ? '启用' : '停用' }}</strong><span>模块状态</span></article>
            </div>
          </section>
        </section>
        <section class="module-grid"><article v-for="folder in folders" :key="'f-' + folder.id"><strong>📁 {{ folder.name }}</strong><small>{{ folder.createTime }}</small></article><article v-for="item in files" :key="'i-' + item.id"><strong>{{ item.name }}</strong><p>{{ item.kind }} · {{ formatFileMediaByteCount(String(item.sizeBytes)) }}</p></article></section>
      </template>

      <section v-else-if="moduleKey === 'search'" class="module-list"><article v-for="item in searchHits" :key="item.messageId"><div><strong>{{ searchSenderLabel(item) }}</strong><p>{{ item.content }}</p><small>{{ item.conversationType === 'group' ? '群聊' : '单聊' }} · {{ item.sentAt || '时间未知' }} · {{ item.conversationId }}</small></div></article></section>

      <section v-else-if="moduleKey === 'moments'" class="module-list"><article v-for="item in moments" :key="item.id"><div><strong>{{ item.userId }}</strong><p>{{ item.content }}</p><small>{{ item.createTime }} · {{ item.commentCount }} 条评论</small></div><button @click="likeMoment(item)">{{ item.liked ? '已赞' : '点赞' }} {{ item.likeCount }}</button></article></section>

      <StatePanel v-if="empty" kind="empty" :title="`${title}暂无数据`" description="模块已正确接入，当前机构尚无业务数据。" />
    </template>
  </main>
</template>

<style scoped>
.module-page{flex:1;min-width:0;overflow:auto;background:var(--surface-soft,#f6f8fa);padding:32px}.module-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}.module-header span,.module-header p,small{color:#718096}.module-header h1{margin:5px 0;font-size:26px}.module-header button,.module-form button,.module-list button{display:inline-flex;align-items:center;gap:6px;border:0;border-radius:10px;padding:10px 15px;background:#20bf6b;color:#fff;cursor:pointer}.module-form{display:flex;gap:10px;margin-bottom:20px}.module-form input,.module-form select{min-width:0;border:1px solid #dce2e8;border-radius:10px;padding:11px 13px;background:#fff}.module-form input{flex:1}.module-list,.module-grid{display:grid;gap:12px}.module-grid{grid-template-columns:repeat(auto-fill,minmax(180px,1fr))}.module-list article,.module-grid article,.module-stats article{display:flex;justify-content:space-between;gap:16px;border:1px solid #e6ebef;border-radius:14px;background:#fff;padding:16px}.module-list p,.module-grid p{margin:7px 0;color:#465466;white-space:pre-wrap}.module-list .danger{background:#fff;color:#dc3545;border:1px solid #f2c8ce}.module-list .highlight{border-color:#a6e9c5;background:#effcf5}.module-split{display:grid;grid-template-columns:220px 1fr;gap:16px}.module-split nav{display:flex;flex-direction:column;gap:8px}.module-split nav button{display:flex;flex-direction:column;text-align:left;border:1px solid #e6ebef;border-radius:12px;background:#fff;padding:12px;cursor:pointer}.module-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px}.module-stats article{flex-direction:column}.module-stats strong{font-size:22px}@media(max-width:760px){.module-page{padding:18px}.module-split{grid-template-columns:1fr}.module-form{flex-wrap:wrap}.module-stats{grid-template-columns:1fr}}
.file-media-sources{display:grid;gap:16px;margin-bottom:16px}.file-media-source{border:1px solid #dfe6ec;border-radius:16px;background:#f9fbfc;padding:16px}.file-media-source>header{display:flex;align-items:center;justify-content:space-between;gap:12px}.file-media-source>header strong{font-size:17px}.file-media-source .file-media-stats{grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin:14px 0 0}.file-media-source .file-media-stats strong{font-size:18px;overflow-wrap:anywhere}@media(max-width:760px){.file-media-source>header{align-items:flex-start;flex-direction:column}}
</style>

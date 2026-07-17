<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watchEffect } from 'vue'
import { Info, RefreshCw } from '@lucide/vue'
import packageInfo from '../package.json'
import AgreementPage from './components/AgreementPage.vue'
import AppShell from './components/AppShell.vue'
import GlobalLayer from './components/GlobalLayer.vue'
import LoginView from './components/LoginView.vue'
import StatePanel from './components/StatePanel.vue'
import UnsupportedClientView from './components/UnsupportedClientView.vue'
import { detectWebClientEnvironment } from './services/clientEnvironment'
import { CLIENT_CONFIG_INVALIDATED_EVENT } from './services/clientConfigEvents'
import { WebApiError } from './services/apiClient'
import {
  CLIENT_MODULE_REGISTRY,
  fetchWebClientConfig,
  isClientModuleKey,
  isClientModuleAvailable,
  type ClientModuleKey,
  type WebClientConfig
} from './services/clientModules'
import { CONTEXT_MENU_CLOSE_EVENT, emitCloseContextMenus, isCloseFromSource } from './services/contextMenu'
import { layer } from './services/layer'
import {
  applyDocumentBrand,
  createUndiscoveredTenantConfig,
  normalizeEnterpriseCode,
  resolveTenantConfig,
  type TenantBrandConfig
} from './services/tenantConfig'
import { clearWebSession, loadWebSession, loginWebIm, saveWebSession } from './services/webIm'
import type { ModuleView, PrimaryView, WebImSession } from './types'

type AgreementRoute = 'userAgreement' | 'privacyPolicy'
type AppRoute =
  | { kind: 'view'; view: PrimaryView }
  | { kind: 'agreement'; agreement: AgreementRoute }
  | { kind: 'not-found' }

type AppContextMenuState = { visible: boolean; x: number; y: number }

const tenantConfig = ref<TenantBrandConfig>(createUndiscoveredTenantConfig())
const webSession = ref<WebImSession | null>(null)
const clientConfig = ref<WebClientConfig | null>(null)
const activeView = ref<PrimaryView>('chats')
const route = ref<AppRoute>(resolveRoute())
const isBootstrapping = ref(true)
const isLoggingIn = ref(false)
const isTenantConfigLoading = ref(false)
const tenantConfigError = ref('')
const isClientConfigLoading = ref(false)
const clientConfigError = ref('')
const clientConfigForbidden = ref(false)
const clientEnvironment = ref(detectWebClientEnvironment())
const appVersion = packageInfo.version
const account = ref({ org: '', username: '' })
const appContextMenu = ref<AppContextMenuState>({ visible: false, x: 0, y: 0 })
let tenantConfigRequestSeq = 0
let clientConfigRequestSeq = 0
let tenantDiscoveryAbort: AbortController | null = null

const isAuthed = computed(() => Boolean(webSession.value))
const appTitle = computed(() => tenantConfig.value.siteName)
const currentAgreement = computed(() => {
  if (route.value.kind !== 'agreement' || !tenantConfig.value.discovered) return null
  return tenantConfig.value.agreements[route.value.agreement]
})
const routedModuleKey = computed<ClientModuleKey | null>(() => {
  if (route.value.kind !== 'view' || !isClientModuleKey(route.value.view)) return null
  return route.value.view
})
const directModuleGuard = computed(() => {
  if (!isAuthed.value || !routedModuleKey.value) return null
  if (isClientConfigLoading.value) return 'loading'
  if (clientConfigForbidden.value) return 'forbidden'
  if (clientConfigError.value) return 'error'
  if (!isClientModuleAvailable(clientConfig.value, routedModuleKey.value)) return 'forbidden'
  return null
})

watchEffect(() => applyDocumentBrand(tenantConfig.value, appTitle.value))

function routePath() {
  const hashPath = window.location.hash.replace(/^#/, '').split('?')[0]
  if (hashPath) return hashPath
  return window.location.pathname === '/' ? '' : window.location.pathname.replace(/\/$/, '')
}

function resolveRoute(): AppRoute {
  const path = routePath()
  if (!path || path === '/' || path === '/chats') return { kind: 'view', view: 'chats' }
  if (path === '/contacts') return { kind: 'view', view: 'contacts' }
  const module = Object.values(CLIENT_MODULE_REGISTRY).find((item) => item.route === path)
  if (module) return { kind: 'view', view: module.moduleKey as ModuleView }
  if (path === '/agreements/user-agreement') return { kind: 'agreement', agreement: 'userAgreement' }
  if (path === '/agreements/privacy-policy') return { kind: 'agreement', agreement: 'privacyPolicy' }
  return { kind: 'not-found' }
}

function syncRoute() {
  route.value = resolveRoute()
  if (route.value.kind === 'view') activeView.value = route.value.view
}

function navigateToView(view: PrimaryView) {
  const paths = {
    chats: '/chats',
    contacts: '/contacts',
    ...Object.fromEntries(Object.values(CLIENT_MODULE_REGISTRY).map((item) => [item.moduleKey, item.route]))
  } as Record<PrimaryView, string>
  activeView.value = view
  const nextHash = `#${paths[view]}`
  if (window.location.hash !== nextHash) window.location.hash = paths[view]
  else syncRoute()
}

function handleViewportChange() {
  clientEnvironment.value = detectWebClientEnvironment()
}

function closeAppContextMenu() {
  appContextMenu.value.visible = false
}

function openAppContextMenu(event: MouseEvent) {
  event.preventDefault()
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest('.message-context-menu, .conversation-context-menu, .app-context-menu')) return
  emitCloseContextMenus('app')
  appContextMenu.value = {
    visible: true,
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - 184)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - 100))
  }
}

function handleContextMenuClose(event: Event) {
  if (!isCloseFromSource(event, 'app')) closeAppContextMenu()
}

function handleGlobalKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') closeAppContextMenu()
}

function refreshPage() {
  closeAppContextMenu()
  window.location.reload()
}

function showAppVersion() {
  closeAppContextMenu()
  layer.info(`App 版本：v${appVersion}`, 3600)
}

async function loadClientConfig() {
  const session = webSession.value
  if (!session) return
  const requestSeq = ++clientConfigRequestSeq
  isClientConfigLoading.value = true
  clientConfigError.value = ''
  clientConfigForbidden.value = false
  clientConfig.value = null
  try {
    const result = await fetchWebClientConfig(tenantConfig.value, session)
    if (requestSeq === clientConfigRequestSeq && webSession.value === session) {
      clientConfig.value = result
    }
  } catch (error) {
    if (requestSeq !== clientConfigRequestSeq) return
    if (error instanceof WebApiError && (error.status === 401 || error.code === 401)) {
      handleLogout()
      layer.warning('会话已失效，请重新登录')
    } else if (error instanceof WebApiError && (error.status === 403 || error.code === 403)) {
      clientConfigForbidden.value = true
    } else {
      clientConfigError.value = error instanceof Error ? error.message : '客户端配置加载失败'
    }
  } finally {
    if (requestSeq === clientConfigRequestSeq) isClientConfigLoading.value = false
  }
}

async function restoreSession() {
  const session = loadWebSession(tenantConfig.value)
  if (!session) return
  webSession.value = session
  account.value = {
    org: session.organization,
    username: session.user.nickname || session.user.account
  }
  await loadClientConfig()
}

async function discoverTenant(enterpriseCode = '', silent = false) {
  if (isAuthed.value) return tenantConfig.value
  const requestSeq = ++tenantConfigRequestSeq
  tenantDiscoveryAbort?.abort()
  const discoveryAbort = new AbortController()
  tenantDiscoveryAbort = discoveryAbort
  isTenantConfigLoading.value = true
  tenantConfigError.value = ''
  try {
    const config = await resolveTenantConfig(enterpriseCode, discoveryAbort.signal)
    if (requestSeq === tenantConfigRequestSeq) tenantConfig.value = config
    return config
  } catch (error) {
    const message = error instanceof Error ? error.message : '企业信息加载失败'
    if (requestSeq === tenantConfigRequestSeq) {
      const empty = createUndiscoveredTenantConfig()
      tenantConfig.value = { ...empty, enterpriseCode: enterpriseCode.trim() }
      tenantConfigError.value = message
      if (!silent) layer.error(message)
    }
    throw error
  } finally {
    if (tenantDiscoveryAbort === discoveryAbort) tenantDiscoveryAbort = null
    if (requestSeq === tenantConfigRequestSeq) isTenantConfigLoading.value = false
  }
}

async function bootstrap() {
  isBootstrapping.value = true
  try {
    const initial = tenantConfig.value
    if (initial.mode === 'domain' || initial.enterpriseCode) {
      await discoverTenant(initial.enterpriseCode, true)
      await restoreSession()
    }
  } catch {
    // 发现错误由页面状态展示；不能带默认 organization 继续进入业务链路。
  } finally {
    isBootstrapping.value = false
  }
}

async function handleEnterpriseCodeChange(enterpriseCode: string) {
  if (isAuthed.value) return
  if (
    tenantConfig.value.discovered &&
    tenantConfig.value.enterpriseCode === enterpriseCode.trim().toLowerCase()
  ) return
  try {
    await discoverTenant(enterpriseCode, true)
  } catch {
    // LoginView 直接展示 tenantConfigError。
  }
}

async function handleLogin(payload: { enterpriseCode: string; username: string; password: string }) {
  if (isLoggingIn.value) return
  isLoggingIn.value = true
  try {
    let config = tenantConfig.value
    if (
      config.mode === 'enterprise_code' &&
      (!config.discovered || config.enterpriseCode !== normalizeEnterpriseCode(payload.enterpriseCode))
    ) {
      config = await discoverTenant(payload.enterpriseCode, true)
    }
    if (!config.discovered || !config.organization) throw new Error(tenantConfigError.value || '请先确认企业信息')

    const session = await loginWebIm(config, {
      account: payload.username.trim(),
      password: payload.password
    })
    if (session.organization !== config.organization) {
      throw new Error('登录 organization 与发现上下文不一致')
    }
    saveWebSession(session)
    webSession.value = session
    account.value = {
      org: session.organization,
      username: session.user.nickname || session.user.account
    }
    await loadClientConfig()
    if (route.value.kind === 'view') activeView.value = route.value.view
  } catch (error) {
    layer.error(error instanceof Error ? error.message : '登录失败，请稍后重试')
  } finally {
    isLoggingIn.value = false
  }
}

function handleLogout() {
  clientConfigRequestSeq += 1
  clearWebSession(webSession.value)
  webSession.value = null
  clientConfig.value = null
  clientConfigError.value = ''
  clientConfigForbidden.value = false
  isClientConfigLoading.value = false
  account.value = { org: '', username: '' }
  activeView.value = 'chats'
}

function handleSessionUpdated(session: WebImSession) {
  if (
    session.organization !== tenantConfig.value.organization ||
    session.deploymentId !== tenantConfig.value.deploymentId ||
    session.apiServerUrl !== tenantConfig.value.serverInfo.apiServerUrl ||
    session.imServerUrl !== tenantConfig.value.serverInfo.imServerUrl
  ) {
    handleLogout()
    layer.error('会话 organization 已变化，请重新登录')
    return
  }
  saveWebSession(session)
  webSession.value = session
  account.value = {
    org: session.organization,
    username: session.user.nickname || session.user.account
  }
}

function refreshClientConfigWhenVisible() {
  if (!document.hidden && isAuthed.value && !isClientConfigLoading.value) {
    void loadClientConfig()
  }
}

async function handleClientConfigInvalidated() {
  if (!isAuthed.value || isClientConfigLoading.value) return
  await loadClientConfig()
  if (routedModuleKey.value && !isClientModuleAvailable(clientConfig.value, routedModuleKey.value)) {
    navigateToView('chats')
  }
}

onMounted(() => {
  window.addEventListener('hashchange', syncRoute)
  window.addEventListener('popstate', syncRoute)
  window.addEventListener('resize', handleViewportChange)
  window.addEventListener('click', closeAppContextMenu, { capture: true })
  window.addEventListener('keydown', handleGlobalKeydown)
  window.addEventListener('blur', closeAppContextMenu)
  document.addEventListener('visibilitychange', refreshClientConfigWhenVisible)
  window.addEventListener(CONTEXT_MENU_CLOSE_EVENT, handleContextMenuClose)
  window.addEventListener(CLIENT_CONFIG_INVALIDATED_EVENT, handleClientConfigInvalidated)
  syncRoute()
  void bootstrap()
})

onBeforeUnmount(() => {
  tenantDiscoveryAbort?.abort()
  window.removeEventListener('hashchange', syncRoute)
  window.removeEventListener('popstate', syncRoute)
  window.removeEventListener('resize', handleViewportChange)
  window.removeEventListener('click', closeAppContextMenu, true)
  window.removeEventListener('keydown', handleGlobalKeydown)
  window.removeEventListener('blur', closeAppContextMenu)
  document.removeEventListener('visibilitychange', refreshClientConfigWhenVisible)
  window.removeEventListener(CONTEXT_MENU_CLOSE_EVENT, handleContextMenuClose)
  window.removeEventListener(CLIENT_CONFIG_INVALIDATED_EVENT, handleClientConfigInvalidated)
})
</script>

<template>
  <div class="app-root" @contextmenu="openAppContextMenu">
    <div v-if="isBootstrapping" class="app-boot-loader" role="status" aria-live="polite">
      <div class="app-boot-loader__panel"><div class="app-boot-loader__spinner"></div></div>
    </div>
    <StatePanel
      v-else-if="route.kind === 'not-found'"
      kind="not-found"
      title="页面不存在"
      description="该地址不在当前 Web 客户端的固定路由注册表中。"
      action-label="返回消息"
      @action="navigateToView('chats')"
    />
    <StatePanel
      v-else-if="tenantConfig.mode === 'domain' && !tenantConfig.discovered"
      kind="error"
      title="无法识别当前机构"
      :description="tenantConfigError || '企业信息加载失败，请稍后重试。'"
      action-label="重新连接"
      @action="bootstrap"
    />
    <UnsupportedClientView
      v-else-if="clientEnvironment.unsupported"
      :tenant-config="tenantConfig"
    />
    <AgreementPage
      v-else-if="currentAgreement"
      :agreement="currentAgreement"
      :tenant-config="tenantConfig"
    />
    <LoginView
      v-else-if="!isAuthed"
      :tenant-config="tenantConfig"
      :loading="isLoggingIn"
      :tenant-loading="isTenantConfigLoading"
      :tenant-error="tenantConfigError"
      @enterprise-code-change="handleEnterpriseCodeChange"
      @login="handleLogin"
    />
    <StatePanel
      v-else-if="directModuleGuard === 'loading'"
      kind="loading"
      title="正在校验企业应用"
      description="正在读取当前机构的客户端配置和模块可用投影。"
    />
    <StatePanel
      v-else-if="directModuleGuard === 'error'"
      kind="error"
      title="模块配置加载失败"
      :description="clientConfigError"
      action-label="重新加载"
      @action="loadClientConfig"
    />
    <StatePanel
      v-else-if="directModuleGuard === 'forbidden'"
      kind="forbidden"
      title="企业应用不可用"
      description="当前机构未启用该模块，或 Web 客户端能力投影未授权该入口。"
      action-label="返回消息"
      @action="navigateToView('chats')"
    />
    <AppShell
      v-else-if="webSession"
      :active-view="activeView"
      :account="account"
      :tenant-config="tenantConfig"
      :web-session="webSession"
      :client-config="clientConfig"
      @update:active-view="navigateToView"
      @session-updated="handleSessionUpdated"
      @logout="handleLogout"
    />

    <div
      v-if="appContextMenu.visible"
      class="app-context-menu"
      :style="{ left: `${appContextMenu.x}px`, top: `${appContextMenu.y}px` }"
      @click.stop
      @contextmenu.prevent.stop
    >
      <button type="button" @click="refreshPage">
        <RefreshCw :size="15" /><span>刷新</span>
      </button>
      <button type="button" @click="showAppVersion">
        <Info :size="15" /><span>App 版本</span>
      </button>
    </div>
  </div>
  <GlobalLayer />
</template>

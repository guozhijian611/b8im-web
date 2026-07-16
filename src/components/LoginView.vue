<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch, watchEffect } from 'vue'
import {
  CheckCircle2,
  Download,
  MessageCircle,
  MonitorSmartphone,
  QrCode,
  RefreshCw,
  XCircle
} from '@lucide/vue'
import QRCode from 'qrcode'
import type { TenantBrandConfig } from '../services/tenantConfig'
import {
  cancelQrLogin,
  createQrLogin,
  fetchWebAccountPolicy,
  fetchWebCaptcha,
  pollQrLogin,
  registerWebIm,
  type QrLoginSessionSecret,
  type QrLoginStatus
} from '../services/webIm'
import {
  validateWebRegistration,
  type WebRegistrationErrors
} from '../services/webAuthValidation'
import type { WebImSession } from '../types'

type LoginTab = 'account' | 'qr'
type AccountMode = 'login' | 'register'
type QrViewStatus = 'idle' | 'creating' | QrLoginStatus | 'error'

interface ActiveQrSession {
  config: TenantBrandConfig
  contextKey: string
  secret: QrLoginSessionSecret
}

const props = defineProps<{
  tenantConfig: TenantBrandConfig
  loading: boolean
  tenantLoading: boolean
  tenantError: string
}>()

const emit = defineEmits<{
  login: [{ enterpriseCode: string; username: string; password: string }]
  authenticated: [session: WebImSession]
  'enterprise-code-change': [enterpriseCode: string]
}>()

const enterpriseCode = ref('')
const username = ref('')
const password = ref('')
const enterpriseCodeTouched = ref(false)
const activeTab = ref<LoginTab>('account')
const accountMode = ref<AccountMode>('login')
const accountPolicyState = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle')
const registerEnabled = ref(false)
const registerLoading = ref(false)
const registerError = ref('')
const captchaLoading = ref(false)
const captchaError = ref('')
const captchaUuid = ref('')
const captchaImage = ref('')
const qrCanvas = ref<HTMLCanvasElement | null>(null)
const qrStatus = ref<QrViewStatus>('idle')
const qrError = ref('')

const registerForm = reactive({
  account: '',
  nickname: '',
  password: '',
  passwordConfirm: '',
  code: ''
})
const registerErrors = reactive<WebRegistrationErrors>({})

let enterpriseCodeTimer: number | undefined
let qrPollTimer: number | undefined
let policyRequestEpoch = 0
let captchaRequestEpoch = 0
let qrRequestEpoch = 0
let activeQrSession: ActiveQrSession | null = null

const tenantConfig = computed(() => props.tenantConfig)
const isDomainMode = computed(() => props.tenantConfig.mode === 'domain')
const normalizedEnterpriseInput = computed(() => enterpriseCode.value.trim().toLowerCase())
const tenantContextReady = computed(() => {
  if (!props.tenantConfig.discovered || !props.tenantConfig.organization) return false
  return isDomainMode.value || normalizedEnterpriseInput.value === props.tenantConfig.enterpriseCode
})
const tenantContextKey = computed(() => {
  if (!tenantContextReady.value) return ''
  const config = props.tenantConfig
  return [
    config.deploymentId,
    config.organization,
    config.enterpriseCode,
    config.configVersion,
    config.serverInfo.apiServerUrl
  ].join(':')
})
const isSubmitting = computed(() => props.loading || props.tenantLoading)
const registrationAvailable = computed(
  () => tenantContextReady.value && accountPolicyState.value === 'ready' && registerEnabled.value
)
const qrHasCode = computed(() => qrStatus.value === 'pending' || qrStatus.value === 'scanned')
const qrCanCancel = computed(() => qrStatus.value === 'pending' || qrStatus.value === 'scanned')
const qrCanRefresh = computed(() =>
  qrStatus.value === 'expired' ||
  qrStatus.value === 'cancelled' ||
  qrStatus.value === 'consumed' ||
  qrStatus.value === 'error'
)
const qrStatusTitle = computed(() => {
  switch (qrStatus.value) {
    case 'creating': return '正在生成安全二维码'
    case 'pending': return '等待扫描'
    case 'scanned': return '已扫描，请在 App 中确认'
    case 'confirmed': return '确认成功，正在进入客户端'
    case 'expired': return '二维码已过期'
    case 'cancelled': return '本次扫码已取消'
    case 'consumed': return '二维码已使用，请刷新后重试'
    case 'error': return qrError.value || '扫码登录暂时不可用'
    default: return tenantContextReady.value ? '准备扫码登录' : '请先连接企业'
  }
})

watchEffect(() => {
  if (!enterpriseCodeTouched.value || isDomainMode.value) {
    enterpriseCode.value = props.tenantConfig.enterpriseCode
  }
})

watch(
  tenantContextKey,
  (contextKey) => {
    policyRequestEpoch += 1
    captchaRequestEpoch += 1
    registerEnabled.value = false
    accountPolicyState.value = contextKey ? 'loading' : 'idle'
    closeRegistration()
    void stopQrSession(true)

    if (!contextKey) {
      qrStatus.value = 'idle'
      return
    }

    const config = props.tenantConfig
    const requestEpoch = policyRequestEpoch
    void fetchWebAccountPolicy(config)
      .then((policy) => {
        if (requestEpoch !== policyRequestEpoch || contextKey !== tenantContextKey.value) return
        registerEnabled.value = policy.registerEnabled
        accountPolicyState.value = 'ready'
      })
      .catch(() => {
        if (requestEpoch !== policyRequestEpoch || contextKey !== tenantContextKey.value) return
        registerEnabled.value = false
        accountPolicyState.value = 'failed'
      })

    if (activeTab.value === 'qr') void startQrLogin()
  },
  { immediate: true }
)

watch(activeTab, (tab) => {
  if (tab === 'qr') {
    accountMode.value = 'login'
    void startQrLogin()
    return
  }
  void stopQrSession(true)
})

onBeforeUnmount(() => {
  clearEnterpriseCodeTimer()
  policyRequestEpoch += 1
  captchaRequestEpoch += 1
  void stopQrSession(true)
})

function clearEnterpriseCodeTimer() {
  if (!enterpriseCodeTimer) return
  window.clearTimeout(enterpriseCodeTimer)
  enterpriseCodeTimer = undefined
}

function clearQrPollTimer() {
  if (!qrPollTimer) return
  window.clearTimeout(qrPollTimer)
  qrPollTimer = undefined
}

function requestTenantConfigReload() {
  clearEnterpriseCodeTimer()
  const code = enterpriseCode.value.trim()
  if (code && !isDomainMode.value) emit('enterprise-code-change', code)
}

function handleEnterpriseCodeInput() {
  enterpriseCodeTouched.value = true
  registerEnabled.value = false
  accountPolicyState.value = 'idle'
  clearEnterpriseCodeTimer()
  enterpriseCodeTimer = window.setTimeout(requestTenantConfigReload, 500)
}

function submitLogin() {
  clearEnterpriseCodeTimer()
  emit('login', {
    enterpriseCode: enterpriseCode.value.trim(),
    username: username.value.trim(),
    password: password.value
  })
}

function setActiveTab(tab: LoginTab) {
  if (activeTab.value !== tab) activeTab.value = tab
}

function handleTabKeydown(event: KeyboardEvent) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  setActiveTab(activeTab.value === 'account' ? 'qr' : 'account')
  void nextTick(() => {
    document.getElementById(`login-tab-${activeTab.value}`)?.focus()
  })
}

function clearRegistrationErrors() {
  for (const key of Object.keys(registerErrors) as Array<keyof WebRegistrationErrors>) {
    delete registerErrors[key]
  }
}

function resetCaptcha() {
  captchaRequestEpoch += 1
  captchaLoading.value = false
  captchaUuid.value = ''
  captchaImage.value = ''
  captchaError.value = ''
  registerForm.code = ''
}

function closeRegistration() {
  accountMode.value = 'login'
  registerError.value = ''
  clearRegistrationErrors()
  resetCaptcha()
}

function openRegistration() {
  if (!registrationAvailable.value) return
  accountMode.value = 'register'
  registerError.value = ''
  clearRegistrationErrors()
  void refreshCaptcha()
}

async function refreshCaptcha() {
  if (!registrationAvailable.value || captchaLoading.value) return
  const config = props.tenantConfig
  const contextKey = tenantContextKey.value
  const requestEpoch = ++captchaRequestEpoch
  captchaLoading.value = true
  captchaError.value = ''
  captchaUuid.value = ''
  captchaImage.value = ''
  registerForm.code = ''
  try {
    const captcha = await fetchWebCaptcha(config)
    if (requestEpoch !== captchaRequestEpoch || contextKey !== tenantContextKey.value) return
    captchaUuid.value = captcha.uuid
    captchaImage.value = captcha.image
  } catch (error) {
    if (requestEpoch !== captchaRequestEpoch || contextKey !== tenantContextKey.value) return
    captchaError.value = error instanceof Error ? error.message : '验证码加载失败'
  } finally {
    if (requestEpoch === captchaRequestEpoch) captchaLoading.value = false
  }
}

async function submitRegistration() {
  if (!registrationAvailable.value || registerLoading.value) return
  clearRegistrationErrors()
  Object.assign(registerErrors, validateWebRegistration(registerForm))
  if (!captchaUuid.value || !captchaImage.value) {
    captchaError.value = '请先加载图形验证码'
  }
  if (Object.keys(registerErrors).length > 0 || !captchaUuid.value || !captchaImage.value) return

  const config = props.tenantConfig
  const contextKey = tenantContextKey.value
  registerLoading.value = true
  registerError.value = ''
  try {
    const session = await registerWebIm(config, {
      account: registerForm.account.trim(),
      nickname: registerForm.nickname.trim(),
      password: registerForm.password,
      passwordConfirm: registerForm.passwordConfirm,
      uuid: captchaUuid.value,
      code: registerForm.code.trim()
    })
    if (contextKey !== tenantContextKey.value) {
      throw new Error('注册期间企业上下文已变化，请重试')
    }
    emit('authenticated', session)
  } catch (error) {
    registerError.value = error instanceof Error ? error.message : '注册失败，请稍后重试'
    if (contextKey === tenantContextKey.value) void refreshCaptcha()
  } finally {
    registerLoading.value = false
  }
}

function detachQrSession() {
  qrRequestEpoch += 1
  clearQrPollTimer()
  const active = activeQrSession
  activeQrSession = null
  return active
}

async function cancelDetachedQrSession(active: ActiveQrSession | null) {
  if (!active) return
  try {
    await cancelQrLogin(active.config, active.secret)
  } catch {
    // 本地已废弃此次会话；远端仍会按 expires_at 失效。
  }
}

async function stopQrSession(cancelRemote: boolean) {
  const active = detachQrSession()
  if (cancelRemote) await cancelDetachedQrSession(active)
}

async function renderQrCode(content: string, requestEpoch: number) {
  await nextTick()
  if (requestEpoch !== qrRequestEpoch || !qrCanvas.value) return false
  await QRCode.toCanvas(qrCanvas.value, content, {
    width: 224,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#1f2a37', light: '#ffffff' }
  })
  return requestEpoch === qrRequestEpoch
}

function isCurrentQrRequest(requestEpoch: number, contextKey: string) {
  return (
    requestEpoch === qrRequestEpoch &&
    activeTab.value === 'qr' &&
    contextKey !== '' &&
    contextKey === tenantContextKey.value
  )
}

async function startQrLogin() {
  const previous = detachQrSession()
  const contextKey = tenantContextKey.value
  const requestEpoch = ++qrRequestEpoch
  if (activeTab.value !== 'qr' || !tenantContextReady.value || !contextKey) {
    qrStatus.value = 'idle'
    await cancelDetachedQrSession(previous)
    return
  }

  const config = props.tenantConfig
  qrStatus.value = 'creating'
  qrError.value = ''
  try {
    await cancelDetachedQrSession(previous)
    if (!isCurrentQrRequest(requestEpoch, contextKey)) return
    const secret = await createQrLogin(config)
    if (!isCurrentQrRequest(requestEpoch, contextKey)) {
      await cancelDetachedQrSession({ config, contextKey, secret })
      return
    }
    activeQrSession = { config, contextKey, secret }
    if (!(await renderQrCode(secret.qrContent, requestEpoch))) return
    qrStatus.value = 'pending'
    scheduleQrPoll(requestEpoch)
  } catch (error) {
    if (requestEpoch !== qrRequestEpoch) return
    const active = detachQrSession()
    void cancelDetachedQrSession(active)
    qrError.value = error instanceof Error ? error.message : '二维码生成失败'
    qrStatus.value = 'error'
  }
}

function scheduleQrPoll(requestEpoch: number) {
  clearQrPollTimer()
  qrPollTimer = window.setTimeout(() => void pollActiveQrSession(requestEpoch), 2000)
}

async function pollActiveQrSession(requestEpoch: number) {
  const active = activeQrSession
  if (!active || requestEpoch !== qrRequestEpoch) return
  if (active.secret.expiresAt <= Math.floor(Date.now() / 1000)) {
    detachQrSession()
    qrStatus.value = 'expired'
    return
  }

  try {
    const result = await pollQrLogin(active.config, active.secret)
    if (
      requestEpoch !== qrRequestEpoch ||
      active !== activeQrSession ||
      active.contextKey !== tenantContextKey.value
    ) return

    qrStatus.value = result.status
    if (result.status === 'confirmed') {
      activeQrSession = null
      clearQrPollTimer()
      qrRequestEpoch += 1
      emit('authenticated', result.session)
      return
    }
    if (result.status === 'expired' || result.status === 'cancelled' || result.status === 'consumed') {
      detachQrSession()
      return
    }
    scheduleQrPoll(requestEpoch)
  } catch (error) {
    if (requestEpoch !== qrRequestEpoch) return
    if (activeQrSession?.secret.expiresAt && activeQrSession.secret.expiresAt <= Math.floor(Date.now() / 1000) + 1) {
      detachQrSession()
      qrStatus.value = 'expired'
      return
    }
    qrError.value = error instanceof Error ? error.message : '扫码状态查询失败'
    qrStatus.value = 'error'
  }
}

async function cancelQrByUser() {
  const active = detachQrSession()
  qrStatus.value = 'cancelled'
  await cancelDetachedQrSession(active)
}

function agreementHref(type: 'userAgreement' | 'privacyPolicy') {
  return type === 'userAgreement'
    ? '#/agreements/user-agreement'
    : '#/agreements/privacy-policy'
}
</script>

<template>
  <main class="login-page">
    <section class="login-card" :aria-label="`${tenantConfig.siteName} 登录`">
      <div class="login-brand">
        <div class="brand-badge">
          <img v-if="tenantConfig.logoUrl" :src="tenantConfig.logoUrl" :alt="tenantConfig.siteName" />
          <span v-else>{{ tenantConfig.logoText }}</span>
        </div>
        <h1>{{ tenantConfig.siteName }}</h1>
        <p>面向组织的 Web 即时通讯客户端</p>
        <div class="brand-points">
          <span><MessageCircle :size="16" /> 单聊与群聊</span>
          <span><MonitorSmartphone :size="16" /> Web / App 多端同步</span>
          <span><CheckCircle2 :size="16" /> 离线与历史消息</span>
        </div>
      </div>

      <div class="login-form-panel">
        <div class="login-tabs" role="tablist" aria-label="登录方式" @keydown="handleTabKeydown">
          <button
            id="login-tab-account"
            type="button"
            role="tab"
            :class="{ active: activeTab === 'account' }"
            :aria-selected="activeTab === 'account'"
            aria-controls="login-panel-account"
            :tabindex="activeTab === 'account' ? 0 : -1"
            @click="setActiveTab('account')"
          >
            账号登录
          </button>
          <button
            id="login-tab-qr"
            type="button"
            role="tab"
            :class="{ active: activeTab === 'qr' }"
            :aria-selected="activeTab === 'qr'"
            aria-controls="login-panel-qr"
            :tabindex="activeTab === 'qr' ? 0 : -1"
            @click="setActiveTab('qr')"
          >
            扫码登录
          </button>
        </div>

        <div class="tenant-context">
          <label v-if="!isDomainMode">
            <span>企业码</span>
            <input
              v-model="enterpriseCode"
              required
              placeholder="请输入企业码"
              autocomplete="organization"
              :disabled="registerLoading"
              @input="handleEnterpriseCodeInput"
              @blur="requestTenantConfigReload"
            />
          </label>
          <p v-if="tenantContextReady" class="tenant-discovery-status success">
            已连接 {{ tenantConfig.siteName }}
          </p>
          <p v-else-if="tenantError" class="tenant-discovery-status error">{{ tenantError }}</p>
          <p v-else-if="tenantLoading" class="tenant-discovery-status" role="status">正在识别企业信息…</p>
        </div>

        <div
          v-show="activeTab === 'account'"
          id="login-panel-account"
          class="login-mode-body"
          role="tabpanel"
          aria-labelledby="login-tab-account"
        >
          <form v-if="accountMode === 'login'" class="login-form" @submit.prevent="submitLogin">
            <label>
              <span>账号</span>
              <input v-model="username" required autocomplete="username" placeholder="请输入账号" />
            </label>
            <label>
              <span>密码</span>
              <input
                v-model="password"
                required
                type="password"
                autocomplete="current-password"
                placeholder="请输入密码"
              />
            </label>

            <button class="primary-login" type="submit" :disabled="isSubmitting">
              {{ tenantLoading ? '加载企业信息…' : loading ? '登录中…' : '登录' }}
            </button>
            <p v-if="registrationAvailable" class="login-note">
              没有账号？
              <button class="login-text-action" type="button" @click="openRegistration">立即注册</button>
            </p>
            <div v-if="tenantConfig.appDownloads.length" class="download-links" aria-label="App 下载地址">
              <a
                v-for="link in tenantConfig.appDownloads"
                :key="link.platform"
                :href="link.url"
                target="_blank"
                rel="noreferrer"
              >
                <Download :size="15" />{{ link.label }}
              </a>
            </div>
          </form>

          <form v-else class="login-form register-form" novalidate @submit.prevent="submitRegistration">
            <div class="register-form-heading">
              <div>
                <strong>创建账号</strong>
                <span>注册后将直接进入 {{ tenantConfig.siteName }}</span>
              </div>
              <button type="button" @click="closeRegistration">返回登录</button>
            </div>
            <div class="register-grid">
              <label>
                <span>账号</span>
                <input
                  v-model="registerForm.account"
                  required
                  minlength="2"
                  maxlength="64"
                  pattern="[A-Za-z0-9_-]{2,64}"
                  autocomplete="username"
                  placeholder="2-64 位字母、数字、_ 或 -"
                  :aria-invalid="Boolean(registerErrors.account)"
                  aria-describedby="register-account-error"
                />
                <small v-if="registerErrors.account" id="register-account-error" class="field-error">{{ registerErrors.account }}</small>
              </label>
              <label>
                <span>昵称</span>
                <input
                  v-model="registerForm.nickname"
                  required
                  maxlength="64"
                  autocomplete="nickname"
                  placeholder="1-64 个字符"
                  :aria-invalid="Boolean(registerErrors.nickname)"
                  aria-describedby="register-nickname-error"
                />
                <small v-if="registerErrors.nickname" id="register-nickname-error" class="field-error">{{ registerErrors.nickname }}</small>
              </label>
              <label>
                <span>密码</span>
                <input
                  v-model="registerForm.password"
                  required
                  type="password"
                  minlength="8"
                  maxlength="72"
                  autocomplete="new-password"
                  placeholder="8-72 个字符"
                  :aria-invalid="Boolean(registerErrors.password)"
                  aria-describedby="register-password-error"
                />
                <small v-if="registerErrors.password" id="register-password-error" class="field-error">{{ registerErrors.password }}</small>
              </label>
              <label>
                <span>确认密码</span>
                <input
                  v-model="registerForm.passwordConfirm"
                  required
                  type="password"
                  minlength="8"
                  maxlength="72"
                  autocomplete="new-password"
                  placeholder="请再次输入密码"
                  :aria-invalid="Boolean(registerErrors.passwordConfirm)"
                  aria-describedby="register-confirm-password-error"
                />
                <small v-if="registerErrors.passwordConfirm" id="register-confirm-password-error" class="field-error">{{ registerErrors.passwordConfirm }}</small>
              </label>
            </div>
            <label>
              <span>图形验证码</span>
              <div class="captcha-field">
                <input
                  v-model="registerForm.code"
                  required
                  minlength="4"
                  maxlength="4"
                  autocomplete="off"
                  inputmode="text"
                  placeholder="请输入验证码"
                  :aria-invalid="Boolean(registerErrors.code)"
                  aria-describedby="register-code-error captcha-error"
                />
                <button type="button" :disabled="captchaLoading" aria-label="刷新图形验证码" @click="refreshCaptcha">
                  <img v-if="captchaImage" :src="captchaImage" alt="图形验证码，点击可刷新" />
                  <span v-else>{{ captchaLoading ? '加载中…' : '刷新验证码' }}</span>
                </button>
              </div>
              <small v-if="registerErrors.code" id="register-code-error" class="field-error">{{ registerErrors.code }}</small>
              <small v-if="captchaError" id="captcha-error" class="field-error">{{ captchaError }}</small>
            </label>
            <p v-if="registerError" class="auth-form-error" role="alert">{{ registerError }}</p>
            <button
              class="primary-login"
              type="submit"
              :disabled="registerLoading || captchaLoading || !registrationAvailable"
            >
              {{ registerLoading ? '注册中…' : '注册并进入客户端' }}
            </button>
          </form>
        </div>

        <div
          v-show="activeTab === 'qr'"
          id="login-panel-qr"
          class="login-mode-body qr-login-panel"
          role="tabpanel"
          aria-labelledby="login-tab-qr"
        >
          <div class="qr-code-shell" :class="`is-${qrStatus}`">
            <canvas
              v-show="qrHasCode"
              ref="qrCanvas"
              role="img"
              :aria-label="`${tenantConfig.siteName} 扫码登录二维码`"
            ></canvas>
            <div v-if="!qrHasCode" class="qr-code-placeholder" aria-hidden="true">
              <QrCode :size="62" />
            </div>
            <div v-if="qrStatus === 'scanned'" class="qr-code-overlay"><CheckCircle2 :size="36" /></div>
            <div v-else-if="qrStatus === 'expired' || qrStatus === 'cancelled' || qrStatus === 'consumed' || qrStatus === 'error'" class="qr-code-overlay terminal">
              <XCircle :size="36" />
            </div>
          </div>
          <div class="qr-status" role="status" aria-live="polite" aria-atomic="true">
            <strong>{{ qrStatusTitle }}</strong>
            <span v-if="qrStatus === 'pending'">请使用已登录的 b8im App 扫描</span>
            <span v-else-if="qrStatus === 'scanned'">确认后会自动登录当前浏览器</span>
            <span v-else-if="qrStatus === 'idle' && !tenantContextReady">识别企业后将自动生成</span>
          </div>
          <div class="qr-actions">
            <button v-if="qrCanCancel" type="button" @click="cancelQrByUser">取消扫码</button>
            <button v-if="qrCanRefresh" type="button" @click="startQrLogin">
              <RefreshCw :size="15" />刷新二维码
            </button>
          </div>
          <p class="qr-security-note">二维码由当前页面本地生成，确认前不会登录。</p>
        </div>
      </div>
    </section>
    <footer class="login-footer">
      <span>{{ tenantConfig.copyright }}</span>
      <a v-if="tenantConfig.icp" href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">
        {{ tenantConfig.icp }}
      </a>
      <a
        v-if="tenantConfig.publicSecurityRecordNo"
        :href="tenantConfig.publicSecurityRecordUrl"
        target="_blank"
        rel="noreferrer"
      >
        {{ tenantConfig.publicSecurityRecordNo }}
      </a>
      <a :href="agreementHref('userAgreement')">{{ tenantConfig.agreements.userAgreement.title }}</a>
      <a :href="agreementHref('privacyPolicy')">{{ tenantConfig.agreements.privacyPolicy.title }}</a>
    </footer>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, watchEffect } from 'vue'
import { CheckCircle2, Download, MessageCircle, MonitorSmartphone } from '@lucide/vue'
import type { TenantBrandConfig } from '../services/tenantConfig'

const props = defineProps<{
  tenantConfig: TenantBrandConfig
  loading: boolean
  tenantLoading: boolean
  tenantError: string
}>()

const emit = defineEmits<{
  login: [{ enterpriseCode: string; username: string; password: string }]
  'enterprise-code-change': [enterpriseCode: string]
}>()

const enterpriseCode = ref('')
const username = ref('')
const password = ref('')
const enterpriseCodeTouched = ref(false)
let enterpriseCodeTimer: number | undefined

const tenantConfig = computed(() => props.tenantConfig)
const isDomainMode = computed(() => props.tenantConfig.mode === 'domain')
const isSubmitting = computed(() => props.loading || props.tenantLoading)

watchEffect(() => {
  if (!enterpriseCodeTouched.value || isDomainMode.value) {
    enterpriseCode.value = props.tenantConfig.enterpriseCode
  }
})

watch(enterpriseCode, () => {
  if (!enterpriseCodeTouched.value || isDomainMode.value) return
  scheduleTenantConfigReload()
})

onBeforeUnmount(clearEnterpriseCodeTimer)

function clearEnterpriseCodeTimer() {
  if (!enterpriseCodeTimer) return
  window.clearTimeout(enterpriseCodeTimer)
  enterpriseCodeTimer = undefined
}

function requestTenantConfigReload() {
  clearEnterpriseCodeTimer()
  const code = enterpriseCode.value.trim()
  if (code && !isDomainMode.value) emit('enterprise-code-change', code)
}

function scheduleTenantConfigReload() {
  clearEnterpriseCodeTimer()
  enterpriseCodeTimer = window.setTimeout(requestTenantConfigReload, 500)
}

function submit() {
  clearEnterpriseCodeTimer()
  emit('login', {
    enterpriseCode: enterpriseCode.value.trim(),
    username: username.value.trim(),
    password: password.value
  })
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
        <div class="login-tabs"><strong>账号登录</strong></div>
        <div class="login-mode-body">
          <form class="login-form" @submit.prevent="submit">
            <label v-if="!isDomainMode">
              <span>企业码</span>
              <input
                v-model="enterpriseCode"
                required
                placeholder="请输入企业码"
                autocomplete="organization"
                @input="enterpriseCodeTouched = true"
                @blur="requestTenantConfigReload"
              />
            </label>
            <p v-if="tenantConfig.discovered" class="tenant-discovery-status success">
              已连接 {{ tenantConfig.siteName }}
            </p>
            <p v-else-if="tenantError" class="tenant-discovery-status error">{{ tenantError }}</p>
            <p v-else-if="tenantLoading" class="tenant-discovery-status">正在识别企业信息…</p>

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
            <p class="login-note">没有账号？请联系当前机构管理员开通</p>
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

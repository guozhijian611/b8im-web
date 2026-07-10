<script setup lang="ts">
import { Download, Monitor } from '@lucide/vue'
import type { TenantBrandConfig } from '../services/tenantConfig'

defineProps<{
  tenantConfig: TenantBrandConfig
}>()
</script>

<template>
  <main class="unsupported-client-page">
    <section class="unsupported-client-card">
      <div class="unsupported-client-brand">
        <img
          v-if="tenantConfig.logoUrl"
          :src="tenantConfig.logoUrl"
          :alt="tenantConfig.siteName"
        />
        <span v-else>{{ tenantConfig.logoText }}</span>
      </div>
      <div class="unsupported-client-icon">
        <Monitor :size="34" />
      </div>
      <h1>移动端请下载 App</h1>
      <p>
        {{ tenantConfig.siteName }} Web 聊天端仅支持电脑浏览器。手机浏览器、H5、WAP
        调试环境不会进入 Web 页面，请下载安装 App 使用。
      </p>
      <div class="unsupported-client-downloads" aria-label="App 下载地址">
        <a
          v-for="link in tenantConfig.appDownloads"
          :key="link.platform"
          :href="link.url"
          target="_blank"
          rel="noreferrer"
        >
          <Download :size="15" />
          {{ link.label }}
        </a>
      </div>
    </section>
  </main>
</template>

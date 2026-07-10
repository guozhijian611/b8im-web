<script setup lang="ts">
import { ArrowLeft } from '@lucide/vue'
import type { LegalAgreement, TenantBrandConfig } from '../services/tenantConfig'

defineProps<{
  agreement: LegalAgreement
  tenantConfig: TenantBrandConfig
}>()
</script>

<template>
  <main class="agreement-page">
    <section class="agreement-page__shell">
      <header class="agreement-page__header">
        <a class="agreement-page__back" href="#/">
          <ArrowLeft :size="18" />
          返回登录
        </a>
        <div class="agreement-page__brand">
          <img
            v-if="tenantConfig.logoUrl"
            :src="tenantConfig.logoUrl"
            :alt="tenantConfig.siteName"
          />
          <span v-else>{{ tenantConfig.logoText }}</span>
          <strong>{{ tenantConfig.siteName }}</strong>
        </div>
      </header>

      <article class="agreement-page__article">
        <h1>{{ agreement.title }}</h1>
        <p
          v-if="agreement.content.trim()"
          class="agreement-page__content"
        >{{ agreement.content }}</p>
        <div v-else class="agreement-page__empty">
          当前租户暂未配置{{ agreement.title }}
        </div>
      </article>
    </section>
  </main>
</template>

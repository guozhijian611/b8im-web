<script setup lang="ts">
import { AlertCircle, Ban, FileQuestion, Inbox, LoaderCircle } from '@lucide/vue'

const props = withDefaults(defineProps<{
  kind: 'loading' | 'empty' | 'error' | 'forbidden' | 'not-found'
  title: string
  description?: string
  actionLabel?: string
}>(), {
  description: '',
  actionLabel: ''
})

const emit = defineEmits<{ action: [] }>()
const icons = {
  loading: LoaderCircle,
  empty: Inbox,
  error: AlertCircle,
  forbidden: Ban,
  'not-found': FileQuestion
}
</script>

<template>
  <section class="state-panel" :class="`state-panel--${props.kind}`" role="status" aria-live="polite">
    <component :is="icons[props.kind]" :size="40" :class="{ spinning: props.kind === 'loading' }" />
    <h2>{{ props.title }}</h2>
    <p v-if="props.description">{{ props.description }}</p>
    <button v-if="props.actionLabel" type="button" @click="emit('action')">
      {{ props.actionLabel }}
    </button>
  </section>
</template>

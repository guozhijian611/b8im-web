<script setup lang="ts">
import { AlertCircle, CheckCircle2, Info, X, XCircle } from '@lucide/vue'
import { layer, type LayerToast } from '../services/layer'

const icons = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertCircle,
  info: Info
}

function close(item: LayerToast) {
  layer.remove(item.id)
}
</script>

<template>
  <Teleport to="body">
    <div class="layer-host" aria-live="polite" aria-atomic="false">
      <TransitionGroup name="layer-toast" tag="div" class="layer-stack">
        <div
          v-for="item in layer.state.toasts"
          :key="item.id"
          class="layer-toast"
          :class="item.type"
          role="status"
        >
          <component :is="icons[item.type]" :size="19" />
          <span>{{ item.message }}</span>
          <button type="button" aria-label="关闭" @click="close(item)">
            <X :size="15" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

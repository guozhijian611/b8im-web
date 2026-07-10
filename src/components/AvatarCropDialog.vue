<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ImagePlus, RotateCcw, X } from '@lucide/vue'

const props = defineProps<{
  saving: boolean
}>()

const emit = defineEmits<{
  close: []
  save: [File]
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const errorMessage = ref('')
const selectedName = ref('')
const imageReady = ref(false)
const scale = ref(1)
const offsetX = ref(0)
const offsetY = ref(0)
const cropSize = 320
const outputSize = 512
let image: HTMLImageElement | null = null
let objectUrl = ''
let dragState: {
  pointerId: number
  startX: number
  startY: number
  originX: number
  originY: number
} | null = null

function pickFile() {
  fileInputRef.value?.click()
}

function revokeObjectUrl() {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl)
    objectUrl = ''
  }
}

function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  if (!file.type.startsWith('image/')) {
    errorMessage.value = '请选择图片文件'
    return
  }
  if (file.size > 10 * 1024 * 1024) {
    errorMessage.value = '图片不能超过 10MB'
    return
  }

  revokeObjectUrl()
  imageReady.value = false
  selectedName.value = file.name
  errorMessage.value = ''
  objectUrl = URL.createObjectURL(file)
  image = new window.Image()
  image.onload = () => {
    resetCrop()
    imageReady.value = true
    void nextTick(drawPreview)
  }
  image.onerror = () => {
    errorMessage.value = '图片读取失败，请换一张图片'
    imageReady.value = false
    revokeObjectUrl()
  }
  image.src = objectUrl
}

function resetCrop() {
  scale.value = 1
  offsetX.value = 0
  offsetY.value = 0
  drawPreview()
}

function drawPreview() {
  const canvas = canvasRef.value
  if (!canvas) return

  canvas.width = cropSize
  canvas.height = cropSize
  const context = canvas.getContext('2d')
  if (!context) return

  context.clearRect(0, 0, cropSize, cropSize)
  context.fillStyle = '#101820'
  context.fillRect(0, 0, cropSize, cropSize)

  if (!image || !imageReady.value) {
    context.fillStyle = '#8b949f'
    context.font = '15px "PingFang SC", "Microsoft YaHei", sans-serif'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText('选择图片后裁剪头像', cropSize / 2, cropSize / 2)
    return
  }

  const baseScale = Math.max(cropSize / image.naturalWidth, cropSize / image.naturalHeight)
  const drawScale = baseScale * scale.value
  const width = image.naturalWidth * drawScale
  const height = image.naturalHeight * drawScale
  const left = (cropSize - width) / 2 + offsetX.value
  const top = (cropSize - height) / 2 + offsetY.value

  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, left, top, width, height)
  context.strokeStyle = 'rgba(255, 255, 255, 0.92)'
  context.lineWidth = 2
  context.strokeRect(1, 1, cropSize - 2, cropSize - 2)
}

function startDrag(event: PointerEvent) {
  if (!imageReady.value || event.button !== 0) return
  dragState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originX: offsetX.value,
    originY: offsetY.value
  }
  canvasRef.value?.setPointerCapture(event.pointerId)
  event.preventDefault()
}

function moveDrag(event: PointerEvent) {
  if (!dragState || event.pointerId !== dragState.pointerId) return
  offsetX.value = dragState.originX + event.clientX - dragState.startX
  offsetY.value = dragState.originY + event.clientY - dragState.startY
  drawPreview()
}

function stopDrag(event: PointerEvent) {
  if (!dragState || event.pointerId !== dragState.pointerId) return
  canvasRef.value?.releasePointerCapture(event.pointerId)
  dragState = null
}

function createAvatarFile() {
  const source = image
  if (!source || !imageReady.value) {
    throw new Error('请先选择头像图片')
  }

  const output = document.createElement('canvas')
  output.width = outputSize
  output.height = outputSize
  const context = output.getContext('2d')
  if (!context) {
    throw new Error('当前浏览器不支持头像裁剪')
  }

  const factor = outputSize / cropSize
  const baseScale = Math.max(cropSize / source.naturalWidth, cropSize / source.naturalHeight)
  const drawScale = baseScale * scale.value * factor
  const width = source.naturalWidth * drawScale
  const height = source.naturalHeight * drawScale
  const left = ((cropSize - source.naturalWidth * baseScale * scale.value) / 2 + offsetX.value) * factor
  const top = ((cropSize - source.naturalHeight * baseScale * scale.value) / 2 + offsetY.value) * factor

  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, outputSize, outputSize)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(source, left, top, width, height)

  return new Promise<File>((resolve, reject) => {
    output.toBlob((blob) => {
      if (!blob) {
        reject(new Error('头像裁剪失败，请重试'))
        return
      }
      resolve(new File([blob], 'avatar.png', { type: 'image/png' }))
    }, 'image/png', 0.92)
  })
}

async function submitAvatar() {
  if (props.saving) return
  try {
    errorMessage.value = ''
    emit('save', await createAvatarFile())
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '头像裁剪失败'
  }
}

watch(scale, () => drawPreview())

onMounted(() => {
  drawPreview()
})

onBeforeUnmount(() => {
  revokeObjectUrl()
})
</script>

<template>
  <div class="avatar-crop-overlay" @click.self="emit('close')">
    <section class="avatar-crop-dialog" role="dialog" aria-modal="true" aria-label="修改头像">
      <header>
        <div>
          <h3>修改头像</h3>
          <p>{{ selectedName || '上传图片后拖动裁剪区域' }}</p>
        </div>
        <button type="button" aria-label="关闭" @click="emit('close')">
          <X :size="18" />
        </button>
      </header>

      <div class="avatar-crop-body">
        <canvas
          ref="canvasRef"
          class="avatar-crop-canvas"
          width="320"
          height="320"
          @pointerdown="startDrag"
          @pointermove="moveDrag"
          @pointerup="stopDrag"
          @pointercancel="stopDrag"
        ></canvas>
        <div class="avatar-crop-controls">
          <button type="button" @click="pickFile">
            <ImagePlus :size="17" />
            <span>选择图片</span>
          </button>
          <button type="button" :disabled="!imageReady" @click="resetCrop">
            <RotateCcw :size="16" />
            <span>重置</span>
          </button>
          <label>
            <span>缩放</span>
            <input v-model.number="scale" type="range" min="1" max="3" step="0.01" :disabled="!imageReady" />
          </label>
        </div>
        <p v-if="errorMessage" class="avatar-crop-error">{{ errorMessage }}</p>
      </div>

      <footer>
        <button type="button" @click="emit('close')">取消</button>
        <button type="button" class="primary" :disabled="saving || !imageReady" @click="submitAvatar">
          {{ saving ? '保存中...' : '保存头像' }}
        </button>
      </footer>

      <input ref="fileInputRef" type="file" accept="image/*" @change="onFileChange" />
    </section>
  </div>
</template>

<style scoped>
.avatar-crop-overlay {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(15, 23, 32, 0.54);
}

.avatar-crop-dialog {
  width: min(480px, 100%);
  max-height: min(720px, calc(100vh - 48px));
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  color: var(--text);
  box-shadow: var(--shadow);
}

.avatar-crop-dialog header,
.avatar-crop-dialog footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px;
  border-bottom: 1px solid var(--line);
}

.avatar-crop-dialog footer {
  justify-content: flex-end;
  border-top: 1px solid var(--line);
  border-bottom: 0;
}

.avatar-crop-dialog h3,
.avatar-crop-dialog p {
  margin: 0;
}

.avatar-crop-dialog h3 {
  font-size: 18px;
  line-height: 1.3;
}

.avatar-crop-dialog header p {
  margin-top: 4px;
  color: var(--muted);
  font-size: 13px;
}

.avatar-crop-dialog button {
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--panel);
  color: var(--text);
}

.avatar-crop-dialog header button {
  width: 36px;
  flex: 0 0 auto;
}

.avatar-crop-dialog button.primary {
  min-width: 92px;
  border-color: var(--green);
  background: var(--green);
  color: #fff;
}

.avatar-crop-dialog button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.avatar-crop-body {
  min-height: 0;
  display: grid;
  justify-items: center;
  gap: 16px;
  padding: 22px 20px 18px;
  overflow: auto;
}

.avatar-crop-canvas {
  width: 320px;
  height: 320px;
  max-width: min(100%, calc(100vw - 88px));
  aspect-ratio: 1;
  border-radius: 50%;
  background: #101820;
  cursor: grab;
  touch-action: none;
}

.avatar-crop-canvas:active {
  cursor: grabbing;
}

.avatar-crop-controls {
  width: min(360px, 100%);
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.avatar-crop-controls label {
  grid-column: 1 / -1;
  display: grid;
  gap: 7px;
  color: var(--muted);
  font-size: 13px;
}

.avatar-crop-controls input[type="range"] {
  width: 100%;
  accent-color: var(--green);
}

.avatar-crop-error {
  width: min(360px, 100%);
  color: var(--danger);
  font-size: 13px;
  line-height: 1.5;
}

.avatar-crop-dialog > input {
  display: none;
}

:global(:root[data-web-theme="dark"]) .avatar-crop-overlay {
  background: rgba(0, 0, 0, 0.62);
}
</style>

let audioContext: AudioContext | null = null
let originalSound: HTMLAudioElement | null = null
let originalSoundUnavailable = false

const ORIGINAL_SOUND_URL = '/sounds/wechat-message.mp3'

function getAudioContext() {
  if (audioContext && audioContext.state !== 'closed') {
    return audioContext
  }

  const AudioContextClass =
    window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextClass) return null

  audioContext = new AudioContextClass()
  return audioContext
}

export function playNotificationSound() {
  void playOriginalNotificationSound().then((played) => {
    if (!played) {
      playSyntheticNotificationSound()
    }
  })
}

export function installNotificationSoundUnlock() {
  const unlock = () => {
    primeNotificationSound()
    cleanup()
  }
  const cleanup = () => {
    window.removeEventListener('pointerdown', unlock)
    window.removeEventListener('keydown', unlock)
    window.removeEventListener('touchstart', unlock)
  }

  window.addEventListener('pointerdown', unlock, { passive: true })
  window.addEventListener('keydown', unlock)
  window.addEventListener('touchstart', unlock, { passive: true })

  return cleanup
}

export function primeNotificationSound() {
  const sound = getOriginalSound()
  if (sound) {
    sound.preload = 'auto'
    sound.load()
  }

  const context = getAudioContext()
  if (context?.state === 'suspended') {
    void context.resume().catch(() => {
      // 用户代理可能仍要求下一次手势；消息到达时再尝试播放。
    })
  }
}

async function playOriginalNotificationSound() {
  if (originalSoundUnavailable) return false

  const sound = getOriginalSound()
  if (!sound) return false

  sound.currentTime = 0
  try {
    await sound.play()
    return true
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotSupportedError') {
      originalSoundUnavailable = true
    }
    return false
  }
}

function getOriginalSound() {
  if (originalSoundUnavailable) return null

  originalSound ??= new Audio(ORIGINAL_SOUND_URL)
  return originalSound
}

function playSyntheticNotificationSound() {
  if (!('AudioContext' in window) && !('webkitAudioContext' in window)) return

  try {
    const context = getAudioContext()
    if (!context) return

    void context.resume().then(() => {
      const startedAt = context.currentTime
      playChimeTone(context, startedAt, 1567.98, 0.08, 0.09)
      playChimeTone(context, startedAt + 0.085, 1174.66, 0.13, 0.12)
    })
  } catch {
    // 浏览器可能因为自动播放策略拦截声音，不能影响消息收发。
  }
}

function playChimeTone(
  context: AudioContext,
  startedAt: number,
  frequency: number,
  duration: number,
  peakGain: number
) {
  const oscillator = context.createOscillator()
  const overtone = context.createOscillator()
  const gain = context.createGain()
  const overtoneGain = context.createGain()

  oscillator.type = 'sine'
  overtone.type = 'triangle'
  oscillator.frequency.setValueAtTime(frequency, startedAt)
  overtone.frequency.setValueAtTime(frequency * 2, startedAt)
  oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.992, startedAt + duration)
  overtone.frequency.exponentialRampToValueAtTime(frequency * 1.985, startedAt + duration)
  gain.gain.setValueAtTime(0.001, startedAt)
  gain.gain.exponentialRampToValueAtTime(peakGain, startedAt + 0.008)
  gain.gain.exponentialRampToValueAtTime(0.001, startedAt + duration)
  overtoneGain.gain.setValueAtTime(0.001, startedAt)
  overtoneGain.gain.exponentialRampToValueAtTime(peakGain * 0.18, startedAt + 0.006)
  overtoneGain.gain.exponentialRampToValueAtTime(0.001, startedAt + duration * 0.72)

  oscillator.connect(gain)
  overtone.connect(overtoneGain)
  gain.connect(context.destination)
  overtoneGain.connect(context.destination)
  oscillator.start(startedAt)
  overtone.start(startedAt)
  oscillator.stop(startedAt + duration + 0.015)
  overtone.stop(startedAt + duration + 0.005)
  oscillator.addEventListener('ended', () => {
    oscillator.disconnect()
    gain.disconnect()
  })
  overtone.addEventListener('ended', () => {
    overtone.disconnect()
    overtoneGain.disconnect()
  })
}

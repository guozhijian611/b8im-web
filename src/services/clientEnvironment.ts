export interface WebClientEnvironment {
  unsupported: boolean
  reason: 'mobile_user_agent' | 'touch_small_viewport' | ''
}

const MOBILE_USER_AGENT_PATTERN =
  /Android|iPhone|iPad|iPod|Mobile|Mobi|Windows Phone|BlackBerry|Opera Mini|IEMobile|webOS|WAP|MicroMessenger/i

export function detectWebClientEnvironment(win: Window = window): WebClientEnvironment {
  const ua = win.navigator.userAgent || ''
  const likelyIpadDesktopMode = /Macintosh/i.test(ua) && win.navigator.maxTouchPoints > 1
  if (MOBILE_USER_AGENT_PATTERN.test(ua) || likelyIpadDesktopMode) {
    return {
      unsupported: true,
      reason: 'mobile_user_agent'
    }
  }

  const coarsePointer = win.matchMedia?.('(pointer: coarse)').matches ?? false
  const smallViewport = Math.min(win.innerWidth, win.innerHeight) < 900
  if (coarsePointer && smallViewport) {
    return {
      unsupported: true,
      reason: 'touch_small_viewport'
    }
  }

  return {
    unsupported: false,
    reason: ''
  }
}

let baseTitle = 'b8im'
let unreadCount = 0
let noticeText = ''
let scrollIndex = 0
let scrollTimer = 0

const SCROLL_INTERVAL_MS = 450
const NOTICE_GAP = '    '

function normalizeTitle(value: string) {
  return value.trim() || 'b8im'
}

function normalizeNotice(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 48) || '收到新消息'
}

function unreadPrefix() {
  return unreadCount > 0 ? `(${unreadCount}) ` : ''
}

function defaultTitle() {
  return `${unreadPrefix()}${baseTitle}`
}

function setTitle(value: string) {
  document.title = value
}

function renderDefaultTitle() {
  setTitle(defaultTitle())
}

function renderScrollingTitle() {
  if (!noticeText || unreadCount <= 0) {
    stopTitleScroll()
    return
  }

  const source = `${noticeText}${NOTICE_GAP}`
  const index = scrollIndex % source.length
  const rotated = `${source.slice(index)}${source.slice(0, index)}`
  scrollIndex += 1
  setTitle(`${unreadPrefix()}${rotated} - ${baseTitle}`)
}

function startTitleScroll() {
  window.clearInterval(scrollTimer)
  renderScrollingTitle()
  scrollTimer = window.setInterval(renderScrollingTitle, SCROLL_INTERVAL_MS)
}

export function setTitleNotifierBaseTitle(title: string) {
  baseTitle = normalizeTitle(title)
  renderDefaultTitle()
}

export function setTitleNotifierUnreadCount(count: number) {
  unreadCount = Math.max(0, Math.floor(Number(count) || 0))
  if (unreadCount <= 0) {
    stopTitleScroll()
    return
  }

  if (scrollTimer > 0) {
    renderScrollingTitle()
    return
  }

  if (noticeText && !document.hasFocus()) {
    startTitleScroll()
    return
  }

  renderDefaultTitle()
}

export function notifyTitleIncomingMessage(conversationTitle: string, messagePreview: string) {
  if (document.hasFocus()) {
    renderDefaultTitle()
    return
  }

  noticeText = normalizeNotice(`${conversationTitle}：${messagePreview}`)
  scrollIndex = 0
  if (unreadCount <= 0) {
    return
  }

  startTitleScroll()
}

export function stopTitleScroll() {
  window.clearInterval(scrollTimer)
  scrollTimer = 0
  noticeText = ''
  scrollIndex = 0
  renderDefaultTitle()
}

if (typeof window !== 'undefined') {
  window.addEventListener('focus', stopTitleScroll)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      stopTitleScroll()
    }
  })
}

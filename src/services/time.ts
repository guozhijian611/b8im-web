const TIME_WITH_ZONE_RE = /(?:z|[+-]\d{2}:?\d{2})$/i

export function parseImTimestamp(value?: string) {
  if (!value) return new Date()

  const normalized = value.trim()
  if (!normalized) return new Date()

  const isoValue = normalized.includes('T') ? normalized : normalized.replace(' ', 'T')
  const date = new Date(TIME_WITH_ZONE_RE.test(isoValue) ? isoValue : `${isoValue}Z`)

  return Number.isNaN(date.getTime()) ? new Date(normalized) : date
}

export function formatImTime(value?: string) {
  const date = value ? parseImTimestamp(value) : new Date()

  if (Number.isNaN(date.getTime())) return value || ''

  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

export function formatImMessageTime(value?: string) {
  const date = value ? parseImTimestamp(value) : new Date()
  if (Number.isNaN(date.getTime())) return value || ''

  const now = new Date()
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

  if (isToday) {
    return time
  }

  const dateText = date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).replace(/\//g, '-')

  return `${dateText} ${time}`
}

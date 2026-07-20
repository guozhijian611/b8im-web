const POSITIVE_ORGANIZATION = /^[1-9][0-9]*$/

export function normalizeImOrganization(value: unknown): string {
  const organization = String(value ?? '').trim()
  return POSITIVE_ORGANIZATION.test(organization) ? organization : ''
}

export function imIdentityKey(organization: unknown, userId: unknown): string {
  const normalizedOrganization = normalizeImOrganization(organization)
  const normalizedUserId = typeof userId === 'string' ? userId.trim() : ''
  if (!normalizedOrganization || !normalizedUserId) return ''
  return `${normalizedOrganization}:${normalizedUserId}`
}

export function isSameImIdentity(
  leftOrganization: unknown,
  leftUserId: unknown,
  rightOrganization: unknown,
  rightUserId: unknown
): boolean {
  const left = imIdentityKey(leftOrganization, leftUserId)
  return left !== '' && left === imIdentityKey(rightOrganization, rightUserId)
}

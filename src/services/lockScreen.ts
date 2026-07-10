import type { LockScreenSettings, WebImSession } from '../types'

interface LockCredential {
  version: 1
  salt: string
  passwordHash: string
  updatedAt: string
}

const LOCK_CREDENTIAL_PREFIX = 'b8im_web_lock_credential'
const LOCK_STATE_PREFIX = 'b8im_web_lock_state'
const encoder = new TextEncoder()

function getSessionUserKey(session: WebImSession) {
  const userKey = session.user.userId || session.user.account || session.user.id || 'user'
  return `${encodeURIComponent(session.deploymentId)}:${encodeURIComponent(session.organization)}:${encodeURIComponent(userKey)}`
}

function getCredentialStorageKey(session: WebImSession) {
  return `${LOCK_CREDENTIAL_PREFIX}:${getSessionUserKey(session)}`
}

function getStateStorageKey(session: WebImSession) {
  return `${LOCK_STATE_PREFIX}:${getSessionUserKey(session)}`
}

function bytesToHex(bytes: ArrayBuffer | Uint8Array) {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

function createSalt() {
  const bytes = new Uint8Array(16)
  window.crypto.getRandomValues(bytes)
  return bytesToHex(bytes)
}

async function digestPassword(password: string, salt: string) {
  if (!window.crypto?.subtle) {
    throw new Error('当前浏览器不支持锁屏密码')
  }

  const digest = await window.crypto.subtle.digest('SHA-256', encoder.encode(`${salt}:${password}`))
  return bytesToHex(digest)
}

export function loadLockCredential(session: WebImSession): LockCredential | null {
  const raw = window.localStorage.getItem(getCredentialStorageKey(session))
  if (!raw) return null

  try {
    const credential = JSON.parse(raw) as Partial<LockCredential>
    if (
      credential.version !== 1 ||
      !credential.salt ||
      !credential.passwordHash ||
      typeof credential.updatedAt !== 'string'
    ) {
      return null
    }
    return credential as LockCredential
  } catch {
    return null
  }
}

export function loadLockScreenState(session: WebImSession): LockScreenSettings {
  const hasPassword = Boolean(loadLockCredential(session))
  const locked = hasPassword && window.sessionStorage.getItem(getStateStorageKey(session)) === 'locked'
  return { hasPassword, locked }
}

export async function saveLockPassword(session: WebImSession, password: string) {
  const salt = createSalt()
  const credential: LockCredential = {
    version: 1,
    salt,
    passwordHash: await digestPassword(password, salt),
    updatedAt: new Date().toISOString()
  }
  window.localStorage.setItem(getCredentialStorageKey(session), JSON.stringify(credential))
}

export async function verifyLockPassword(session: WebImSession, password: string) {
  const credential = loadLockCredential(session)
  if (!credential) return false
  return (await digestPassword(password, credential.salt)) === credential.passwordHash
}

export function clearLockPassword(session: WebImSession) {
  window.localStorage.removeItem(getCredentialStorageKey(session))
  setLockScreenLocked(session, false)
}

export function setLockScreenLocked(session: WebImSession, locked: boolean) {
  const key = getStateStorageKey(session)
  if (locked) {
    window.sessionStorage.setItem(key, 'locked')
  } else {
    window.sessionStorage.removeItem(key)
  }
}

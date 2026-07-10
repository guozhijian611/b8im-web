import type {
  AvatarMember,
  Contact,
  FriendRequest,
  ImConversation,
  ImPacketMessage,
  ImTokenInfo,
  GroupMember,
  MessageGroup,
  UploadedAsset,
  WebImSession,
  WebImUser
} from '../types'
import { requestWebApi, requestWebApiWithUpload } from './apiClient'
import type { TenantBrandConfig } from './tenantConfig'
import { formatImTime } from './time'

interface WebImUserPayload {
  id?: string | number
  user_id?: string
  account?: string
  nickname?: string
  signature?: string
  avatar?: string
  mobile?: string
  im_short_no?: string
  gender?: number
  status?: number
  status_text?: string
  remark?: string
  login_time?: string
  relation_status?: WebImUser['relationStatus']
  is_system?: boolean | number
  system_code?: string
}

interface WebImLoginPayload {
  organization?: string | number
  deployment_id?: string
  token: {
    expires_in?: number
    access_token?: string
    refresh_token?: string
  }
  im_token?: ImTokenPayload
  user: WebImUserPayload
}

interface ImTokenPayload {
  token?: string
  expire_at?: number
  device_id?: string
}

type UploadProgressHandler = (progress: number) => void

interface ConversationPayload {
  conversation_id?: string
  conversation_sort_id?: number | string
  conversation_type?: number
  title?: string
  avatar?: string
  description?: string
  avatar_members?: WebImUserPayload[]
  peer_user?: WebImUserPayload | null
  last_message_id?: string
  last_message_seq?: number | string
  last_message_index_id?: number | string
  last_message_summary?: string
  last_message_time?: string
  sort_time?: string
  unread_count?: number
  is_pinned?: boolean | number
  is_muted?: boolean | number
  message_group_id?: number | string
  message_group_name?: string
}

interface MessageGroupPayload {
  id: number | string
  name: string
  sort?: number
}

interface GroupMemberPayload {
  user: WebImUserPayload
  role: number
  status: number
  mute_until?: string
  join_time: string
}

interface UpdateGroupProfilePayload extends ConversationPayload {
  notice_message?: ImPacketMessage | null
}

interface UploadedAssetPayload {
  kind: UploadedAsset['kind']
  name: string
  url: string
  size: number
  mime_type: string
  extension: string
}

interface PrepareUploadPayload {
  mode: 'direct' | 'proxy'
  provider?: 's3' | 'cos'
  method?: 'PUT' | 'POST'
  upload_url: string
  headers?: Record<string, string>
  object_key?: string
  public_url?: string
  filename?: string
  size?: number
  mime_type?: string
  extension?: string
  expires_at?: number
}

export interface MessageConfig {
  deleteSingleEnabled: boolean
  deleteBothEnabled: boolean
}

interface MessageConfigPayload {
  delete_single_enabled?: boolean | number
  delete_both_enabled?: boolean | number
}

interface FriendRequestPayload {
  id: number
  direction: 'incoming' | 'outgoing'
  message: string
  status: number
  status_text: string
  create_time: string
  handle_time: string
  from_user: WebImUserPayload | null
  to_user: WebImUserPayload | null
}

const WINDOW_STORAGE_KEY = 'b8im_web_window_session'
const LOCAL_RESOURCE_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

const firstText = (value: string) => (value.trim().slice(0, 1) || '用').toUpperCase()

const createRuntimeDeviceId = () => {
  const randomValue =
    typeof window.crypto?.randomUUID === 'function'
      ? window.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`

  return `web-${randomValue.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)}`
}

const runtimeDeviceId = createRuntimeDeviceId()

const mapImToken = (payload?: ImTokenPayload): ImTokenInfo => ({
  token: String(payload?.token ?? ''),
  expireAt: Number(payload?.expire_at ?? 0),
  deviceId: String(payload?.device_id ?? '')
})

function decodeJwtPayload(token: string): Record<string, unknown> {
  const encoded = token.split('.')[1]
  if (!encoded) throw new Error('凭证格式无效')
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
}

function assertJwtContext(
  token: string,
  config: TenantBrandConfig,
  audience: 'web-api' | 'im',
  deviceId = ''
) {
  const payload = decodeJwtPayload(token)
  const audiences = Array.isArray(payload.aud) ? payload.aud.map(String) : [String(payload.aud ?? '')]
  const expiresAt = Number(payload.exp ?? 0)
  if (
    String(payload.organization ?? '') !== config.organization ||
    String(payload.iss ?? '') !== config.deploymentId ||
    String(payload.deployment_id ?? '') !== config.deploymentId ||
    !audiences.includes(audience) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Math.floor(Date.now() / 1000)
  ) {
    throw new Error(`${audience} 凭证与当前部署或机构不一致`)
  }
  if (deviceId && String(payload.device_id ?? '') !== deviceId) {
    throw new Error('IM 凭证设备与当前窗口不一致')
  }

  return expiresAt
}

function assertResourceUrl(value: string, base?: string) {
  if (!value.trim()) throw new Error('资源地址为空')
  const url = new URL(value, base)
  const local = LOCAL_RESOURCE_HOSTS.has(url.hostname.toLowerCase())
  if (
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
  ) {
    throw new Error('资源地址不符合安全要求')
  }
  return url.toString()
}

export function getWebDeviceId() {
  return runtimeDeviceId
}

function normalizeWindowSession(session: WebImSession): WebImSession {
  const deviceId = getWebDeviceId()
  if (session.imToken?.deviceId === deviceId) {
    return session
  }

  return {
    ...session,
    imToken: {
      token: '',
      expireAt: 0,
      deviceId
    }
  }
}

function isValidSession(session: WebImSession, config: TenantBrandConfig) {
  return Boolean(
    session.accessToken &&
    session.organization === config.organization &&
    session.deploymentId === config.deploymentId &&
    session.apiServerUrl === config.serverInfo.apiServerUrl &&
    session.imServerUrl === config.serverInfo.imServerUrl
  )
}

export function mapWebImUser(payload: WebImUserPayload): WebImUser {
  return {
    id: String(payload.id ?? ''),
    userId: String(payload.user_id ?? ''),
    account: String(payload.account ?? ''),
    nickname: String(payload.nickname ?? payload.account ?? '未命名用户'),
    signature: String(payload.signature ?? ''),
    avatarUrl: String(payload.avatar ?? ''),
    mobile: String(payload.mobile ?? ''),
    imShortNo: String(payload.im_short_no ?? ''),
    gender: Number(payload.gender ?? 0),
    status: Number(payload.status ?? 1),
    statusText: String(payload.status_text ?? '正常'),
    remark: String(payload.remark ?? ''),
    loginTime: String(payload.login_time ?? ''),
    relationStatus: payload.relation_status ?? 'none',
    isSystem: payload.is_system === true || Number(payload.is_system ?? 2) === 1,
    systemCode: String(payload.system_code ?? '')
  }
}

export function mapContact(payload: WebImUserPayload): Contact {
  const user = mapWebImUser(payload)
  return {
    id: user.id,
    userId: user.userId,
    account: user.account,
    name: user.nickname,
    avatar: firstText(user.nickname || user.account),
    avatarUrl: user.avatarUrl,
    title: user.signature || user.account || user.imShortNo || 'IM 用户',
    status: user.statusText,
    online: false,
    mobile: user.mobile,
    imShortNo: user.imShortNo,
    signature: user.signature,
    remark: user.remark,
    isSystem: user.isSystem,
    systemCode: user.systemCode
  }
}

const mapFriendRequest = (payload: FriendRequestPayload): FriendRequest => {
  return {
    id: payload.id,
    direction: payload.direction,
    message: payload.message,
    status: payload.status,
    statusText: payload.status_text,
    createTime: payload.create_time,
    handleTime: payload.handle_time,
    fromUser: payload.from_user ? mapWebImUser(payload.from_user) : null,
    toUser: payload.to_user ? mapWebImUser(payload.to_user) : null
  }
}

export async function loginWebIm(
  config: TenantBrandConfig,
  payload: { account: string; password: string }
): Promise<WebImSession> {
  const data = await requestWebApi<WebImLoginPayload>(config, '/saimulti/web/im/login', {
    method: 'POST',
    body: {
      account: payload.account,
      password: payload.password,
      platform: 'web',
      device_id: getWebDeviceId()
    }
  })

  if (String(data.organization ?? '') !== config.organization) {
    throw new Error('登录响应的 organization 与发现上下文不一致')
  }
  if (data.deployment_id !== config.deploymentId) {
    throw new Error('登录响应的 deployment_id 与发现上下文不一致')
  }

  const accessToken = String(data.token.access_token ?? '')
  if (!accessToken) throw new Error('登录响应缺少 access token')
  assertJwtContext(accessToken, config, 'web-api')
  const imToken = mapImToken(data.im_token)
  if (imToken.token) {
    imToken.expireAt = assertJwtContext(imToken.token, config, 'im', getWebDeviceId())
  }

  return normalizeWindowSession({
    accessToken,
    refreshToken: data.token.refresh_token || '',
    expiresIn: Number(data.token.expires_in ?? 0),
    organization: config.organization,
    deploymentId: config.deploymentId,
    apiServerUrl: config.serverInfo.apiServerUrl,
    imServerUrl: config.serverInfo.imServerUrl,
    imToken,
    user: mapWebImUser(data.user)
  })
}

export async function refreshImToken(
  config: TenantBrandConfig,
  session: WebImSession
): Promise<ImTokenInfo> {
  const data = await requestWebApi<ImTokenPayload>(config, '/saimulti/web/im/imToken', {
    method: 'POST',
    token: session.accessToken,
    body: { device_id: getWebDeviceId() }
  })

  const token = mapImToken(data)
  if (!token.token) throw new Error('IM 凭证响应无效')
  token.expireAt = assertJwtContext(token.token, config, 'im', getWebDeviceId())
  return token
}

export async function fetchCurrentWebUser(
  config: TenantBrandConfig,
  session: WebImSession
): Promise<WebImUser> {
  const data = await requestWebApi<WebImUserPayload>(config, '/saimulti/web/im/me', {
    token: session.accessToken
  })

  return mapWebImUser(data)
}

export async function updateWebAvatar(
  config: TenantBrandConfig,
  session: WebImSession,
  avatar: string
): Promise<WebImUser> {
  const data = await requestWebApi<WebImUserPayload>(config, '/saimulti/web/im/updateAvatar', {
    method: 'POST',
    token: session.accessToken,
    body: { avatar }
  })

  return mapWebImUser(data)
}

export async function fetchConversations(
  config: TenantBrandConfig,
  session: WebImSession
): Promise<ImConversation[]> {
  const data = await requestWebApi<ConversationPayload[]>(config, '/saimulti/web/im/conversations', {
    token: session.accessToken
  })

  return data.map((item) => mapConversation(item))
}

export async function fetchMessageGroups(
  config: TenantBrandConfig,
  session: WebImSession
): Promise<MessageGroup[]> {
  const data = await requestWebApi<MessageGroupPayload[]>(config, '/saimulti/web/im/messageGroups', {
    token: session.accessToken
  })

  return data.map(mapMessageGroup)
}

export async function createMessageGroup(
  config: TenantBrandConfig,
  session: WebImSession,
  name: string
): Promise<MessageGroup> {
  const data = await requestWebApi<MessageGroupPayload>(config, '/saimulti/web/im/createMessageGroup', {
    method: 'POST',
    token: session.accessToken,
    body: { name }
  })

  return mapMessageGroup(data)
}

export async function updateConversationGroup(
  config: TenantBrandConfig,
  session: WebImSession,
  payload: { conversationId: string; messageGroupId: number }
) {
  return requestWebApi<{ conversation_id: string; message_group_id: number; message_group_name: string }>(
    config,
    '/saimulti/web/im/updateConversationGroup',
    {
      method: 'POST',
      token: session.accessToken,
      body: {
        conversation_id: payload.conversationId,
        message_group_id: payload.messageGroupId
      }
    }
  )
}

export async function fetchMessageConfig(
  config: TenantBrandConfig,
  session: WebImSession
): Promise<MessageConfig> {
  const data = await requestWebApi<MessageConfigPayload>(config, '/saimulti/web/im/messageConfig', {
    token: session.accessToken
  })

  return {
    deleteSingleEnabled: data.delete_single_enabled === true || Number(data.delete_single_enabled ?? 0) === 1,
    deleteBothEnabled: data.delete_both_enabled === true || Number(data.delete_both_enabled ?? 0) === 1
  }
}

export async function fetchMessages(
  config: TenantBrandConfig,
  session: WebImSession,
  params: { conversationId?: string; peerUserId?: string; afterSeq?: number; beforeSeq?: number; limit?: number }
) {
  return requestWebApi<{
    messages: ImPacketMessage[]
    next_after_seq: number
    next_before_seq: number
    has_more_before?: boolean
  }>(
    config,
    '/saimulti/web/im/messages',
    {
      token: session.accessToken,
      query: {
        conversation_id: params.conversationId,
        peer_user_id: params.peerUserId,
        after_seq: params.afterSeq ?? 0,
        before_seq: params.beforeSeq ?? 0,
        limit: params.limit ?? 50
      }
    }
  )
}

export async function markConversationRead(
  config: TenantBrandConfig,
  session: WebImSession,
  params: { conversationId?: string; all?: boolean }
) {
  return requestWebApi<{ updated: number }>(config, '/saimulti/web/im/markRead', {
    method: 'POST',
    token: session.accessToken,
    body: {
      conversation_id: params.conversationId,
      all: params.all ?? false
    }
  })
}

export function mapConversation(payload: ConversationPayload): ImConversation {
  const type = Number(payload.conversation_type ?? 1) === 2 ? 'group' : 'single'
  const peerUser = payload.peer_user ? mapWebImUser(payload.peer_user) : null
  const title = String(payload.title || peerUser?.nickname || (type === 'group' ? '群聊' : '单聊'))
  const lastMessageTime = String(payload.last_message_time ?? '')
  const sortTime = String(payload.sort_time || payload.last_message_time || '')

  return {
    id: String(payload.conversation_id ?? ''),
    conversationId: String(payload.conversation_id ?? ''),
    conversationSortId: Number(payload.conversation_sort_id ?? 0),
    conversationType: type,
    title,
    avatar: type === 'group' ? String(payload.avatar ?? '') : String(payload.avatar || firstText(title)),
    description: type === 'group' ? String(payload.description ?? '') : '',
    avatarMembers: Array.isArray(payload.avatar_members)
      ? payload.avatar_members.map(mapAvatarMember)
      : [],
    peerUserId: peerUser?.userId ?? '',
    peerUser,
    preview: normalizeConversationPreview(String(payload.last_message_summary ?? '')),
    time: formatConversationTime(lastMessageTime),
    lastMessageId: String(payload.last_message_id ?? ''),
    lastMessageSeq: Number(payload.last_message_seq ?? 0),
    lastMessageIndexId: Number(payload.last_message_index_id ?? 0),
    lastMessageTime,
    sortTime,
    localSortOrder: 0,
    unread: Number(payload.unread_count ?? 0),
    virtual: false,
    isPinned: payload.is_pinned === true || Number(payload.is_pinned ?? 2) === 1,
    isMuted: payload.is_muted === true || Number(payload.is_muted ?? 2) === 1,
    messageGroupId: Number(payload.message_group_id ?? 0),
    messageGroupName: String(payload.message_group_name ?? '')
  }
}

function mapAvatarMember(payload: WebImUserPayload): AvatarMember {
  return {
    userId: String(payload.user_id ?? ''),
    nickname: String(payload.nickname ?? payload.account ?? ''),
    account: String(payload.account ?? ''),
    avatarUrl: String(payload.avatar ?? '')
  }
}

function mapMessageGroup(payload: MessageGroupPayload): MessageGroup {
  return {
    id: Number(payload.id ?? 0),
    name: String(payload.name ?? ''),
    sort: Number(payload.sort ?? 0)
  }
}

export function normalizeConversationPreview(value: string) {
  const text = value.trim()
  if (!text) return '暂无消息'
  if (text.includes('【合并转发的聊天记录】')) return '合并转发的聊天记录'
  if (text.startsWith('合并转发的聊天记录')) return '合并转发的聊天记录'
  return text
}

export function createVirtualConversation(contact: Contact): ImConversation {
  return {
    id: `friend:${contact.userId}`,
    conversationId: '',
    conversationSortId: 0,
    conversationType: 'single',
    title: contact.name,
    avatar: contact.avatarUrl || contact.avatar,
    description: '',
    avatarMembers: [],
    peerUserId: contact.userId,
    peerUser: {
      id: contact.id,
      userId: contact.userId,
      account: contact.account,
      nickname: contact.name,
      signature: contact.signature,
      avatarUrl: contact.avatarUrl,
      mobile: contact.mobile,
      imShortNo: contact.imShortNo,
      gender: 0,
      status: 1,
      statusText: contact.status,
      remark: contact.remark,
      loginTime: '',
      relationStatus: 'friend',
      isSystem: contact.isSystem,
      systemCode: contact.systemCode
    },
    preview: '开始聊天',
    time: '',
    lastMessageId: '',
    lastMessageSeq: 0,
    lastMessageIndexId: 0,
    lastMessageTime: '',
    sortTime: '',
    localSortOrder: 0,
    unread: 0,
    virtual: true,
    isPinned: false,
    isMuted: false,
    messageGroupId: 0,
    messageGroupName: ''
  }
}

function formatConversationTime(value: string) {
  if (!value) return ''
  return formatImTime(value)
}

export async function fetchContacts(
  config: TenantBrandConfig,
  session: WebImSession,
  keyword = ''
): Promise<Contact[]> {
  const data = await requestWebApi<WebImUserPayload[]>(config, '/saimulti/web/im/contacts', {
    token: session.accessToken,
    query: { keyword }
  })

  return data.map(mapContact)
}

export async function searchUsers(
  config: TenantBrandConfig,
  session: WebImSession,
  keyword: string
): Promise<WebImUser[]> {
  const data = await requestWebApi<WebImUserPayload[]>(config, '/saimulti/web/im/searchUsers', {
    token: session.accessToken,
    query: { keyword }
  })

  return data.map(mapWebImUser)
}

export async function sendFriendRequest(
  config: TenantBrandConfig,
  session: WebImSession,
  userId: string,
  message: string
) {
  return requestWebApi<{ status: string; message: string }>(config, '/saimulti/web/im/sendFriendRequest', {
    method: 'POST',
    token: session.accessToken,
    body: {
      to_user_id: userId,
      message
    }
  })
}

export async function fetchFriendRequests(
  config: TenantBrandConfig,
  session: WebImSession
): Promise<FriendRequest[]> {
  const data = await requestWebApi<FriendRequestPayload[]>(config, '/saimulti/web/im/requests', {
    token: session.accessToken
  })

  return data.map(mapFriendRequest)
}

export async function handleFriendRequest(
  config: TenantBrandConfig,
  session: WebImSession,
  id: number,
  action: 'accept' | 'reject'
) {
  return requestWebApi<{ status: string }>(config, '/saimulti/web/im/handleFriendRequest', {
    method: 'POST',
    token: session.accessToken,
    body: { id, action }
  })
}

export async function createGroupConversation(
  config: TenantBrandConfig,
  session: WebImSession,
  payload: { title: string; memberIds: string[] }
): Promise<ImConversation> {
  const data = await requestWebApi<ConversationPayload>(config, '/saimulti/web/im/createGroup', {
    method: 'POST',
    token: session.accessToken,
    body: {
      title: payload.title,
      member_ids: payload.memberIds
    }
  })

  return mapConversation(data)
}

export async function fetchGroupMembers(
  config: TenantBrandConfig,
  session: WebImSession,
  conversationId: string
): Promise<GroupMember[]> {
  const data = await requestWebApi<GroupMemberPayload[]>(config, '/saimulti/web/im/groupMembers', {
    token: session.accessToken,
    query: { conversation_id: conversationId }
  })

  return data.map((item) => ({
    user: mapWebImUser(item.user),
    role: Number(item.role ?? 1),
    status: Number(item.status ?? 1),
    muteUntil: String(item.mute_until ?? ''),
    joinTime: String(item.join_time ?? '')
  }))
}

export async function addGroupMembers(
  config: TenantBrandConfig,
  session: WebImSession,
  payload: { conversationId: string; memberIds: string[] }
): Promise<GroupMember[]> {
  const data = await requestWebApi<GroupMemberPayload[]>(config, '/saimulti/web/im/addGroupMembers', {
    method: 'POST',
    token: session.accessToken,
    body: {
      conversation_id: payload.conversationId,
      member_ids: payload.memberIds
    }
  })

  return data.map(mapGroupMember)
}

function mapGroupMember(item: GroupMemberPayload): GroupMember {
  return {
    user: mapWebImUser(item.user),
    role: Number(item.role ?? 1),
    status: Number(item.status ?? 1),
    muteUntil: String(item.mute_until ?? ''),
    joinTime: String(item.join_time ?? '')
  }
}

export async function updateConversationSetting(
  config: TenantBrandConfig,
  session: WebImSession,
  payload: { conversationId: string; isPinned?: boolean; isMuted?: boolean }
) {
  return requestWebApi<{ conversation_id: string; is_pinned: boolean; is_muted: boolean }>(
    config,
    '/saimulti/web/im/updateConversationSetting',
    {
      method: 'POST',
      token: session.accessToken,
      body: {
        conversation_id: payload.conversationId,
        is_pinned: payload.isPinned,
        is_muted: payload.isMuted
      }
    }
  )
}

export async function updateGroupProfile(
  config: TenantBrandConfig,
  session: WebImSession,
  payload: { conversationId: string; title?: string; avatar?: string; description?: string; notifyAll?: boolean }
): Promise<{ conversation: ImConversation; noticeMessage: ImPacketMessage | null }> {
  const data = await requestWebApi<UpdateGroupProfilePayload>(config, '/saimulti/web/im/updateGroupProfile', {
    method: 'POST',
    token: session.accessToken,
    body: {
      conversation_id: payload.conversationId,
      title: payload.title,
      avatar: payload.avatar,
      description: payload.description,
      notify_all: payload.notifyAll ?? false
    }
  })

  return {
    conversation: mapConversation(data),
    noticeMessage: data.notice_message ?? null
  }
}

export async function updateGroupManagers(
  config: TenantBrandConfig,
  session: WebImSession,
  payload: { conversationId: string; managerUserIds: string[] }
): Promise<GroupMember[]> {
  const data = await requestWebApi<GroupMemberPayload[]>(config, '/saimulti/web/im/updateGroupManagers', {
    method: 'POST',
    token: session.accessToken,
    body: {
      conversation_id: payload.conversationId,
      manager_user_ids: payload.managerUserIds
    }
  })

  return data.map((item) => ({
    user: mapWebImUser(item.user),
    role: Number(item.role ?? 1),
    status: Number(item.status ?? 1),
    muteUntil: String(item.mute_until ?? ''),
    joinTime: String(item.join_time ?? '')
  }))
}

export async function updateGroupMemberStatus(
  config: TenantBrandConfig,
  session: WebImSession,
  payload: { conversationId: string; memberUserId: string; status: number; muteUntil?: string }
): Promise<GroupMember[]> {
  const data = await requestWebApi<GroupMemberPayload[]>(config, '/saimulti/web/im/updateGroupMemberStatus', {
    method: 'POST',
    token: session.accessToken,
    body: {
      conversation_id: payload.conversationId,
      member_user_id: payload.memberUserId,
      status: payload.status,
      mute_until: payload.muteUntil ?? ''
    }
  })

  return data.map(mapGroupMember)
}

export async function removeGroupMember(
  config: TenantBrandConfig,
  session: WebImSession,
  payload: { conversationId: string; memberUserId: string }
): Promise<GroupMember[]> {
  const data = await requestWebApi<GroupMemberPayload[]>(config, '/saimulti/web/im/removeGroupMember', {
    method: 'POST',
    token: session.accessToken,
    body: {
      conversation_id: payload.conversationId,
      member_user_id: payload.memberUserId
    }
  })

  return data.map(mapGroupMember)
}

export async function updateFriendRemark(
  config: TenantBrandConfig,
  session: WebImSession,
  friendUserId: string,
  remark: string
) {
  return requestWebApi<{ friend_user_id: string; remark: string }>(config, '/saimulti/web/im/updateFriendRemark', {
    method: 'POST',
    token: session.accessToken,
    body: {
      friend_user_id: friendUserId,
      remark
    }
  })
}

export async function searchConversationMessages(
  config: TenantBrandConfig,
  session: WebImSession,
  params: { conversationId: string; keyword: string; messageType?: number; limit?: number }
) {
  return requestWebApi<ImPacketMessage[]>(config, '/saimulti/web/im/searchMessages', {
    token: session.accessToken,
    query: {
      conversation_id: params.conversationId,
      keyword: params.keyword,
      message_type: params.messageType,
      limit: params.limit ?? 50
    }
  })
}

export async function uploadImAsset(
  config: TenantBrandConfig,
  session: WebImSession,
  file: File,
  kind: UploadedAsset['kind'],
  options: { conversationType?: 'single' | 'group'; onProgress?: UploadProgressHandler } = {}
): Promise<UploadedAsset> {
  options.onProgress?.(3)
  const prepared = await requestWebApi<PrepareUploadPayload>(config, '/saimulti/web/im/prepareUpload', {
    method: 'POST',
    token: session.accessToken,
    body: {
      kind,
      filename: file.name,
      size: file.size,
      mime_type: file.type,
      conversation_type: options.conversationType
    }
  })
  options.onProgress?.(8)

  if (prepared.mode === 'direct') {
    if (!prepared.upload_url || !prepared.object_key) {
      throw new Error('直传配置不完整')
    }
    await uploadFileByXhr(prepared.upload_url, file, {
      method: prepared.method ?? 'PUT',
      headers: prepared.headers ?? {},
      onProgress: (progress) => options.onProgress?.(8 + Math.round(progress * 0.84))
    })
    options.onProgress?.(94)

    const confirmed = await requestWebApi<UploadedAssetPayload>(config, '/saimulti/web/im/confirmUpload', {
      method: 'POST',
      token: session.accessToken,
      body: {
        kind,
        filename: file.name,
        object_key: prepared.object_key,
        size: file.size,
        mime_type: file.type,
        extension: prepared.extension
      }
    })

    options.onProgress?.(100)
    return mapUploadedAsset(config, confirmed, file)
  }

  if (prepared.mode === 'proxy') {
    return uploadImAssetByProxy(config, session, file, kind, options.onProgress)
  }

  throw new Error('上传模式无效')
}

async function uploadImAssetByProxy(
  config: TenantBrandConfig,
  session: WebImSession,
  file: File,
  kind: UploadedAsset['kind'],
  onProgress?: UploadProgressHandler
): Promise<UploadedAsset> {
  const form = new FormData()
  form.set('file', file)
  form.set('kind', kind)
  const data = await requestWebApiWithUpload<UploadedAssetPayload>(config, '/saimulti/web/im/upload', {
    token: session.accessToken,
    body: form,
    onProgress
  })

  onProgress?.(100)
  return mapUploadedAsset(config, data, file)
}

function uploadFileByXhr(
  url: string,
  file: File,
  options: { method: string; headers: Record<string, string>; onProgress?: UploadProgressHandler }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const uploadUrl = assertResourceUrl(url)
    const xhr = new XMLHttpRequest()
    xhr.open(options.method, uploadUrl, true)
    Object.entries(options.headers).forEach(([key, value]) => {
      xhr.setRequestHeader(key, value)
    })
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || !options.onProgress) return
      options.onProgress(Math.round((event.loaded / event.total) * 100))
    }
    xhr.onerror = () => reject(new Error('直传失败，请检查网络后重试'))
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`直传失败：${xhr.status}`))
        return
      }
      resolve()
    }
    xhr.send(file)
  })
}

function mapUploadedAsset(config: TenantBrandConfig, data: UploadedAssetPayload, file: File): UploadedAsset {
  const base = config.serverInfo.uploadServerUrl || config.serverInfo.apiServerUrl
  const url = String(data.url ?? '')

  return {
    kind: data.kind,
    name: String(data.name ?? file.name),
    url: assertResourceUrl(url, base),
    size: Number(data.size ?? file.size),
    mimeType: String(data.mime_type ?? file.type),
    extension: String(data.extension ?? '')
  }
}

export function saveWebSession(session: WebImSession) {
  const normalized = normalizeWindowSession(session)
  window.sessionStorage.setItem(WINDOW_STORAGE_KEY, JSON.stringify(normalized))
}

export function loadWebSession(config: TenantBrandConfig): WebImSession | null {
  const raw = window.sessionStorage.getItem(WINDOW_STORAGE_KEY)
  if (!raw) return null

  try {
    const session = JSON.parse(raw) as WebImSession
    if (!isValidSession(session, config)) {
      window.sessionStorage.removeItem(WINDOW_STORAGE_KEY)
      return null
    }
    const normalized = normalizeWindowSession(session)
    window.sessionStorage.setItem(WINDOW_STORAGE_KEY, JSON.stringify(normalized))
    return normalized
  } catch {
    window.sessionStorage.removeItem(WINDOW_STORAGE_KEY)
    return null
  }
}

export function clearWebSession(_session?: WebImSession | null) {
  window.sessionStorage.removeItem(WINDOW_STORAGE_KEY)
}

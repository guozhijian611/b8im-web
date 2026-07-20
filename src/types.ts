import type { Component } from 'vue'

export type ModuleView =
  | 'announcement'
  | 'i18n'
  | 'favorite'
  | 'sticker'
  | 'customer_service'
  | 'robot_single'
  | 'file_media'
  | 'search'
  | 'moments'

export type PrimaryView = 'chats' | 'contacts' | ModuleView

export interface RailItem {
  key: PrimaryView
  label: string
  icon: Component
  badge?: number
}

export interface Conversation {
  id: string
  title: string
  avatar: string
  type: 'single' | 'group'
  preview: string
  time: string
  unread: number
  online?: boolean
  pinned?: boolean
}

export type ImConnectionState = 'idle' | 'connecting' | 'connected' | 'offline' | 'error'

export interface WebImUser {
  id: string
  organization: string
  organizationName: string
  companyName: string
  isCrossOrganization: boolean
  displayName: string
  userId: string
  account: string
  nickname: string
  signature: string
  avatarFileId: string
  avatarUrl: string
  avatarExpiresAt: number
  mobile: string
  imShortNo: string
  gender: number
  status: number
  statusText: string
  remark: string
  loginTime: string
  relationStatus: 'none' | 'friend' | 'pending_in' | 'pending_out'
  isSystem: boolean
  systemCode: string
}

export interface ImMessageSender {
  id?: string | number
  organization?: string | number
  organization_name?: string
  company_name?: string
  is_cross_organization?: boolean | number
  display_name?: string
  user_id?: string
  account?: string
  nickname?: string
  signature?: string
  avatar_file_id?: string
  avatar_url?: string
  avatar_expires_at?: number
  mobile?: string
  im_short_no?: string
  gender?: number
  status?: number
  status_text?: string
  remark?: string
  login_time?: string
  is_system?: boolean | number
  system_code?: string
}

export interface WebImSession {
  accessToken: string
  refreshToken: string
  expiresIn: number
  organization: string
  deploymentId: string
  apiServerUrl: string
  imServerUrl: string
  crossOrgAccessSnapshotId: string
  user: WebImUser
}

export interface WatermarkSettings {
  enabled: boolean
  text: string
  opacity: number
  color: string
}

export interface NotificationSettings {
  browserEnabled: boolean
  soundEnabled: boolean
}

export interface LockScreenSettings {
  hasPassword: boolean
  locked: boolean
}

export type ThemeMode = 'dark' | 'light' | 'system'

export type MessageGroupLayout = 'scroll' | 'wrap'

export interface ImConversation {
  id: string
  conversationId: string
  conversationSortId: number
  conversationType: 'single' | 'group'
  title: string
  avatar: string
  avatarFileId: string
  avatarExpiresAt: number
  description: string
  avatarMembers: AvatarMember[]
  peerOrganization: string
  peerUserId: string
  peerUser?: WebImUser | null
  preview: string
  time: string
  lastMessageId: string
  lastMessageSeq: number
  lastChangeSeq: number
  lastMessageIndexId: number
  lastMessageTime: string
  sortTime: string
  localSortOrder: number
  unread: number
  virtual: boolean
  isPinned: boolean
  isMuted: boolean
  messageGroupId: number
  messageGroupName: string
}

export interface AvatarMember {
  userId: string
  nickname: string
  account: string
  avatarUrl: string
}

export interface MessageGroup {
  id: number
  name: string
  sort: number
}

export interface ImPacketMessage {
  id: number
  organization: string | number
  global_seq?: string | number
  conversation_id: string
  conversation_type: number
  message_id: string
  message_seq: number
  client_msg_id: string
  sender_organization: string | number
  sender_id: string
  sender_user?: ImMessageSender | null
  delivery_status?: 'sent' | 'delivered' | 'read'
  message_type: number
  content: Record<string, unknown>
  status: number
  edit_time?: string
  edit_count?: number
  create_time: string
}

export interface MessageQuote {
  messageId: string
  messageSeq: number
  sender: string
  senderUserId: string
  type: Message['type']
  content: string
}

export interface MessageForwardItem {
  sender: string
  time: string
  type: Message['type']
  content: string
  url?: string
  fileName?: string
  fileSize?: number
  forwardBundle?: MessageForwardBundle | null
}

export interface MessageForwardBundle {
  title: string
  count: number
  items: MessageForwardItem[]
}

export interface MessageMention {
  userId: string
  nickname: string
  account: string
  avatarUrl: string
}

export interface FriendRequest {
  id: number
  direction: 'incoming' | 'outgoing'
  message: string
  status: number
  statusText: string
  createTime: string
  handleTime: string
  fromOrganization: string
  toOrganization: string
  fromUser: WebImUser | null
  toUser: WebImUser | null
}

export interface FriendRequestPushEvent {
  event: 'created'
  requestId: number
  pendingCount: number
  fromUser: WebImUser | null
  message: string
  createTime: string
}

export interface Message {
  id: string
  messageId?: string
  conversationId?: string
  fileId?: string
  sender: string
  avatar: string
  avatarUrl?: string
  side: 'in' | 'out' | 'system'
  type: 'text' | 'image' | 'file' | 'voice' | 'video' | 'notice'
  content: string
  url?: string
  fileName?: string
  fileSize?: number
  messageSeq?: number
  createTime?: string
  localOrder?: number
  time?: string
  state?: 'uploading' | 'sent' | 'delivered' | 'read' | 'failed'
  uploadProgress?: number
  editTime?: string
  editCount?: number
  meta?: string
  senderUserId?: string
  senderOrganization?: string
  quote?: MessageQuote | null
  forwardBundle?: MessageForwardBundle | null
  mentions?: MessageMention[]
}

export interface Contact {
  id: string
  organization: string
  organizationName: string
  companyName: string
  isCrossOrganization: boolean
  userId: string
  account: string
  name: string
  avatar: string
  avatarFileId: string
  avatarUrl: string
  avatarExpiresAt: number
  title: string
  status: string
  online: boolean
  mobile: string
  imShortNo: string
  signature: string
  remark: string
  isSystem: boolean
  systemCode: string
}

export interface SharedFile {
  id: string
  name: string
  type: string
  size: string
  date: string
}

export interface GroupMember {
  user: WebImUser
  role: number
  status: number
  muteUntil: string
  joinTime: string
}

export interface UploadedAsset {
  fileId: string
  kind: 'image' | 'file' | 'voice' | 'video'
  name: string
  url: string
  size: number
  mimeType: string
  extension: string
}

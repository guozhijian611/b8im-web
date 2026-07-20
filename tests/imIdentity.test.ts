import assert from 'node:assert/strict'
import test from 'node:test'
import {
  imIdentityKey,
  isSameImIdentity,
  normalizeImOrganization
} from '../src/services/imIdentity.ts'
import {
  createVirtualConversation,
  mapConversation,
  mapWebImUser
} from '../src/services/webIm.ts'

test('global IM identity always includes organization and user id', () => {
  assert.equal(imIdentityKey(901, 'same-id'), '901:same-id')
  assert.equal(imIdentityKey(902, 'same-id'), '902:same-id')
  assert.equal(isSameImIdentity(901, 'same-id', 902, 'same-id'), false)
  assert.equal(isSameImIdentity('901', 'same-id', 901, 'same-id'), true)
  assert.equal(normalizeImOrganization('0901'), '')
  assert.equal(imIdentityKey(0, 'user'), '')
})

test('cross-organization contact creates a composite virtual conversation', () => {
  const user = mapWebImUser({
    id: 10,
    organization: 902,
    organization_name: '乙机构',
    company_name: '乙公司',
    is_cross_organization: true,
    user_id: 'same-id',
    account: 'peer',
    nickname: '对方'
  })
  const conversation = createVirtualConversation({
    id: user.id,
    organization: user.organization,
    organizationName: user.organizationName,
    companyName: user.companyName,
    isCrossOrganization: user.isCrossOrganization,
    userId: user.userId,
    account: user.account,
    name: user.nickname,
    avatar: '对',
    avatarFileId: '',
    avatarUrl: '',
    avatarExpiresAt: 0,
    title: '',
    status: '正常',
    online: false,
    mobile: '',
    imShortNo: '',
    signature: '',
    remark: '',
    isSystem: false,
    systemCode: ''
  })

  assert.equal(conversation.id, 'friend:902:same-id')
  assert.equal(conversation.peerOrganization, '902')
  assert.equal(conversation.peerUser?.companyName, '乙公司')
})

test('single conversation fails closed without a composite peer user', () => {
  assert.throws(() => mapConversation({
    conversation_id: 'single-invalid',
    conversation_type: 1,
    peer_user: null
  }), /缺少 peer_user 复合身份/)

  assert.throws(() => mapConversation({
    conversation_id: 'single-invalid-peer',
    conversation_type: 1,
    peer_user: { organization: 902, user_id: '' }
  }), /缺少有效复合身份/)
})

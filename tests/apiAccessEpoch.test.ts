import assert from 'node:assert/strict'
import test from 'node:test'
import { requestWebApi } from '../src/services/apiClient.ts'
import {
  ConversationAccessEpochChangedError,
  observeConversationAccessSnapshot,
  setConversationAccessRecoveryRequired
} from '../src/services/conversationAccess.ts'
import {
  fetchConversations,
  fetchFriendRequests,
  handleFriendRequest,
  markConversationRead,
  updateConversationGroup,
  updateConversationSetting,
  updateFriendRemark
} from '../src/services/webIm.ts'
import type { TenantBrandConfig } from '../src/services/tenantConfig.ts'
import type { WebImSession } from '../src/types.ts'

const organization = '91919'
const userId = 'epoch-http-user'
const config = {
  organization,
  discovered: true,
  serverInfo: {
    routes: [{
      routeId: 'primary',
      endpoints: {
        apiServerUrl: 'https://api.example.test',
        imServerUrl: 'wss://ws.example.test',
        uploadServerUrl: 'https://api.example.test',
        webServerUrl: 'https://web.example.test'
      }
    }],
    apiServerUrl: 'https://api.example.test'
  }
} as TenantBrandConfig

function jwt(payload: Record<string, unknown>) {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode(payload)}.signature`
}

test('authenticated HTTP drops an in-flight response after access epoch advances', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  Object.assign(globalThis, { window: globalThis })
  let completeResponse: ((response: Response) => void) | null = null
  globalThis.fetch = () => new Promise<Response>((resolve) => {
    completeResponse = resolve
  })

  try {
    assert.equal(
      observeConversationAccessSnapshot(organization, userId, '100'),
      'new'
    )
    const pending = requestWebApi<{ protected: string }>(
      config,
      '/saimulti/web/im/conversations',
      {
        token: jwt({ organization, user_id: userId })
      }
    )
    await Promise.resolve()
    assert.ok(completeResponse)
    assert.equal(
      observeConversationAccessSnapshot(organization, userId, '101'),
      'new'
    )
    completeResponse(new Response(JSON.stringify({
      code: 200,
      data: { protected: 'stale' }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }))
    await assert.rejects(
      pending,
      (error) => error instanceof ConversationAccessEpochChangedError
    )
  } finally {
    globalThis.fetch = originalFetch
    Object.assign(globalThis, { window: originalWindow })
  }
})

test('AUTH rebuild can read the authoritative cross-org list while UI HTTP stays fail-closed', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  const recoveryOrganization = '91920'
  const recoveryUserId = 'recovery-http-user'
  const recoveryConfig = {
    ...config,
    organization: recoveryOrganization
  } as TenantBrandConfig
  const session = {
    accessToken: jwt({
      organization: recoveryOrganization,
      user_id: recoveryUserId
    }),
    organization: recoveryOrganization,
    user: {
      userId: recoveryUserId
    }
  } as unknown as WebImSession
  const response = [
    {
      conversation_id: 'same-org',
      conversation_type: 1,
      peer_user: {
        organization: recoveryOrganization,
        user_id: 'same-peer',
        account: 'same-peer'
      }
    },
    {
      conversation_id: 'cross-org',
      conversation_type: 1,
      peer_user: {
        organization: 91921,
        user_id: 'cross-peer',
        account: 'cross-peer'
      }
    }
  ]
  Object.assign(globalThis, { window: globalThis })
  globalThis.fetch = async () => new Response(JSON.stringify({
    code: 200,
    data: response
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })

  try {
    assert.equal(
      observeConversationAccessSnapshot(
        recoveryOrganization,
        recoveryUserId,
        '200'
      ),
      'new'
    )
    setConversationAccessRecoveryRequired(
      recoveryOrganization,
      recoveryUserId,
      true
    )
    assert.deepEqual(
      (await fetchConversations(recoveryConfig, session))
        .map((conversation) => conversation.conversationId),
      ['same-org']
    )
    assert.deepEqual(
      (await fetchConversations(
        recoveryConfig,
        session,
        { authoritativeRecovery: true }
      )).map((conversation) => conversation.conversationId),
      ['same-org', 'cross-org']
    )
  } finally {
    setConversationAccessRecoveryRequired(
      recoveryOrganization,
      recoveryUserId,
      false
    )
    globalThis.fetch = originalFetch
    Object.assign(globalThis, { window: originalWindow })
  }
})

test('friend requests use authoritative organization fields when fail-closed', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  const requestOrganization = '91930'
  const requestUserId = 'request-filter-user'
  const requestConfig = {
    ...config,
    organization: requestOrganization
  } as TenantBrandConfig
  const session = {
    accessToken: jwt({
      organization: requestOrganization,
      user_id: requestUserId
    }),
    organization: requestOrganization,
    user: { userId: requestUserId }
  } as unknown as WebImSession
  const user = (organizationValue: number, id: string) => ({
    organization: organizationValue,
    user_id: id,
    account: id
  })
  Object.assign(globalThis, { window: globalThis })
  globalThis.fetch = async () => new Response(JSON.stringify({
    code: 200,
    data: [
      {
        id: 1,
        direction: 'incoming',
        message: 'same',
        status: 1,
        status_text: 'pending',
        create_time: '',
        handle_time: '',
        from_organization: Number(requestOrganization),
        to_organization: Number(requestOrganization),
        from_user: user(Number(requestOrganization), 'same-peer'),
        to_user: user(Number(requestOrganization), requestUserId)
      },
      {
        id: 2,
        direction: 'incoming',
        message: 'cross-null-side',
        status: 1,
        status_text: 'pending',
        create_time: '',
        handle_time: '',
        from_organization: 91931,
        to_organization: Number(requestOrganization),
        from_user: null,
        to_user: user(Number(requestOrganization), requestUserId)
      },
      {
        id: 3,
        direction: 'incoming',
        message: 'missing-authoritative-org',
        status: 1,
        status_text: 'pending',
        create_time: '',
        handle_time: '',
        from_user: user(Number(requestOrganization), 'same-peer-2'),
        to_user: user(Number(requestOrganization), requestUserId)
      }
    ]
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })

  try {
    assert.equal(
      observeConversationAccessSnapshot(
        requestOrganization,
        requestUserId,
        '0'
      ),
      'new'
    )
    const requests = await fetchFriendRequests(requestConfig, session)
    assert.deepEqual(requests.map((request) => request.id), [1])
    assert.equal(requests[0]?.fromOrganization, requestOrganization)
    assert.equal(requests[0]?.toOrganization, requestOrganization)
  } finally {
    globalThis.fetch = originalFetch
    Object.assign(globalThis, { window: originalWindow })
  }
})

test('known cross-org HTTP mutations never leave the client during access recovery', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  const mutationOrganization = '91940'
  const mutationUserId = 'mutation-guard-user'
  const mutationConfig = {
    ...config,
    organization: mutationOrganization
  } as TenantBrandConfig
  const session = {
    accessToken: jwt({
      organization: mutationOrganization,
      user_id: mutationUserId
    }),
    organization: mutationOrganization,
    user: { userId: mutationUserId }
  } as unknown as WebImSession
  let fetchCount = 0
  Object.assign(globalThis, { window: globalThis })
  globalThis.fetch = async () => {
    fetchCount += 1
    return new Response(JSON.stringify({ code: 200, data: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  try {
    assert.equal(
      observeConversationAccessSnapshot(
        mutationOrganization,
        mutationUserId,
        '700'
      ),
      'new'
    )
    setConversationAccessRecoveryRequired(
      mutationOrganization,
      mutationUserId,
      true
    )
    await assert.rejects(
      updateFriendRemark(
        mutationConfig,
        session,
        '91941',
        'cross-peer',
        'remark'
      ),
      /不能修改跨机构好友备注/
    )
    await assert.rejects(
      handleFriendRequest(mutationConfig, session, {
        id: 10,
        fromOrganization: '91941',
        toOrganization: mutationOrganization
      }, 'accept'),
      /不能处理跨机构好友申请/
    )
    await assert.rejects(
      handleFriendRequest(mutationConfig, session, {
        id: 11,
        fromOrganization: '',
        toOrganization: mutationOrganization
      }, 'reject'),
      /缺少权威复合机构身份/
    )
    await assert.rejects(
      updateConversationGroup(mutationConfig, session, {
        conversationId: 'cross-conversation',
        messageGroupId: 2,
        conversationType: 'single',
        peerOrganization: '91941'
      }),
      /不能修改跨机构会话/
    )
    await assert.rejects(
      updateConversationSetting(mutationConfig, session, {
        conversationId: 'cross-conversation',
        conversationType: 'single',
        peerOrganization: '91941',
        isMuted: true
      }),
      /不能修改跨机构会话/
    )
    await assert.rejects(
      markConversationRead(mutationConfig, session, {
        conversationId: 'cross-conversation',
        conversationType: 'single',
        peerOrganization: '91941'
      }),
      /不能修改跨机构会话/
    )
    await assert.rejects(
      markConversationRead(mutationConfig, session, { all: true }),
      /不能批量修改会话已读状态/
    )
    assert.equal(fetchCount, 0)
  } finally {
    setConversationAccessRecoveryRequired(
      mutationOrganization,
      mutationUserId,
      false
    )
    globalThis.fetch = originalFetch
    Object.assign(globalThis, { window: originalWindow })
  }
})

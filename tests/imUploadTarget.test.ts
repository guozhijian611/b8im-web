import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveCapturedUploadConversation } from '../src/services/imUploadTarget.ts'
import type { ImConversation } from '../src/types.ts'

function conversation(
  id: string,
  peerOrganization: string,
  peerUserId: string
) {
  return {
    id,
    conversationId: id,
    conversationType: 'single',
    peerOrganization,
    peerUserId,
    virtual: false
  } as ImConversation
}

test('an upload remains bound to its captured conversation after active chat switches', () => {
  const original = conversation('conversation-a', '902', 'peer-a')
  const newlyActive = conversation('conversation-b', '903', 'peer-b')
  let activeConversation = original
  const captured = activeConversation

  activeConversation = newlyActive
  const target = resolveCapturedUploadConversation(
    captured,
    [original, activeConversation]
  )
  assert.equal(target, original)
  assert.notEqual(target, activeConversation)
})

test('an upload cannot target a removed or identity-replaced conversation', () => {
  const captured = conversation('conversation-a', '902', 'peer-a')
  assert.equal(resolveCapturedUploadConversation(captured, []), null)
  assert.equal(
    resolveCapturedUploadConversation(
      captured,
      [conversation('conversation-a', '904', 'peer-c')]
    ),
    null
  )
})

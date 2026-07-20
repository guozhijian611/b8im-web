import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildConversationSyncMessageProjection,
  commitConversationSyncChangeBatch,
  commitConversationSyncPageBatch,
  isCanonicalConversationSyncMessageId,
  normalizeConversationSyncChange,
  type ConversationSyncChange,
  type ConversationSyncProjectedMessage
} from '../src/services/imConversationSync.ts'

const conversation = {
  conversationId: 'conversation-1',
  conversationType: 'single' as const,
  peerOrganization: '902',
  peerUserId: 'peer'
}

const context = {
  organization: '901',
  userId: 'current',
  conversation
}

const original = {
  conversationId: 'conversation-1',
  messageId: 'message-1',
  messageSeq: 7,
  senderOrganization: '902',
  senderUserId: 'peer',
  messageType: 1,
  side: 'in' as const
}

function editChange() {
  return {
    conversation_id: 'conversation-1',
    change_seq: 1,
    change_type: 'edit',
    message_id: 'message-1',
    message_seq: 7,
    actor_organization: 902,
    actor_user_id: 'peer',
    target_organization: null,
    target_user_id: null,
    payload: {
      content: { text: 'authoritative edit' },
      edit_time: '2026-07-20 12:00:00',
      edit_count: 1
    },
    create_time: '2026-07-20 12:00:00'
  }
}

function parse(
  value: unknown,
  originalMessage: typeof original | null = original
) {
  return normalizeConversationSyncChange(value, {
    ...context,
    conversationId: conversation.conversationId,
    previousChangeSeq: 0,
    nextAfterChangeSeq: 1,
    original: originalMessage
  })
}

function projectedMessage(
  overrides: Partial<ConversationSyncProjectedMessage> = {}
): ConversationSyncProjectedMessage {
  return {
    ...original,
    messageType: 1,
    contentSemantic: '{"content":"before"}',
    ...overrides
  }
}

test('conversation SYNC normalizes a valid composite actor and authoritative edit', () => {
  const change = parse(editChange())
  assert.ok(change)
  assert.equal(change.actor_organization, '902')
  assert.equal(change.actor_user_id, 'peer')
  assert.equal(change.change_type, 'edit')
  if (change.change_type !== 'edit') {
    assert.fail('expected normalized edit change')
  }
  assert.deepEqual(change.payload.content, {
    text: 'authoritative edit'
  })
  assert.equal(change.payload.edit_time, '2026-07-20 12:00:00')
  assert.equal(change.payload.edit_count, 1)
})

test('conversation SYNC rejects missing, wrong-home and non-participant actors', () => {
  for (const actorField of [
    'actor_organization',
    'actor_user_id'
  ] as const) {
    const missingActor = editChange()
    delete (missingActor as Partial<ReturnType<typeof editChange>>)[actorField]
    assert.equal(parse(missingActor), null, actorField)
  }
  assert.equal(parse({
    ...editChange(),
    actor_organization: 901,
    actor_user_id: 'peer'
  }), null)
  assert.equal(parse({
    ...editChange(),
    actor_organization: 903,
    actor_user_id: 'intruder'
  }), null)
})

test('conversation SYNC accepts only same-home group participants', () => {
  const groupConversation = {
    ...conversation,
    conversationType: 'group' as const
  }
  const groupChange = {
    ...editChange(),
    change_type: 'recall',
    actor_organization: 901,
    actor_user_id: 'group-member',
    payload: { status: 'recalled' }
  }
  const parseGroup = (value: unknown) => normalizeConversationSyncChange(
    value,
    {
      organization: '901',
      userId: 'current',
      conversation: groupConversation,
      conversationId: groupConversation.conversationId,
      previousChangeSeq: 0,
      nextAfterChangeSeq: 1,
      original: null
    }
  )
  assert.ok(parseGroup(groupChange))
  assert.equal(parseGroup({
    ...groupChange,
    actor_organization: 902
  }), null)
})

test('conversation SYNC rejects incomplete targets and forged delete_self identities', () => {
  assert.equal(parse({
    ...editChange(),
    target_organization: 901
  }), null)

  const validDeleteSelf = {
    ...editChange(),
    change_type: 'delete_self',
    actor_organization: 901,
    actor_user_id: 'current',
    target_organization: 901,
    target_user_id: 'current',
    payload: { scope: 'self' }
  }
  assert.ok(parse(validDeleteSelf))
  assert.equal(parse({
    ...validDeleteSelf,
    target_organization: 902,
    target_user_id: 'peer'
  }), null)
  assert.equal(parse({
    ...validDeleteSelf,
    actor_organization: 902,
    actor_user_id: 'peer'
  }), null)
})

test('conversation SYNC requires both target fields as explicit wire properties', () => {
  const missingBothTargets = editChange()
  delete (
    missingBothTargets as Partial<ReturnType<typeof editChange>>
  ).target_organization
  delete (
    missingBothTargets as Partial<ReturnType<typeof editChange>>
  ).target_user_id
  assert.equal(parse(missingBothTargets), null)

  assert.equal(parse({
    ...editChange(),
    target_organization: undefined,
    target_user_id: undefined
  }), null)
  assert.ok(parse(editChange()))
})

test('conversation SYNC requires canonical untrimmed message ids', () => {
  assert.equal(parse({
    ...editChange(),
    message_id: ' message-1 '
  }), null)
  assert.equal(isCanonicalConversationSyncMessageId(' message-1 '), false)
  assert.equal(isCanonicalConversationSyncMessageId(''), false)
  assert.equal(isCanonicalConversationSyncMessageId('message-1'), true)
})

test('conversation SYNC binds broadcast actor to a known original sender', () => {
  assert.equal(parse({
    ...editChange(),
    actor_organization: 901,
    actor_user_id: 'current'
  }), null)
  assert.equal(parse(editChange(), {
    ...original,
    messageType: 3
  }), null)
})

test('conversation SYNC requires the complete authoritative edit and delete payloads', () => {
  const missingEditTime = editChange()
  delete missingEditTime.payload.edit_time
  assert.equal(parse(missingEditTime), null)

  const invalidEditCount = editChange()
  invalidEditCount.payload.edit_count = 0
  assert.equal(parse(invalidEditCount), null)

  assert.equal(parse({
    ...editChange(),
    change_type: 'delete_both',
    payload: { scope: 'both' }
  }), null)
  assert.ok(parse({
    ...editChange(),
    change_type: 'delete_both',
    payload: { scope: 'both', status: 'deleted_both' }
  }))
})

test('invalid conversation SYNC batches cannot apply or advance the change cursor', () => {
  const valid = parse(editChange())
  assert.ok(valid)
  const forged = {
    ...valid,
    actor_organization: '901',
    actor_user_id: 'current'
  } as ConversationSyncChange
  let content = 'before'
  let changeCursor = 0
  let appliedChanges = 0

  const committed = commitConversationSyncChangeBatch(
    [forged],
    context,
    () => original,
    () => {
      content = 'forged'
      changeCursor = 1
      appliedChanges += 1
    }
  )

  assert.equal(committed, false)
  assert.equal(content, 'before')
  assert.equal(changeCursor, 0)
  assert.equal(appliedChanges, 0)
})

test('valid conversation SYNC batches commit once and advance the cursor', () => {
  const valid = parse(editChange())
  assert.ok(valid)
  let changeCursor = 0
  let appliedChanges = 0

  const committed = commitConversationSyncChangeBatch(
    [valid],
    context,
    () => original,
    () => {
      changeCursor = valid.change_seq
      appliedChanges += 1
    }
  )

  assert.equal(committed, true)
  assert.equal(changeCursor, 1)
  assert.equal(appliedChanges, 1)
})

test('page/local message conflicts fail before a non-text overwrite or edit can mutate state', () => {
  const valid = parse(editChange())
  assert.ok(valid)
  const localMessage = projectedMessage()
  const maliciousPageMessage = projectedMessage({
    messageType: 3,
    contentSemantic: '{"file_id":"forged"}'
  })
  let content = 'before'
  let messageCursor = 7
  let changeCursor = 0
  let commitCallbacks = 0
  let recoveryRequests = 0

  const committed = commitConversationSyncPageBatch(
    [localMessage],
    [maliciousPageMessage],
    [valid],
    context,
    () => {
      content = 'authoritative edit'
      messageCursor = 8
      changeCursor = 1
      commitCallbacks += 1
    }
  )
  if (!committed) recoveryRequests += 1

  assert.equal(committed, false)
  assert.equal(content, 'before')
  assert.equal(messageCursor, 7)
  assert.equal(changeCursor, 0)
  assert.equal(commitCallbacks, 0)
  assert.equal(recoveryRequests, 1)
})

test('same-page duplicate message ids fail atomically and enter recovery', () => {
  const pageMessage = projectedMessage({
    messageId: 'message-2',
    messageSeq: 8,
    contentSemantic: '{"content":"new"}'
  })
  let messageCount = 1
  let messageCursor = 7
  let changeCursor = 0
  let commitCallbacks = 0
  let recoveryRequests = 0

  const committed = commitConversationSyncPageBatch(
    [],
    [pageMessage, { ...pageMessage }],
    [],
    context,
    () => {
      messageCount = 3
      messageCursor = 8
      changeCursor = 1
      commitCallbacks += 1
    }
  )
  if (!committed) recoveryRequests += 1

  assert.equal(committed, false)
  assert.equal(messageCount, 1)
  assert.equal(messageCursor, 7)
  assert.equal(changeCursor, 0)
  assert.equal(commitCallbacks, 0)
  assert.equal(recoveryRequests, 1)
})

test('whitespace page ids fail the projection gate without committing', () => {
  let committedCallbacks = 0
  const projection = buildConversationSyncMessageProjection([], [
    projectedMessage({ messageId: ' message-2 ', messageSeq: 8 })
  ])
  const committed = commitConversationSyncPageBatch(
    [],
    [projectedMessage({ messageId: ' message-2 ', messageSeq: 8 })],
    [],
    context,
    () => {
      committedCallbacks += 1
    }
  )

  assert.equal(projection, null)
  assert.equal(committed, false)
  assert.equal(committedCallbacks, 0)
})

test('compatible same-id page projections replace local originals and commit once', () => {
  const valid = parse(editChange())
  assert.ok(valid)
  const localMessage = projectedMessage()
  const pageMessage = { ...localMessage }
  let commitCallbacks = 0

  const committed = commitConversationSyncPageBatch(
    [localMessage],
    [pageMessage],
    [valid],
    context,
    () => {
      commitCallbacks += 1
    }
  )

  assert.equal(committed, true)
  assert.equal(commitCallbacks, 1)
})

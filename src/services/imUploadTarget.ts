import type { ImConversation } from '../types.ts'
import { isSameImIdentity } from './imIdentity.ts'

/**
 * Resolves the exact conversation captured when an upload started. The
 * currently active conversation is intentionally irrelevant.
 */
export function resolveCapturedUploadConversation(
  captured: ImConversation,
  currentConversations: readonly ImConversation[]
) {
  return currentConversations.find((conversation) => {
    if (
      conversation.id !== captured.id ||
      conversation.conversationId !== captured.conversationId ||
      conversation.conversationType !== captured.conversationType ||
      conversation.virtual !== captured.virtual
    ) {
      return false
    }
    return conversation.conversationType === 'group' ||
      isSameImIdentity(
        conversation.peerOrganization,
        conversation.peerUserId,
        captured.peerOrganization,
        captured.peerUserId
      )
  }) ?? null
}

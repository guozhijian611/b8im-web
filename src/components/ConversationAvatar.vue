<script setup lang="ts">
import { computed } from 'vue'
import type { AvatarMember, ImConversation } from '../types'

const props = withDefaults(defineProps<{
  title: string
  avatar?: string
  peerAvatarUrl?: string
  avatarMembers?: AvatarMember[]
  conversationType?: ImConversation['conversationType']
  mini?: boolean
  profile?: boolean
}>(), {
  avatar: '',
  peerAvatarUrl: '',
  avatarMembers: () => [],
  conversationType: 'single',
  mini: false,
  profile: false
})

const isGroup = computed(() => props.conversationType === 'group')
const imageUrl = computed(() => {
  const avatar = props.avatar.trim()
  if (isImageAvatar(avatar)) return avatar
  if (!isGroup.value && isImageAvatar(props.peerAvatarUrl)) return props.peerAvatarUrl
  return ''
})
const avatarText = computed(() => {
  const avatar = props.avatar.trim()
  if (avatar && !isImageAvatar(avatar)) return avatar.slice(0, 1).toUpperCase()
  return (props.title.trim().slice(0, 1) || (isGroup.value ? '群' : '聊')).toUpperCase()
})
const groupTiles = computed(() => {
  if (!isGroup.value || imageUrl.value) return []
  return props.avatarMembers
    .filter((member) => member.avatarUrl || member.nickname || member.account)
    .slice(0, 4)
    .map((member) => ({
      key: member.userId || member.nickname || member.account,
      title: member.nickname || member.account || '成员',
      avatarUrl: member.avatarUrl,
      text: (member.nickname || member.account || '群').slice(0, 1).toUpperCase()
    }))
})

function isImageAvatar(value?: string) {
  const text = String(value ?? '').trim()
  return /^(https?:\/\/|data:image\/|blob:|\/)/i.test(text)
}
</script>

<template>
  <span
    class="avatar conversation-avatar"
    :class="{
      group: isGroup,
      mini,
      profile: profile,
      aggregated: groupTiles.length > 0
    }"
  >
    <img v-if="imageUrl" :src="imageUrl" :alt="title" />
    <span v-else-if="groupTiles.length" class="conversation-avatar__grid" aria-hidden="true">
      <span
        v-for="tile in groupTiles"
        :key="tile.key"
        class="conversation-avatar__tile"
        :title="tile.title"
      >
        <img v-if="tile.avatarUrl" :src="tile.avatarUrl" :alt="tile.title" />
        <span v-else>{{ tile.text }}</span>
      </span>
    </span>
    <template v-else>{{ avatarText }}</template>
  </span>
</template>

<style scoped>
.conversation-avatar.aggregated {
  padding: 2px;
  background: #dbe2e8;
}

.conversation-avatar__grid {
  width: 100%;
  height: 100%;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: repeat(2, minmax(0, 1fr));
  gap: 2px;
}

.conversation-avatar__tile {
  min-width: 0;
  min-height: 0;
  display: grid;
  place-items: center;
  overflow: hidden;
  border-radius: 4px;
  background: linear-gradient(135deg, #67717c, #303943);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
}

.conversation-avatar:not(.mini) .conversation-avatar__tile {
  font-size: 12px;
}

.conversation-avatar.profile .conversation-avatar__tile {
  font-size: 16px;
}

.conversation-avatar__tile img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

:global(:root[data-web-theme="dark"]) .conversation-avatar.aggregated {
  background: #2b3542;
}
</style>

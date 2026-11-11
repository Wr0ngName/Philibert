<script setup lang="ts">
/**
 * Where the input is for an archived discussion: nothing is written in one,
 * so instead of the prompt and its buttons it says so, and offers to bring
 * it back — unless its Claude Code session is gone, when there is nothing
 * left to continue and it stays archived.
 */

import { ref } from 'vue';

import type { Conversation } from '@shared/types';

import { useConversationsStore } from '../../stores/conversations';
import Icon from '../shared/Icon.vue';
import Spinner from '../shared/Spinner.vue';

const props = defineProps<{
  conversation: Conversation;
}>();

const conversationsStore = useConversationsStore();
const restoring = ref(false);

async function bringBack() {
  restoring.value = true;
  try {
    await conversationsStore.setConversationArchived(props.conversation.id, false);
  } finally {
    restoring.value = false;
  }
}
</script>

<template>
  <div
    class="archived-discussion-bar border-t border-surface-200 dark:border-surface-700 p-4 bg-white dark:bg-surface-800"
    role="status"
  >
    <div class="flex items-center gap-3">
      <Icon
        name="archive"
        size="sm"
        class="shrink-0 text-surface-400 dark:text-surface-500"
      />
      <p
        v-if="conversation.sessionGone"
        class="flex-1 text-sm text-surface-600 dark:text-surface-300"
      >
        This discussion is archived. Claude's session for it no longer exists, so it can't be brought back.
      </p>
      <template v-else>
        <p class="flex-1 text-sm text-surface-600 dark:text-surface-300">
          This discussion is archived. Bring it back to write in it again.
        </p>
        <button
          type="button"
          class="bring-back shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-60 transition-colors"
          :disabled="restoring"
          @click="bringBack"
        >
          <Spinner
            v-if="restoring"
            size="xs"
          />
          <Icon
            v-else
            name="restore"
            size="xs"
          />
          Bring back
        </button>
      </template>
    </div>
  </div>
</template>

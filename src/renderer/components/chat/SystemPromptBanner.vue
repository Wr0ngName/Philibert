<script setup lang="ts">
/**
 * Says, at the top of the discussion on screen, that it does not run on the
 * system prompt the settings ask for (useSystemPromptStatus): a discussion
 * keeps the prompt it started with, for good. Nothing is done to it — the
 * user goes on, or starts a new discussion when what is under way is done.
 *
 * - legacy: started before the app kept what it started on, so not known:
 *   newer settings may not apply to it.
 * - differs: started on a prompt the settings no longer ask for; the change
 *   can be reviewed, and gone on with ("Continue as is": not pointed out
 *   again until the settings change once more).
 */

import { storeToRefs } from 'pinia';
import { ref } from 'vue';

import { useSystemPromptStatus } from '../../composables/useSystemPromptStatus';
import { useConversationsStore } from '../../stores/conversations';
import NoticeBanner from '../shared/NoticeBanner.vue';

import SystemPromptReviewModal from './SystemPromptReviewModal.vue';

const conversationsStore = useConversationsStore();
const { currentArchived } = storeToRefs(conversationsStore);
const status = useSystemPromptStatus();
const reviewing = ref(false);

function startNew(): void {
  reviewing.value = false;
  conversationsStore.createNewConversation();
}

async function keep(): Promise<void> {
  if (status.value.kind !== 'differs') return;
  const { current } = status.value;
  reviewing.value = false;
  await conversationsStore.keepSystemPromptUnder(current);
}
</script>

<template>
  <div
    v-if="!currentArchived && status.kind !== 'current'"
    class="px-4 pt-2"
  >
    <NoticeBanner
      v-if="status.kind === 'legacy'"
      data-testid="system-prompt-legacy"
      wrap
    >
      <strong>Legacy discussion.</strong>
      It started before Philibert kept track of its system prompt, so newer settings may not
      apply to it. Open a new discussion when you are ready, to get them.
      <template #actions>
        <button
          class="btn-sm btn-amber"
          data-testid="system-prompt-start-new"
          @click="startNew"
        >
          New discussion
        </button>
      </template>
    </NoticeBanner>

    <template v-else-if="status.kind === 'differs'">
      <NoticeBanner
        data-testid="system-prompt-differs"
        wrap
      >
        <strong>System prompt changed.</strong>
        This discussion keeps the one it started with; the settings now ask for another.
        <template #actions>
          <button
            class="btn-sm btn-amber"
            data-testid="system-prompt-review"
            @click="reviewing = true"
          >
            Review
          </button>
        </template>
      </NoticeBanner>
      <SystemPromptReviewModal
        :open="reviewing"
        :recorded="status.recorded"
        :current="status.current"
        @close="reviewing = false"
        @keep="keep"
        @start-new="startNew"
      />
    </template>
  </div>
</template>

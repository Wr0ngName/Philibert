<script setup lang="ts">
/**
 * Main chat window component
 */

import { ref, nextTick, watch } from 'vue';
import { storeToRefs } from 'pinia';

import type { AskUserQuestionAction, AskUserQuestionAnswer, BackgroundTask, PendingAction, PermissionScope, ToolUseInfo } from '@shared/types';
import { useChatStore } from '../../stores/chat';
import { useConversationsStore } from '../../stores/conversations';
import { useSettingsStore } from '../../stores/settings';
import { useClaudeChat } from '../../composables/useClaudeChat';
import ActionApproval from './ActionApproval.vue';
import AskUserQuestionMessage from './AskUserQuestionMessage.vue';
import BackgroundTaskDetailModal from './BackgroundTaskDetailModal.vue';
import BackgroundTaskPanel from './BackgroundTaskPanel.vue';
import ContextUsageBar from './ContextUsageBar.vue';
import InputBox from './InputBox.vue';
import MessageList from './MessageList.vue';
import ResourceLimitWarning from './ResourceLimitWarning.vue';
import ToolDetailModal from './ToolDetailModal.vue';
import Toast from '../shared/Toast.vue';
import TransitionFade from '../shared/TransitionFade.vue';

const chatStore = useChatStore();
const conversationsStore = useConversationsStore();
const settingsStore = useSettingsStore();
const { pendingActions, error, hasPendingActions, hasRunningBackgroundTasks, runningBackgroundTasksList, sessionUsage, hasSessionUsage, activeQueryCount, maxConcurrentQueries, processingQueryCount, pendingScrollMessageId } = storeToRefs(chatStore);
const { currentModeMismatch } = storeToRefs(conversationsStore);

const { sendMessage, approveAction, rejectAction, abort, sendQuestionAnswer } = useClaudeChat();

async function continueInCurrentMode() {
  await conversationsStore.adoptCurrentExecutionMode();
}

async function switchExecutionMode() {
  if (!currentModeMismatch.value) return;
  await settingsStore.setExecutionMode(currentModeMismatch.value.conversationMode);
}

const messageListRef = ref<InstanceType<typeof MessageList> | null>(null);

// Task detail modal state
const taskDetailOpen = ref(false);
const taskDetailTask = ref<BackgroundTask | null>(null);

// Tool detail modal state
const toolDetailOpen = ref(false);
const toolDetailInfo = ref<ToolUseInfo | null>(null);

function handleSend(message: string) {
  sendMessage(message);
  nextTick(() => messageListRef.value?.scrollToBottom());
}

// Search modal sets pendingScrollMessageId; forward it to the MessageList ref
// once it's resolved (the ref may not exist on the very first frame after a
// conversation switch). Clear the request after dispatch so the same target
// doesn't re-fire on later store mutations.
watch(pendingScrollMessageId, async (id) => {
  if (!id) return;
  await nextTick();
  for (let i = 0; i < 10 && !messageListRef.value; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (messageListRef.value) {
    await messageListRef.value.scrollToMessage(id);
  }
  pendingScrollMessageId.value = null;
});

function handleAbort() {
  abort();
}

function handleApprove(actionId: string, alwaysAllow?: boolean, chosenScope?: PermissionScope) {
  approveAction(actionId, alwaysAllow, chosenScope);
}

function handleReject(actionId: string) {
  rejectAction(actionId);
}

function isQuestionAction(action: PendingAction): action is AskUserQuestionAction {
  return action.type === 'ask-user-question';
}

function handleQuestionAnswer(actionId: string, answers: AskUserQuestionAnswer[]) {
  sendQuestionAnswer(actionId, answers, false);
}

function handleQuestionCancel(actionId: string) {
  sendQuestionAnswer(actionId, [], true);
}

function clearError() {
  chatStore.clearError();
}

function openTaskDetail(taskId: string) {
  const task = chatStore.backgroundTasks.get(taskId);
  if (task) {
    taskDetailTask.value = task;
    taskDetailOpen.value = true;
  }
}

function closeTaskDetail() {
  taskDetailOpen.value = false;
  taskDetailTask.value = null;
}

function openToolDetail(id: string) {
  const msg = chatStore.messages.find(
    m => m.toolUse && (m.toolUse.toolUseBlockId === id || m.toolUse.actionId === id)
  );
  if (msg?.toolUse) {
    toolDetailInfo.value = msg.toolUse;
    toolDetailOpen.value = true;
  }
}

function closeToolDetail() {
  toolDetailOpen.value = false;
  toolDetailInfo.value = null;
}
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Error toast -->
    <TransitionFade type="slideDown">
      <div
        v-if="error"
        class="absolute top-0 left-0 right-0 z-10 p-4"
      >
        <Toast
          type="error"
          :message="error"
          @dismiss="clearError"
        />
      </div>
    </TransitionFade>

    <!-- Resource limit warning -->
    <TransitionFade type="slideDown">
      <div
        v-if="processingQueryCount > 0 || activeQueryCount >= maxConcurrentQueries - 1"
        class="px-4 pt-2"
      >
        <ResourceLimitWarning
          :active-count="activeQueryCount"
          :max-count="maxConcurrentQueries"
          :processing-count="processingQueryCount"
        />
      </div>
    </TransitionFade>

    <!-- Execution mode mismatch banner -->
    <TransitionFade type="slideDown">
      <div
        v-if="currentModeMismatch"
        class="px-4 pt-2"
      >
        <div class="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 text-sm">
          <p class="text-amber-900 dark:text-amber-100">
            <strong>Mode mismatch.</strong>
            This conversation was started in
            <span class="font-mono">{{ currentModeMismatch.conversationMode }}</span>
            mode but you're using
            <span class="font-mono">{{ currentModeMismatch.currentMode }}</span>
            now. The previous session can't be resumed — pick one:
          </p>
          <div class="flex gap-2 mt-2">
            <button
              type="button"
              class="px-3 py-1 text-xs rounded bg-amber-600 text-white hover:bg-amber-700"
              @click="switchExecutionMode"
            >
              Switch back to {{ currentModeMismatch.conversationMode }} mode
            </button>
            <button
              type="button"
              class="px-3 py-1 text-xs rounded border border-amber-400 text-amber-900 dark:text-amber-100 hover:bg-amber-100 dark:hover:bg-amber-900/40"
              @click="continueInCurrentMode"
            >
              Continue in {{ currentModeMismatch.currentMode }} (starts fresh, loses prior context)
            </button>
          </div>
        </div>
      </div>
    </TransitionFade>

    <!-- Messages -->
    <MessageList
      ref="messageListRef"
      @open-task-detail="openTaskDetail"
      @open-tool-detail="openToolDetail"
    />

    <!-- Background tasks panel (running only) -->
    <TransitionFade type="slideUp">
      <div
        v-if="hasRunningBackgroundTasks"
        class="px-4 pt-2"
      >
        <BackgroundTaskPanel
          :tasks="runningBackgroundTasksList"
          @open-detail="openTaskDetail"
        />
      </div>
    </TransitionFade>

    <!-- Background task detail modal -->
    <BackgroundTaskDetailModal
      :open="taskDetailOpen"
      :task="taskDetailTask"
      @close="closeTaskDetail"
    />

    <!-- Tool use detail modal -->
    <ToolDetailModal
      :open="toolDetailOpen"
      :tool-use="toolDetailInfo"
      @close="closeToolDetail"
    />

    <!-- Pending actions -->
    <div
      v-if="hasPendingActions"
      class="border-t border-surface-200 dark:border-surface-700 p-4 space-y-3 max-h-[40%] overflow-y-auto"
    >
      <TransitionGroup
        name="action"
        tag="div"
        class="space-y-3"
      >
        <template
          v-for="action in pendingActions"
          :key="action.id"
        >
          <AskUserQuestionMessage
            v-if="isQuestionAction(action)"
            :action="action"
            @answer="handleQuestionAnswer"
            @cancel="handleQuestionCancel"
          />
          <ActionApproval
            v-else
            :action="action"
            @approve="handleApprove"
            @reject="handleReject"
          />
        </template>
      </TransitionGroup>
    </div>

    <!-- Context usage bar -->
    <TransitionFade>
      <ContextUsageBar
        v-if="hasSessionUsage"
        :usage="sessionUsage"
      />
    </TransitionFade>

    <!-- Input -->
    <InputBox
      @send="handleSend"
      @abort="handleAbort"
    />
  </div>
</template>

<style scoped>
.action-enter-active,
.action-leave-active {
  transition: all 0.2s ease;
}

.action-enter-from {
  opacity: 0;
  transform: translateY(10px);
}

.action-leave-to {
  opacity: 0;
  transform: translateX(20px);
}
</style>

<script setup lang="ts">
/**
 * Main chat window component
 */

import { ref } from 'vue';
import { storeToRefs } from 'pinia';

import type { BackgroundTask, PermissionScope } from '@shared/types';
import { useChatStore } from '../../stores/chat';
import { useClaudeChat } from '../../composables/useClaudeChat';
import ActionApproval from './ActionApproval.vue';
import BackgroundTaskDetailModal from './BackgroundTaskDetailModal.vue';
import BackgroundTaskPanel from './BackgroundTaskPanel.vue';
import ContextUsageBar from './ContextUsageBar.vue';
import InputBox from './InputBox.vue';
import MessageList from './MessageList.vue';
import ResourceLimitWarning from './ResourceLimitWarning.vue';
import Toast from '../shared/Toast.vue';
import TransitionFade from '../shared/TransitionFade.vue';

const chatStore = useChatStore();
const { pendingActions, error, hasPendingActions, hasRunningBackgroundTasks, runningBackgroundTasksList, sessionUsage, hasSessionUsage, activeQueryCount, maxConcurrentQueries, processingQueryCount } = storeToRefs(chatStore);

const { sendMessage, approveAction, rejectAction, abort } = useClaudeChat();

// Task detail modal state
const taskDetailOpen = ref(false);
const taskDetailTask = ref<BackgroundTask | null>(null);

function handleSend(message: string) {
  sendMessage(message);
}

function handleAbort() {
  abort();
}

function handleApprove(actionId: string, alwaysAllow?: boolean, chosenScope?: PermissionScope) {
  approveAction(actionId, alwaysAllow, chosenScope);
}

function handleReject(actionId: string) {
  rejectAction(actionId);
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

    <!-- Messages -->
    <MessageList @open-task-detail="openTaskDetail" />

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
        <ActionApproval
          v-for="action in pendingActions"
          :key="action.id"
          :action="action"
          @approve="handleApprove"
          @reject="handleReject"
        />
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

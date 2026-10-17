<script setup lang="ts">
/**
 * Main chat window component
 */

import { ref, computed, nextTick, watch } from 'vue';
import { storeToRefs } from 'pinia';

import type { AskUserQuestionAction, AskUserQuestionAnswer, BackgroundTask, MessageImage, PendingAction, PermissionScope, ToolUseInfo } from '@shared/types';
import { useChatStore } from '../../stores/chat';
import { useConversationsStore } from '../../stores/conversations';
import { useSettingsStore } from '../../stores/settings';
import { useClaudeChat } from '../../composables/useClaudeChat';
import { descendantsOf, toolUseIdForTask, type ActivityRow } from '../../utils/message-tree';
import ActionApproval from './ActionApproval.vue';
import AskUserQuestionMessage from './AskUserQuestionMessage.vue';
import BackgroundTaskDetailModal from './BackgroundTaskDetailModal.vue';
import BackgroundTaskPanel from './BackgroundTaskPanel.vue';
import ContextUsageBar from './ContextUsageBar.vue';
import InputBox from './InputBox.vue';
import MessageList from './MessageList.vue';
import TaskListPanel from './TaskListPanel.vue';
import ToolDetailModal from './ToolDetailModal.vue';
import Toast from '../shared/Toast.vue';
import TransitionFade from '../shared/TransitionFade.vue';

const chatStore = useChatStore();
const conversationsStore = useConversationsStore();
const settingsStore = useSettingsStore();
const { pendingActions, error, hasPendingActions, hasRunningBackgroundTasks, runningBackgroundTasksList, hasTaskListItems, taskListItems, sessionUsage, hasSessionUsage, pendingScrollMessageId } = storeToRefs(chatStore);
const { currentModeMismatch } = storeToRefs(conversationsStore);

const {
  sendMessage,
  queuePrompt,
  releaseQueuedPrompts,
  approveAction,
  rejectAction,
  abort,
  sendQuestionAnswer,
} = useClaudeChat();

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
/**
 * The modal tracks the task by id, not by value. handleTaskNotification and
 * the live-set reconciler both replace Map entries rather than mutating them,
 * so a captured object never changes — an open modal sat on whatever the task
 * looked like at click time and a running task appeared to stay running.
 */
const taskDetailTaskId = ref<string | null>(null);
const taskDetailTask = computed<BackgroundTask | null>(() =>
  taskDetailTaskId.value ? chatStore.backgroundTasks.get(taskDetailTaskId.value) ?? null : null,
);
const stoppingTask = ref(false);
const stopTaskError = ref<string | null>(null);

/**
 * The tool call that spawned the task the modal is showing.
 *
 * Looked up live by the task's toolUseId, so the modal can show the command
 * or agent prompt behind the task. Without it a running task had only its
 * description, status and duration to show — summary, output file, model and
 * tokens all arrive at the end.
 */
const taskDetailSpawningTool = computed<ToolUseInfo | null>(() => {
  const task = taskDetailTask.value;
  if (!task) return null;
  // toolUseIdForTask, not task.toolUseId: a backgrounded tool's first
  // notification carries its tool_use block id as the task id and leaves
  // toolUseId unset, so keying on that field alone found nothing and the
  // modal showed no command at all for every background command.
  const toolUseId = toolUseIdForTask(task);
  const message = chatStore.messages.find(
    m => m.toolUse && (m.toolUse.toolUseBlockId === toolUseId || m.toolUse.actionId === toolUseId),
  );
  return message?.toolUse ?? null;
});

/**
 * The tool calls the open task has made.
 *
 * Read from the message stream rather than the task record, because the task
 * record carries no history of what it did — only its final summary. While a
 * task runs this is the only thing the detail modal has to show.
 */
const taskDetailActivity = computed<ActivityRow[]>(() => {
  const task = taskDetailTask.value;
  if (!task) return [];
  return descendantsOf(chatStore.messages, toolUseIdForTask(task));
});

// Tool detail modal state
const toolDetailOpen = ref(false);
const toolDetailInfo = ref<ToolUseInfo | null>(null);

function handleSend(message: string, images?: MessageImage[]) {
  sendMessage(message, images);
  nextTick(() => messageListRef.value?.scrollToBottom());
}

function handleQueue(message: string) {
  queuePrompt(message);
}

function handleReleaseQueue() {
  // Scrolls to the bottom for the same reason a send does: a prompt the user
  // just released is the newest thing in the conversation.
  void releaseQueuedPrompts();
  nextTick(() => messageListRef.value?.scrollToBottom());
}

function handleUnqueue(promptId: string) {
  const conversationId = conversationsStore.currentConversationId;
  if (conversationId) chatStore.removeQueuedPrompt(conversationId, promptId);
}

// Search modal sets pendingScrollMessageId; forward it to the MessageList ref
// once it's resolved (the ref may not exist on the very first frame after a
// conversation switch). Clear the request after dispatch so the same target
// doesn't re-fire on later store mutations.
/**
 * Close the detail modals when the conversation changes.
 *
 * Both are keyed to the conversation they were opened from. The task modal
 * resolves its task out of the current conversation's map, so after a switch
 * the lookup misses and it renders as an empty shell; the tool modal holds a
 * snapshot, so it does the opposite and keeps showing a tool from the
 * conversation that is no longer on screen. Neither is worth trying to
 * preserve across a switch.
 */
watch(() => conversationsStore.currentConversationId, () => {
  if (taskDetailOpen.value) closeTaskDetail();
  if (toolDetailOpen.value) closeToolDetail();
});

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

/**
 * Stop the turn AND every background task it left running.
 *
 * Interrupting the turn deliberately spares background agents and workflows
 * now (`perTaskStopAffordance` in ClaudeCodeService), which is what makes Stop
 * usable — but it also means there has to be a way to take the lot down on
 * purpose. This is it.
 *
 * Tasks first, then the turn: the session survives an interrupt either way,
 * but stopping a task needs the session, so doing it in this order means a
 * failure in the interrupt cannot leave tasks running that the user asked to
 * kill. Each is requested independently, so one refusal does not spare the
 * rest.
 */
async function handleAbortEverything() {
  await stopAllRunningTasks();
  abort();
}

/**
 * Stop the background tasks when there is no turn to interrupt.
 *
 * The turn ending no longer ends the work it started, so the work can outlive
 * it — and the Stop control went away with the turn, which left running agents
 * reachable only one at a time through each task's detail modal. This is the
 * same request as "stop everything" minus the interrupt there is nothing to
 * interrupt.
 */
async function handleStopTasks() {
  await stopAllRunningTasks();
}

/**
 * Ask every running background task to stop.
 *
 * Each is requested independently, so one that refuses does not spare the
 * rest. The list is copied first because stopping them mutates it as the
 * notifications come back.
 */
async function stopAllRunningTasks(): Promise<void> {
  const tasks = [...chatStore.runningBackgroundTasksList];
  await Promise.allSettled(tasks.map((task) => stopTask(task.id)));
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
  if (!chatStore.backgroundTasks.has(taskId)) return;
  taskDetailTaskId.value = taskId;
  taskDetailOpen.value = true;
}

function closeTaskDetail() {
  taskDetailOpen.value = false;
  taskDetailTaskId.value = null;
  stopTaskError.value = null;
}

/**
 * Stop the task the modal is showing.
 *
 * Status is not set optimistically: the authoritative change arrives as a task
 * notification, and the live list reconciles anything that notification misses.
 * Writing 'stopped' here would show success even when the request failed.
 */
async function stopTaskFromDetail(taskId: string) {
  stoppingTask.value = true;
  stopTaskError.value = null;
  try {
    await stopTask(taskId);
  } catch (error) {
    stopTaskError.value = error instanceof Error ? error.message : 'Failed to stop task';
  } finally {
    stoppingTask.value = false;
  }
}

/**
 * Request that one background task stop.
 *
 * The single place that request is made, so the modal's stop button and the
 * Stop button's "stop everything" cannot drift apart. Throws rather than
 * swallowing, because the two callers want different things from a failure:
 * the modal shows it against the task, while stopping everything carries on
 * with the others.
 */
async function stopTask(taskId: string): Promise<void> {
  const conversationId = conversationsStore.currentConversationId;
  if (!conversationId) return;
  await window.electron.claude.stopTask(conversationId, taskId);
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

/**
 * Show a tool call the task modal handed over directly.
 *
 * Separate from openToolDetail, which looks a call up by id: the task modal
 * already holds the ToolUseInfo, and searching for it again would fail for a
 * call whose parent agent is no longer in the message list.
 */
function openToolDetailFor(toolUse: ToolUseInfo) {
  toolDetailInfo.value = toolUse;
  toolDetailOpen.value = true;
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

    <!-- Task list panel (model's SDK todo list) -->
    <TransitionFade type="slideUp">
      <div
        v-if="hasTaskListItems"
        class="px-4 pt-2"
      >
        <TaskListPanel :items="taskListItems" />
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
        class="px-4 py-2"
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
      :spawning-tool="taskDetailSpawningTool"
      :activity="taskDetailActivity"
      :stopping="stoppingTask"
      :stop-error="stopTaskError"
      @close="closeTaskDetail"
      @stop="stopTaskFromDetail"
      @open-tool-detail="openToolDetailFor"
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
      @queue="handleQueue"
      @release-queue="handleReleaseQueue"
      @unqueue="handleUnqueue"
      @abort="handleAbort"
      @abort-everything="handleAbortEverything"
      @stop-tasks="handleStopTasks"
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

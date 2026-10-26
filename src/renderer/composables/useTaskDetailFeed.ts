/**
 * What the task detail view shows of a task while it is open: an agent's
 * transcript, or a command's output — read now, and read again while the task
 * runs.
 *
 * Both only ever add to what is shown. The view used to clear its content and
 * read it all again whenever the task changed, and a running agent changes
 * with every step it takes: the block emptied to a spinner and refilled, and
 * whatever the reader had scrolled to was gone each time.
 */

import { onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue';

import type { BackgroundTask, ChatMessage } from '@shared/types';

import { useConversationsStore } from '../stores/conversations';
import { logger } from '../utils/logger';

/** How often a running task is read again. */
export const TASK_FEED_INTERVAL_MS = 2000;

/**
 * At most this much of a command's output is kept on screen: its tail. A
 * build or a test run can write megabytes, and a view following it would
 * otherwise hold all of it.
 */
export const MAX_SHOWN_CHARS = 512 * 1024;

const utf8 = new TextEncoder();

interface FeedOptions {
  /** Whether the view is open. Nothing is read while it is not. */
  open: () => boolean;
  task: () => BackgroundTask | null;
  conversationId: () => string;
}

/**
 * Read with `load` when the view opens on a task, every interval while that
 * task runs, and once more when it stops running — the end of its output
 * arrives with the end of the task.
 */
function usePolledFeed(options: FeedOptions, load: (task: BackgroundTask, first: boolean) => Promise<void>): void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  function stopTimer(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function read(first: boolean): Promise<void> {
    const task = options.task();
    if (!task || inFlight) return;
    inFlight = true;
    try {
      await load(task, first);
    } catch (err) {
      logger.warn('Failed to read task detail', { taskId: task.id, error: err instanceof Error ? err.message : String(err) });
    } finally {
      inFlight = false;
    }
  }

  // Watched as separate primitives, not as one object: a task's record is
  // replaced on every progress notice, and an object source would count each
  // of those as a change — which is the reload this exists to stop.
  watch(
    [options.open, () => options.task()?.id, () => options.task()?.status],
    ([open, id, status], previous) => {
      stopTimer();
      if (!open || !id) return;
      const [wasOpen, previousId] = previous ?? [false, undefined];
      void read(!wasOpen || previousId !== id);
      if (status === 'running') {
        timer = setInterval(() => void read(false), TASK_FEED_INTERVAL_MS);
      }
    },
    { immediate: true },
  );

  onBeforeUnmount(stopTimer);
}

/** What distinguishes one reading of a transcript from the next. */
function transcriptSignature(messages: ChatMessage[]): string {
  return messages.map((m) => `${m.id}:${m.toolUse?.status ?? ''}`).join('|');
}

/** An agent's transcript, as the messages the discussion is drawn from. */
export function useAgentTranscript(options: FeedOptions): { messages: Ref<ChatMessage[]>; loaded: Ref<boolean> } {
  const conversationsStore = useConversationsStore();
  const messages = shallowRef<ChatMessage[]>([]);
  const loaded = ref(false);

  usePolledFeed(options, async (task, first) => {
    if (task.taskType !== 'agent') return;
    if (first) {
      messages.value = [];
      loaded.value = false;
    }
    const conversationId = options.conversationId();
    const next = await window.electron.claude.getAgentTranscript(
      conversationId,
      task.id,
      conversationsStore.getSdkSessionId(conversationId),
    );
    // Only when something changed, so an idle agent does not re-render. A
    // result can land on any call still waiting, not just the last.
    if (transcriptSignature(next) !== transcriptSignature(messages.value)) {
      messages.value = next;
    }
    loaded.value = true;
  });

  return { messages, loaded };
}

/** A command's output, read in increments as it grows. */
export function useCommandOutput(options: FeedOptions): {
  text: Ref<string>;
  skippedBytes: Ref<number>;
  loaded: Ref<boolean>;
} {
  const conversationsStore = useConversationsStore();
  const text = ref('');
  const skippedBytes = ref(0);
  const loaded = ref(false);
  let nextByte = 0;

  usePolledFeed(options, async (task, first) => {
    if (task.taskType === 'agent') return;
    if (first) {
      text.value = '';
      skippedBytes.value = 0;
      loaded.value = false;
      nextByte = 0;
    }
    const conversationId = options.conversationId();
    const chunk = await window.electron.claude.readTaskOutput(
      conversationId,
      task.id,
      conversationsStore.getSdkSessionId(conversationId),
      nextByte,
    );
    loaded.value = true;
    if (!chunk) return;
    nextByte = chunk.nextByte;
    if (!chunk.text && chunk.skippedBytes === 0) return;

    // More arrived than fits: what is shown is the tail, starting afresh.
    const shown = chunk.skippedBytes > 0 ? chunk.text : text.value + chunk.text;
    const kept = shown.length > MAX_SHOWN_CHARS ? shown.slice(-MAX_SHOWN_CHARS) : shown;
    text.value = kept;
    // Everything before what is shown, in bytes, as the file counts them.
    skippedBytes.value = chunk.nextByte - utf8.encode(kept).length;
  });

  return { text, skippedBytes, loaded };
}

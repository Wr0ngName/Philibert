/**
 * Turns a flat message list into the tree the chat renders.
 *
 * Extracted from MessageList.vue so it can be tested. It decides which tool
 * calls are shown as the main conversation and which are nested under the
 * agent or background task that made them — and getting that wrong is how a
 * sub-agent's work ends up looking like something Claude did directly in the
 * main thread.
 */

import type { ChatMessage } from '@shared/types';

/** Every tool_use block id present as a message. */
export function knownToolUseIds(messages: readonly ChatMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    const id = m.toolUse?.toolUseBlockId;
    if (id) ids.add(id);
    // A background task message stands in for the tool_use that spawned it,
    // so its children must be able to find it as a parent. Without this, an
    // agent that is represented by a background-task row rather than a
    // tool_use row orphans every tool call it makes.
    const taskToolUseId = m.backgroundTask?.toolUseId;
    if (taskToolUseId) ids.add(taskToolUseId);
  }
  return ids;
}

/** Direct children of each parent tool_use id, in arrival order. */
export function childrenByParent(messages: readonly ChatMessage[]): Map<string, ChatMessage[]> {
  const map = new Map<string, ChatMessage[]>();
  for (const m of messages) {
    const parent = m.toolUse?.parentToolUseId;
    if (!parent) continue;
    const list = map.get(parent);
    if (list) {
      list.push(m);
    } else {
      map.set(parent, [m]);
    }
  }
  return map;
}

/** How a message with a missing parent should be treated. */
export type OrphanPolicy =
  /** Show it as a normal top-level message — what the chat used to do. */
  | 'promote'
  /** Keep it out of the main thread; the caller renders it as agent activity. */
  | 'quarantine';

export interface TopLevelResult {
  /** Messages forming the main conversation. */
  topLevel: ChatMessage[];
  /**
   * Messages whose parent tool_use is not in the list. Under 'promote' these
   * also appear in `topLevel`; under 'quarantine' they do not.
   */
  orphans: ChatMessage[];
}

/**
 * Split the list into the main conversation and orphaned agent activity.
 *
 * A message is orphaned when it names a `parentToolUseId` that no message in
 * the list provides. That happens for real, not just in theory: the store used
 * to cap the message list at 1000 entries by splicing the oldest off, and a
 * parent agent invocation is always older than the tool calls it makes — so
 * every subsequent child surfaced with no parent. Because the truncated list
 * was then persisted, reloading such a conversation orphaned them permanently.
 *
 * Promoting an orphan into the main conversation is what made a sub-agent's
 * tool calls read as Claude's own, which is misleading: the user sees edits
 * and commands in the main thread that nothing in the main thread asked for.
 */
export function splitTopLevel(
  messages: readonly ChatMessage[],
  policy: OrphanPolicy = 'quarantine',
): TopLevelResult {
  const known = knownToolUseIds(messages);
  const topLevel: ChatMessage[] = [];
  const orphans: ChatMessage[] = [];

  for (const m of messages) {
    const parent = m.toolUse?.parentToolUseId;
    if (!parent) {
      topLevel.push(m);
      continue;
    }
    if (known.has(parent)) {
      // Rendered under its parent, not at the top level.
      continue;
    }
    orphans.push(m);
    if (policy === 'promote') topLevel.push(m);
  }

  return { topLevel, orphans };
}

/** Id prefix for a stand-in parent, so callers can recognise one. */
export const ORPHAN_PARENT_PREFIX = 'orphan-parent:';

/** Label shown on a stand-in parent row. */
export const ORPHAN_PARENT_LABEL = 'Agent activity';

/**
 * Build a stand-in for a parent tool_use that is not in the message list.
 *
 * It carries the missing id as its own `toolUseBlockId`, so the orphaned
 * children nest under it through the ordinary parent lookup and collapse
 * behind the same "N actions" pill as any other agent — rather than being
 * promoted into the main conversation, where they read as work Claude did
 * directly.
 */
function standInParent(parentToolUseId: string, timestamp: number): ChatMessage {
  return {
    id: `${ORPHAN_PARENT_PREFIX}${parentToolUseId}`,
    role: 'assistant',
    content: '',
    timestamp,
    toolUse: {
      actionId: parentToolUseId,
      toolName: 'Agent',
      description: ORPHAN_PARENT_LABEL,
      status: 'executed',
      toolUseBlockId: parentToolUseId,
    },
  };
}

/**
 * The messages the main conversation should render, in order.
 *
 * Messages nested under a parent are left out — the renderer walks down to
 * them when their parent is expanded. A message whose parent is missing gets a
 * stand-in parent inserted where that message first appeared, so the activity
 * stays visible and stays attributed to an agent.
 */
export function topLevelSequence(messages: readonly ChatMessage[]): ChatMessage[] {
  const known = knownToolUseIds(messages);
  const sequence: ChatMessage[] = [];
  const standInsAdded = new Set<string>();

  for (const m of messages) {
    const parent = m.toolUse?.parentToolUseId;
    if (!parent) {
      sequence.push(m);
      continue;
    }
    if (known.has(parent)) continue;

    if (!standInsAdded.has(parent)) {
      standInsAdded.add(parent);
      sequence.push(standInParent(parent, m.timestamp));
    }
  }

  return sequence;
}

/**
 * The tool_use block id a background task is linked to, if any.
 *
 * `toolUseId` is the proper field, but the CLI's first notification for a
 * backgrounded tool sends the tool_use block id as the task's `id` and sets no
 * `toolUseId` at all (SDKMessageHandler emits `taskId: toolBlock.id`). Falling
 * back to the id is what lets such a task find the tool that spawned it — the
 * shell command or agent prompt behind it, and any tool calls it has made.
 *
 * For a task whose id is a real task id the fallback simply matches nothing,
 * which is the same as having no link.
 */
export function toolUseIdForTask(task: { id: string; toolUseId?: string }): string {
  return task.toolUseId ?? task.id;
}

/** One tool call made beneath an agent or background task. */
export interface ActivityRow {
  message: ChatMessage;
  /** 0 for a direct child, deeper for a sub-agent's own calls. */
  depth: number;
}

/**
 * Every tool call made beneath a parent tool_use, flattened in order.
 *
 * This is what a background task actually did, and it is the thing worth
 * reading while one is running: the task's own fields — summary, output file,
 * model, tokens — are only populated once it finishes, so a modal built from
 * those alone shows an empty box for the entire time the task is live.
 */
export function descendantsOf(
  messages: readonly ChatMessage[],
  parentToolUseId: string,
): ActivityRow[] {
  const children = childrenByParent(messages);
  const rows: ActivityRow[] = [];
  const visiting = new Set<string>();

  function walk(parentId: string, depth: number): void {
    if (visiting.has(parentId)) return; // malformed chains must not hang the UI
    visiting.add(parentId);
    for (const child of children.get(parentId) ?? []) {
      if (!child.toolUse) continue;
      rows.push({ message: child, depth });
      const childId = child.toolUse.toolUseBlockId;
      if (childId) walk(childId, depth + 1);
    }
    visiting.delete(parentId);
  }

  walk(parentToolUseId, 0);
  return rows;
}

/**
 * Transitive count of tool_use descendants per parent, for the "N actions"
 * pill. Guards against a cycle, which a malformed parent chain could create.
 */
export function descendantCounts(messages: readonly ChatMessage[]): Map<string, number> {
  const children = childrenByParent(messages);
  const counts = new Map<string, number>();
  const visiting = new Set<string>();

  function count(id: string): number {
    const cached = counts.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let n = 0;
    for (const kid of children.get(id) ?? []) {
      if (!kid.toolUse) continue;
      n += 1;
      const kidId = kid.toolUse.toolUseBlockId;
      if (kidId) n += count(kidId);
    }
    visiting.delete(id);
    counts.set(id, n);
    return n;
  }

  for (const m of messages) {
    const id = m.toolUse?.toolUseBlockId;
    if (id) count(id);
  }
  return counts;
}

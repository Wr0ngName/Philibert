/**
 * Which tool calls appear in the main conversation.
 *
 * Written to answer a reported bug with data rather than argument: tool use
 * from background tasks and agents was appearing in the main discussion. These
 * reproduce the exact message shapes the store builds and show when a child
 * escapes its parent.
 */

import { describe, it, expect } from 'vitest';

import type { ChatMessage } from '@shared/types';

import {
  ORPHAN_PARENT_LABEL,
  ORPHAN_PARENT_PREFIX,
  childrenByParent,
  descendantCounts,
  descendantsOf,
  knownToolUseIds,
  splitTopLevel,
  toolUseIdForTask,
  topLevelSequence,
} from '../message-tree';

let seq = 0;

/** An assistant tool_use message, as addAutoToolUseMessage builds it. */
function toolUse(
  blockId: string,
  toolName: string,
  parentToolUseId?: string,
): ChatMessage {
  seq += 1;
  return {
    id: `msg-${seq}`,
    role: 'assistant',
    content: '',
    timestamp: seq,
    toolUse: {
      actionId: blockId,
      toolName,
      description: `${toolName} call`,
      status: 'approved',
      toolUseBlockId: blockId,
      ...(parentToolUseId ? { parentToolUseId } : {}),
    },
  };
}

/** A background-task message, as addBackgroundTaskMessage builds it. */
function backgroundTask(taskId: string, toolUseId?: string): ChatMessage {
  seq += 1;
  return {
    id: `msg-${seq}`,
    role: 'assistant',
    content: '',
    timestamp: seq,
    backgroundTask: {
      taskId,
      description: 'Install Unity editor',
      status: 'running',
      ...(toolUseId ? { toolUseId } : {}),
    },
  };
}

function userMessage(content: string): ChatMessage {
  seq += 1;
  return { id: `msg-${seq}`, role: 'user', content, timestamp: seq };
}

describe('the healthy case', () => {
  it('keeps an agent\'s tool calls out of the main conversation', () => {
    const messages = [
      userMessage('do the thing'),
      toolUse('toolu_task', 'Task'),
      toolUse('toolu_read', 'Read', 'toolu_task'),
      toolUse('toolu_edit', 'Edit', 'toolu_task'),
    ];

    const { topLevel, orphans } = splitTopLevel(messages);

    expect(topLevel.map((m) => m.toolUse?.toolName ?? m.role)).toEqual(['user', 'Task']);
    expect(orphans).toEqual([]);
    expect(childrenByParent(messages).get('toolu_task')).toHaveLength(2);
  });

  it('counts nested descendants for the pill', () => {
    const messages = [
      toolUse('toolu_outer', 'Task'),
      toolUse('toolu_inner', 'Task', 'toolu_outer'),
      toolUse('toolu_grep', 'Grep', 'toolu_inner'),
    ];

    expect(descendantCounts(messages).get('toolu_outer')).toBe(2);
  });

  it('survives a cyclic parent chain', () => {
    const a = toolUse('toolu_a', 'Task', 'toolu_b');
    const b = toolUse('toolu_b', 'Task', 'toolu_a');

    expect(() => descendantCounts([a, b])).not.toThrow();
  });
});

describe('the reported bug: an agent\'s tool calls reach the main conversation', () => {
  it('reproduces it — losing the parent promotes every child', () => {
    // This is what the 1000-message cap did. It spliced the OLDEST messages
    // off, and a parent agent invocation is always older than the tool calls
    // it makes, so the parent went first and the children kept arriving.
    const full = [
      userMessage('do the thing'),
      toolUse('toolu_task', 'Task'),
      toolUse('toolu_read', 'Read', 'toolu_task'),
      toolUse('toolu_edit', 'Edit', 'toolu_task'),
    ];

    // Drop the two oldest, exactly as `sink.splice(0, removeCount)` did.
    const truncated = full.slice(2);

    const promoted = splitTopLevel(truncated, 'promote');
    expect(promoted.topLevel.map((m) => m.toolUse?.toolName)).toEqual(['Read', 'Edit']);

    // With the parent gone, the agent's Read and Edit read as Claude's own
    // work in the main thread. That is the bug as the user sees it.
    expect(promoted.orphans).toHaveLength(2);
  });

  it('quarantines orphans instead of promoting them', () => {
    const truncated = [
      toolUse('toolu_read', 'Read', 'toolu_task'),
      toolUse('toolu_edit', 'Edit', 'toolu_task'),
    ];

    const { topLevel, orphans } = splitTopLevel(truncated, 'quarantine');

    // Nothing pretends to be main-thread activity...
    expect(topLevel).toEqual([]);
    // ...but nothing is silently dropped either, so the caller can still show
    // it as agent activity. Disappearing was the other half of the old
    // trade-off and is no better than mislabelling.
    expect(orphans).toHaveLength(2);
  });

  it('nests under a background task that stands in for the tool_use', () => {
    // A background task spawned by a tool is represented by a backgroundTask
    // row when its tool_use capture never produced a message. Children name
    // the tool_use id, so the row has to answer for it or they all orphan.
    const messages = [
      userMessage('install it'),
      backgroundTask('task-1', 'toolu_bash'),
      toolUse('toolu_read', 'Read', 'toolu_bash'),
    ];

    const { topLevel, orphans } = splitTopLevel(messages);

    expect(orphans).toEqual([]);
    expect(topLevel).toHaveLength(2);
    expect(knownToolUseIds(messages).has('toolu_bash')).toBe(true);
  });

  it('still orphans when the background task has no tool_use link', () => {
    // A true background command has no tool_use id, so nothing claims the
    // child. It must be quarantined rather than promoted.
    const messages = [
      backgroundTask('task-1'),
      toolUse('toolu_read', 'Read', 'toolu_missing'),
    ];

    const { topLevel, orphans } = splitTopLevel(messages);

    expect(topLevel.map((m) => m.backgroundTask?.taskId)).toEqual(['task-1']);
    expect(orphans).toHaveLength(1);
  });
});

describe('topLevelSequence', () => {
  it('leaves nested children out and keeps the parent', () => {
    const messages = [
      userMessage('go'),
      toolUse('toolu_task', 'Task'),
      toolUse('toolu_read', 'Read', 'toolu_task'),
    ];

    expect(topLevelSequence(messages).map((m) => m.id)).toEqual([
      messages[0].id,
      messages[1].id,
    ]);
  });

  it('inserts one stand-in parent for orphaned children', () => {
    const messages = [
      userMessage('go'),
      toolUse('toolu_read', 'Read', 'toolu_gone'),
      toolUse('toolu_edit', 'Edit', 'toolu_gone'),
    ];

    const sequence = topLevelSequence(messages);

    // The two orphans collapse behind a single agent row instead of appearing
    // as main-thread tool calls.
    expect(sequence).toHaveLength(2);
    expect(sequence[1].id).toBe(`${ORPHAN_PARENT_PREFIX}toolu_gone`);
    expect(sequence[1].toolUse?.toolUseBlockId).toBe('toolu_gone');
    expect(sequence[1].toolUse?.description).toBe(ORPHAN_PARENT_LABEL);
  });

  it('places the stand-in where the first orphan appeared', () => {
    const messages = [
      userMessage('first'),
      toolUse('toolu_read', 'Read', 'toolu_gone'),
      userMessage('second'),
    ];

    expect(topLevelSequence(messages).map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
  });

  it('gives each missing parent its own stand-in', () => {
    const messages = [
      toolUse('toolu_a', 'Read', 'toolu_gone1'),
      toolUse('toolu_b', 'Read', 'toolu_gone2'),
    ];

    expect(topLevelSequence(messages).map((m) => m.id)).toEqual([
      `${ORPHAN_PARENT_PREFIX}toolu_gone1`,
      `${ORPHAN_PARENT_PREFIX}toolu_gone2`,
    ]);
  });

  it('lets orphans nest under their stand-in', () => {
    // The stand-in claims the missing id, so the ordinary parent lookup finds
    // the children and the pill can count them.
    const messages = [
      toolUse('toolu_read', 'Read', 'toolu_gone'),
      toolUse('toolu_edit', 'Edit', 'toolu_gone'),
    ];
    const sequence = topLevelSequence(messages);
    const withStandIn = [...sequence, ...messages];

    expect(childrenByParent(withStandIn).get('toolu_gone')).toHaveLength(2);
    expect(descendantCounts(withStandIn).get('toolu_gone')).toBe(2);
  });

  it('adds no stand-in when nothing is orphaned', () => {
    const messages = [userMessage('hi'), toolUse('toolu_a', 'Read')];

    expect(
      topLevelSequence(messages).some((m) => m.id.startsWith(ORPHAN_PARENT_PREFIX)),
    ).toBe(false);
  });
});

describe('descendantsOf', () => {
  it('collects what a task actually did, in order', () => {
    // The background task modal is built from this: while a task runs, its
    // own summary/output/model fields are all still empty, so its tool calls
    // are the only thing there is to show.
    const messages = [
      backgroundTask('task-1', 'toolu_task'),
      toolUse('toolu_read', 'Read', 'toolu_task'),
      toolUse('toolu_bash', 'Bash', 'toolu_task'),
    ];

    expect(descendantsOf(messages, 'toolu_task').map((r) => r.message.toolUse?.toolName)).toEqual([
      'Read',
      'Bash',
    ]);
  });

  it('includes a sub-agent\'s own calls, deeper', () => {
    const messages = [
      toolUse('toolu_inner', 'Task', 'toolu_outer'),
      toolUse('toolu_grep', 'Grep', 'toolu_inner'),
    ];

    expect(descendantsOf(messages, 'toolu_outer')).toEqual([
      expect.objectContaining({ depth: 0 }),
      expect.objectContaining({ depth: 1 }),
    ]);
  });

  it('returns nothing for a task that has done nothing yet', () => {
    expect(descendantsOf([backgroundTask('task-1', 'toolu_task')], 'toolu_task')).toEqual([]);
  });

  it('returns nothing for an unknown parent', () => {
    expect(descendantsOf([toolUse('toolu_a', 'Read')], 'toolu_nope')).toEqual([]);
  });

  it('does not hang on a cyclic chain', () => {
    const a = toolUse('toolu_a', 'Task', 'toolu_b');
    const b = toolUse('toolu_b', 'Task', 'toolu_a');

    expect(() => descendantsOf([a, b], 'toolu_a')).not.toThrow();
  });
});

describe('toolUseIdForTask', () => {
  it('prefers the proper field when it is set', () => {
    expect(toolUseIdForTask({ id: 'task-1', toolUseId: 'toolu_x' })).toBe('toolu_x');
  });

  it('falls back to the task id', () => {
    // A backgrounded tool's first notification sends the tool_use block id as
    // the task id and sets no toolUseId (SDKMessageHandler emits
    // `taskId: toolBlock.id`). Keying only on toolUseId is why the detail
    // modal showed no command for background commands.
    expect(toolUseIdForTask({ id: 'toolu_bash' })).toBe('toolu_bash');
  });

  it('lets a task with only an id find its spawning tool', () => {
    const messages = [toolUse('toolu_bash', 'Bash')];
    const id = toolUseIdForTask({ id: 'toolu_bash' });

    expect(knownToolUseIds(messages).has(id)).toBe(true);
  });
});

describe('knownToolUseIds', () => {
  it('collects tool_use block ids', () => {
    expect(knownToolUseIds([toolUse('toolu_a', 'Read')])).toEqual(new Set(['toolu_a']));
  });

  it('collects a background task\'s tool_use id too', () => {
    expect(knownToolUseIds([backgroundTask('t1', 'toolu_b')])).toEqual(new Set(['toolu_b']));
  });

  it('ignores messages with neither', () => {
    expect(knownToolUseIds([userMessage('hi')])).toEqual(new Set());
  });
});

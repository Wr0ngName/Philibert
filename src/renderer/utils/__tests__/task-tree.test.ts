/**
 * Background tasks as a tree, for the panel. Every case here is one where a
 * task could go missing from the panel or be shown under the wrong agent.
 */

import { describe, it, expect } from 'vitest';

import type { BackgroundTask } from '@shared/types';

import { taskTreeRows } from '../task-tree';

function task(id: string, parentTaskId?: string): BackgroundTask {
  return { id, description: id, status: 'running', startedAt: 1, ...(parentTaskId ? { parentTaskId } : {}) };
}

function shape(tasks: BackgroundTask[]): [string, number][] {
  return taskTreeRows(tasks).map((r) => [r.task.id, r.depth]);
}

describe('taskTreeRows', () => {
  it('puts each task under the agent that started it, keeping order among siblings', () => {
    expect(shape([task('a'), task('main-cmd'), task('a-cmd-1', 'a'), task('a-sub', 'a'), task('sub-cmd', 'a-sub'), task('a-cmd-2', 'a')])).toEqual([
      ['a', 0],
      ['a-cmd-1', 1],
      ['a-sub', 1],
      ['sub-cmd', 2],
      ['a-cmd-2', 1],
      ['main-cmd', 0],
    ]);
  });

  it('shows a task whose agent has finished at the top rather than hiding it', () => {
    expect(shape([task('orphan', 'gone')])).toEqual([['orphan', 0]]);
  });

  it('shows every task of a malformed cycle exactly once', () => {
    const rows = shape([task('x', 'y'), task('y', 'x'), task('self', 'self')]);
    expect(rows.map(([id]) => id).sort()).toEqual(['self', 'x', 'y']);
  });
});

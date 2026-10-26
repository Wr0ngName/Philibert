/**
 * Background tasks as a tree: what the main conversation started at the top,
 * and under each agent what that agent started.
 *
 * As a flat list there was no telling a command the main conversation ran
 * from one an agent ran, and with several agents going nothing said whose
 * command was whose.
 */

import type { BackgroundTask } from '@shared/types';

export interface TaskTreeRow {
  task: BackgroundTask;
  /** 0 for a task the main conversation started; one more per agent above it. */
  depth: number;
}

/**
 * The tasks in tree order, each under the agent that started it. A task whose
 * agent is not among them — that agent has finished — is shown at the top
 * rather than hidden. Order among siblings is kept.
 */
export function taskTreeRows(tasks: readonly BackgroundTask[]): TaskTreeRow[] {
  const ids = new Set(tasks.map((t) => t.id));
  const children = new Map<string, BackgroundTask[]>();
  const roots: BackgroundTask[] = [];

  for (const task of tasks) {
    const parent = task.parentTaskId;
    if (parent && parent !== task.id && ids.has(parent)) {
      const list = children.get(parent) ?? [];
      list.push(task);
      children.set(parent, list);
    } else {
      roots.push(task);
    }
  }

  const rows: TaskTreeRow[] = [];
  const placed = new Set<string>();
  function place(task: BackgroundTask, depth: number): void {
    // A malformed chain must not hang the panel or repeat a row.
    if (placed.has(task.id)) return;
    placed.add(task.id);
    rows.push({ task, depth });
    for (const child of children.get(task.id) ?? []) place(child, depth + 1);
  }
  for (const root of roots) place(root, 0);

  // Tasks only reachable through a cycle have no root; still show them.
  for (const task of tasks) place(task, 0);
  return rows;
}

/**
 * A persistent SDK session, driven the way the real one is, for tests that
 * stand in for the SDK's `query`: it announces its session id, then stays
 * open between turns while the test decides what the CLI says and when each
 * turn ends. An iterator that simply ends makes the service tear the session
 * down, and one that never announces an id makes a second message wait on
 * `sessionReady` for ever — so neither can show a session living on.
 */

import { vi } from 'vitest';

export type OpenSession = ReturnType<typeof openSession>;

export function openSession(sdkSessionId = 'sdk-session-1') {
  const queue: unknown[] = [
    { type: 'system', subtype: 'init', session_id: sdkSessionId },
  ];
  let wake: (() => void) | null = null;
  let done = false;

  const api = {
    /** What the stand-in `query` returns. */
    iterator: {
      [Symbol.asyncIterator]: async function* () {
        while (!done) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => { wake = resolve; });
            continue;
          }
          yield queue.shift();
        }
      },
      interrupt: vi.fn(),
      supportedCommands: vi.fn().mockResolvedValue([]),
      supportedModels: vi.fn().mockResolvedValue([]),
      setModel: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    },
    /** Have the CLI say this. */
    push(message: unknown) {
      queue.push(message);
      const w = wake;
      wake = null;
      w?.();
    },
    /** End the current turn the way the CLI does, with a human-origin result. */
    endTurn() {
      api.push({
        type: 'result', subtype: 'success', session_id: sdkSessionId,
        origin: { kind: 'human' }, num_turns: 1, duration_ms: 10,
      });
    },
    /** End the stream, as the process exiting does. */
    close() {
      done = true;
      const w = wake;
      wake = null;
      w?.();
    },
  };
  return api;
}

/**
 * Let V8 release what it keeps alive "for the current job", after every test.
 *
 * V8 keeps the target of every WeakRef created or dereferenced during a job
 * alive until that job ends — and a job ends only when control returns to the
 * event loop between macrotasks. happy-dom takes WeakRefs to the elements of
 * each document it parses, and DOMPurify parses one document per sanitised
 * message. A test that only ever awaits microtasks (`nextTick`, resolved
 * promises) never ends its job, nor does the file around it, so every parsed
 * document stayed alive until the file finished.
 *
 * Measured: conversation-window-slide.test.ts held 878MB after a forced GC by
 * its last test, ~2GB RSS in all, the heap snapshot's retainer chain ending in
 * V8's `weak_refs_keep_during_job` list. That is what timed the CI worker out
 * on a 5.7GB runner. One real macrotask releases the lot (85MB → 22MB for 2000
 * sanitised messages).
 *
 * `setImmediate` is captured here, at load, because tests replace the global
 * one with fake timers, and a faked one would never run.
 */

import { afterEach } from 'vitest';

const realSetImmediate = globalThis.setImmediate;

afterEach(async () => {
  await new Promise<void>((resolve) => realSetImmediate(() => resolve()));
});

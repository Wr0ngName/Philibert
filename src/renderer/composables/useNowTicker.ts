import { onBeforeUnmount, ref, watch, type Ref } from 'vue';

/**
 * A clock that advances once a second while something needs it.
 *
 * Anything showing a live elapsed time has to read the time from a reactive
 * source. Two places needed one and only one had it: the background task
 * panel ran its own interval, and the detail modal called `Date.now()` inside
 * a computed — which is not a dependency, so that computed never recomputed
 * and the runtime it displayed was frozen from the moment the modal opened.
 *
 * `active` is a getter so the interval exists only while it is wanted: no
 * wake-ups once the panel is empty or the modal is closed.
 *
 * The visibility listener is not an optimisation. Chromium throttles timers in
 * a hidden or occluded window to roughly one wake-up a minute (and harder
 * after five minutes), and Electron leaves `backgroundThrottling` on by
 * default. So a window that has been minimised comes back showing a duration
 * that can be up to a minute stale, and stays wrong until the throttled timer
 * next fires. Re-reading the clock on the visibility change corrects it
 * immediately, which is the right trade: keep the throttling, which is there
 * to save the battery, and fix the only thing it breaks.
 */
export function useNowTicker(active: () => boolean): Ref<number> {
  const now = ref(Date.now());
  let timer: ReturnType<typeof setInterval> | null = null;

  function sync(): void {
    now.value = Date.now();
  }

  function start(): void {
    if (timer) return;
    sync();
    timer = setInterval(sync, 1000);
  }

  function stop(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  function onVisibilityChange(): void {
    if (!document.hidden && timer) sync();
  }

  document.addEventListener('visibilitychange', onVisibilityChange);

  watch(active, (on) => (on ? start() : stop()), { immediate: true });

  onBeforeUnmount(() => {
    stop();
    document.removeEventListener('visibilitychange', onVisibilityChange);
  });

  return now;
}

import { onBeforeUnmount, ref, type Ref } from 'vue';

/**
 * The time, moved on at each local midnight.
 *
 * For text that says a time alone when it is today and adds the date when it
 * is not (formatMoment): it only changes when the day does, so a clock
 * ticking every second would wake the window for nothing. A window left open
 * overnight still says "yesterday's" time with its date in the morning.
 *
 * Chromium throttles timers in a hidden window, so the timeout can fire late;
 * the clock is read again whenever the window is shown, which corrects it.
 */
export function useMidnightClock(): Ref<number> {
  const now = ref(Date.now());
  let timer: ReturnType<typeof setTimeout> | null = null;

  function schedule(): void {
    if (timer) clearTimeout(timer);
    const next = new Date(now.value);
    next.setHours(24, 0, 0, 0);
    timer = setTimeout(() => {
      now.value = Date.now();
      schedule();
    }, next.getTime() - now.value);
  }

  function onVisibilityChange(): void {
    if (document.hidden) return;
    now.value = Date.now();
    schedule();
  }

  schedule();
  document.addEventListener('visibilitychange', onVisibilityChange);

  onBeforeUnmount(() => {
    if (timer) clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  });

  return now;
}

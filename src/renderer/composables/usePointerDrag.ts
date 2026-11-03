/**
 * Following a drag from a handle: the sidebar edges and the dialog grip.
 *
 * The pointer is captured by the handle, so the drag goes on when it leaves
 * the handle — or the window — and still ends where it is released. While it
 * lasts the whole page shows the handle's cursor and selects no text, which
 * the cursor crossing the discussion would otherwise do.
 */

export interface PointerDrag {
  /** Called with how far the pointer has moved since the drag began. */
  move: (dx: number, dy: number) => void;
  /** Called once, when the pointer is released or the drag is cancelled. */
  end: () => void;
}

export function startPointerDrag(event: PointerEvent, cursor: string, drag: PointerDrag): void {
  if (event.button !== 0) return;
  event.preventDefault();
  const handle = event.currentTarget as HTMLElement;
  const { pointerId, clientX: startX, clientY: startY } = event;
  handle.setPointerCapture(pointerId);

  const body = document.body.style;
  const previous = { cursor: body.cursor, userSelect: body.userSelect };
  body.cursor = cursor;
  body.userSelect = 'none';

  function onMove(moveEvent: PointerEvent) {
    if (moveEvent.pointerId !== pointerId) return;
    drag.move(moveEvent.clientX - startX, moveEvent.clientY - startY);
  }

  function finish(endEvent: PointerEvent) {
    if (endEvent.pointerId !== pointerId) return;
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', finish);
    handle.removeEventListener('pointercancel', finish);
    handle.removeEventListener('lostpointercapture', finish);
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    body.cursor = previous.cursor;
    body.userSelect = previous.userSelect;
    drag.end();
  }

  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
  handle.addEventListener('lostpointercapture', finish);
}

/** `value` kept within [min, max]; min wins when the range is empty. */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

<script setup lang="ts">
/**
 * The right edge of a sidebar, dragged to change its width.
 *
 * The width follows the pointer while dragging (`update:width`) and is
 * reported once more when the drag ends (`commit`), so the parent saves it
 * once rather than at every pixel. Arrow keys move it too, and a double-click
 * puts it back to its default.
 */

import { RESIZE_KEY_STEP, SIDEBAR_WIDTH } from '../../constants/layout';
import { clamp, startPointerDrag } from '../../composables/usePointerDrag';

const props = defineProps<{
  width: number;
  defaultWidth: number;
  /** What the sidebar is, for screen readers: "Resize <label>". */
  label: string;
}>();

const emit = defineEmits<{
  (e: 'update:width', width: number): void;
  (e: 'commit', width: number): void;
}>();

function bounded(width: number): number {
  return clamp(Math.round(width), SIDEBAR_WIDTH.MIN, SIDEBAR_WIDTH.MAX);
}

/**
 * The width the sidebar is drawn at: less than `width` while the window is
 * too narrow for it, and the drag starts from what the user sees.
 */
function drawnWidth(handle: HTMLElement): number {
  const sidebar = handle.parentElement;
  return sidebar ? Math.round(sidebar.getBoundingClientRect().width) || props.width : props.width;
}

function onPointerDown(event: PointerEvent) {
  const startWidth = drawnWidth(event.currentTarget as HTMLElement);
  let width = startWidth;
  startPointerDrag(event, 'col-resize', {
    move: (dx) => {
      width = bounded(startWidth + dx);
      emit('update:width', width);
    },
    end: () => {
      if (width !== startWidth) emit('commit', width);
    },
  });
}

function set(width: number) {
  const next = bounded(width);
  if (next === props.width) return;
  emit('update:width', next);
  emit('commit', next);
}

function onKeydown(event: KeyboardEvent) {
  const moves: Record<string, number> = {
    ArrowLeft: props.width - RESIZE_KEY_STEP,
    ArrowRight: props.width + RESIZE_KEY_STEP,
    Home: SIDEBAR_WIDTH.MIN,
    End: SIDEBAR_WIDTH.MAX,
  };
  if (!(event.key in moves)) return;
  event.preventDefault();
  set(moves[event.key]);
}
</script>

<template>
  <div
    class="sidebar-resize-handle"
    role="separator"
    aria-orientation="vertical"
    :aria-label="`Resize ${label}`"
    :aria-valuenow="width"
    :aria-valuemin="SIDEBAR_WIDTH.MIN"
    :aria-valuemax="SIDEBAR_WIDTH.MAX"
    tabindex="0"
    title="Drag to resize, double-click to reset"
    @pointerdown="onPointerDown"
    @dblclick="set(defaultWidth)"
    @keydown="onKeydown"
  />
</template>

<style scoped>
.sidebar-resize-handle {
  position: absolute;
  top: 0;
  right: -3px;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  z-index: 10;
  touch-action: none;
}

.sidebar-resize-handle:hover,
.sidebar-resize-handle:focus-visible {
  background-color: var(--color-primary-400);
  outline: none;
}
</style>

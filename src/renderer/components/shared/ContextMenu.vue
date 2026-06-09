<script setup lang="ts">
/**
 * Lightweight right-click context menu.
 *
 * Renders a floating menu at viewport coordinates, dismisses on outside
 * click, Escape, or any window event that would invalidate the menu
 * (scroll, blur, resize). Items are passed in; the consumer decides what
 * happens when each is clicked.
 */
import { onMounted, onUnmounted, ref, watch, nextTick } from 'vue';

export interface ContextMenuItem {
  /** Display label */
  label: string;
  /** Click handler */
  onSelect: () => void | Promise<void>;
  /** Disable the item (still rendered, greyed out) */
  disabled?: boolean;
}

interface Props {
  /** Whether the menu is open */
  open: boolean;
  /** Viewport-relative anchor (typically the contextmenu event's clientX/clientY) */
  x: number;
  y: number;
  /** Items to show */
  items: ContextMenuItem[];
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const menuRef = ref<HTMLElement | null>(null);

/** Clamp the menu inside the viewport so it never renders partially off-screen. */
const clamped = ref({ x: 0, y: 0 });

async function reclamp(): Promise<void> {
  await nextTick();
  const el = menuRef.value;
  if (!el) {
    clamped.value = { x: props.x, y: props.y };
    return;
  }
  const margin = 8;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const maxX = window.innerWidth - w - margin;
  const maxY = window.innerHeight - h - margin;
  clamped.value = {
    x: Math.max(margin, Math.min(props.x, maxX)),
    y: Math.max(margin, Math.min(props.y, maxY)),
  };
}

watch(
  () => [props.open, props.x, props.y],
  () => {
    if (props.open) {
      void reclamp();
    }
  },
);

function close(): void {
  emit('close');
}

function onDocumentMousedown(event: MouseEvent): void {
  if (!props.open) return;
  if (menuRef.value && menuRef.value.contains(event.target as Node)) return;
  close();
}

function onKeydown(event: KeyboardEvent): void {
  if (!props.open) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
  }
}

function onScrollOrResize(): void {
  if (props.open) close();
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentMousedown);
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('scroll', onScrollOrResize, true);
  window.addEventListener('resize', onScrollOrResize);
  window.addEventListener('blur', onScrollOrResize);
});

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocumentMousedown);
  document.removeEventListener('keydown', onKeydown);
  window.removeEventListener('scroll', onScrollOrResize, true);
  window.removeEventListener('resize', onScrollOrResize);
  window.removeEventListener('blur', onScrollOrResize);
});

async function handleItemClick(item: ContextMenuItem): Promise<void> {
  if (item.disabled) return;
  close();
  await Promise.resolve(item.onSelect());
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="menuRef"
      class="fixed z-[100] min-w-[160px] py-1 rounded-md shadow-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800"
      :style="{ left: `${clamped.x}px`, top: `${clamped.y}px` }"
      role="menu"
    >
      <button
        v-for="(item, idx) in items"
        :key="idx"
        type="button"
        :disabled="item.disabled"
        :class="[
          'w-full text-left px-3 py-1.5 text-sm transition-colors',
          item.disabled
            ? 'text-surface-400 dark:text-surface-500 cursor-not-allowed'
            : 'text-surface-700 dark:text-surface-200 hover:bg-surface-100 dark:hover:bg-surface-700',
        ]"
        role="menuitem"
        @click="handleItemClick(item)"
      >
        {{ item.label }}
      </button>
    </div>
  </Teleport>
</template>

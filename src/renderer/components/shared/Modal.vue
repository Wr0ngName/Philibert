<script setup lang="ts">
/**
 * Modal dialog component
 */

import { computed, onMounted, onUnmounted, watch, ref, nextTick } from 'vue';

import type { ModalSize } from '@shared/types';

import Icon from './Icon.vue';
import TransitionFade from './TransitionFade.vue';
import { clamp, startPointerDrag } from '../../composables/usePointerDrag';
import { MODAL_SIZE, RESIZE_KEY_STEP } from '../../constants/layout';
import { useSettingsStore } from '../../stores/settings';
import { generateId, ID_PREFIXES } from '../../utils/id';

interface Props {
  /** Whether the modal is open */
  open: boolean;
  /** Modal title (displayed in header) */
  title?: string;
  /** Modal size preset */
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl';
  /** Whether clicking the overlay closes the modal */
  closeOnOverlay?: boolean;
  /** Whether pressing Escape closes the modal */
  closeOnEscape?: boolean;
  /** Accessible description for screen readers */
  ariaDescription?: string;
  /**
   * Makes the dialog resizable from a grip in its corner, and names it for
   * the size to be remembered by: dialogs that share a key share a size.
   */
  resizeKey?: string;
}

const props = withDefaults(defineProps<Props>(), {
  title: '',
  size: 'md',
  closeOnOverlay: true,
  closeOnEscape: true,
  ariaDescription: '',
  resizeKey: undefined,
});

// Only a resizable dialog reaches for the settings, so the others stay
// usable without a store.
const settingsStore = props.resizeKey ? useSettingsStore() : null;
/** The size a drag has given the dialog, before it is saved. */
const draggedSize = ref<ModalSize | null>(null);
const savedSize = computed<ModalSize | null>(() =>
  props.resizeKey ? settingsStore?.config.modalSizes[props.resizeKey] ?? null : null,
);

/** A size kept within the window, however large it was when it was saved. */
function fitted(size: ModalSize): ModalSize {
  const margin = 2 * MODAL_SIZE.VIEWPORT_MARGIN;
  return {
    width: Math.round(clamp(size.width, MODAL_SIZE.MIN_WIDTH, window.innerWidth - margin)),
    height: Math.round(clamp(size.height, MODAL_SIZE.MIN_HEIGHT, window.innerHeight - margin)),
  };
}

const customSize = computed<ModalSize | null>(() => {
  const size = draggedSize.value ?? savedSize.value;
  return size ? fitted(size) : null;
});

const contentStyle = computed(() =>
  customSize.value
    ? { width: `${customSize.value.width}px`, height: `${customSize.value.height}px`, maxWidth: 'none' }
    : undefined,
);

function onGripPointerDown(event: PointerEvent) {
  const box = modalContentRef.value;
  if (!box || !props.resizeKey) return;
  const key = props.resizeKey;
  const start = { width: box.offsetWidth, height: box.offsetHeight };
  startPointerDrag(event, 'nwse-resize', {
    // The dialog stays centred, so it grows on both sides: twice the
    // pointer's move keeps its corner under the pointer.
    move: (dx, dy) => {
      draggedSize.value = fitted({ width: start.width + 2 * dx, height: start.height + 2 * dy });
    },
    end: () => {
      const dragged = draggedSize.value;
      if (dragged && (dragged.width !== start.width || dragged.height !== start.height)) {
        // A plain copy: the ref's value is a reactive proxy, which cannot be
        // sent to the main process.
        void saveSize(key, { width: dragged.width, height: dragged.height }).finally(() => {
          draggedSize.value = null;
        });
      } else {
        draggedSize.value = null;
      }
    },
  });
}

/**
 * Save a size, or forget it with null. A save that fails is logged and
 * reported by the store; the dialog keeps the size it had saved before.
 */
async function saveSize(key: string, size: ModalSize | null): Promise<void> {
  try {
    await settingsStore?.setModalSize(key, size);
  } catch {
    // Reported by the store (saveConfig).
  }
}

function resetSize() {
  draggedSize.value = null;
  if (props.resizeKey) void saveSize(props.resizeKey, null);
}

function onGripKeydown(event: KeyboardEvent) {
  const box = modalContentRef.value;
  if (!box || !props.resizeKey) return;
  const steps: Record<string, [number, number]> = {
    ArrowLeft: [-RESIZE_KEY_STEP, 0],
    ArrowRight: [RESIZE_KEY_STEP, 0],
    ArrowUp: [0, -RESIZE_KEY_STEP],
    ArrowDown: [0, RESIZE_KEY_STEP],
  };
  const step = steps[event.key];
  if (!step) return;
  event.preventDefault();
  void saveSize(
    props.resizeKey,
    fitted({ width: box.offsetWidth + step[0], height: box.offsetHeight + step[1] }),
  );
}

// Generate unique IDs for ARIA attributes using consistent utility
const modalId = generateId(ID_PREFIXES.MODAL);
const titleId = `${modalId}-title`;
const descId = `${modalId}-desc`;

// Reference to the modal content for focus management
const modalContentRef = ref<HTMLElement | null>(null);
const previousActiveElement = ref<Element | null>(null);

const emit = defineEmits<{
  (e: 'close'): void;
}>();

function handleOverlayClick() {
  if (props.closeOnOverlay) {
    emit('close');
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && props.closeOnEscape) {
    emit('close');
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown);
  // Restore body scroll if component unmounts while open
  if (props.open) {
    document.body.style.overflow = '';
  }
});

// Lock body scroll and manage focus when modal is open
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      // Save the currently focused element to restore later
      previousActiveElement.value = document.activeElement;
      document.body.style.overflow = 'hidden';

      // Focus the modal content after it renders
      nextTick(() => {
        if (modalContentRef.value) {
          modalContentRef.value.focus();
        }
      });
    } else {
      document.body.style.overflow = '';

      // Restore focus to the previously focused element
      if (previousActiveElement.value instanceof HTMLElement) {
        previousActiveElement.value.focus();
      }
    }
  },
  { immediate: true }
);

const sizeClasses = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
  '3xl': 'max-w-3xl',
};
</script>

<template>
  <Teleport to="body">
    <TransitionFade type="fade">
      <div
        v-if="open"
        class="fixed inset-0 z-50 flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="title ? titleId : undefined"
        :aria-describedby="ariaDescription ? descId : undefined"
      >
        <!-- Overlay -->
        <div
          class="absolute inset-0 bg-black/50"
          @click="handleOverlayClick"
        />

        <!-- Modal content -->
        <TransitionFade type="scale">
          <div
            v-if="open"
            ref="modalContentRef"
            tabindex="-1"
            :class="[
              'relative w-full flex flex-col bg-white dark:bg-surface-800 rounded-xl shadow-xl outline-hidden',
              sizeClasses[size],
            ]"
            :style="contentStyle"
          >
            <!-- Header -->
            <div
              v-if="title || $slots.header"
              class="flex items-center justify-between px-6 py-4 border-b border-surface-200 dark:border-surface-700"
            >
              <slot name="header">
                <h2
                  :id="titleId"
                  class="text-lg font-semibold text-surface-900 dark:text-surface-100"
                >
                  {{ title }}
                </h2>
              </slot>
              <!-- Hidden description for screen readers -->
              <span
                v-if="ariaDescription"
                :id="descId"
                class="sr-only"
              >
                {{ ariaDescription }}
              </span>
              <button
                class="btn-icon -mr-2"
                aria-label="Close"
                @click="emit('close')"
              >
                <Icon
                  name="close"
                  size="md"
                />
              </button>
            </div>

            <!-- Body -->
            <!-- A dialog given a size fills it; otherwise it fits its content. -->
            <div
              :class="[
                'px-6 py-4 overflow-y-auto',
                customSize ? 'flex-1 min-h-0' : 'max-h-[calc(100vh-12rem)]',
              ]"
            >
              <slot />
            </div>

            <!-- Footer -->
            <div
              v-if="$slots.footer"
              class="flex items-center justify-end gap-3 px-6 py-4 border-t border-surface-200 dark:border-surface-700"
            >
              <slot name="footer" />
            </div>

            <div
              v-if="resizeKey"
              class="modal-resize-grip"
              role="separator"
              aria-label="Resize dialog"
              tabindex="0"
              title="Drag to resize, double-click to reset"
              @pointerdown="onGripPointerDown"
              @dblclick="resetSize"
              @keydown="onGripKeydown"
            />
          </div>
        </TransitionFade>
      </div>
    </TransitionFade>
  </Teleport>
</template>

<style scoped>
/* A corner grip: two diagonal strokes, as resizable windows draw it. */
.modal-resize-grip {
  position: absolute;
  right: 2px;
  bottom: 2px;
  width: 14px;
  height: 14px;
  cursor: nwse-resize;
  touch-action: none;
  border-bottom-right-radius: 0.75rem;
  background:
    linear-gradient(135deg, transparent 45%, var(--color-surface-400) 45%, var(--color-surface-400) 55%, transparent 55%),
    linear-gradient(135deg, transparent 72%, var(--color-surface-400) 72%, var(--color-surface-400) 82%, transparent 82%);
  opacity: 0.7;
}

.modal-resize-grip:hover,
.modal-resize-grip:focus-visible {
  opacity: 1;
  outline: none;
}
</style>

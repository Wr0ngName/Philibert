<script setup lang="ts">
/**
 * Modal dialog component
 */

import { onMounted, onUnmounted, watch, ref, nextTick } from 'vue';
import Icon from './Icon.vue';
import TransitionFade from './TransitionFade.vue';
import { generateId, ID_PREFIXES } from '../../utils/id';

interface Props {
  /** Whether the modal is open */
  open: boolean;
  /** Modal title (displayed in header) */
  title?: string;
  /** Modal size preset */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Whether clicking the overlay closes the modal */
  closeOnOverlay?: boolean;
  /** Whether pressing Escape closes the modal */
  closeOnEscape?: boolean;
  /** Accessible description for screen readers */
  ariaDescription?: string;
}

const props = withDefaults(defineProps<Props>(), {
  title: '',
  size: 'md',
  closeOnOverlay: true,
  closeOnEscape: true,
  ariaDescription: '',
});

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
              'relative w-full bg-white dark:bg-surface-800 rounded-xl shadow-xl outline-none',
              sizeClasses[size],
            ]"
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
            <div class="px-6 py-4 overflow-y-auto max-h-[calc(100vh-12rem)]">
              <slot />
            </div>

            <!-- Footer -->
            <div
              v-if="$slots.footer"
              class="flex items-center justify-end gap-3 px-6 py-4 border-t border-surface-200 dark:border-surface-700"
            >
              <slot name="footer" />
            </div>
          </div>
        </TransitionFade>
      </div>
    </TransitionFade>
  </Teleport>
</template>

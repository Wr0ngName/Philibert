<script setup lang="ts">
/**
 * Toast notification component
 */

import { computed } from 'vue';
import type { IconName } from './Icon.vue';
import Icon from './Icon.vue';

interface Props {
  /** Toast type determines icon and color scheme */
  type?: 'info' | 'success' | 'warning' | 'error';
  /** Message content to display */
  message: string;
  /** Whether the toast can be dismissed */
  dismissible?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  type: 'info',
  dismissible: true,
});

const emit = defineEmits<{
  (e: 'dismiss'): void;
}>();

const typeStyles = computed(() => {
  switch (props.type) {
    case 'success':
      return {
        bg: 'bg-green-50 dark:bg-green-900/20',
        border: 'border-green-500',
        icon: 'text-green-500',
      };
    case 'warning':
      return {
        bg: 'bg-yellow-50 dark:bg-yellow-900/20',
        border: 'border-yellow-500',
        icon: 'text-yellow-500',
      };
    case 'error':
      return {
        bg: 'bg-red-50 dark:bg-red-900/20',
        border: 'border-red-500',
        icon: 'text-red-500',
      };
    default:
      return {
        bg: 'bg-blue-50 dark:bg-blue-900/20',
        border: 'border-blue-500',
        icon: 'text-blue-500',
      };
  }
});

const icons: Record<string, IconName> = {
  info: 'info',
  success: 'check-circle',
  warning: 'warning',
  error: 'x-circle',
};
</script>

<template>
  <div
    :class="[
      'flex items-start gap-3 p-4 rounded-lg border-l-4',
      typeStyles.bg,
      typeStyles.border,
    ]"
    role="alert"
  >
    <Icon
      :name="icons[type]"
      size="md"
      :class="['shrink-0', typeStyles.icon]"
    />

    <p class="flex-1 text-sm text-surface-700 dark:text-surface-300">
      {{ message }}
    </p>

    <button
      v-if="dismissible"
      class="btn-icon shrink-0 -mr-2 -mt-1"
      aria-label="Dismiss"
      @click="emit('dismiss')"
    >
      <Icon
        name="close"
        size="sm"
      />
    </button>
  </div>
</template>

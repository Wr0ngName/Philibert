<script setup lang="ts">
/**
 * Reusable button component
 */

import Icon from './Icon.vue';

interface Props {
  /** Button style variant */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
  /** Button size preset */
  size?: 'sm' | 'md' | 'lg';
  /** Whether the button is disabled */
  disabled?: boolean;
  /** Whether to show a loading spinner */
  loading?: boolean;
  /** HTML button type attribute */
  type?: 'button' | 'submit' | 'reset';
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'primary',
  size: 'md',
  disabled: false,
  loading: false,
  type: 'button',
});

const emit = defineEmits<{
  (e: 'click', event: MouseEvent): void;
}>();

function handleClick(event: MouseEvent) {
  if (!props.disabled && !props.loading) {
    emit('click', event);
  }
}

const variantClasses = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
  success: 'btn-success',
};

/**
 * Each size carries a minimum height as well as padding.
 *
 * Without it a button's height came from its content, so an icon-only button
 * ended up shorter than one with a label beside the same icon — the icon is
 * 16px and a line of text is 20px, so they differed by 4px and sat visibly
 * mismatched next to each other (the dictate button against Send/Stop in the
 * chat input, among others).
 *
 * The minimums are the heights the labelled buttons already had, so labelled
 * buttons do not move and icon-only ones grow to match. `min-h` rather than
 * `h`, so a button with unusual content — two lines, a larger icon — can still
 * grow instead of overflowing.
 */
const sizeClasses = {
  sm: 'min-h-7 px-3 py-1.5 text-xs',
  md: 'min-h-9 px-4 py-2 text-sm',
  lg: 'min-h-12 px-6 py-3 text-base',
};
</script>

<template>
  <button
    :type="type"
    :disabled="disabled || loading"
    :class="[
      variantClasses[variant],
      sizeClasses[size],
      { 'opacity-50 cursor-not-allowed': disabled || loading },
    ]"
    @click="handleClick"
  >
    <Icon
      v-if="loading"
      name="loading"
      size="sm"
      class="animate-spin -ml-1 mr-2"
    />
    <slot />
  </button>
</template>

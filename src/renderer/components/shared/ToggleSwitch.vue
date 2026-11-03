<script setup lang="ts">
/**
 * An on/off switch, announced as one: role="switch" with its state in
 * aria-checked, and a label for what it turns on.
 */

interface Props {
  /** Whether it is on. */
  modelValue: boolean;
  /** What it turns on, for assistive technology. */
  label: string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
}>();
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="props.modelValue"
    :aria-label="label"
    :class="[
      'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
      props.modelValue ? 'bg-primary-600' : 'bg-surface-300 dark:bg-surface-600',
    ]"
    @click="emit('update:modelValue', !props.modelValue)"
  >
    <span
      :class="[
        'inline-block h-4 w-4 rounded-full bg-white transition-transform',
        props.modelValue ? 'translate-x-6' : 'translate-x-1',
      ]"
    />
  </button>
</template>

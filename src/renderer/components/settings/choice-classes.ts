/** A choice button of the settings, chosen or not. */
export function choiceClasses(chosen: boolean): string {
  return chosen
    ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300'
    : 'border-surface-300 dark:border-surface-600 text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-700';
}

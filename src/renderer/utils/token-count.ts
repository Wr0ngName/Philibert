/**
 * A token count as the CLI writes it on a task's row: "160.8k", "1.2M".
 *
 * One formatter for every count shown — the usage bar and the background
 * tasks had a copy each, which already disagreed on the case of the k.
 */
export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

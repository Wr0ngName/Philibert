/**
 * Turn a raw model identifier like "claude-sonnet-4-5-20250929" into a
 * human-readable label like "Sonnet 4.5". Returns the input unchanged if it
 * doesn't match the expected shape, so unknown / family-alias values still
 * render something readable.
 */
export function formatModelId(modelId: string): string {
  const match = modelId.match(/claude-(\w+)-(\d+)-?(\d+)?/);
  if (!match) return modelId;
  const family = match[1].charAt(0).toUpperCase() + match[1].slice(1);
  const version = match[3] ? `${match[2]}.${match[3]}` : match[2];
  return `${family} ${version}`;
}

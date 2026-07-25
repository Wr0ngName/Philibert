/**
 * Renderer-side model helpers.
 *
 * The parsing itself lives in @shared/model-id so main and renderer can never
 * disagree about what `claude-opus-5` means. Re-exported here to keep existing
 * renderer imports working.
 */
export { formatModelId } from '@shared/model-id';

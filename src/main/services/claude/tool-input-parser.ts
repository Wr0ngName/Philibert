/**
 * Parser for unknown tool inputs displayed in the permission approval UI.
 *
 * Most MCP tools (PowerShell, custom commands…) share a small set of common
 * input keys: a long "command/script/prompt/query" string, an optional
 * "description", and a handful of scalar fields like file paths or URLs.
 * This parser extracts those into a structured GenericToolDetails so the UI
 * can render each piece with appropriate formatting — instead of dumping
 * `JSON.stringify(input)` into a one-line code block.
 *
 * Used by:
 *  - SDK mode: PermissionManager.createPendingAction default case
 *  - Channel mode: ChannelService.buildPermissionAction default case
 *    (input may be a truncated JSON string from input_preview)
 */

import type { GenericToolDetails, GenericToolField } from '../../../shared/types';

/**
 * Fields treated as "primary" — they're long strings the user mainly cares
 * about (commands, scripts, prompts). Ordered by priority; first match wins.
 */
const PRIMARY_FIELD_KEYS = [
  'command',
  'script',
  'code',
  'sql',
  'query',
  'prompt',
  'content',
  'body',
  'text',
] as const;

/**
 * Build a GenericToolDetails from a tool input object.
 *
 * @param input  The raw input object passed to the tool
 * @param truncated  Optional flag: true when `input` came from a clipped source
 *                   (e.g. channel-mode input_preview)
 */
export function parseGenericToolInput(
  input: unknown,
  truncated = false,
): GenericToolDetails {
  // Defensive: only plain objects produce a usable rawInput; everything else
  // (null, arrays, primitives) gets an empty shell.
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      rawInput: {},
      secondaryFields: [],
      jsonFields: [],
      ...(truncated ? { truncated: true } : {}),
    };
  }

  const obj = input as Record<string, unknown>;
  const details: GenericToolDetails = {
    rawInput: obj,
    secondaryFields: [],
    jsonFields: [],
    ...(truncated ? { truncated: true } : {}),
  };

  // Extract input.description (if it's a string)
  const inputDescription = typeof obj.description === 'string' ? obj.description : '';
  if (inputDescription) {
    details.inputDescription = inputDescription;
  }

  // Find the primary text field (first matching key with a non-empty string value)
  let primaryKey: string | null = null;
  for (const key of PRIMARY_FIELD_KEYS) {
    const val = obj[key];
    if (typeof val === 'string' && val.length > 0) {
      primaryKey = key;
      details.primaryText = { label: key, content: val };
      break;
    }
  }

  // Collect remaining fields
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'description' && key in obj && typeof value === 'string') continue;
    if (key === primaryKey) continue;

    if (value === null || value === undefined) continue;

    if (typeof value === 'string') {
      details.secondaryFields.push({
        label: key,
        value,
        multiline: value.includes('\n'),
      });
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      details.secondaryFields.push({
        label: key,
        value: String(value),
        multiline: false,
      });
    } else {
      // Object or array → render as compact JSON
      try {
        details.jsonFields.push({
          label: key,
          json: JSON.stringify(value, null, 2),
        });
      } catch {
        details.jsonFields.push({ label: key, json: '[unserializable]' });
      }
    }
  }

  return details;
}

/**
 * Pick a human-readable card title for a generic tool action.
 *
 *  - When the input carries a short `description`, prefix the tool name with it
 *    (`PowerShell: Run audit script`).
 *  - Otherwise fall back to `Tool: PowerShell`.
 *
 * Truncates long descriptions to keep the header on one line.
 */
export function buildGenericToolDescription(toolName: string, details: GenericToolDetails): string {
  const desc = details.inputDescription;
  if (desc) {
    const trimmed = desc.length > 80 ? desc.slice(0, 79) + '…' : desc;
    return `${toolName}: ${trimmed}`;
  }
  return `Tool: ${toolName}`;
}

/** Convenience re-export of the field shape for callers that need it. */
export type { GenericToolField };

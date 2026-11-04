/**
 * Claude Code's permission asks, read as the CLI wrote them.
 *
 * The SDK hands `canUseTool` only some of a `can_use_tool` control request's
 * fields, and leaves out `classifier_approvable`: whether a safety check
 * behind the ask (a dangerous `rm`, a Windows path bypass, …) lets anything
 * but a person approve it. Measured against CLI 2.1.280: such an ask comes
 * even when the tool is allowed — by a settings rule, by `allowedTools`, and
 * by an allow rule for that exact command — with `classifier_approvable:
 * false` and no suggestions. Nothing can be remembered for it, so it is
 * allowed once, by the person, every time.
 *
 * The field is read off the CLI's stdout on its way to the SDK: every chunk
 * passes through unchanged, and a request is noted before the SDK reads it,
 * so before `canUseTool` is called for it.
 */

import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

/** What the CLI said about one permission ask that the SDK does not pass on. */
export interface CanUseToolRequest {
  /** The tool use asked about: `canUseTool`'s `toolUseID`. */
  toolUseId: string;
  /** A safety check requires a person to approve this, once (`classifier_approvable: false`). */
  manualApprovalRequired: boolean;
}

/** The part of the control request read here, as the CLI writes it. */
interface RawControlRequest {
  type?: unknown;
  request?: {
    subtype?: unknown;
    tool_use_id?: unknown;
    classifier_approvable?: unknown;
  };
}

/** The CLI writes one JSON message per line; only these lines can be an ask. */
const CAN_USE_TOOL_MARKER = '"can_use_tool"';

function parseCanUseToolRequest(line: string): CanUseToolRequest | null {
  if (!line.includes(CAN_USE_TOOL_MARKER)) return null;
  let message: RawControlRequest;
  try {
    message = JSON.parse(line) as RawControlRequest;
  } catch {
    return null;
  }
  const request = message.request;
  if (message.type !== 'control_request' || request?.subtype !== 'can_use_tool') return null;
  if (typeof request.tool_use_id !== 'string') return null;
  return {
    toolUseId: request.tool_use_id,
    manualApprovalRequired: request.classifier_approvable === false,
  };
}

/**
 * A pass-through for the CLI's stdout that reports each permission ask in it.
 * Its output is its input, byte for byte.
 */
export function observeCanUseToolRequests(onRequest: (request: CanUseToolRequest) => void): Transform {
  const decoder = new StringDecoder('utf8');
  let partialLine = '';

  const inspect = (text: string): void => {
    let start = 0;
    for (let newline = text.indexOf('\n'); newline !== -1; newline = text.indexOf('\n', start)) {
      const line = partialLine + text.slice(start, newline);
      partialLine = '';
      start = newline + 1;
      const request = parseCanUseToolRequest(line);
      if (request) onRequest(request);
    }
    partialLine += text.slice(start);
  };

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      inspect(decoder.write(chunk));
      callback(null, chunk);
    },
    flush(callback) {
      inspect(`${decoder.end()}\n`);
      callback();
    },
  });
}

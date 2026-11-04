import { describe, expect, it } from 'vitest';

import { observeCanUseToolRequests, type CanUseToolRequest } from '../can-use-tool-requests';

// As CLI 2.1.280 wrote it for `rm -rf /` (probe, 2026-11-04).
const ASK = '{"type":"control_request","request_id":"f2a28a79","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"rm -rf /"},"permission_suggestions":[],"decision_reason":"Dangerous rm operation on critical path: /","decision_reason_type":"safetyCheck","classifier_approvable":false,"tool_use_id":"toolu_danger"}}';
const ORDINARY_ASK = '{"type":"control_request","request_id":"3d9da364","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"rm -rf build"},"permission_suggestions":[],"tool_use_id":"toolu_build"}}';

/** Writes the chunks through an observer; what came out and what it reported. */
async function observe(chunks: Buffer[]): Promise<{ out: Buffer; requests: CanUseToolRequest[] }> {
  const requests: CanUseToolRequest[] = [];
  const observer = observeCanUseToolRequests((request) => requests.push(request));
  const out: Buffer[] = [];
  observer.on('data', (chunk: Buffer) => out.push(chunk));
  const ended = new Promise((resolve) => observer.on('end', resolve));
  for (const chunk of chunks) observer.write(chunk);
  observer.end();
  await ended;
  return { out: Buffer.concat(out), requests };
}

/** The bytes, split at every given offset. */
function split(bytes: Buffer, ...offsets: number[]): Buffer[] {
  const bounds = [0, ...offsets, bytes.length];
  return bounds.slice(1).map((end, i) => bytes.subarray(bounds[i], end));
}

describe('observeCanUseToolRequests', () => {
  it('passes the stream on byte for byte, a character split across chunks included', async () => {
    const bytes = Buffer.from(`{"type":"assistant","text":"Supprimé — ✓"}\n${ASK}\n{"type":"result"}\n`);
    const accented = bytes.indexOf(Buffer.from('é'));
    const { out, requests } = await observe(split(bytes, accented + 1, bytes.indexOf('can_use_tool') + 4, bytes.length - 3));

    expect(out.equals(bytes)).toBe(true);
    expect(requests).toEqual([{ toolUseId: 'toolu_danger', manualApprovalRequired: true }]);
  });

  it('reports an ask with no safety check as one anything may answer', async () => {
    const { requests } = await observe([Buffer.from(`${ORDINARY_ASK}\n`)]);
    expect(requests).toEqual([{ toolUseId: 'toolu_build', manualApprovalRequired: false }]);
  });

  it('reads the last line though no newline ends it', async () => {
    const { requests } = await observe([Buffer.from(ASK)]);
    expect(requests).toEqual([{ toolUseId: 'toolu_danger', manualApprovalRequired: true }]);
  });

  it('reports nothing for other lines that name the subtype, or are not JSON', async () => {
    const lines = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"\\"can_use_tool\\" is a subtype"}]}}',
      '{"type":"control_response","response":{"subtype":"can_use_tool"}}',
      'not json "can_use_tool"',
      '{"type":"control_request","request":{"subtype":"can_use_tool"}}',
    ];
    const { requests } = await observe([Buffer.from(`${lines.join('\n')}\n`)]);
    expect(requests).toEqual([]);
  });
});

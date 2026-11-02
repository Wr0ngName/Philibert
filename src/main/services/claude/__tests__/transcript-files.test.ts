/**
 * Finding the CLI's transcripts by session and agent id, in a folder laid out
 * as the CLI lays it out.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { findAgentTranscript, findSessionTranscript } from '../transcript-files';

describe('transcript files', () => {
  let config: string;
  let project: string;

  beforeEach(() => {
    config = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-config-'));
    project = path.join(config, 'projects', 'C--Users-someone-project');
    fs.mkdirSync(path.join(config, 'projects', 'another-project'), { recursive: true });
    fs.mkdirSync(path.join(project, 'session-1', 'subagents', 'agent-a1'), { recursive: true });
    fs.writeFileSync(path.join(project, 'session-1.jsonl'), '');
    fs.writeFileSync(path.join(project, 'session-1', 'subagents', 'agent-a1.jsonl'), '');
    // An agent started by agent a1 is filed under a1's folder.
    fs.writeFileSync(path.join(project, 'session-1', 'subagents', 'agent-a1', 'agent-a2.jsonl'), '');
  });

  afterEach(() => fs.rmSync(config, { recursive: true, force: true }));

  it('finds a session by its id, whatever its project folder is called', () => {
    expect(findSessionTranscript('session-1', config)).toBe(path.join(project, 'session-1.jsonl'));
    expect(findSessionTranscript('session-2', config)).toBeNull();
  });

  it("finds an agent's transcript, an agent's agent's included", () => {
    const agents = path.join(project, 'session-1', 'subagents');
    expect(findAgentTranscript('session-1', 'a1', config)).toBe(path.join(agents, 'agent-a1.jsonl'));
    expect(findAgentTranscript('session-1', 'a2', config)).toBe(path.join(agents, 'agent-a1', 'agent-a2.jsonl'));
    expect(findAgentTranscript('session-1', 'a3', config)).toBeNull();
  });

  it('finds nothing when the CLI has no projects folder', () => {
    expect(findSessionTranscript('session-1', path.join(config, 'nowhere'))).toBeNull();
  });
});

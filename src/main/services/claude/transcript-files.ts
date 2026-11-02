/**
 * Where the CLI keeps a session's transcript, and an agent's.
 *
 *   <config>/projects/<project>/<sessionId>.jsonl
 *   <config>/projects/<project>/<sessionId>/subagents/…/agent-<agentId>.jsonl
 *
 * <project> is the working directory escaped by the CLI's own rule, which is
 * not reproduced here: the session id is unique, so the project folder is
 * found by looking for it. An agent started by an agent is filed under that
 * agent's folder, hence the search under `subagents`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { cliConfigDir } from './cliCredentials';

/** The session's own transcript, or null when no project folder holds one. */
export function findSessionTranscript(sessionId: string, configDir: string = cliConfigDir()): string | null {
  const projectsDir = path.join(configDir, 'projects');
  const fileName = `${sessionId}.jsonl`;
  let projects: string[];
  try {
    projects = fs.readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const project of projects) {
    const candidate = path.join(projectsDir, project, fileName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** An agent's transcript in a session, or null when it has none on disk. */
export function findAgentTranscript(
  sessionId: string,
  agentId: string,
  configDir: string = cliConfigDir(),
): string | null {
  const session = findSessionTranscript(sessionId, configDir);
  if (!session) return null;
  const fileName = `agent-${agentId}.jsonl`;
  const pending = [path.join(session.slice(0, -'.jsonl'.length), 'subagents')];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) pending.push(path.join(dir, entry.name));
      else if (entry.name === fileName) return path.join(dir, entry.name);
    }
  }
  return null;
}

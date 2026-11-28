/**
 * What the shell sandbox needs installed before a sandboxed discussion can
 * start, checked before the CLI is: the CLI refuses to start without it
 * (failIfUnavailable) and says so in words meant for its own settings —
 * "Set sandbox.failIfUnavailable=false to allow unsandboxed execution" —
 * which is not something a user of this app does. Checked here, the
 * discussion says what to install, or that its sandbox can be turned off.
 *
 * Linux: bubblewrap runs the commands, socat carries their network traffic
 * to the CLI's proxy — the two tools the CLI 2.1.280 names when they are
 * missing ("install missing tools (e.g. apt install bubblewrap socat)").
 * macOS: Seatbelt, part of the system. Windows: the CLI's own check is the
 * only one — its sandbox is set up by `/sandbox install`, not by a program on
 * the PATH — and its error is shown as it comes.
 */

import fs from 'node:fs';
import path from 'node:path';

const LINUX_TOOLS = ['bwrap', 'socat'] as const;

/** Whether an executable of that name is on a PATH. */
function onPath(name: string, pathValue: string): boolean {
  return pathValue.split(path.delimiter).filter(Boolean).some((dir) => {
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** The programs the sandbox needs on this platform that are not installed. */
export function missingSandboxTools(platform: NodeJS.Platform, pathValue: string): string[] {
  if (platform !== 'linux') return [];
  return LINUX_TOOLS.filter((tool) => !onPath(tool, pathValue));
}

/** What a sandboxed discussion that cannot start says. */
export function sandboxUnavailableNotice(missing: string[]): string {
  return `This discussion runs shell commands in a sandbox, and the sandbox cannot start: ${missing.join(' and ')} `
    + `${missing.length === 1 ? 'is' : 'are'} not installed. Install ${missing.length === 1 ? 'it' : 'them'} `
    + '(for example: sudo apt install bubblewrap socat), or turn the sandbox off for this discussion '
    + 'in its permissions menu (the shield) — its commands then run unrestricted.';
}

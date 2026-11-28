/**
 * The sandbox Claude Code runs shell commands in, as this app sets it up.
 *
 * Sandboxed, a command (Bash, PowerShell) can write only inside the working
 * folder and the paths listed here, and reach only the hosts listed here or
 * allowed when it asks — enforced by the operating system (bubblewrap on
 * Linux, Seatbelt on macOS), not by matching command lines. Measured on CLI
 * 2.1.280: a sandboxed `touch` outside the folder fails with "Read-only file
 * system", whatever was approved.
 *
 * Not sandboxed, a command runs as the user and can change anything the
 * user's account can, anywhere on the computer.
 */

/** The app's sandbox settings: what new discussions start with, and what a sandboxed one may do. */
export interface SandboxPreferences {
  /**
   * Whether a new discussion runs its shell commands sandboxed. Changing one
   * discussion's sandbox does not change this.
   */
  enabledByDefault: boolean;
  /** Hosts sandboxed commands may reach without asking (`example.com`, `*.npmjs.org`). */
  allowedDomains: string[];
  /** Directories outside the working folder sandboxed commands may write (`~/.npm`). */
  allowWrite: string[];
}

/**
 * Whether the sandbox is on by default on a platform.
 *
 * Off on native Windows: its sandbox runs commands as a separate user that a
 * one-time `/sandbox install` in Claude Code sets up, with an administrator
 * prompt — on by default, every discussion would fail to start until that was
 * done. On Linux it needs bubblewrap and socat; a discussion that cannot start
 * its sandbox says so and starts nothing (failIfUnavailable), it never runs
 * unsandboxed in its place.
 */
export function sandboxOnByDefault(platform: string): boolean {
  return platform !== 'win32';
}

export function defaultSandboxPreferences(platform: string): SandboxPreferences {
  return { enabledByDefault: sandboxOnByDefault(platform), allowedDomains: [], allowWrite: [] };
}

/**
 * A host as the sandbox's network allow list takes it: a name, optionally
 * starting with `*.` for its subdomains. No scheme, path or port.
 */
export function isSandboxDomain(value: string): boolean {
  return /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(value) && value.length <= 253;
}

/** A path the sandbox's write list takes: absolute, or from the home folder (`~/`). */
export function isSandboxPath(value: string): boolean {
  return /^(\/|~\/|~$|[a-zA-Z]:[\\/])/.test(value);
}

/** The preferences with every list entry trimmed, deduplicated and valid. */
export function cleanSandboxPreferences(preferences: SandboxPreferences): SandboxPreferences {
  const clean = (values: string[], valid: (v: string) => boolean) =>
    [...new Set(values.map((v) => v.trim()).filter((v) => v.length > 0 && valid(v)))];
  return {
    enabledByDefault: preferences.enabledByDefault === true,
    allowedDomains: clean(preferences.allowedDomains, isSandboxDomain),
    allowWrite: clean(preferences.allowWrite, isSandboxPath),
  };
}

/** What a sandboxed shell command may do, as the approval card says it. */
export const SANDBOXED_SHELL_SUMMARY =
  "Sandboxed: it can change files only inside this discussion's folder (and the folders allowed in Settings), and reach only the sites allowed.";

/** What an unsandboxed shell command may do, as the approval card says it. */
export const UNSANDBOXED_SHELL_SUMMARY =
  'Not sandboxed: it runs as you, and can read, change or delete anything your account can, anywhere on this computer.';

/**
 * The `sandbox` settings a discussion's Claude Code process starts with, in
 * the CLI's settings shape (the SDK's `sandbox` option, or `sandbox` in a
 * settings file).
 *
 * Sandboxed, measured on CLI 2.1.280:
 * - `allowUnsandboxedCommands: false`: a command the model asks to run
 *   outside the sandbox (`dangerouslyDisableSandbox`) runs inside it all the
 *   same, even under an allow rule for the whole tool (probes P12, P19).
 *   With it true, such a rule let the command out without asking (P7).
 * - `autoAllowBashIfSandboxed: false`: a sandboxed command is still asked
 *   for, as it is unsandboxed; true, every command runs unasked (P5b).
 * - `failIfUnavailable: true`: a sandbox that cannot start stops the
 *   discussion with an error; it never runs the commands unsandboxed (P11b).
 *
 * Not sandboxed, `enabled: false` is given all the same, so a sandbox the
 * user's own Claude Code settings turn on does not make the discussion's
 * commands behave otherwise than the discussion says: these are the flag
 * layer, above the user's settings.
 */
export function cliSandboxSettings(sandboxed: boolean, preferences: SandboxPreferences) {
  if (!sandboxed) return { enabled: false };
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: false,
    network: { allowedDomains: [...preferences.allowedDomains] },
    filesystem: { allowWrite: [...preferences.allowWrite] },
  };
}

/** The tool the CLI asks with when a sandboxed command wants a host not allowed yet; its input is `{ host }`. */
export const SANDBOX_NETWORK_TOOL = 'SandboxNetworkAccess';

/**
 * The session rule that lets sandboxed commands reach a host: a WebFetch
 * domain rule — the one the CLI itself suggests for the ask, and measured to
 * open the host to sandboxed commands, live (P14). Neither a rule for
 * SandboxNetworkAccess (P15) nor a bare WebFetch rule (P16) opens any host.
 */
export function networkRuleContent(host: string): string {
  return `domain:${host}`;
}

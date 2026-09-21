/**
 * MCP server management for the active project.
 *
 * Claude Code discovers project MCP servers from two files in the working
 * directory, and both are required before a server contributes any tools:
 *
 *   <project>/.mcp.json                    server definitions
 *   <project>/.claude/settings.local.json  which of them are approved
 *
 * A definition without an approval is not a no-op. In SDK mode the CLI reports
 * the server as `pending` and silently exposes none of its tools; in channel
 * mode the interactive CLI raises a "New MCP server found in this project"
 * dialog that neither of ChannelSession's PTY handlers answers, so the session
 * can sit at the prompt. This service therefore always writes both files
 * together — that pairing is the whole reason it exists.
 *
 * Approval precedence, verified against claude-code 2.1.220:
 *   disabledMcpjsonServers  beats  enabledMcpjsonServers
 *                           beats  enableAllProjectMcpServers
 * so disabling is expressed by adding to the disabled list rather than by
 * removing from the enabled one — that is the only form that also overrides a
 * blanket `enableAllProjectMcpServers: true` the user may have set by hand.
 *
 * Both files belong to the user and may hold keys we know nothing about, so
 * every write is a merge onto the parsed original.
 *
 * @see docs/mcp-servers.md
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  McpCommandCheck,
  McpRuntimeInfo,
  McpServerEntry,
  McpServerInput,
  McpTransport,
} from '../../shared/types';
import { ConfigurationError, ValidationError, ERROR_CODES } from '../errors';
import logger from '../utils/logger';
import { WindowsPaths } from '../utils/resourcePaths';

/** Server names are used verbatim in `mcp__<name>__<tool>` tool identifiers. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Philibert's own channel server uses this name; a project one would collide. */
const RESERVED_SERVER_NAMES = new Set(['philibert']);

/**
 * Commands that can never resolve in a Philibert-only install. Philibert
 * bundles a bare `node.exe` on Windows and no Node at all elsewhere — see
 * scripts/download-node-windows.sh, which extracts only node.exe — so no
 * package runner is present on any platform.
 */
const PACKAGE_RUNNERS = new Set(['npx', 'npm', 'pnpm', 'pnpx', 'yarn', 'bunx', 'uvx', 'pipx']);

interface RawSettings {
  enableAllProjectMcpServers?: boolean;
  enabledMcpjsonServers?: string[];
  disabledMcpjsonServers?: string[];
  [key: string]: unknown;
}

interface RawMcpConfig {
  mcpServers?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

export class McpConfigService {
  /** Absolute path of the project's `.mcp.json`. */
  getConfigPath(workingDirectory: string): string {
    return path.join(workingDirectory, '.mcp.json');
  }

  /** Absolute path of the project's `.claude/settings.local.json`. */
  getApprovalsPath(workingDirectory: string): string {
    return path.join(workingDirectory, '.claude', 'settings.local.json');
  }

  /**
   * Host facts the settings UI needs. Kept in the main process so the renderer
   * never has to guess at paths or touch the filesystem.
   */
  getRuntimeInfo(workingDirectory: string): McpRuntimeInfo {
    let bundledNodePath: string | null = null;
    if (process.platform === 'win32' && WindowsPaths.hasBundledNode()) {
      bundledNodePath = WindowsPaths.getBundledNodeExe();
    }

    return {
      platform: process.platform,
      bundledNodePath,
      configPath: this.getConfigPath(workingDirectory),
      approvalsPath: this.getApprovalsPath(workingDirectory),
    };
  }

  /**
   * Every server declared in the project's `.mcp.json`, with its approval
   * state and — for stdio entries — whether the command can actually run.
   *
   * Returns an empty list when the project has no `.mcp.json`; that is the
   * normal state for a project with no servers, not an error.
   */
  list(workingDirectory: string): McpServerEntry[] {
    const config = this.readJson<RawMcpConfig>(this.getConfigPath(workingDirectory));
    const settings = this.readJson<RawSettings>(this.getApprovalsPath(workingDirectory));
    const servers = config.mcpServers ?? {};

    return Object.entries(servers).map(([name, raw]) =>
      this.toEntry(name, raw, settings)
    );
  }

  /**
   * Create a server, or update an existing one.
   *
   * @param previousName - name currently stored, when editing. Pass null to
   *   create. When it differs from `input.name` the entry is renamed, which
   *   also moves its approval so a rename never silently unapproves a server.
   */
  save(
    workingDirectory: string,
    previousName: string | null,
    input: McpServerInput
  ): McpServerEntry[] {
    const server = this.validateInput(input);
    const configPath = this.getConfigPath(workingDirectory);
    const config = this.readJson<RawMcpConfig>(configPath);
    const servers = { ...(config.mcpServers ?? {}) };

    const renaming = previousName !== null && previousName !== server.name;
    if (renaming) {
      if (!(previousName in servers)) {
        throw new ValidationError(
          `There is no server named "${previousName}" to rename.`,
          'previousName',
          ERROR_CODES.VALIDATION_REQUIRED
        );
      }
      delete servers[previousName];
    }

    const isNew = previousName === null;
    if (isNew && server.name in servers) {
      throw new ValidationError(
        `A server named "${server.name}" already exists in this project.`,
        'name',
        ERROR_CODES.VALIDATION_TYPE_MISMATCH
      );
    }
    if (renaming && server.name in servers) {
      throw new ValidationError(
        `A server named "${server.name}" already exists in this project.`,
        'name',
        ERROR_CODES.VALIDATION_TYPE_MISMATCH
      );
    }

    servers[server.name] = this.toRawServer(server);
    this.writeJson(configPath, { ...config, mcpServers: servers });

    // A server the user just added is meant to be used, so approve it in the
    // same operation. Without this the definition is inert and, in channel
    // mode, can stall the next session on an unanswered trust dialog.
    this.updateApprovals(workingDirectory, (settings) => {
      if (renaming) {
        this.removeName(settings, previousName);
      }
      this.approveName(settings, server.name);
    });

    logger.info('Saved MCP server', {
      name: server.name,
      transport: server.transport,
      renamedFrom: renaming ? previousName : undefined,
    });

    return this.list(workingDirectory);
  }

  /**
   * Delete a server from `.mcp.json` and drop its approval entries, so a later
   * server reusing the name does not inherit this one's approval.
   */
  remove(workingDirectory: string, name: string): McpServerEntry[] {
    const configPath = this.getConfigPath(workingDirectory);
    const config = this.readJson<RawMcpConfig>(configPath);
    const servers = { ...(config.mcpServers ?? {}) };

    if (!(name in servers)) {
      throw new ValidationError(
        `There is no server named "${name}" in this project.`,
        'name',
        ERROR_CODES.VALIDATION_REQUIRED
      );
    }

    delete servers[name];
    this.writeJson(configPath, { ...config, mcpServers: servers });
    this.updateApprovals(workingDirectory, (settings) => this.removeName(settings, name));

    logger.info('Removed MCP server', { name });
    return this.list(workingDirectory);
  }

  /**
   * Turn a server on or off without deleting its definition.
   *
   * Disabling writes to `disabledMcpjsonServers` because that is the only key
   * that also overrides a blanket `enableAllProjectMcpServers: true`.
   */
  setEnabled(workingDirectory: string, name: string, enabled: boolean): McpServerEntry[] {
    const config = this.readJson<RawMcpConfig>(this.getConfigPath(workingDirectory));
    if (!(config.mcpServers ?? {})[name]) {
      throw new ValidationError(
        `There is no server named "${name}" in this project.`,
        'name',
        ERROR_CODES.VALIDATION_REQUIRED
      );
    }

    this.updateApprovals(workingDirectory, (settings) => {
      if (enabled) {
        this.approveName(settings, name);
      } else {
        this.denyName(settings, name);
      }
    });

    logger.info('Changed MCP server approval', { name, enabled });
    return this.list(workingDirectory);
  }

  /**
   * Whether a stdio command can be launched from the packaged app.
   *
   * A bare command name is resolved against the main process's own PATH,
   * because that is literally the environment the CLI subprocess inherits
   * (ChannelSession and ClaudeCodeService both spawn with `...process.env`).
   * Checking there rather than assuming makes the answer true for this
   * machine: a desktop-launched app on macOS or Linux usually has a much
   * narrower PATH than the user's terminal, while on Windows the bundled Git
   * Bash directories genuinely are on it.
   */
  checkCommand(command: string): McpCommandCheck {
    const trimmed = command.trim();

    if (trimmed.length === 0) {
      return {
        ok: false,
        problem: 'not-absolute',
        message: 'Enter the full path to the program.',
      };
    }

    const base = path.basename(trimmed).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();

    let resolved = trimmed;
    if (!path.isAbsolute(trimmed)) {
      // Package runners are hopeless regardless of PATH: Philibert bundles a
      // bare node.exe and no package manager, so say so specifically rather
      // than leaving the user to read "not found" and go looking for a path.
      if (PACKAGE_RUNNERS.has(base)) {
        return {
          ok: false,
          problem: 'no-package-runner',
          message:
            `Philibert does not include ${base}. Choose a server that ships a ready-made ` +
            'program file, or use a web address instead.',
        };
      }

      const onPath = this.resolveOnPath(trimmed);
      if (!onPath) {
        return {
          ok: false,
          problem: 'not-absolute',
          message:
            'Philibert cannot find a program by that name. Use the full path — ' +
            'click Browse to pick the file.',
        };
      }
      resolved = onPath;
    }

    if (!fs.existsSync(resolved)) {
      return {
        ok: false,
        problem: 'not-found',
        message: 'No file at that path. Check the location, or click Browse to pick it.',
      };
    }

    if (process.platform !== 'win32') {
      try {
        fs.accessSync(resolved, fs.constants.X_OK);
      } catch {
        return {
          ok: false,
          problem: 'not-executable',
          message:
            'That file is not marked as runnable. In a terminal run: ' +
            `chmod +x "${resolved}"`,
        };
      }
    }

    return { ok: true };
  }

  /**
   * Find a bare command name on the PATH the spawned CLI will actually have.
   *
   * On Windows that is the enhanced PATH the app builds for subprocesses (it
   * prepends the bundled Git Bash directories), and the name is tried against
   * PATHEXT so `foo` matches `foo.exe`. Returns the resolved absolute path, or
   * null when nothing matches.
   */
  private resolveOnPath(command: string): string | null {
    // A relative path like `./bin/server` is not a PATH lookup; resolving it
    // would depend on the app's cwd, which is not the project folder.
    if (command.includes('/') || command.includes('\\')) return null;

    const isWindows = process.platform === 'win32';
    const searchPath = isWindows
      ? WindowsPaths.buildEnhancedPath()
      : process.env.PATH ?? '';
    const extensions = isWindows
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];

    for (const dir of searchPath.split(path.delimiter)) {
      if (!dir) continue;
      for (const ext of extensions) {
        const candidate = path.join(dir, command + ext);
        try {
          if (fs.statSync(candidate).isFile()) return candidate;
        } catch {
          // Unreadable or missing entry — keep looking.
        }
      }
    }

    return null;
  }

  // ---------------------------------------------------------------- internals

  /**
   * Normalise and validate renderer input. Throws {@link ValidationError} with
   * a message written for a non-technical user, since it is shown verbatim.
   */
  private validateInput(input: McpServerInput): McpServerInput {
    if (!input || typeof input !== 'object') {
      throw new ValidationError('No server details were provided.', 'server', ERROR_CODES.VALIDATION_REQUIRED);
    }

    const name = String(input.name ?? '').trim();
    if (!SERVER_NAME_PATTERN.test(name)) {
      throw new ValidationError(
        'The name must start with a letter or number and contain only letters, numbers, hyphens and underscores.',
        'name',
        ERROR_CODES.VALIDATION_TYPE_MISMATCH
      );
    }
    if (RESERVED_SERVER_NAMES.has(name.toLowerCase())) {
      throw new ValidationError(
        `"${name}" is reserved by Philibert. Pick a different name.`,
        'name',
        ERROR_CODES.VALIDATION_TYPE_MISMATCH
      );
    }

    const transport = input.transport;
    if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') {
      throw new ValidationError(
        'Choose whether this server is a program on this computer or a web address.',
        'transport',
        ERROR_CODES.VALIDATION_TYPE_MISMATCH
      );
    }

    if (transport === 'stdio') {
      const command = String(input.command ?? '').trim();
      if (command.length === 0) {
        throw new ValidationError(
          'Choose the program to run.',
          'command',
          ERROR_CODES.VALIDATION_REQUIRED
        );
      }
      return {
        name,
        transport,
        command,
        args: this.cleanArgs(input.args),
        env: this.cleanPairs(input.env),
      };
    }

    const url = String(input.url ?? '').trim();
    if (!/^https?:\/\/\S+$/i.test(url)) {
      throw new ValidationError(
        'Enter a web address starting with http:// or https://.',
        'url',
        ERROR_CODES.VALIDATION_TYPE_MISMATCH
      );
    }
    return {
      name,
      transport,
      url,
      headers: this.cleanPairs(input.headers),
    };
  }

  /**
   * Trim each argument and drop the blanks. A whitespace-only argument is
   * always an editing artefact — the form is line-based — and passing one
   * through would hand the server an empty positional argument.
   */
  private cleanArgs(args: string[] | undefined): string[] | undefined {
    if (!Array.isArray(args)) return undefined;
    const cleaned = args.map((a) => String(a).trim()).filter((a) => a.length > 0);
    return cleaned.length > 0 ? cleaned : undefined;
  }

  private cleanPairs(
    pairs: Record<string, string> | undefined
  ): Record<string, string> | undefined {
    if (!pairs || typeof pairs !== 'object') return undefined;
    const cleaned: Record<string, string> = {};
    for (const [key, value] of Object.entries(pairs)) {
      const k = key.trim();
      if (k.length === 0) continue;
      cleaned[k] = String(value ?? '');
    }
    return Object.keys(cleaned).length > 0 ? cleaned : undefined;
  }

  /** Shape one validated server the way `.mcp.json` expects it. */
  private toRawServer(server: McpServerInput): Record<string, unknown> {
    if (server.transport === 'stdio') {
      return {
        type: 'stdio',
        command: server.command,
        ...(server.args ? { args: server.args } : {}),
        ...(server.env ? { env: server.env } : {}),
      };
    }
    return {
      type: server.transport,
      url: server.url,
      ...(server.headers ? { headers: server.headers } : {}),
    };
  }

  /** Build a UI entry from a stored definition plus the approval settings. */
  private toEntry(
    name: string,
    raw: Record<string, unknown>,
    settings: RawSettings
  ): McpServerEntry {
    const transport = this.readTransport(raw);
    const entry: McpServerEntry = {
      name,
      transport,
      enabled: this.isEnabled(name, settings),
    };

    if (transport === 'stdio') {
      entry.command = typeof raw.command === 'string' ? raw.command : '';
      entry.args = Array.isArray(raw.args) ? raw.args.map((a) => String(a)) : undefined;
      entry.env = this.cleanPairs(raw.env as Record<string, string> | undefined);
      entry.check = this.checkCommand(entry.command);
    } else {
      entry.url = typeof raw.url === 'string' ? raw.url : '';
      entry.headers = this.cleanPairs(raw.headers as Record<string, string> | undefined);
    }

    return entry;
  }

  /**
   * `type` is optional in `.mcp.json` and defaults to stdio, so infer from the
   * shape when it is absent rather than mislabelling a remote server.
   */
  private readTransport(raw: Record<string, unknown>): McpTransport {
    const declared = typeof raw.type === 'string' ? raw.type.toLowerCase() : '';
    if (declared === 'http' || declared === 'sse') return declared;
    if (declared === 'stdio') return 'stdio';
    return typeof raw.url === 'string' && raw.url.length > 0 ? 'http' : 'stdio';
  }

  /** Mirrors the CLI's precedence: disabled beats enabled beats enable-all. */
  private isEnabled(name: string, settings: RawSettings): boolean {
    if (this.listOf(settings.disabledMcpjsonServers).includes(name)) return false;
    if (this.listOf(settings.enabledMcpjsonServers).includes(name)) return true;
    return settings.enableAllProjectMcpServers === true;
  }

  private listOf(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  }

  private approveName(settings: RawSettings, name: string): void {
    settings.disabledMcpjsonServers = this.listOf(settings.disabledMcpjsonServers)
      .filter((n) => n !== name);
    const enabled = this.listOf(settings.enabledMcpjsonServers);
    if (!enabled.includes(name)) enabled.push(name);
    settings.enabledMcpjsonServers = enabled;

    if (settings.disabledMcpjsonServers.length === 0) {
      delete settings.disabledMcpjsonServers;
    }
  }

  private denyName(settings: RawSettings, name: string): void {
    settings.enabledMcpjsonServers = this.listOf(settings.enabledMcpjsonServers)
      .filter((n) => n !== name);
    const disabled = this.listOf(settings.disabledMcpjsonServers);
    if (!disabled.includes(name)) disabled.push(name);
    settings.disabledMcpjsonServers = disabled;

    if (settings.enabledMcpjsonServers.length === 0) {
      delete settings.enabledMcpjsonServers;
    }
  }

  /** Drop a name from both lists — used when the server itself is going away. */
  private removeName(settings: RawSettings, name: string): void {
    const enabled = this.listOf(settings.enabledMcpjsonServers).filter((n) => n !== name);
    const disabled = this.listOf(settings.disabledMcpjsonServers).filter((n) => n !== name);

    if (enabled.length > 0) settings.enabledMcpjsonServers = enabled;
    else delete settings.enabledMcpjsonServers;

    if (disabled.length > 0) settings.disabledMcpjsonServers = disabled;
    else delete settings.disabledMcpjsonServers;
  }

  /** Read-modify-write the approvals file, preserving every unrelated key. */
  private updateApprovals(workingDirectory: string, mutate: (settings: RawSettings) => void): void {
    const approvalsPath = this.getApprovalsPath(workingDirectory);
    const settings = this.readJson<RawSettings>(approvalsPath);
    mutate(settings);
    this.writeJson(approvalsPath, settings);
  }

  /**
   * Parse a JSON file, treating "missing" as "empty".
   *
   * A file that exists but does not parse is an error: overwriting it would
   * destroy hand-written configuration, so the user is told to fix it instead.
   */
  private readJson<T extends object>(filePath: string): T {
    if (!fs.existsSync(filePath)) return {} as T;

    let text: string;
    try {
      text = fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
      throw new ConfigurationError(
        `Could not read ${path.basename(filePath)}.`,
        ERROR_CODES.CONFIG_LOAD_FAILED,
        error
      );
    }

    if (text.trim().length === 0) return {} as T;

    try {
      const parsed = JSON.parse(text);
      return (parsed && typeof parsed === 'object' ? parsed : {}) as T;
    } catch (error) {
      throw new ConfigurationError(
        `${path.basename(filePath)} is not valid JSON, so Philibert will not overwrite it. ` +
          `Fix or delete the file at ${filePath} and try again.`,
        ERROR_CODES.CONFIG_INVALID,
        error
      );
    }
  }

  private writeJson(filePath: string, value: object): void {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf-8');
    } catch (error) {
      throw new ConfigurationError(
        `Could not save ${path.basename(filePath)}.`,
        ERROR_CODES.CONFIG_SAVE_FAILED,
        error
      );
    }
  }
}

export default McpConfigService;

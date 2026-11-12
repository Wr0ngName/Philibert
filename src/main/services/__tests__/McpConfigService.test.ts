/**
 * Tests for McpConfigService.
 *
 * These run against a real temp directory rather than a mocked fs, because the
 * behaviour that matters is exactly what ends up on disk: Claude Code reads
 * these two files, and a merge that silently drops a user's unrelated keys
 * would be invisible to a mock-based test.
 *
 * The approval precedence asserted here (disabled beats enabled beats
 * enable-all) was verified against claude-code 2.1.220 by running the CLI with
 * each combination and reading the `mcp_servers` status from its init message.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../utils/resourcePaths', () => ({
  WindowsPaths: {
    hasBundledNode: () => false,
    getBundledNodeExe: () => 'C:\\Philibert\\resources\\node.exe',
    buildEnhancedPath: () => process.env.PATH || '',
  },
}));

vi.mock('../../utils/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { McpConfigService } from '../McpConfigService';

let projectDir: string;
let service: McpConfigService;

/** An existing program path, for stdio entries that should pass the check. */
const realProgram = process.execPath;

function readMcpJson(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf-8'));
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(projectDir, '.claude', 'settings.local.json'), 'utf-8')
  );
}

function writeMcpJson(value: unknown): void {
  fs.writeFileSync(path.join(projectDir, '.mcp.json'), JSON.stringify(value, null, 2));
}

function writeSettings(value: unknown): void {
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, '.claude', 'settings.local.json'),
    JSON.stringify(value, null, 2)
  );
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'philibert-mcp-'));
  service = new McpConfigService();
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe('list', () => {
  it('returns an empty list when the project has no .mcp.json', () => {
    expect(service.list(projectDir)).toEqual([]);
  });

  it('reports a server as disabled when nothing approves it', () => {
    writeMcpJson({ mcpServers: { gsc: { command: realProgram } } });

    const [entry] = service.list(projectDir);
    expect(entry.name).toBe('gsc');
    expect(entry.enabled).toBe(false);
  });

  it('honours enableAllProjectMcpServers', () => {
    writeMcpJson({ mcpServers: { gsc: { command: realProgram } } });
    writeSettings({ enableAllProjectMcpServers: true });

    expect(service.list(projectDir)[0].enabled).toBe(true);
  });

  it('honours an explicit enabledMcpjsonServers entry', () => {
    writeMcpJson({ mcpServers: { gsc: { command: realProgram } } });
    writeSettings({ enabledMcpjsonServers: ['gsc'] });

    expect(service.list(projectDir)[0].enabled).toBe(true);
  });

  it('lets disabledMcpjsonServers override enableAllProjectMcpServers', () => {
    writeMcpJson({ mcpServers: { gsc: { command: realProgram } } });
    writeSettings({ enableAllProjectMcpServers: true, disabledMcpjsonServers: ['gsc'] });

    expect(service.list(projectDir)[0].enabled).toBe(false);
  });

  it('lets disabledMcpjsonServers override enabledMcpjsonServers', () => {
    writeMcpJson({ mcpServers: { gsc: { command: realProgram } } });
    writeSettings({ enabledMcpjsonServers: ['gsc'], disabledMcpjsonServers: ['gsc'] });

    expect(service.list(projectDir)[0].enabled).toBe(false);
  });

  it('infers the http transport from a url when type is absent', () => {
    writeMcpJson({ mcpServers: { remote: { url: 'https://example.com/mcp' } } });

    const [entry] = service.list(projectDir);
    expect(entry.transport).toBe('http');
    expect(entry.url).toBe('https://example.com/mcp');
    expect(entry.check).toBeUndefined();
  });

  it('treats a server with neither type nor url as stdio', () => {
    writeMcpJson({ mcpServers: { local: { command: realProgram } } });

    expect(service.list(projectDir)[0].transport).toBe('stdio');
  });

  it('attaches a command check to stdio entries', () => {
    writeMcpJson({ mcpServers: { broken: { command: '/nope/does-not-exist' } } });

    expect(service.list(projectDir)[0].check).toMatchObject({
      ok: false,
      problem: 'not-found',
    });
  });

  it('refuses to read a .mcp.json that is not valid JSON', () => {
    fs.writeFileSync(path.join(projectDir, '.mcp.json'), '{ not json');

    expect(() => service.list(projectDir)).toThrow(/not valid JSON/);
  });
});

describe('save', () => {
  it('writes the definition and approves it in one operation', () => {
    service.save(projectDir, null, {
      name: 'gsc',
      transport: 'stdio',
      command: realProgram,
    });

    expect(readMcpJson()).toMatchObject({
      mcpServers: { gsc: { type: 'stdio', command: realProgram } },
    });
    expect(readSettings().enabledMcpjsonServers).toEqual(['gsc']);
  });

  it('returns the refreshed list with the new server enabled', () => {
    const list = service.save(projectDir, null, {
      name: 'gsc',
      transport: 'stdio',
      command: realProgram,
    });

    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'gsc', enabled: true });
  });

  it('preserves unrelated keys in .mcp.json', () => {
    writeMcpJson({
      $schema: 'https://example.com/schema.json',
      mcpServers: { existing: { command: realProgram } },
    });

    service.save(projectDir, null, { name: 'added', transport: 'stdio', command: realProgram });

    const config = readMcpJson();
    expect(config.$schema).toBe('https://example.com/schema.json');
    expect(Object.keys(config.mcpServers as object).sort()).toEqual(['added', 'existing']);
  });

  it('preserves unrelated keys in settings.local.json', () => {
    writeSettings({ permissions: { allow: ['Bash(ls:*)'] }, model: 'opus' });

    service.save(projectDir, null, { name: 'gsc', transport: 'stdio', command: realProgram });

    const settings = readSettings();
    expect(settings.permissions).toEqual({ allow: ['Bash(ls:*)'] });
    expect(settings.model).toBe('opus');
    expect(settings.enabledMcpjsonServers).toEqual(['gsc']);
  });

  it('stores a remote server with its url and headers', () => {
    service.save(projectDir, null, {
      name: 'remote',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' },
    });

    expect(readMcpJson()).toMatchObject({
      mcpServers: {
        remote: {
          type: 'http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer token' },
        },
      },
    });
  });

  it('drops empty argument and variable entries', () => {
    service.save(projectDir, null, {
      name: 'gsc',
      transport: 'stdio',
      command: realProgram,
      args: ['--real', '', '  '],
      env: { GOOD: 'yes', '  ': 'dropped' },
    });

    const server = (readMcpJson().mcpServers as Record<string, Record<string, unknown>>).gsc;
    expect(server.args).toEqual(['--real']);
    expect(server.env).toEqual({ GOOD: 'yes' });
  });

  it('omits args and env entirely when they are empty', () => {
    service.save(projectDir, null, {
      name: 'gsc',
      transport: 'stdio',
      command: realProgram,
      args: [],
      env: {},
    });

    const server = (readMcpJson().mcpServers as Record<string, Record<string, unknown>>).gsc;
    expect(server).not.toHaveProperty('args');
    expect(server).not.toHaveProperty('env');
  });

  it('updates an existing server in place', () => {
    service.save(projectDir, null, { name: 'gsc', transport: 'stdio', command: realProgram });
    service.save(projectDir, 'gsc', {
      name: 'gsc',
      transport: 'stdio',
      command: realProgram,
      args: ['--verbose'],
    });

    const servers = readMcpJson().mcpServers as Record<string, Record<string, unknown>>;
    expect(Object.keys(servers)).toEqual(['gsc']);
    expect(servers.gsc.args).toEqual(['--verbose']);
  });

  it('moves the approval when a server is renamed', () => {
    service.save(projectDir, null, { name: 'old', transport: 'stdio', command: realProgram });
    service.save(projectDir, 'old', { name: 'new', transport: 'stdio', command: realProgram });

    expect(Object.keys(readMcpJson().mcpServers as object)).toEqual(['new']);
    expect(readSettings().enabledMcpjsonServers).toEqual(['new']);
  });

  it('clears a stale disabled entry when a renamed server takes a used name', () => {
    service.save(projectDir, null, { name: 'gsc', transport: 'stdio', command: realProgram });
    service.setEnabled(projectDir, 'gsc', false);
    service.save(projectDir, 'gsc', { name: 'gsc', transport: 'stdio', command: realProgram });

    // Re-saving an edited server re-approves it, so it is usable again.
    expect(service.list(projectDir)[0].enabled).toBe(true);
    expect(readSettings().disabledMcpjsonServers).toBeUndefined();
  });

  it('rejects a duplicate name when creating', () => {
    service.save(projectDir, null, { name: 'gsc', transport: 'stdio', command: realProgram });

    expect(() =>
      service.save(projectDir, null, { name: 'gsc', transport: 'stdio', command: realProgram })
    ).toThrow(/already exists/);
  });

  it('rejects renaming onto an existing name', () => {
    service.save(projectDir, null, { name: 'one', transport: 'stdio', command: realProgram });
    service.save(projectDir, null, { name: 'two', transport: 'stdio', command: realProgram });

    expect(() =>
      service.save(projectDir, 'one', { name: 'two', transport: 'stdio', command: realProgram })
    ).toThrow(/already exists/);
  });

  it('rejects the reserved philibert name', () => {
    expect(() =>
      service.save(projectDir, null, { name: 'philibert', transport: 'stdio', command: realProgram })
    ).toThrow(/reserved/);
  });

  it('rejects a name with characters that break the tool prefix', () => {
    expect(() =>
      service.save(projectDir, null, { name: 'my server', transport: 'stdio', command: realProgram })
    ).toThrow(/letters, numbers/);
  });

  it('rejects a stdio server with no command', () => {
    expect(() =>
      service.save(projectDir, null, { name: 'gsc', transport: 'stdio', command: '   ' })
    ).toThrow(/Choose the program/);
  });

  it('rejects a remote server with a non-http url', () => {
    expect(() =>
      service.save(projectDir, null, { name: 'remote', transport: 'http', url: 'ftp://nope' })
    ).toThrow(/http:\/\/ or https:\/\//);
  });

  it('does not write anything when validation fails', () => {
    expect(() =>
      service.save(projectDir, null, { name: '', transport: 'stdio', command: realProgram })
    ).toThrow();

    expect(fs.existsSync(path.join(projectDir, '.mcp.json'))).toBe(false);
  });
});

describe('remove', () => {
  it('deletes the definition and both approval entries', () => {
    service.save(projectDir, null, { name: 'gsc', transport: 'stdio', command: realProgram });
    service.remove(projectDir, 'gsc');

    expect(readMcpJson().mcpServers).toEqual({});
    expect(readSettings().enabledMcpjsonServers).toBeUndefined();
    expect(readSettings().disabledMcpjsonServers).toBeUndefined();
  });

  it('leaves other servers untouched', () => {
    service.save(projectDir, null, { name: 'one', transport: 'stdio', command: realProgram });
    service.save(projectDir, null, { name: 'two', transport: 'stdio', command: realProgram });

    const list = service.remove(projectDir, 'one');

    expect(list.map((s) => s.name)).toEqual(['two']);
    expect(readSettings().enabledMcpjsonServers).toEqual(['two']);
  });

  it('rejects removing a server that is not there', () => {
    expect(() => service.remove(projectDir, 'ghost')).toThrow(/no server named/);
  });
});

describe('setEnabled', () => {
  it('disables via disabledMcpjsonServers so a blanket enable-all cannot win', () => {
    writeMcpJson({ mcpServers: { gsc: { command: realProgram } } });
    writeSettings({ enableAllProjectMcpServers: true });

    const list = service.setEnabled(projectDir, 'gsc', false);

    expect(list[0].enabled).toBe(false);
    expect(readSettings().disabledMcpjsonServers).toEqual(['gsc']);
    // The user's blanket setting is theirs, so it is left in place.
    expect(readSettings().enableAllProjectMcpServers).toBe(true);
  });

  it('re-enabling clears the disabled entry', () => {
    service.save(projectDir, null, { name: 'gsc', transport: 'stdio', command: realProgram });
    service.setEnabled(projectDir, 'gsc', false);

    const list = service.setEnabled(projectDir, 'gsc', true);

    expect(list[0].enabled).toBe(true);
    expect(readSettings().disabledMcpjsonServers).toBeUndefined();
    expect(readSettings().enabledMcpjsonServers).toEqual(['gsc']);
  });

  it('rejects toggling a server that is not declared', () => {
    expect(() => service.setEnabled(projectDir, 'ghost', true)).toThrow(/no server named/);
  });
});

describe('checkCommand', () => {
  it('accepts an absolute path to an existing executable', () => {
    expect(service.checkCommand(realProgram)).toEqual({ ok: true });
  });

  it('calls out package runners Philibert does not bundle', () => {
    const check = service.checkCommand('npx');

    expect(check.ok).toBe(false);
    expect(check.problem).toBe('no-package-runner');
    expect(check.message).toMatch(/does not include npx/);
  });

  it('treats every common package runner the same way', () => {
    for (const runner of ['npm', 'pnpm', 'yarn', 'uvx', 'pipx', 'bunx']) {
      expect(service.checkCommand(runner).problem).toBe('no-package-runner');
    }
  });

  it('recognises a Windows-style runner name', () => {
    expect(service.checkCommand('npx.cmd').problem).toBe('no-package-runner');
  });

  it('rejects a bare command name that is nowhere on PATH', () => {
    const check = service.checkCommand('philibert-no-such-program');

    expect(check.ok).toBe(false);
    expect(check.problem).toBe('not-absolute');
  });

  it('accepts a bare name that resolves on the PATH the CLI will inherit', () => {
    // The spawned CLI inherits the main process environment, so a name that
    // resolves here is genuinely launchable — reporting it as broken would be
    // a false alarm, notably on Windows where the bundled Git Bash
    // directories really are on PATH.
    const onPath = path.basename(process.execPath);
    const pathDirs = (process.env.PATH ?? '').split(path.delimiter);
    const isReachable = pathDirs.some(
      (dir) => dir && fs.existsSync(path.join(dir, onPath))
    );

    // Only meaningful when the running binary is itself reachable by name.
    expect(isReachable).toBe(true);
    expect(service.checkCommand(onPath)).toEqual({ ok: true });
  });

  it('does not treat a relative path as a PATH lookup', () => {
    // Resolving it would depend on the app's cwd, which is not the project.
    expect(service.checkCommand('./bin/server').problem).toBe('not-absolute');
  });

  it('rejects an absolute path that does not exist', () => {
    expect(service.checkCommand(path.join(projectDir, 'missing')).problem).toBe('not-found');
  });

  it('rejects an empty command', () => {
    expect(service.checkCommand('   ').ok).toBe(false);
  });

  it.runIf(process.platform !== 'win32')(
    'rejects a file that is not marked executable',
    () => {
      const notExecutable = path.join(projectDir, 'server.bin');
      fs.writeFileSync(notExecutable, 'stub');
      fs.chmodSync(notExecutable, 0o644);

      expect(service.checkCommand(notExecutable).problem).toBe('not-executable');
    }
  );
});

describe('getRuntimeInfo', () => {
  it('reports the platform, with no project needed', () => {
    expect(service.getRuntimeInfo().platform).toBe(process.platform);
  });

  it('offers no bundled Node when the platform does not ship one', () => {
    // The resourcePaths mock reports no bundled Node, matching macOS and Linux
    // where Philibert bundles none at all.
    expect(service.getRuntimeInfo().bundledNodePath).toBeNull();
  });
});

/**
 * User-wide servers: read from Claude Code's global config file, written by
 * its own `claude mcp` commands. The CLI is the process boundary, so it is
 * faked here, doing what CLI 2.1.280 was measured to do: `add-json --scope
 * user` writes the server into the top-level `mcpServers` and refuses a name
 * there already; `remove --scope user` refuses one that is not; each exits 1
 * with a sentence on stderr when it refuses.
 */
describe('user-wide servers', () => {
  let root: string;
  let globalFile: string;
  let configDir: string;
  let calls: string[][];
  /** A command made to fail, by its first two words after `mcp`. */
  let failing: { command: string; name: string } | null;

  function readGlobal(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(globalFile, 'utf-8'));
  }

  function writeGlobal(value: unknown): void {
    fs.writeFileSync(globalFile, JSON.stringify(value, null, 2));
  }

  function readDenied(): unknown {
    const file = path.join(configDir, 'settings.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')).deniedMcpServers : undefined;
  }

  async function fakeCli(args: readonly string[]): Promise<{ ok: boolean; stderr: string }> {
    calls.push([...args]);
    const [, command, name, json] = args;
    if (failing && failing.command === command && failing.name === name) {
      return { ok: false, stderr: 'Something went wrong' };
    }
    const config = fs.existsSync(globalFile) ? readGlobal() : {};
    const servers = { ...((config.mcpServers ?? {}) as Record<string, unknown>) };
    if (command === 'add-json') {
      if (name in servers) return { ok: false, stderr: `MCP server ${name} already exists in user config` };
      servers[name] = JSON.parse(json);
    } else if (command === 'remove') {
      if (!(name in servers)) return { ok: false, stderr: `No MCP server named "${name}" in user scope` };
      delete servers[name];
    }
    writeGlobal({ ...config, mcpServers: servers });
    return { ok: true, stderr: '' };
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'philibert-user-mcp-'));
    globalFile = path.join(root, '.claude.json');
    configDir = path.join(root, 'claude');
    calls = [];
    failing = null;
    service = new McpConfigService(fakeCli, () => globalFile, () => configDir);
    // What Claude Code keeps beside them, which nothing here may lose.
    writeGlobal({ numStartups: 7, projects: { '/p': { disabledMcpServers: ['x'] } } });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const stdio = { name: 'notes', transport: 'stdio' as const, command: realProgram, args: ['--serve'] };

  it('lists none when Claude Code has no global config file yet', async () => {
    fs.rmSync(globalFile);
    expect(await service.listUser()).toEqual([]);
  });

  it('adds one through `claude mcp add-json --scope user`, in the shape Claude Code stores', async () => {
    const list = await service.saveUser(null, stdio);

    expect(calls).toEqual([['mcp', 'add-json', 'notes', JSON.stringify({ type: 'stdio', command: realProgram, args: ['--serve'] }), '--scope', 'user']]);
    expect(list).toEqual([expect.objectContaining({ name: 'notes', transport: 'stdio', enabled: true, args: ['--serve'] })]);
    expect(readGlobal().numStartups).toBe(7);
  });

  it('is off when turned off everywhere', async () => {
    await service.saveUser(null, stdio);
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ deniedMcpServers: [{ serverName: 'notes' }] }));

    expect((await service.listUser())[0]?.enabled).toBe(false);
  });

  it('refuses a name already there, an unknown one to edit, and a bad name — before running anything', async () => {
    await service.saveUser(null, stdio);
    calls = [];

    await expect(service.saveUser(null, stdio)).rejects.toThrow('A server named "notes" already exists in your tools.');
    await expect(service.saveUser('nosuch', stdio)).rejects.toThrow('There is no server named "nosuch" in your tools.');
    await expect(service.saveUser(null, { ...stdio, name: 'bad name!' })).rejects.toThrow('The name must start with');
    await expect(service.removeUser('nosuch')).rejects.toThrow('There is no server named "nosuch" in your tools.');
    expect(calls).toEqual([]);
  });

  it('updates one as Claude Code allows: removes it, then adds it again', async () => {
    await service.saveUser(null, stdio);
    calls = [];

    await service.saveUser('notes', { ...stdio, args: ['--other'] });

    expect(calls.map((c) => c.slice(0, 3))).toEqual([['mcp', 'remove', 'notes'], ['mcp', 'add-json', 'notes']]);
    expect((readGlobal().mcpServers as Record<string, { args: string[] }>).notes.args).toEqual(['--other']);
  });

  it('puts it back as it was when adding the new one fails, so an update never loses it', async () => {
    await service.saveUser(null, stdio);
    failing = { command: 'add-json', name: 'notes' };
    let tries = 0;
    const realFake = fakeCli;
    service = new McpConfigService(async (args) => {
      // The new definition fails; putting the old one back does not.
      if (args[1] === 'add-json' && tries++ === 0) return { ok: false, stderr: 'Something went wrong' };
      failing = null;
      return realFake(args);
    }, () => globalFile, () => configDir);

    await expect(service.saveUser('notes', { ...stdio, args: ['--other'] })).rejects.toThrow('Something went wrong');

    expect((readGlobal().mcpServers as Record<string, { args: string[] }>).notes.args).toEqual(['--serve']);
  });

  it('renames: adds the new name first, then removes the old — and keeps it off everywhere if it was', async () => {
    await service.saveUser(null, stdio);
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({
      deniedMcpServers: [{ serverName: 'notes' }, { serverUrl: 'https://kept.example/*' }],
    }));
    calls = [];

    const list = await service.saveUser('notes', { ...stdio, name: 'jotter' });

    expect(calls.map((c) => c.slice(0, 3))).toEqual([['mcp', 'add-json', 'jotter'], ['mcp', 'remove', 'notes']]);
    expect(list.map((s) => [s.name, s.enabled])).toEqual([['jotter', false]]);
    expect(readDenied()).toEqual([{ serverUrl: 'https://kept.example/*' }, { serverName: 'jotter' }]);
  });

  it('takes the new name back off when removing the old one fails while renaming', async () => {
    await service.saveUser(null, stdio);
    failing = { command: 'remove', name: 'notes' };

    await expect(service.saveUser('notes', { ...stdio, name: 'jotter' })).rejects.toThrow('Something went wrong');

    expect(Object.keys(readGlobal().mcpServers as object)).toEqual(['notes']);
  });

  it('removes one, and what turned it off everywhere, so a later one of that name is not off by it', async () => {
    await service.saveUser(null, stdio);
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ deniedMcpServers: [{ serverName: 'notes' }] }));

    expect(await service.removeUser('notes')).toEqual([]);
    expect(readDenied()).toBeUndefined();
    expect(readGlobal().projects).toEqual({ '/p': { disabledMcpServers: ['x'] } });
  });

  it("says what Claude Code said when it refuses, and writes nothing more", async () => {
    failing = { command: 'add-json', name: 'notes' };
    await expect(service.saveUser(null, stdio)).rejects.toThrow('Something went wrong');
    expect(readGlobal().mcpServers).toBeUndefined();
  });
});

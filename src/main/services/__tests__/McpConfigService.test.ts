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

  it('rejects any other bare command name', () => {
    const check = service.checkCommand('my-server');

    expect(check.ok).toBe(false);
    expect(check.problem).toBe('not-absolute');
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
  it('reports the paths of the two files it edits', () => {
    const info = service.getRuntimeInfo(projectDir);

    expect(info.configPath).toBe(path.join(projectDir, '.mcp.json'));
    expect(info.approvalsPath).toBe(
      path.join(projectDir, '.claude', 'settings.local.json')
    );
    expect(info.platform).toBe(process.platform);
  });

  it('offers no bundled Node when the platform does not ship one', () => {
    // The resourcePaths mock reports no bundled Node, matching macOS and Linux
    // where Philibert bundles none at all.
    expect(service.getRuntimeInfo(projectDir).bundledNodePath).toBeNull();
  });
});

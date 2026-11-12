/**
 * The tools every project has, as the two settings pages list them — and the
 * rule between the levels: off everywhere wins; a project can only turn a
 * tool off for itself.
 */

import { describe, it, expect } from 'vitest';

import type { GlobalTools, GlobalToolStatus, McpServerEntry, ProjectTools } from '@shared/types';

import { connectorRows, displayName, isConnectorName, otherOffEverywhere, projectToolRows } from '../global-tools';

const connector = (name: string, status: GlobalToolStatus['status'] = 'connected'): GlobalToolStatus =>
  ({ name: `claude.ai ${name}`, kind: 'connector', status });
const userStatus = (name: string, status: GlobalToolStatus['status'] = 'connected'): GlobalToolStatus =>
  ({ name, kind: 'user', status });
const userServer = (name: string, enabled = true): McpServerEntry =>
  ({ name, transport: 'stdio', command: '/bin/x', enabled });

describe('connector names', () => {
  it("knows a connector by Claude Code's own naming, and reads it without the prefix", () => {
    expect(isConnectorName('claude.ai Gmail')).toBe(true);
    expect(isConnectorName('gmail')).toBe(false);
    expect(displayName('claude.ai Google Drive')).toBe('Google Drive');
    expect(displayName('notes')).toBe('notes');
  });
});

describe('connectorRows', () => {
  it('lists those reported, by name, each on unless off everywhere', () => {
    const tools: GlobalTools = {
      statuses: [connector('Gmail', 'needs-auth'), userStatus('notes'), connector('Calendar')],
      userServers: [userServer('notes')],
      offEverywhere: [],
    };

    expect(connectorRows(tools)).toEqual([
      { name: 'claude.ai Calendar', status: connector('Calendar'), offEverywhere: false },
      { name: 'claude.ai Gmail', status: connector('Gmail', 'needs-auth'), offEverywhere: false },
    ]);
  });

  it('still lists one off everywhere, which Claude Code no longer reports', () => {
    const tools: GlobalTools = { statuses: [connector('Calendar')], userServers: [], offEverywhere: ['claude.ai Gmail'] };

    expect(connectorRows(tools)).toEqual([
      { name: 'claude.ai Calendar', status: connector('Calendar'), offEverywhere: false },
      { name: 'claude.ai Gmail', status: null, offEverywhere: true },
    ]);
  });

  it('lists those off everywhere even when no session could start', () => {
    const tools: GlobalTools = { statuses: null, userServers: [], offEverywhere: ['claude.ai Gmail'] };
    expect(connectorRows(tools).map((row) => row.name)).toEqual(['claude.ai Gmail']);
  });
});

describe('otherOffEverywhere', () => {
  it('is what is off everywhere and is neither a connector nor a server of the user', () => {
    const tools: GlobalTools = {
      statuses: [],
      userServers: [userServer('notes', false)],
      offEverywhere: ['notes', 'claude.ai Gmail', 'gsc', 'another'],
    };
    expect(otherOffEverywhere(tools)).toEqual(['another', 'gsc']);
  });
});

describe('projectToolRows', () => {
  const tools = (over: Partial<ProjectTools>): ProjectTools => ({ statuses: [], userServers: [], offEverywhere: [], ...over });

  it('is on when the project leaves it on', () => {
    expect(projectToolRows(tools({ statuses: [connector('Gmail')] }))).toEqual([
      { name: 'claude.ai Gmail', kind: 'connector', state: 'on', status: connector('Gmail') },
    ]);
  });

  it('is off here when the project turned it off', () => {
    const rows = projectToolRows(tools({ statuses: [userStatus('notes', 'disabled')], userServers: ['notes'] }));
    expect(rows.map((row) => [row.name, row.state])).toEqual([['notes', 'off-here']]);
  });

  it('is off everywhere when turned off globally — whatever the project says, and though not reported', () => {
    const rows = projectToolRows(tools({
      statuses: [],
      userServers: ['notes'],
      offEverywhere: ['notes', 'claude.ai Gmail'],
    }));
    expect(rows).toEqual([
      { name: 'claude.ai Gmail', kind: 'connector', state: 'off-everywhere', status: null },
      { name: 'notes', kind: 'user', state: 'off-everywhere', status: null },
    ]);
  });

  it('is off everywhere though the project reports it turned off too: a report read before the switch', () => {
    const rows = projectToolRows(tools({
      statuses: [userStatus('notes', 'disabled')],
      userServers: ['notes'],
      offEverywhere: ['notes'],
    }));
    expect(rows.map((row) => [row.name, row.state])).toEqual([['notes', 'off-everywhere']]);
  });

  it('lists a user-wide server the session did not report, as on, with no status', () => {
    const rows = projectToolRows(tools({ statuses: null, userServers: ['notes'] }));
    expect(rows).toEqual([{ name: 'notes', kind: 'user', state: 'on', status: null }]);
  });

  it('leaves out what is off everywhere and is no tool every project has', () => {
    const rows = projectToolRows(tools({ offEverywhere: ['gsc'] }));
    expect(rows).toEqual([]);
  });
});

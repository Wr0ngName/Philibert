/**
 * Slash command resolution.
 *
 * The resolution rules are not ours to invent — they mirror what the CLI does,
 * quoted in findCommand's doc comment from the SDK's SlashCommand type. If
 * these drift, a command typed here runs something different from the same
 * command typed in a terminal, which is worse than it not working at all.
 *
 * The dispositions are asserted by shape rather than by message wording, with
 * two exceptions that are the whole point of their entries: that `sdk` is the
 * default for an unknown command, and that nothing in the table is a bare
 * "not available" with no explanation.
 */

import { describe, it, expect } from 'vitest';

import {
  GUI_DISPOSITIONS,
  dispositionFor,
  findCommand,
  parseSlashInput,
  rankCommandMatches,
} from '../slash-commands';
import type { SlashCommandInfo } from '../types';

function cmd(name: string, extra: Partial<SlashCommandInfo> = {}): SlashCommandInfo {
  return { name, description: `${name} description`, argumentHint: '', ...extra };
}

describe('parseSlashInput', () => {
  it('splits a command from its arguments', () => {
    expect(parseSlashInput('/compact focus on the CI work')).toEqual({
      name: 'compact',
      args: 'focus on the CI work',
    });
  });

  it('returns empty args for a bare command', () => {
    expect(parseSlashInput('/rewind')).toEqual({ name: 'rewind', args: '' });
  });

  it('lowercases the name but leaves arguments untouched', () => {
    // Arguments can be a path or a prompt, where case matters.
    expect(parseSlashInput('/MODEL Claude-Opus-5')).toEqual({
      name: 'model',
      args: 'Claude-Opus-5',
    });
  });

  it('tolerates surrounding and inner whitespace', () => {
    expect(parseSlashInput('   /model    opus   ')).toEqual({ name: 'model', args: 'opus' });
  });

  it('keeps a multi-line argument intact', () => {
    // A pasted prompt after a command must not be cut at the first newline.
    expect(parseSlashInput('/compact line one\nline two')).toEqual({
      name: 'compact',
      args: 'line one\nline two',
    });
  });

  it('returns null for text that is not a command', () => {
    expect(parseSlashInput('just a prompt')).toBeNull();
    expect(parseSlashInput('')).toBeNull();
  });

  it('returns null for a bare slash', () => {
    // What the input holds the instant the user opens the autocomplete.
    expect(parseSlashInput('/')).toBeNull();
    expect(parseSlashInput('/   ')).toBeNull();
  });

  it('returns null for a path pasted as a prompt', () => {
    // A command name cannot contain a slash, so "/usr/bin/env" is not one.
    // Treating it as the command "usr" would send the wrong thing entirely.
    expect(parseSlashInput('/usr/bin/env python')).toBeNull();
    expect(parseSlashInput('/home/wrongname/notes.md')).toBeNull();
  });
});

describe('findCommand', () => {
  const commands = [
    cmd('usage', { aliases: ['cost', 'stats'], builtin: true }),
    cmd('rewind', { builtin: true }),
    cmd('deploy'),
  ];

  it('finds a command by its name', () => {
    expect(findCommand(commands, 'rewind')?.name).toBe('rewind');
  });

  it('finds a command by an alias', () => {
    // /cost and /stats both resolve to /usage, as the SDK documents.
    expect(findCommand(commands, 'cost')?.name).toBe('usage');
    expect(findCommand(commands, 'stats')?.name).toBe('usage');
  });

  it('matches case-insensitively', () => {
    expect(findCommand(commands, 'REWIND')?.name).toBe('rewind');
    expect(findCommand(commands, 'Cost')?.name).toBe('usage');
  });

  it('returns undefined for an unknown name', () => {
    expect(findCommand(commands, 'nope')).toBeUndefined();
  });

  it('prefers the builtin row when two rows share a name', () => {
    // The SDK's rule: "when a marked row carries it, /name runs that one".
    const shared = [cmd('review', { description: 'project version' }), cmd('review', { description: 'builtin version', builtin: true })];
    expect(findCommand(shared, 'review')?.description).toBe('builtin version');
  });

  it('uses an unmarked row when no builtin shares the name', () => {
    const shared = [cmd('review', { description: 'project version' })];
    expect(findCommand(shared, 'review')?.description).toBe('project version');
  });

  it('prefers a name match over another command holding it as an alias', () => {
    // "The marker describes the row's name, not its aliases: a typed alias
    // runs a command that has it as its name, when one exists."
    const conflicting = [
      cmd('usage', { aliases: ['cost'], builtin: true }),
      cmd('cost', { description: 'a project command actually named cost' }),
    ];
    expect(findCommand(conflicting, 'cost')?.description).toBe('a project command actually named cost');
  });
});

describe('dispositionFor', () => {
  it('sends an unknown command to the CLI', () => {
    // The default that matters most: a command the CLI gains tomorrow works
    // here today, with no entry added to our table.
    expect(dispositionFor(cmd('some-new-cli-command'))).toEqual({ kind: 'sdk' });
  });

  it('sends a project command to the CLI', () => {
    expect(dispositionFor(cmd('deploy'))).toEqual({ kind: 'sdk' });
  });

  it('sends /compact to the CLI rather than intercepting it', () => {
    // The CLI compacts properly; reimplementing it would be strictly worse.
    expect(dispositionFor(cmd('compact'))).toEqual({ kind: 'sdk' });
  });

  it('claims /rewind for the GUI', () => {
    expect(dispositionFor(cmd('rewind'))).toEqual({ kind: 'gui', action: 'rewind' });
  });

  it('routes /mcp to the tool servers panel', () => {
    expect(dispositionFor(cmd('mcp'))).toMatchObject({ kind: 'navigate', target: 'settings-mcp' });
  });

  it('routes /login and /logout to the authentication section', () => {
    expect(dispositionFor(cmd('login'))).toMatchObject({ kind: 'navigate', target: 'settings-auth' });
    expect(dispositionFor(cmd('logout'))).toMatchObject({ kind: 'navigate', target: 'settings-auth' });
  });

  it('matches the name case-insensitively', () => {
    expect(dispositionFor(cmd('Rewind'))).toEqual({ kind: 'gui', action: 'rewind' });
  });
});

describe('GUI_DISPOSITIONS', () => {
  it('explains every command it declines to run', () => {
    // The failure mode this guards: a wall of "not available in GUI mode" that
    // tells the user nothing about what to do instead.
    const unavailable = Object.entries(GUI_DISPOSITIONS).filter(([, d]) => d.kind === 'unavailable');
    expect(unavailable.length).toBeGreaterThan(0);

    for (const [name, disposition] of unavailable) {
      if (disposition.kind !== 'unavailable') throw new Error('filtered above');
      expect(disposition.message.length, `${name} needs a real explanation`).toBeGreaterThan(80);
      expect(disposition.message, `${name} should say what to do instead`).not.toMatch(
        /^_?not (yet )?(available|supported)/i,
      );
    }
  });

  it('names the destination for every command it redirects', () => {
    const navigations = Object.entries(GUI_DISPOSITIONS).filter(([, d]) => d.kind === 'navigate');
    expect(navigations.length).toBeGreaterThan(0);

    for (const [name, disposition] of navigations) {
      if (disposition.kind !== 'navigate') throw new Error('filtered above');
      // "Open Settings" is useless if the control still has to be hunted for,
      // so each message must name the surface in bold.
      expect(disposition.message, `${name} should name its destination`).toMatch(/\*\*/);
    }
  });

  it('is keyed by canonical names, never by an alias', () => {
    // /cost is an alias of /usage, so an entry for it would never be reached:
    // resolution rewrites the name before the disposition is looked up.
    expect(GUI_DISPOSITIONS).not.toHaveProperty('cost');
    expect(GUI_DISPOSITIONS).not.toHaveProperty('stats');
    expect(GUI_DISPOSITIONS).toHaveProperty('usage');
  });
});

describe('rankCommandMatches', () => {
  const commands = [
    cmd('rewind', { builtin: true, description: 'Undo file changes' }),
    cmd('rebase-helper', { description: 'Project rebase assistant' }),
    cmd('usage', { aliases: ['cost', 'stats'], builtin: true, description: 'Token and cost totals' }),
    cmd('clear', { builtin: true, description: 'Clear the conversation' }),
  ];

  it('returns everything for an empty query, builtins first then alphabetical', () => {
    expect(rankCommandMatches(commands, '')).toEqual([
      expect.objectContaining({ name: 'clear' }),
      expect.objectContaining({ name: 'rewind' }),
      expect.objectContaining({ name: 'usage' }),
      expect.objectContaining({ name: 'rebase-helper' }),
    ]);
  });

  it('puts a name prefix match before a project command that merely contains it', () => {
    // Typing "/re" should offer /rewind before /rebase-helper.
    const names = rankCommandMatches(commands, 're').map((c) => c.name);
    expect(names.indexOf('rewind')).toBeLessThan(names.indexOf('rebase-helper'));
  });

  it('finds a command by an alias prefix', () => {
    expect(rankCommandMatches(commands, 'cos').map((c) => c.name)).toContain('usage');
  });

  it('ranks a name match above an alias match', () => {
    const withBoth = [
      cmd('status', { builtin: true }),
      cmd('usage', { aliases: ['stats'], builtin: true }),
    ];
    // "stat" prefixes the name "status" and the alias "stats".
    expect(rankCommandMatches(withBoth, 'stat').map((c) => c.name)).toEqual(['status', 'usage']);
  });

  it('falls back to searching descriptions', () => {
    // Lets the list be searched by what a command does, not just its name.
    expect(rankCommandMatches(commands, 'undo').map((c) => c.name)).toEqual(['rewind']);
  });

  it('does not search descriptions for a one or two letter query', () => {
    // Prose matches almost anything at that length: "co" is in "Clear the
    // conversation" and "Token and cost totals" alike, so a keystroke meant
    // to narrow the list would widen it instead. Only names and aliases
    // match here — /clear by name, /usage via its "cost" alias.
    expect(rankCommandMatches(commands, 'co').map((c) => c.name)).toEqual(['usage']);
  });

  it('searches descriptions from three characters up', () => {
    expect(rankCommandMatches(commands, 'cost').map((c) => c.name)).toEqual(['usage']);
  });

  it('excludes commands that match nothing', () => {
    expect(rankCommandMatches(commands, 'zzzz')).toEqual([]);
  });

  it('is case-insensitive', () => {
    expect(rankCommandMatches(commands, 'REWIND').map((c) => c.name)).toEqual(['rewind']);
  });

  it('does not mutate the array it was given', () => {
    // It sorts, and the caller's array is reactive state shared by every
    // component instance.
    const original = [...commands];
    rankCommandMatches(commands, 're');
    expect(commands).toEqual(original);
  });
});

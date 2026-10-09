# Slash Commands

Typing `/` in the prompt opens a searchable list of every command available in
the current project. This describes where that list comes from, what happens
when a command runs, and how to add to it.

---

## Where the list comes from

**Only from Claude Code.** The SDK's `supportedCommands()` returns every
command — Claude Code's own, plus whatever the project, your plugins and any
MCP servers define — each with its description, argument hint, aliases, and a
marker saying whether it is one of Claude Code's.

Philibert keeps no list of its own. It used to, copied from a blog post, and
that is exactly why `/rewind` was missing: a hand-written table cannot keep up
with the CLI, and it cannot know about a project's commands at all. The table
also outranked the SDK's rows where the two overlapped, so stale descriptions
won.

The practical consequence: **a command the CLI gains works here immediately**,
with no change to Philibert.

The list is fetched when the app starts, not when the first message is sent.
`supportedCommands()` is a free control command, so Philibert starts a
throwaway CLI process, asks, and shuts it down — no turn runs and no tokens are
spent. (The same trick fills the model picker.) Before this, the list was empty
until a session existed, which made the commands look as though they did not
exist.

If the list is empty, the CLI could not be started — check **Settings →
Authentication**.

---

## What happens when you run one

Three things can happen, and which one is a property of the command.

### 1. It goes to Claude Code (the default)

Most commands are simply sent, and the CLI does what it always does. This is
the default for anything Philibert does not explicitly claim, including every
project and plugin command, and `/compact`.

### 2. Philibert answers it

Some commands need information Philibert holds rather than the CLI: the running
token and cost totals, the context occupation, which model is selected. Those
are answered directly in the chat.

| Command | What it does here |
| --- | --- |
| `/help` | Lists the real commands, grouped into Claude Code's and the project's, with aliases |
| `/usage` (`/cost`, `/stats`) | Cost, turn count and a token breakdown, per model when more than one was used |
| `/context` | Tokens in use against the real context window, and what is left |
| `/status` | Model, reasoning effort, working directory, Claude Code session id, turn count |
| `/doctor` | Versions of the app, Claude Code, the SDK, Electron, Node and whisper, plus the data and log paths |
| `/bug` | Where to report a problem **with Philibert**, and what to attach |
| `/memory` | Opens the project's `CLAUDE.md` in the viewer, or explains how to create one |
| `/model` | With a name, switches model (a partial name is enough); without, lists what is available |
| `/clear` | Empties the transcript |
| `/rewind` | Opens the rewind dialog — see below |

### 3. It opens the part of the GUI that does the job

`/config`, `/permissions`, `/allowed-tools`, `/login`, `/logout` and `/mcp` open
Settings, scrolled to the relevant section, and say in the chat where they sent
you.

A few commands genuinely do not apply — `/vim`, `/terminal-setup`,
`/install-github-app`, `/agents` — and say what they would have done and what
to do instead. None of them is a bare "not available".

---

## Rewind

`/rewind` restores your work to an earlier turn. The CLI draws an interactive
picker for this; Philibert shows the same choice as a dialog.

Pick a turn, then pick what to restore:

- **Code only** — files go back; the conversation still describes the edits.
- **Conversation only** — later turns are dropped; files keep every change.
- **Both** — both return to that turn.

Anything that touches files shows a **dry-run preview first**: which files
differ and how many lines would be added and removed. Restoring overwrites
files on disk and cannot be undone from inside the app, so nothing is written
until you confirm.

### What can be rewound

A turn can be targeted only once Claude Code has acknowledged it — the rewind
point is the id the CLI filed that turn under, and a turn it never recorded is
not a place it can return to. Turns that cannot be targeted are listed greyed
out rather than hidden, so a short list does not look like a fault.

**Checkpoints last as long as the session.** They are created by the CLI, under
`enableFileCheckpointing`, which Philibert turns on for every session. Reopening
an old conversation starts a new session, so turns from before that cannot have
their files restored — the conversation can still be rewound.

A restore can be partial. If a tracked path has become a symlink or hard link,
its parent directory no longer resolves where it did, or a backup cannot be read
safely, the CLI leaves that file alone and reports how many it skipped.
Philibert passes that count straight through with a warning, because only you
can judge whether a half-restored tree matters.

---

## Adding your own

A command is a Markdown file. Put it in `.claude/commands/<name>.md` for the
project, or `~/.claude/commands/<name>.md` for yourself. Claude Code discovers
them, so they appear in the list here with no further setup, tagged **project**
to distinguish them from Claude Code's own.

Subagents work the same way from `.claude/agents/<name>.md`. Both are picked up
by **new conversations**; one already running keeps the set it started with.

---

## Searching the list

The list is searched by name, by alias, and — from three characters up — by
description, so `/undo` finds `/rewind` without knowing its name. Descriptions
are not searched for one or two characters, because at that length prose
matches nearly everything and a keystroke meant to narrow the list would widen
it.

Results are ordered: name matches before alias matches, prefixes before
substrings, Claude Code's commands before the project's, then alphabetically —
so the order does not jump around as you type. **Tab** completes the
highlighted command; **Enter** sends the message as usual.

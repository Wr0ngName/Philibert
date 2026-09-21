# Adding an MCP Server to a Project

This guide describes how to give Claude extra tools inside Philibert by adding
an **MCP server** (Model Context Protocol) to a project.

**The good news: the process is identical in SDK mode and Channel mode.** Both
modes run Claude Code with your project folder as its working directory and
neither one passes `--strict-mcp-config`, so both discover the exact same
project-level MCP configuration. There is nothing mode-specific to do.

Philibert has no MCP management UI — `/mcp` in the chat box reports that it is
unsupported and points at the CLI
(`src/main/services/claude/BuiltinCommandHandler.ts:244`). The process below is
the native Claude Code mechanism, which Philibert inherits for free.

---

## The process (3 steps)

### Step 1 — Create `.mcp.json` in the project folder

In the folder you picked as Philibert's working directory, create a file named
`.mcp.json`:

```json
{
  "mcpServers": {
    "weather": {
      "command": "/usr/local/bin/npx",
      "args": ["-y", "weather-mcp"],
      "env": {
        "API_KEY": "your-key-here"
      }
    }
  }
}
```

The key (`weather`) is the server name. It becomes the tool prefix: the server's
`forecast` tool is exposed to Claude as `mcp__weather__forecast`.

Remote servers work too:

```json
{
  "mcpServers": {
    "sentry": {
      "type": "http",
      "url": "https://mcp.sentry.dev/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

Supported shapes are `stdio` (default — `command`/`args`/`env`), `http` and
`sse` (both `url`/`headers`).

> **Use absolute paths for `command`.** Philibert only augments `PATH` on
> Windows (`WindowsPaths.buildEnhancedPath()`, used at
> `ClaudeCodeService.ts:962`). On macOS and Linux the app inherits the desktop
> session's `PATH`, which usually does **not** include `nvm`, Homebrew or other
> user-installed toolchains. A bare `"command": "npx"` is the single most common
> reason a server silently fails to start. Run `which npx` in a terminal and
> paste the full path.

### Step 2 — Approve the server in `.claude/settings.local.json`

A project-scoped `.mcp.json` is **not trusted by default** — Claude Code marks
it "pending approval" and exposes none of its tools. Normally you approve it
interactively on first launch; Philibert's chat window cannot show that prompt,
so grant the approval in a file.

In the same project folder, create `.claude/settings.local.json`:

```json
{
  "enableAllProjectMcpServers": true
}
```

Or, to approve servers one by one instead of blanket-approving the file:

```json
{
  "enabledMcpjsonServers": ["weather"]
}
```

Both are verified to work. `settings.local.json` is the right file for machine-
local choices — it is git-ignored by convention. Use `.claude/settings.json`
instead if you want the approval committed and shared with your team.

Philibert never writes to your project's `.claude/` directory, so this file is
yours alone and nothing will overwrite it.

### Step 3 — Start a **new conversation**

Philibert reuses a live Claude Code session for the whole conversation — an SDK
`query()` iterator (`ClaudeCodeService.ts:384`) or a long-running PTY process in
channel mode. MCP servers are connected once at session startup, so editing
`.mcp.json` has no effect on a conversation that is already running.

Open a new conversation (or restart Philibert) to pick up the change.

### Verify it worked

Ask Claude in the chat: *"Which MCP tools do you have?"* It should list tools
named `mcp__<server>__<tool>`.

The first time Claude calls one, Philibert shows its normal approval dialog —
MCP tools render through the generic tool card
(`PermissionManager.ts:756`). Approve it as you would a `Bash` or `Edit` call.

---

## Optional: let the CLI write `.mcp.json` for you

If you are comfortable in a terminal, `cd` into the project folder and run:

```bash
claude mcp add --scope project weather -e API_KEY=xxx -- npx -y weather-mcp
```

`--scope project` is the **only** scope that works with Philibert. It writes the
same `.mcp.json` described in Step 1. You still need Step 2 — the CLI records
approval in a different file that Philibert does not read (see below).

### Why the other scopes do not work

Philibert relocates Claude Code's config directory. When you are signed in with
OAuth, `AuthValidator.setupAuthEnv()` sets
`CLAUDE_CONFIG_DIR=<userData>/claude-config`
(`AuthValidator.ts:128`, `resourcePaths.ts:187`):

| OS | Philibert's config dir |
|---|---|
| Linux | `~/.config/Philibert/claude-config` |
| macOS | `~/Library/Application Support/Philibert/claude-config` |
| Windows | `%APPDATA%\Philibert\claude-config` |

`claude mcp add` with the default `local` scope, and with `--scope user`, both
write to `$CLAUDE_CONFIG_DIR/.claude.json`. Run from a normal terminal that
resolves to `~/.claude.json` — a different file from the one Philibert points
the CLI at, so the server is invisible to the app.

`.mcp.json` is resolved from the working directory instead, which both modes set
to your project folder, so it is unaffected.

| Scope | Stored in | Works in Philibert |
|---|---|---|
| `project` (`.mcp.json`) | project folder | **Yes** |
| `local` (default) | `$CLAUDE_CONFIG_DIR/.claude.json` | No |
| `user` | `$CLAUDE_CONFIG_DIR/.claude.json` | No |

---

## Why this works the same in both modes

### Channel mode

`ChannelSession.start()` spawns the CLI with `cwd` set to the project folder
(`ChannelSession.ts:269`) and passes `--mcp-config <sessionDir>/.mcp.json`
(`ChannelSession.ts:241`) to inject Philibert's own `philibert` channel server.

`--mcp-config` is **additive**. Because `--strict-mcp-config` is not passed, the
CLI keeps loading every other MCP source, your project `.mcp.json` included.
Verified: a run with both a project `.mcp.json` and `--mcp-config` pointing
elsewhere connected both servers and exposed both tool sets.

`--allowedTools mcp__philibert__reply` is likewise additive — it pre-approves the
channel reply tool, it does not restrict the tool list. Your server's tools stay
available and route through the normal permission flow into Philibert's UI.

### SDK mode

`ClaudeCodeService` calls `query()` with `cwd` set to the project folder
(`ClaudeCodeService.ts:655`) and sets neither `settingSources` nor
`strictMcpConfig`. In `@anthropic-ai/claude-agent-sdk` 0.3.220, omitting
`settingSources` means **all filesystem settings are loaded**, matching CLI
defaults — so `.mcp.json` and `.claude/settings.local.json` are both read.

---

## Implementation note

Channel mode writes a `.claude/settings.local.json` into its per-conversation
session directory (`ChannelSession.ts:656`) containing
`enableAllProjectMcpServers: true`. That file is inert: the CLI resolves project
settings from its working directory, which is the user's project folder, not the
session directory. The settings it carries are already supplied by other means —
tool permissions via `--allowedTools`, workspace trust via the global settings
file — so nothing is broken by it, but it is **not** the reason Step 2 works and
it does not remove the need for Step 2.

---

## Troubleshooting

**Claude lists no MCP tools.**
Work through this order:

1. Is `.mcp.json` in the folder Philibert shows as the working directory?
   (Settings → Working Directory.) It must be the project root, not a subfolder.
2. Did you create `.claude/settings.local.json` (Step 2)? Without it the server
   is discovered but stays unapproved and contributes zero tools.
3. Did you open a **new** conversation after editing the files?
4. Is `command` an absolute path?

**Checking the logs.**

- Philibert's main log: `<userData>/logs/main.log`
- Channel mode PTY transcript, which carries the CLI's own MCP startup output:
  `<tmpdir>/philibert-pty-<conversationId>.log`

**Remote servers that need an OAuth login.** Servers whose auth flow relies on
the CLI's interactive `/mcp` authentication cannot be completed from inside
Philibert. Use a server that accepts a token in `headers`, or a stdio server that
reads a key from `env`.

---

## Reference

| Thing | Where |
|---|---|
| Server definitions | `<project>/.mcp.json` |
| Server approval | `<project>/.claude/settings.local.json` |
| Tool naming | `mcp__<server-name>__<tool-name>` |
| Transports | `stdio` (default), `http`, `sse` |
| Philibert config dir | `<userData>/claude-config` |

# Adding an MCP Server to a Project

This guide describes how to give Claude extra tools inside Philibert by adding
an **MCP server** (Model Context Protocol) to a project.

**The process is identical in SDK mode and Channel mode.** Both modes run Claude
Code with your project folder as its working directory and neither passes
`--strict-mcp-config`, so both discover the same project-level configuration.

Philibert has no MCP management UI — `/mcp` in the chat box reports that it is
unsupported and points at the CLI
(`src/main/services/claude/BuiltinCommandHandler.ts:244`). The process below is
the native Claude Code mechanism, which Philibert inherits.

---

## Before you start: can Philibert run the server?

Most MCP servers are published as npm packages and their README tells you to
write `"command": "npx"`. **On a machine that only has Philibert installed, that
does not work**, and it is the single biggest gotcha on this page.

Philibert bundles a bare `node.exe` on Windows and nothing else:

- `scripts/download-node-windows.sh` extracts **only** `node.exe` from the Node
  zip — its comment says *"we don't need npm, etc."*
- The online-bundle path does the same at runtime
  (`extractNodeExe()` in `src/main/utils/archiveExtractor.ts:68` copies
  `node.exe` out of a temp dir and deletes the rest).
- macOS and Linux bundle no Node at all — the Claude Code CLI ships there as a
  native binary, so none is needed.

So there is **no `npm` and no `npx`** in a Philibert install, on any platform.
And `PATH` is only augmented on Windows, with the bundled Git Bash directories
(`WindowsPaths.buildEnhancedPath()`, used at
`src/main/services/ClaudeCodeService.ts:962`) — never the resources folder — so
even a bare `"command": "node"` will not resolve unless the user installed Node
themselves.

### What to pick instead

| Server type | Works on a Philibert-only machine? |
|---|---|
| Prebuilt native binary (Go, Rust, .NET AOT) | **Yes** — point `command` at the file |
| Remote `http` / `sse` server | **Yes** — no local runtime at all |
| npm package via `npx` | No — `npx` does not exist |
| Python (`uvx`, `python -m`) | No — no Python bundled |
| Node script you vendor into the project | Only if you give the absolute path to the bundled `node.exe` (Windows) or the user has Node installed |

If the user *does* have Node or Python installed system-wide, the usual `npx` /
`uvx` recipes work normally. This section is about the zero-setup case Philibert
is built for.

**Finding the bundled `node.exe` (Windows).** The default install location is
`%LOCALAPPDATA%\Programs\Philibert\resources\node.exe`, but the installer lets
users change the directory. The exact path is logged on every start — open
`<userData>\logs\main.log` and look for `resourcesPath` in the
`Windows dependency setup` entry (`src/main/utils/windowsSetup.ts:21`).

---

## The process (3 steps)

### Step 1 — Create `.mcp.json` in the project folder

In the folder you picked as Philibert's working directory, create `.mcp.json`:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "C:\\Tools\\my-mcp-server.exe",
      "env": { "API_KEY": "..." }
    }
  }
}
```

The key (`my-server`) is the server name and becomes the tool prefix: its
`search` tool reaches Claude as `mcp__my-server__search`.

Remote servers need no local runtime at all:

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
`sse` (both `url`/`headers`). Always give `command` as an **absolute path**.

### Step 2 — Approve the server in `.claude/settings.local.json`

A project `.mcp.json` is **not trusted by default**. Create
`.claude/settings.local.json` in the same project folder:

```json
{
  "enableAllProjectMcpServers": true
}
```

Or approve servers individually:

```json
{
  "enabledMcpjsonServers": ["my-server"]
}
```

Both are verified to work. `settings.local.json` is the right file for
machine-local choices and is git-ignored by convention; use
`.claude/settings.json` if you want the approval committed for your team.

Philibert never writes to your project's `.claude/` directory, so this file is
yours alone.

**Do not skip this step — see [Why Step 2 is mandatory](#why-step-2-is-mandatory)
below. Skipping it does not merely hide the tools; in Channel mode it can leave
the conversation stuck.**

### Step 3 — Start a **new conversation**

Philibert reuses a live Claude Code session for the whole conversation — an SDK
`query()` iterator (`ClaudeCodeService.ts:384`) or a long-running PTY in channel
mode. MCP servers connect once at session startup, so editing `.mcp.json` has no
effect on a conversation that is already running.

### Verify it worked

Ask Claude: *"Which MCP tools do you have?"* It should list tools named
`mcp__<server>__<tool>`.

---

## Why Step 2 is mandatory

The two modes fail differently when a project MCP server is unapproved, and
neither failure is self-explanatory.

**SDK mode fails silently.** There is no interactive prompt in a headless
session. The server is reported with `status: "pending"` in the init message and
contributes zero tools. Claude simply behaves as though the server does not
exist.

**Channel mode shows a dialog Philibert does not handle.** The interactive CLI
prints a startup prompt:

```
New MCP server found in this project: my-server
MCP servers may execute code or access system resources.
All tool calls require approval.
  1. Use this MCP server
  2. Use this and all future MCP servers in this project
  3. Continue without using this MCP server
Enter to confirm · Esc to cancel
```

`ChannelSession`'s auto-accept only matches an MCP dialog when the buffer
contains **both** `mcpserver` and `philibert` (`ChannelSession.ts:319`), and the
PTY permission relay keys on `do you want to proceed` (`ChannelSession.ts:361`),
which this dialog does not contain. So neither path reliably answers it and the
PTY can sit at the prompt until the turn watchdog fires.

Philibert's own channel server never triggers this dialog: it is injected with
`--mcp-config`, and servers from `--mcp-config` are exempt from the project-trust
gate. Verified — a `--mcp-config` server produces no dialog, a project
`.mcp.json` server does.

---

## Permissions: server trust vs. tool approval

These are two different gates, which is why Philibert handles one and not the
other.

**Tool approval — already fully supported.** Every tool call, MCP tools
included, arrives through an API built for exactly this: the SDK's `canUseTool`
callback, or `notifications/claude/channel/permission_request` in channel mode.
`PermissionManager.createCanUseToolCallback()` is generic over the tool name, so
`mcp__gsc__query_search_analytics` gets the same approval card as `Bash` or
`Edit` (rendered through the generic tool card, `PermissionManager.ts:756`).

**Server trust — not exposed.** It is not a tool call, so there is no callback
to hook. In SDK mode the CLI never asks; in channel mode it asks as a PTY
startup dialog. That is why it has to be granted in a file up front.

### Can a user trust just one MCP tool?

Yes — per tool, not per server. For an MCP tool call the SDK offers a rule
scoped to that exact tool. Verified against a live server:

```json
[{ "type": "addRules",
   "rules": [{ "toolName": "mcp__demo-echo__shout" }],
   "behavior": "allow",
   "destination": "localSettings" }]
```

So approving "always allow" grants `mcp__demo-echo__shout` only — sibling tools
from the same server still prompt individually.

**Caveat on session scope.** Philibert builds its always-allow buttons from the
scopes the SDK actually suggests (`describePermissionSuggestions`,
`PermissionManager.ts:482` — scopes with no suggestion are skipped at
`if (!hasSuggestions) continue`). For MCP tools the SDK suggests only
`localSettings`, which Philibert maps to **project** scope
(`mapDestinationToScope`, `PermissionManager.ts:459`). The practical result is
that an MCP tool's approval card offers *allow once* and *always allow for this
project* (persisted to `.claude/settings.local.json`), but **no "for this
session" button** — unlike tools where the SDK suggests a session destination.
Session-scoped MCP grants are supported by the machinery
(`SessionPermissionCache` keys on tool name and is agnostic to MCP), they are
just never offered, because nothing suggests them.

---

## Worked example: Google Search Console

A complete, beginner-friendly setup, chosen to satisfy the runtime constraint
above.

### Which GSC server to use

| Project | Runtime | Philibert-only machine |
|---|---|---|
| [`ncosentino/google-search-console-mcp`](https://github.com/ncosentino/google-search-console-mcp) | **Prebuilt binary** (Go or C# AOT) | **Works** |
| [`ahonn/mcp-server-gsc`](https://github.com/ahonn/mcp-server-gsc) | Node, via `npx` | Needs Node installed |
| [`AminForou/mcp-gsc`](https://github.com/AminForou/mcp-gsc) | Python | Needs Python installed |

Use **`ncosentino/google-search-console-mcp`**: it ships zero-dependency native
binaries for Linux, macOS and Windows, which is the only option that works on a
machine with nothing but Philibert.

Be aware of the trade-off before you commit: it is MIT-licensed but small and
young (14 stars, v0.1.2 at the time of writing), while the npm and Python
alternatives are far more widely used (273 and 1,608 stars). If the user already
has Node installed, `ahonn/mcp-server-gsc` is the better-trodden path and Step 3
below is the only part that changes.

### Step 1 — Create a Google service account

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create
   or select a project.
2. Enable the Search Console API:
   <https://console.cloud.google.com/apis/library/searchconsole.googleapis.com>
   → **Enable**. (The API is free; no billing account is required.)
3. **IAM & Admin → Service Accounts → Create Service Account**. Name it
   e.g. `gsc-mcp`. No project-level roles are needed.
4. Open the service account → **Keys → Add Key → Create new key → JSON**.
   Download the file. The `client_email` inside is what you need next.
5. In [Search Console](https://search.google.com/search-console), select your
   property → **Settings → Users and permissions → Add user**. Paste the
   `client_email` **exactly as it appears in the JSON** (e.g.
   `gsc-mcp@my-project.iam.gserviceaccount.com`), set permission to **Full**,
   and click **Add**.

### Step 2 — Save the key file outside the project

Put the JSON somewhere the project will never publish it — **not** inside a git
repository:

| OS | Suggested location |
|---|---|
| Windows | `C:\Users\<you>\gsc\service-account.json` |
| macOS | `~/gsc/service-account.json` |
| Linux | `~/gsc/service-account.json` |

If you must keep it in the project, add it to `.gitignore` first. Pass the key
by **file path**, never by pasting its contents into `.mcp.json` — that file is
routinely committed.

### Step 3 — Download the binary

From the
[latest release](https://github.com/ncosentino/google-search-console-mcp/releases/latest),
pick the Go build for your platform (smaller and faster to start than the C# one):

| Platform | File |
|---|---|
| Windows x64 | `gsc-mcp-go-windows-amd64.exe` |
| Windows arm64 | `gsc-mcp-go-windows-arm64.exe` |
| macOS Apple Silicon | `gsc-mcp-go-darwin-arm64` |
| macOS Intel | `gsc-mcp-go-darwin-amd64` |
| Linux x64 | `gsc-mcp-go-linux-amd64` |
| Linux arm64 | `gsc-mcp-go-linux-arm64` |

Save it somewhere permanent, e.g. `C:\Tools\` or `~/bin/`.

On macOS and Linux, make it executable:

```bash
chmod +x ~/bin/gsc-mcp-go-darwin-arm64
```

On macOS, a binary downloaded from the internet may be blocked by Gatekeeper
("cannot be opened because the developer cannot be verified"). Clear the
quarantine flag:

```bash
xattr -d com.apple.quarantine ~/bin/gsc-mcp-go-darwin-arm64
```

### Step 4 — Write the two files

`<project>/.mcp.json` — Windows:

```json
{
  "mcpServers": {
    "gsc": {
      "command": "C:\\Tools\\gsc-mcp-go-windows-amd64.exe",
      "env": {
        "GOOGLE_SERVICE_ACCOUNT_FILE": "C:\\Users\\you\\gsc\\service-account.json"
      }
    }
  }
}
```

macOS / Linux:

```json
{
  "mcpServers": {
    "gsc": {
      "command": "/home/you/bin/gsc-mcp-go-linux-amd64",
      "env": {
        "GOOGLE_SERVICE_ACCOUNT_FILE": "/home/you/gsc/service-account.json"
      }
    }
  }
}
```

Backslashes must be doubled in JSON on Windows. `~` is **not** expanded — write
the full path.

`<project>/.claude/settings.local.json`:

```json
{
  "enabledMcpjsonServers": ["gsc"]
}
```

### Step 5 — New conversation, then ask

Start a new conversation and ask:

> Which Search Console properties can you see?

Claude calls `mcp__gsc__list_sites`, Philibert shows the approval card, you
approve, and the properties come back.

The server provides four tools:

| Tool | What it does |
|---|---|
| `list_sites` | Lists the properties the service account can read |
| `query_search_analytics` | Clicks, impressions, CTR and position, grouped by `query`, `page`, `country`, `device` or `date` |
| `list_sitemaps` | Sitemaps submitted for a property |
| `inspect_url` | Index status for a single URL |

**Property URL format.** Search Console has two property types. A *domain*
property is addressed as `sc-domain:example.com`, not `https://www.example.com/`.
Run `list_sites` first and use the exact string it returns.

Once that works, real questions look like:

> What were my top 20 queries by clicks last month, and which pages did they
> land on?

---

## Optional: let the CLI write `.mcp.json` for you

With a terminal, `cd` into the project folder and run:

```bash
claude mcp add --scope project gsc \
  -e GOOGLE_SERVICE_ACCOUNT_FILE=/home/you/gsc/service-account.json \
  -- /home/you/bin/gsc-mcp-go-linux-amd64
```

`--scope project` is the **only** scope that works with Philibert. It writes the
same `.mcp.json`. You still need Step 2 — the CLI records approval in a file
Philibert does not read.

### Why the other scopes do not work

Philibert relocates Claude Code's config directory. Signed in with OAuth,
`AuthValidator.setupAuthEnv()` sets
`CLAUDE_CONFIG_DIR=<userData>/claude-config`
(`src/main/services/claude/AuthValidator.ts:128`,
`src/main/utils/resourcePaths.ts:187`):

| OS | Philibert's config dir |
|---|---|
| Linux | `~/.config/Philibert/claude-config` |
| macOS | `~/Library/Application Support/Philibert/claude-config` |
| Windows | `%APPDATA%\Philibert\claude-config` |

`claude mcp add` at the default `local` scope, and at `--scope user`, both write
to `$CLAUDE_CONFIG_DIR/.claude.json`. From a normal terminal that is
`~/.claude.json` — a different file from the one Philibert points the CLI at, so
the server is invisible to the app. `.mcp.json` is resolved from the working
directory instead, which both modes set to your project folder.

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
(`ChannelSession.ts:241`) to inject Philibert's own channel server.

`--mcp-config` is **additive**. Because `--strict-mcp-config` is not passed, the
CLI keeps loading every other MCP source, your project `.mcp.json` included.
Verified: a run with both a project `.mcp.json` and `--mcp-config` pointing
elsewhere connected both servers and exposed both tool sets.

`--allowedTools mcp__philibert__reply` is likewise additive — it pre-approves the
channel reply tool, it does not restrict the tool list.

### SDK mode

`ClaudeCodeService` calls `query()` with `cwd` set to the project folder
(`ClaudeCodeService.ts:655`) and sets neither `settingSources` nor
`strictMcpConfig`. In `@anthropic-ai/claude-agent-sdk` 0.3.220, omitting
`settingSources` means all filesystem settings are loaded, matching CLI
defaults — so `.mcp.json` and `.claude/settings.local.json` are both read.

---

## Implementation note

Channel mode writes a `.claude/settings.local.json` into its per-conversation
session directory (`ChannelSession.ts:656`) containing
`enableAllProjectMcpServers: true`. That file is inert: the CLI resolves project
settings from its working directory, which is the user's project folder, not the
session directory. Its contents are already supplied by other means — tool
permissions via `--allowedTools`, workspace trust via the global settings file —
so nothing is broken by it, but it is **not** why Step 2 works and it does not
remove the need for Step 2.

---

## Troubleshooting

**Claude lists no MCP tools.** Work through this order:

1. Is `.mcp.json` in the folder Philibert shows as the working directory?
   (Settings → Working Directory.) It must be the project root.
2. Did you create `.claude/settings.local.json` (Step 2)?
3. Did you open a **new** conversation after editing the files?
4. Is `command` an absolute path to a file that exists?
5. Does the server need a runtime Philibert does not bundle? See
   [Before you start](#before-you-start-can-philibert-run-the-server).

**The conversation hangs right after you add a server.** That is the
unhandled trust dialog in channel mode — do Step 2 and start a new conversation.

**Checking the logs.**

- Philibert's main log: `<userData>/logs/main.log`
- Channel mode PTY transcript, carrying the CLI's own MCP startup output:
  `<tmpdir>/philibert-pty-<conversationId>.log`

**Remote servers needing an interactive OAuth login.** Servers that rely on the
CLI's `/mcp` authentication flow cannot be completed from inside Philibert. Use
a server that accepts a token in `headers`, or a stdio server that reads a key
from `env`.

---

## Reference

| Thing | Where |
|---|---|
| Server definitions | `<project>/.mcp.json` |
| Server approval | `<project>/.claude/settings.local.json` |
| Tool naming | `mcp__<server-name>__<tool-name>` |
| Transports | `stdio` (default), `http`, `sse` |
| Philibert config dir | `<userData>/claude-config` |
| Bundled Node (Windows only) | `<install dir>/resources/node.exe` — no npm, no npx |

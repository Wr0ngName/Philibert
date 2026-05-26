# Channel Execution Mode

Channel mode is an alternative execution path that runs Claude Code in a
pseudo-terminal (PTY) instead of through the Agent SDK. This triggers
**subscription billing** (Pro/Max) rather than the SDK credit pool, giving
users uncapped usage against their existing Claude subscription.

## Architecture

```
Renderer (Vue 3)          Main Process (Electron)              Subprocess
+-----------+   IPC       +--------------------+
| Chat UI   | <-------->  | ClaudeCodeService  |
| Settings  |             | (mode-aware facade)|
+-----------+             +---+--------+-------+
                              |        |
                     SDK mode |        | Channel mode
                              v        v
                   +----------+   +-----------------+    HTTP     +--------------------+
                   | query()  |   | ChannelService  | <-------->  | channel-server.cjs |
                   | (as-is)  |   +-------+---------+             | (MCP over stdio)   |
                   +----------+           |                       +--------------------+
                                          v                              ^
                                  +---------------+                      | spawned by
                                  | ChannelBridge |                      |
                                  | (HTTP server) |               +------+---------+
                                  +-------+-------+               | Claude Code    |
                                          |                       | (interactive   |
                                  +-------+--------+   PTY -----> |  subscription) |
                                  | ChannelSession |              +----------------+
                                  | (node-pty)     |
                                  +----------------+
```

## How It Works

### Message Flow (user sends a message)

1. **User types message** in Philibert chat UI
2. **ClaudeCodeService.sendMessage()** checks `executionMode` config
   - If `'channel'` + OAuth auth: delegates to `ChannelService`
   - If `'sdk'`: uses Agent SDK as before
3. **ChannelService.sendMessage()** ensures the bridge and session exist
4. **ChannelBridge.pushMessage()** enqueues the message with sender/timestamp metadata
5. **channel-server.cjs** (inside Claude Code's MCP subprocess) long-polls the
   bridge at `GET /api/channel/poll/:convId` and receives the message
6. The channel server pushes a `notifications/claude/channel` JSON-RPC
   notification to Claude Code via the stdio MCP transport
7. **Claude Code** wraps the content in a `<channel source="philibert">` tag,
   enqueues it as a user turn, and runs inference
8. The model calls the `reply` MCP tool with the response text
9. The `reply` tool handler POSTs to `POST /api/channel/reply/:convId`
10. **ChannelBridge** invokes the `onReply` callback
11. **ChannelService.handleReply()** emits `CLAUDE_CHUNK` IPC with the text
12. After 2 seconds of silence (no more replies), emits `CLAUDE_DONE`
13. **Renderer** displays the message in the chat UI

### Reply Routing

Claude Code's channel protocol is model-driven: the MCP server's `instructions`
field tells the model to use the `reply` tool for all responses. This is
confirmed by Claude Code's source (`src/services/mcp/channelNotification.ts`):

> "The model sees where the message came from and decides which tool to reply
> with (the channel's MCP tool, SendUserMessage, or both)."

The `instructions` block in `channel-server.ts` is essential and must not be
removed. Both Anthropic's official `fakechat` plugin and the `small-claw`
reference implementation use the same mechanism.

### Permission Flow

Claude Code fires **both** an MCP channel permission notification **and** a
terminal dialog simultaneously as racers — the first to respond wins via an
internal atomic `claim()` mechanism (see `interactiveHandler.ts` in the CLI
source). The MCP channel protocol is the primary path; the PTY dialog is gated
behind feature flags (`KAIROS`/`tengu_harbor_permissions`) and serves as a
fallback when those flags are closed.

**Primary path (MCP channel protocol):**

1. Claude Code sends `notifications/claude/channel/permission_request` to the
   MCP channel server
2. The channel server POSTs to `POST /api/channel/permission/request/:convId`
3. ChannelBridge stores the pending permission and invokes the callback
4. ChannelService emits `CLAUDE_TOOL_USE` IPC (same as SDK mode) and resolves
   a per-tool Promise signal with `true`
5. User approves or denies in the Philibert UI
6. ChannelService calls `bridge.submitPermissionVerdict()`
7. The channel server long-polls `GET /api/channel/permission/poll/:convId`
   and receives the verdict
8. The channel server pushes `notifications/claude/channel/permission` to
   Claude Code, which proceeds or aborts

**Fallback path (PTY dialog parsing):**

Channel mode always has both MCP and PTY. PTY detects the interactive
"Do you want to proceed?" dialog in the PTY output but does **not** emit
directly. Instead, PTY awaits the MCP signal (a per-tool Promise):

- If MCP emitted (`true`): PTY is suppressed. MCP handled it.
- If MCP resolved `false` (forwarding failed): PTY emits as fallback.

This is pure event-driven coordination via Promises — no timers, no
races, deterministic regardless of arrival order. MCP always wins when
available; PTY only activates when MCP explicitly signals failure.

**MCP failure recovery:** If the channel server fails to POST the
permission request to the bridge (network error, bridge down), it POSTs
to `POST /api/channel/permission/failed/:convId` instead. The bridge
invokes the failure callback, which resolves the signal with `false`,
triggering the PTY fallback path.

**Verdict routing:** tries the MCP bridge first (`submitPermissionVerdict`),
falling back to PTY (`submitPtyPermission`).

### Error Handling

Claude Code's channel protocol defines **only** three notification types:
messages, permission requests, and permission verdicts. There are **no error
notifications** in the protocol (no quota, rate limit, auth, or status
notifications via MCP).

All errors are detected via **PTY output pattern matching** in ChannelSession:

| Error Type | PTY Pattern | User Message |
|------------|-------------|--------------|
| Rate limit | "you've hit your", "request rejected (429)" | Rate limit reached |
| Auth | "please run /login", "oauth token revoked" | Authentication error |
| Quota | "credit balance is too low" | Quota exceeded |
| Org | "belongs to a disabled organization" | Organization disabled |
| Context | "prompt is too long", "request too large" | Context limit reached |

Errors emit `CLAUDE_ERROR` + `CLAUDE_DONE` IPC events. Fatal errors (CLI
incompatibility) also clean up the session. A dedup Set prevents the same
error from firing multiple times.

### Usage Tracking

Channel mode reads Claude Code's internal session JSONL files to track token
usage and costs. The same JSONL parsing approach is used by `small-claw`.

- `ChannelSession.discoverSessionId()` reads `~/.claude/sessions/{pid}.json`
- `ChannelSession.findSessionJsonl()` locates the JSONL at
  `~/.claude/projects/{escapedCwd}/{sessionId}.jsonl`
- `parseSessionUsage()` filters for `type === 'assistant'` entries and
  accumulates per-model token counts with cache-aware cost calculation
- ChannelService polls usage every 10 seconds and emits `CLAUDE_USAGE_UPDATE`
  IPC, which the renderer's `ContextUsageBar` consumes

## Files

### Core (`src/main/services/channel/`)

| File | Purpose |
|------|---------|
| `ChannelService.ts` | Orchestrator: manages bridge, sessions, message/reply flow, turn boundaries, health checks, usage polling |
| `ChannelBridge.ts` | HTTP IPC server with per-conversation message queues, long-poll endpoints, permission relay, token auth |
| `ChannelSession.ts` | PTY lifecycle: spawns Claude Code, auto-accepts dialogs, parses errors, reads JSONL usage |
| `channel-server.ts` | Standalone MCP server subprocess: bridges Claude Code <-> ChannelBridge over HTTP |
| `index.ts` | Barrel exports |

### Integration Points

| File | What |
|------|------|
| `src/main/services/ClaudeCodeService.ts` | Mode-aware facade: delegates to ChannelService when `executionMode === 'channel'` |
| `src/shared/types.ts` | `ExecutionMode`, `ChannelStatus`, `ChannelModelTokens`, `ChannelUsageData`, IPC channel constants |
| `src/main/constants/app.ts` | `MAIN_CONSTANTS.CHANNEL`: PTY dimensions, timeouts, retry limits |
| `src/main/utils/resourcePaths.ts` | `ChannelPaths.getChannelServerScript()`, `getChannelSessionsDir()` |
| `src/main/ipc/conversations.ts` | Cleanup: deletes `channel-sessions/<convId>` directory on conversation delete |
| `src/renderer/stores/settings.ts` | `executionMode` computed getter, `setExecutionMode()` action |
| `src/renderer/components/settings/SettingsPanel.vue` | Execution Mode toggle (SDK / Channel) with trade-off warning |

### Build

The channel server is built as a separate esbuild bundle:

```bash
npm run build:channel-server
# Produces: out/channel-server.cjs
```

In packaged builds, the script is placed at `resources/channel-server.cjs`.

## Configuration

Channel mode is enabled per-user in Settings. The `executionMode` field in
`AppConfig` defaults to `'sdk'`. Switching to `'channel'` takes effect on the
next conversation (active sessions keep their mode).

Channel mode requires OAuth authentication. API key users are blocked at both
the Philibert level (ClaudeCodeService checks `authMethod === 'oauth'`) and the
Claude Code level (channel gate requires OAuth tokens).

## Channel Server Details

The MCP server declares these capabilities to pass Claude Code's gate check:

```typescript
capabilities: {
  tools: {},
  experimental: {
    'claude/channel': {},
    'claude/channel/permission': {},
  },
},
```

Claude Code's gate function (`KrH` / `gateChannelServer`) checks:

1. Server declares `experimental['claude/channel']` capability
2. Runtime feature flag is enabled
3. OAuth authentication present
4. Org policy allows channels (Teams/Enterprise)
5. Server listed in `--channels` session arg
6. Plugin on approved allowlist (bypassed by `--dangerously-load-development-channels`)

The `--dangerously-load-development-channels server:philibert` CLI flag bypasses
the allowlist gate for local development.

## Session Lifecycle

### Startup

1. ChannelService creates the ChannelBridge (HTTP server on dynamic port)
2. Creates a session directory at `{userData}/channel-sessions/{conversationId}/`
3. Writes `.mcp.json` with the channel server config (command, args, env vars)
4. Writes `.claude/settings.local.json` with tool permissions
5. Pre-writes `hasCompletedOnboarding: true` and `theme: dark` to Claude
   Code's config file. The file path must match Claude Code's
   `getGlobalClaudeFile()` resolution (`src/utils/env.ts`):
   - If `CLAUDE_CONFIG_DIR` is set: `$CLAUDE_CONFIG_DIR/.claude.json`
   - Legacy: if `~/.claude/.config.json` exists, use that
   - Default (no `CLAUDE_CONFIG_DIR`): `~/.claude.json` (homedir, **not**
     `~/.claude/.claude.json`)
   This flag gates `showSetupScreens()` in `src/interactiveHelpers.tsx`.
   Since Philibert provides credentials externally, the setup screens
   (theme picker, login selector) are unnecessary.
6. Sets workspace trust in the global `settings.json` for the working directory
7. Spawns Claude Code in a PTY via `node-pty`
8. Auto-accepts startup dialogs (workspace trust, dev channels warning,
   and as a fallback: theme picker, login method selector, post-login
   "Press Enter to continue")
9. Channel server starts, connects to bridge, begins polling

### Shutdown

- `ChannelSession.stop()` kills the PTY process (SIGTERM, then SIGKILL after 10s)
- Session directories are cleaned up on conversation delete
- `ChannelService.shutdown()` stops all sessions and the bridge on app quit

### Health Monitoring

ChannelService checks every 10 seconds whether the PTY is still running. If it
crashed, it restarts with exponential backoff (5s base, 2x multiplier, max 60s,
max 10 attempts). After 10 consecutive failures, it reports an error to the UI.

### Session Resume (v0.15.0+)

Channel mode supports conversation continuity across app restarts via Claude
Code's `--resume <sessionId>` CLI flag. The flow mirrors SDK mode:

1. After PTY starts, `ChannelSession` polls `~/.claude/sessions/{pid}.json`
   every second (up to 30 attempts) to discover the session ID
2. Once found, the session ID is emitted via `CLAUDE_SESSION_ID` IPC — the
   same channel used by SDK mode
3. The renderer stores it in the `Conversation` object (persisted to disk)
4. On next app launch, when the user sends a message to an existing
   conversation, the persisted session ID is passed as `resumeSessionId`
5. `ChannelSession.start()` adds `--resume <sessionId>` to the CLI args
6. Claude Code resumes the conversation with full context

For crash recovery (health check restarts within the same app session), the
discovered session ID is preserved internally on the `ChannelSession` instance
and reused on the next `start()` call.

## Trade-offs vs SDK Mode

| Feature | SDK Mode | Channel Mode |
|---------|----------|--------------|
| Billing | Credit pool ($20 Pro / $100-200 Max) | Subscription (uncapped) |
| Streaming | Real-time token streaming | Complete messages only |
| Model switching | Mid-session | Per-conversation only |
| Session resume | Supported | Supported (v0.15.0+) |
| Usage tracking | Direct from SDK | Parsed from JSONL files |

## Known Constraints

- A 2-second delay after bridge readiness is needed to prevent a race condition
  where the first notification arrives ~13ms before Claude Code registers the
  channel handler
- The `instructions` MCP field is the mechanism for directing replies through
  the `reply` tool; removing it breaks the reply flow
- Channel mode uses Haiku/Sonnet/Opus at whatever the user selects, but model
  switching mid-conversation requires starting a new session
- PTY output parsing for dialogs is inherently fragile (ANSI stripping +
  pattern matching); the MCP permission protocol is the preferred path
- `hasCompletedOnboarding` in Claude Code's config file gates
  `showSetupScreens()`. The config file path varies by context — see
  `getGlobalClaudeFile()` in `src/utils/env.ts`: without `CLAUDE_CONFIG_DIR`
  it resolves to `~/.claude.json` (homedir), **not** `~/.claude/.claude.json`.
  Writing to the wrong path was the root cause of onboarding persisting in
  v0.14.5. PTY auto-accept patterns (theme picker, login selector, post-login
  "Press Enter") are kept as a fallback.
  Ref: https://github.com/codeaashu/claude-code

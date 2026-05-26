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

When Claude Code needs user approval for a tool (Bash, file writes, etc.):

1. Claude Code sends `notifications/claude/channel/permission_request` to the
   MCP channel server
2. The channel server POSTs to `POST /api/channel/permission/request/:convId`
3. ChannelBridge stores the pending permission and invokes the callback
4. ChannelService emits `CLAUDE_TOOL_USE` IPC (same as SDK mode)
5. User approves or denies in the Philibert UI
6. ChannelService calls `bridge.submitPermissionVerdict()`
7. The channel server long-polls `GET /api/channel/permission/poll/:convId`
   and receives the verdict
8. The channel server pushes `notifications/claude/channel/permission` to
   Claude Code, which proceeds or aborts

There is also a **PTY fallback**: if Claude Code shows an interactive permission
dialog in the terminal instead of using the MCP protocol, ChannelSession parses
the PTY output and relays the dialog to the UI.

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
5. Pre-writes `hasCompletedOnboarding: true` and `theme: dark` to
   `.claude.json` in the Claude config directory, skipping the entire first-run
   onboarding flow (theme picker, login method selector, OAuth flow).
   Claude Code ignores `CLAUDE_CODE_OAUTH_TOKEN` during onboarding and forces
   an interactive OAuth flow that cannot be completed in channel mode.
6. Sets workspace trust in the global `settings.json` for the working directory
7. Spawns Claude Code in a PTY via `node-pty`
8. Auto-accepts startup dialogs (workspace trust, dev channels warning,
   and as a fallback: theme picker, login method selector)
9. Channel server starts, connects to bridge, begins polling

### Shutdown

- `ChannelSession.stop()` kills the PTY process (SIGTERM, then SIGKILL after 10s)
- Session directories are cleaned up on conversation delete
- `ChannelService.shutdown()` stops all sessions and the bridge on app quit

### Health Monitoring

ChannelService checks every 10 seconds whether the PTY is still running. If it
crashed, it restarts with exponential backoff (5s base, 2x multiplier, max 60s,
max 10 attempts). After 10 consecutive failures, it reports an error to the UI.

## Trade-offs vs SDK Mode

| Feature | SDK Mode | Channel Mode |
|---------|----------|--------------|
| Billing | Credit pool ($20 Pro / $100-200 Max) | Subscription (uncapped) |
| Streaming | Real-time token streaming | Complete messages only |
| Model switching | Mid-session | Per-conversation only |
| Session resume | Supported | Not supported |
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
- Claude Code's first-run onboarding ignores `CLAUDE_CODE_OAUTH_TOKEN` and
  forces an interactive OAuth flow (browser + paste-code prompt). The
  `hasCompletedOnboarding` pre-write in `.claude.json` is essential to skip
  this; the PTY auto-accept patterns for theme picker and login selector are
  kept only as a fallback

/**
 * Tests for SDKMessageHandler
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { SlashCommandInfo } from '../../../../shared/types';
// Mock the logger to avoid Electron app dependency
vi.mock('../../../utils/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
import { SDKMessageHandler, MessageHandlerCallbacks, resolveResultError, extractTaskCreateId, usageLimitStopFrom, usageWarningFrom } from '../SDKMessageHandler';

describe('SDKMessageHandler', () => {
  let callbacks: MessageHandlerCallbacks;
  let handler: SDKMessageHandler;

  beforeEach(() => {
    callbacks = {
      onChunk: vi.fn(),
      onSlashCommands: vi.fn(),
      onTaskNotification: vi.fn(),
      onUsageUpdate: vi.fn(),
      onSystemNote: vi.fn(),
    };
    handler = new SDKMessageHandler(callbacks);
  });

  describe('a tool result carrying an image', () => {
    /**
     * The wiring, not the arithmetic: `toolResultParts` is tested on its own,
     * but what regressed in the first place was this handler folding an image
     * block into an empty string with `blocks.map(b => b.text || '')`. The
     * extractor can be perfect and the handler can still not call it.
     */
    const DATA = 'aGVsbG8=';

    function userMessageWith(content: unknown, toolUseResult?: unknown) {
      return {
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
        ...(toolUseResult !== undefined ? { tool_use_result: toolUseResult } : {}),
      };
    }

    it('hands the image to the caller instead of dropping it', async () => {
      const onToolResult = vi.fn();
      const h = new SDKMessageHandler({ ...callbacks, onToolResult });

      await h.handleMessage(userMessageWith([
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [
            { type: 'text', text: 'here is the image' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: DATA } },
          ],
        },
      ]) as never);

      expect(onToolResult).toHaveBeenCalledTimes(1);
      const result = onToolResult.mock.calls[0][0];
      expect(result.toolUseBlockId).toBe('toolu_1');
      expect(result.text ?? result.content).toBe('here is the image');
      expect(result.images).toEqual([{ base64: DATA, mediaType: 'image/png' }]);
    });

    it('does not report an image-only result as empty text', async () => {
      // The exact defect: a Read of a .png showed a blank result.
      const onToolResult = vi.fn();
      const h = new SDKMessageHandler({ ...callbacks, onToolResult });

      await h.handleMessage(userMessageWith([
        {
          type: 'tool_result',
          tool_use_id: 'toolu_2',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: DATA } },
          ],
        },
      ]) as never);

      const result = onToolResult.mock.calls[0][0];
      expect(result.content).not.toBe('');
      expect(result.images).toHaveLength(1);
    });

    it('takes the image off the structured Read result too', async () => {
      const onToolResult = vi.fn();
      const h = new SDKMessageHandler({ ...callbacks, onToolResult });

      await h.handleMessage(userMessageWith(
        [{ type: 'tool_result', tool_use_id: 'toolu_3', content: 'Read 1 image' }],
        { type: 'image', file: { base64: DATA, type: 'image/png', originalSize: 5 } },
      ) as never);

      const result = onToolResult.mock.calls[0][0];
      expect(result.content).toBe('Read 1 image');
      expect(result.images).toEqual([{ base64: DATA, mediaType: 'image/png' }]);
    });

    it('says nothing about images on an ordinary text result', async () => {
      const onToolResult = vi.fn();
      const h = new SDKMessageHandler({ ...callbacks, onToolResult });

      await h.handleMessage(userMessageWith([
        { type: 'tool_result', tool_use_id: 'toolu_4', content: 'ok' },
      ]) as never);

      const result = onToolResult.mock.calls[0][0];
      expect(result.content).toBe('ok');
      expect(result.images).toBeUndefined();
    });
  });

  describe('tool progress heartbeats', () => {
    // Captured from a real session: a Bash command still running at 30s.
    const heartbeat = {
      type: 'tool_progress',
      tool_use_id: 'toolu_01Vp8UFXGekPvhfr9cE7GvoY-heartbeat-0',
      tool_name: 'Bash',
      parent_tool_use_id: 'toolu_01Vp8UFXGekPvhfr9cE7GvoY',
      elapsed_time_seconds: 30,
      heartbeat: true,
      session_id: '02050891-c712-4746-9f21-205df6f2756d',
      uuid: '67bde0c4-4df6-4f9f-af88-99b8dc866d94',
    };

    it('is known, so it does not fill main.log as unhandled', async () => {
      // main.log is written at info and above; a heartbeat arrives every 30
      // seconds for as long as a command runs.
      const logger = (await import('../../../utils/logger')).default;
      vi.mocked(logger.info).mockClear();
      vi.mocked(logger.warn).mockClear();

      await handler.handleMessage(heartbeat as never);

      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith('Tool still running', {
        toolName: 'Bash',
        toolUseId: 'toolu_01Vp8UFXGekPvhfr9cE7GvoY',
        elapsedSeconds: 30,
      });
    });

    it('changes nothing the user sees', async () => {
      await handler.handleMessage(heartbeat as never);

      for (const callback of Object.values(callbacks)) {
        expect(callback).not.toHaveBeenCalled();
      }
    });

    it('still reports a message type nothing handles', async () => {
      // Which is how a new SDK message is noticed at all.
      const logger = (await import('../../../utils/logger')).default;
      vi.mocked(logger.info).mockClear();

      await handler.handleMessage({ type: 'something_new', uuid: 'u' } as never);

      expect(logger.info).toHaveBeenCalledWith('Unhandled SDK message type', expect.objectContaining({
        type: 'something_new',
      }));
    });
  });

  describe('a turn stopped by a usage limit', () => {
    // Shapes per sdk.d.ts (SDKRateLimitEvent, SDKAssistantMessage.error).
    const RESETS_AT_SECONDS = 1_792_000_000;

    function rateLimitEvent(info: Record<string, unknown>) {
      return { type: 'rate_limit_event', rate_limit_info: info, uuid: 'u-rl', session_id: 's' };
    }

    const rejected = rateLimitEvent({
      status: 'rejected',
      resetsAt: RESETS_AT_SECONDS,
      rateLimitType: 'five_hour',
    });

    function refusal(parentToolUseId: string | null = null) {
      return {
        type: 'assistant',
        message: { content: [{ type: 'text', text: "You've hit your limit · resets 7:50pm" }] },
        parent_tool_use_id: parentToolUseId,
        error: 'rate_limit',
        uuid: 'u-a',
        session_id: 's',
      };
    }

    it('reports the reset, in milliseconds, at the end of the turn', async () => {
      await handler.handleMessage(rejected as never);
      await handler.handleMessage(refusal() as never);

      expect(handler.takeUsageLimitStop()).toEqual({
        resetsAt: RESETS_AT_SECONDS * 1000,
        limitType: 'five_hour',
      });
    });

    it('does not report the same stop for a later turn', async () => {
      await handler.handleMessage(rejected as never);
      await handler.handleMessage(refusal() as never);
      handler.takeUsageLimitStop();

      expect(handler.takeUsageLimitStop()).toBeNull();
    });

    it('needs the turn to have been refused, not just a rejected status', async () => {
      // A turn can carry on past a rejected limit, e.g. on a fallback model.
      await handler.handleMessage(rejected as never);

      expect(handler.takeUsageLimitStop()).toBeNull();
    });

    it("ignores a sub-agent's refusal, which does not stop the turn", async () => {
      await handler.handleMessage(rejected as never);
      await handler.handleMessage(refusal('toolu_agent') as never);

      expect(handler.takeUsageLimitStop()).toBeNull();
    });

    it('forgets a refusal when a new query starts', async () => {
      await handler.handleMessage(rejected as never);
      await handler.handleMessage(refusal() as never);
      handler.reset();

      expect(handler.takeUsageLimitStop()).toBeNull();
    });

    it('is not a usage-limit stop while drawing on extra usage', async () => {
      await handler.handleMessage(rateLimitEvent({
        status: 'rejected', resetsAt: RESETS_AT_SECONDS, isUsingOverage: true,
      }) as never);
      await handler.handleMessage(refusal() as never);

      expect(handler.takeUsageLimitStop()).toBeNull();
    });

    it('is handled, so it does not fill main.log as unhandled', async () => {
      const logger = (await import('../../../utils/logger')).default;
      vi.mocked(logger.info).mockClear();

      await handler.handleMessage(rejected as never);

      expect(logger.info).not.toHaveBeenCalledWith('Unhandled SDK message type', expect.anything());
      expect(logger.info).toHaveBeenCalledWith('Rate limit status', expect.objectContaining({ status: 'rejected' }));
    });

    it('passes on a usage warning, and its end, as the server reports them', async () => {
      // The sequence a real session logged (2026-10-27): allowed at start,
      // then the weekly limit past its threshold.
      const onUsageWarning = vi.fn();
      handler = new SDKMessageHandler({ ...callbacks, onUsageWarning });

      await handler.handleMessage(rateLimitEvent({ status: 'allowed', rateLimitType: 'five_hour' }) as never);
      await handler.handleMessage(rateLimitEvent({
        status: 'allowed_warning',
        utilization: 0.8,
        rateLimitType: 'seven_day',
        resetsAt: RESETS_AT_SECONDS,
        surpassedThreshold: 0.75,
      }) as never);

      expect(onUsageWarning.mock.calls).toEqual([
        [null],
        [{ utilization: 0.8, limitType: 'seven_day', resetsAt: RESETS_AT_SECONDS * 1000, surpassedThreshold: 0.75 }],
      ]);
    });
  });

  describe('usageWarningFrom', () => {
    it('is a warning only for allowed_warning, with what the server said', () => {
      expect(usageWarningFrom({ status: 'allowed' })).toBeNull();
      expect(usageWarningFrom({ status: 'rejected', resetsAt: 10 })).toBeNull();
      expect(usageWarningFrom({ status: 'allowed_warning' })).toEqual({});
      expect(usageWarningFrom({ status: 'allowed_warning', utilization: Number.NaN, resetsAt: Number.NaN })).toEqual({});
    });
  });

  describe('usageLimitStopFrom', () => {
    it('needs a rejection with a known reset time', () => {
      expect(usageLimitStopFrom(null)).toBeNull();
      expect(usageLimitStopFrom({ status: 'allowed_warning', resetsAt: 10 })).toBeNull();
      expect(usageLimitStopFrom({ status: 'rejected' })).toBeNull();
      expect(usageLimitStopFrom({ status: 'rejected', resetsAt: Number.NaN })).toBeNull();
      expect(usageLimitStopFrom({ status: 'rejected', resetsAt: 10 })).toEqual({ resetsAt: 10_000 });
    });

    it('is not one when extra usage is in use', () => {
      expect(usageLimitStopFrom({ status: 'rejected', resetsAt: 10, overageInUse: true })).toBeNull();
      expect(usageLimitStopFrom({ status: 'rejected', resetsAt: 10, isUsingOverage: true })).toBeNull();
    });
  });

  describe('reset', () => {
    it('should reset querySucceeded flag', () => {
      // Simulate query success
      handler.handleMessage({
        type: 'result',
        subtype: 'success',
        num_turns: 1,
        duration_ms: 100,
      } as never);

      expect(handler.didQuerySucceed()).toBe(true);

      handler.reset();
      expect(handler.didQuerySucceed()).toBe(false);
    });

    it('should reset slash command tracking flag', () => {
      handler.markSlashCommandSent();
      handler.reset();
      // Flag should be reset - verify by checking behavior
      // When slash command flag is reset, assistant messages won't be emitted
      handler.handleMessage({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'test' }] },
      } as never);
      expect(callbacks.onChunk).not.toHaveBeenCalled();
    });
  });

  describe('markSlashCommandSent', () => {
    it('should mark that a slash command was sent', () => {
      handler.markSlashCommandSent();

      // When slash command is marked, assistant messages should be emitted
      handler.handleMessage({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Help output' }] },
      } as never);

      expect(callbacks.onChunk).toHaveBeenCalledWith('Help output');
    });

    it('should reset flag after processing assistant message', () => {
      handler.markSlashCommandSent();

      // First assistant message - emitted
      handler.handleMessage({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'First' }] },
      } as never);

      // Clear the mock
      vi.clearAllMocks();

      // Second assistant message - not emitted (flag was reset)
      handler.handleMessage({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Second' }] },
      } as never);

      expect(callbacks.onChunk).not.toHaveBeenCalled();
    });
  });

  describe('updateSlashCommands', () => {
    it('should replace the list with exactly what the SDK reports', () => {
      // A replacement, not a merge. The SDK's push is authoritative
      // ("Clients should REPLACE their cached command list with this
      // payload") and already includes Claude Code's own commands. Merging a
      // local table over it was what hid /rewind, which the table lacked.
      const commands: SlashCommandInfo[] = [
        { name: 'custom-skill', description: 'Custom skill', argumentHint: '' },
      ];

      handler.updateSlashCommands(commands);

      expect(handler.getSlashCommands()).toEqual(commands);
    });

    it('should keep aliases and the builtin marker', () => {
      // Dropping these broke alias resolution (/cost → /usage) and left the
      // autocomplete unable to tell a project command from a builtin one.
      const commands: SlashCommandInfo[] = [
        {
          name: 'usage',
          description: 'Token and cost totals',
          argumentHint: '',
          aliases: ['cost', 'stats'],
          builtin: true,
        },
      ];

      handler.updateSlashCommands(commands);

      const usage = handler.getSlashCommands().find((c) => c.name === 'usage');
      expect(usage?.aliases).toEqual(['cost', 'stats']);
      expect(usage?.builtin).toBe(true);
    });

    it('should keep two rows that share a name', () => {
      // The SDK allows it and defines which one a typed name runs, so
      // collapsing them here would break that rule.
      const commands: SlashCommandInfo[] = [
        { name: 'review', description: 'project version', argumentHint: '' },
        { name: 'review', description: 'builtin version', argumentHint: '', builtin: true },
      ];

      handler.updateSlashCommands(commands);

      expect(handler.getSlashCommands()).toHaveLength(2);
    });
  });

  describe('handleMessage - assistant type', () => {
    it('should not emit regular assistant messages', async () => {
      await handler.handleMessage({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Regular message' }] },
      } as never);

      expect(callbacks.onChunk).not.toHaveBeenCalled();
    });

    it('should emit assistant messages when slash command flag is set', async () => {
      handler.markSlashCommandSent();

      await handler.handleMessage({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Command output' }] },
      } as never);

      expect(callbacks.onChunk).toHaveBeenCalledWith('Command output');
    });

    it('should not emit empty text content', async () => {
      handler.markSlashCommandSent();

      await handler.handleMessage({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '   ' }] },
      } as never);

      expect(callbacks.onChunk).not.toHaveBeenCalled();
    });
  });

  describe('handleMessage - session_id handling', () => {
    it('should emit session_id from init message', async () => {
      const onSessionId = vi.fn();
      const callbacksWithSession: MessageHandlerCallbacks = {
        ...callbacks,
        onSessionId,
      };
      const sessionHandler = new SDKMessageHandler(callbacksWithSession);

      await sessionHandler.handleMessage({
        type: 'system',
        subtype: 'init',
        slash_commands: [],
        model: 'claude-3',
        session_id: 'test-session-abc123',
      } as never);

      expect(onSessionId).toHaveBeenCalledWith('test-session-abc123');
    });

    it('should emit session_id from result message', async () => {
      const onSessionId = vi.fn();
      const callbacksWithSession: MessageHandlerCallbacks = {
        ...callbacks,
        onSessionId,
      };
      const sessionHandler = new SDKMessageHandler(callbacksWithSession);

      await sessionHandler.handleMessage({
        type: 'result',
        subtype: 'success',
        num_turns: 1,
        duration_ms: 100,
        session_id: 'result-session-xyz789',
      } as never);

      expect(onSessionId).toHaveBeenCalledWith('result-session-xyz789');
    });

    it('should NOT emit session_id from error result messages', async () => {
      const onSessionId = vi.fn();
      const callbacksWithSession: MessageHandlerCallbacks = {
        ...callbacks,
        onSessionId,
      };
      const sessionHandler = new SDKMessageHandler(callbacksWithSession);

      await sessionHandler.handleMessage({
        type: 'result',
        subtype: 'error_during_execution',
        num_turns: 0,
        duration_ms: 0,
        session_id: 'stale-error-session-id',
      } as never);

      expect(onSessionId).not.toHaveBeenCalled();
    });

    it('should NOT emit session_id from error subtype result messages', async () => {
      const onSessionId = vi.fn();
      const callbacksWithSession: MessageHandlerCallbacks = {
        ...callbacks,
        onSessionId,
      };
      const sessionHandler = new SDKMessageHandler(callbacksWithSession);

      await sessionHandler.handleMessage({
        type: 'result',
        subtype: 'error',
        num_turns: 0,
        duration_ms: 0,
        session_id: 'another-stale-session-id',
      } as never);

      expect(onSessionId).not.toHaveBeenCalled();
    });

    it('should not emit session_id if not present in init message', async () => {
      const onSessionId = vi.fn();
      const callbacksWithSession: MessageHandlerCallbacks = {
        ...callbacks,
        onSessionId,
      };
      const sessionHandler = new SDKMessageHandler(callbacksWithSession);

      await sessionHandler.handleMessage({
        type: 'system',
        subtype: 'init',
        slash_commands: [],
        model: 'claude-3',
      } as never);

      expect(onSessionId).not.toHaveBeenCalled();
    });
  });

  describe('handleMessage - system type with init', () => {
    it('should record the command names the init message carries', async () => {
      // init carries names only, so this is the preliminary list that gets
      // them into the autocomplete at once; supportedCommands() follows with
      // the detailed rows. Nothing is added from a local table.
      await handler.handleMessage({
        type: 'system',
        subtype: 'init',
        slash_commands: ['custom-skill', 'another-skill'],
        model: 'claude-3',
      } as never);

      expect(handler.getSlashCommands()).toEqual([
        { name: 'custom-skill', description: '', argumentHint: '' },
        { name: 'another-skill', description: '', argumentHint: '' },
      ]);
    });

    it('should not downgrade a detailed row to a bare name', async () => {
      // A description the user is reading must not be replaced by nothing
      // just because init lists the same command again.
      handler.updateSlashCommands([
        { name: 'custom-skill', description: 'Full description', argumentHint: '<arg>' },
      ]);

      await handler.handleMessage({
        type: 'system',
        subtype: 'init',
        slash_commands: ['custom-skill'],
        model: 'claude-3',
      } as never);

      const command = handler.getSlashCommands().find((c) => c.name === 'custom-skill');
      expect(command?.description).toBe('Full description');
      expect(command?.argumentHint).toBe('<arg>');
    });

    it('should emit the command list to the callback', async () => {
      vi.clearAllMocks();

      await handler.handleMessage({
        type: 'system',
        subtype: 'init',
        slash_commands: ['custom-skill'],
        model: 'claude-3',
      } as never);

      expect(callbacks.onSlashCommands).toHaveBeenCalled();
      const mockFn = callbacks.onSlashCommands as ReturnType<typeof vi.fn>;
      const emittedCommands = mockFn.mock.calls[mockFn.mock.calls.length - 1][0];
      expect(emittedCommands.find((c: SlashCommandInfo) => c.name === 'custom-skill')).toBeDefined();
    });

    it('should not emit an empty list when constructed', () => {
      // The renderer REPLACES its list with whatever arrives on this channel,
      // so emitting the empty starting value would clear a list it had
      // already fetched for the prompt box.
      const emissions = (callbacks.onSlashCommands as ReturnType<typeof vi.fn>).mock.calls;
      expect(emissions.filter((call) => (call[0] as SlashCommandInfo[]).length === 0)).toEqual([]);
    });

    it('should add new SDK commands while preserving existing descriptions', async () => {
      // First set commands with descriptions via updateSlashCommands
      handler.updateSlashCommands([
        { name: 'custom', description: 'Custom desc', argumentHint: '' },
      ]);

      const commandsBefore = handler.getSlashCommands();
      const countBefore = commandsBefore.length;

      // Then receive init message with a NEW skill (should be added)
      await handler.handleMessage({
        type: 'system',
        subtype: 'init',
        slash_commands: ['new-skill'],
        model: 'claude-3',
      } as never);

      // Should have one more command (new-skill was added)
      const commandsAfter = handler.getSlashCommands();
      expect(commandsAfter.length).toBe(countBefore + 1);

      // Existing descriptions should be preserved
      const customCmd = commandsAfter.find(c => c.name === 'custom');
      expect(customCmd?.description).toBe('Custom desc');

      // New skill should be added (with empty description from init)
      const newSkill = commandsAfter.find(c => c.name === 'new-skill');
      expect(newSkill).toBeDefined();
    });
  });

  describe('handleMessage - stream_event type', () => {
    it('should emit text delta chunks', async () => {
      await handler.handleMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Hello' },
        },
      } as never);

      expect(callbacks.onChunk).toHaveBeenCalledWith('Hello');
    });

    /**
     * A text content block is a transport unit, not a paragraph: the server
     * ends one wherever it likes, including mid-word. Emitting a separator at
     * each block start therefore broke replies apart at arbitrary points —
     * reported as line breaks everywhere, even in the middle of words.
     */
    describe('text split across content blocks', () => {
      /** Stream one text block's worth of deltas. */
      async function textBlock(...deltas: string[]): Promise<void> {
        await handler.handleMessage({
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        } as never);
        for (const text of deltas) {
          await handler.handleMessage({
            type: 'stream_event',
            event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
          } as never);
        }
      }

      /** Everything that reached the renderer, concatenated as it would be. */
      function streamed(): string {
        return vi.mocked(callbacks.onChunk).mock.calls.map((c) => c[0] as string).join('');
      }

      it('does not break a word split across two blocks', async () => {
        await textBlock('The chat bat');
        await textBlock('ch has started another test run');

        expect(streamed()).toBe('The chat batch has started another test run');
      });

      it('inserts nothing at all between blocks', async () => {
        await textBlock('one');
        await textBlock('two');
        await textBlock('three');

        expect(vi.mocked(callbacks.onChunk).mock.calls.map((c) => c[0])).toEqual([
          'one', 'two', 'three',
        ]);
      });

      it('keeps the model\'s own paragraph breaks', async () => {
        // The breaks that belong to the text arrive inside the deltas, which
        // is why none have to be invented.
        await textBlock('first paragraph\n\n', 'second paragraph');

        expect(streamed()).toBe('first paragraph\n\nsecond paragraph');
      });

      /** A non-text block between two text blocks, as thinking or a tool is. */
      async function block(type: string): Promise<void> {
        await handler.handleMessage({
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0, content_block: { type } },
        } as never);
      }

      it('separates two finished sentences split across blocks by thinking', async () => {
        // The case a separator exists for: nothing splits the message at a
        // thinking block, so without one these read as
        // "I'm about to check.It printed "hi"." — which is what the app looked
        // like before any separator, and what removing it outright brought
        // back.
        await textBlock("I'm about to check.");
        await block('thinking');
        await textBlock('It printed "hi".');

        expect(streamed()).toBe('I\'m about to check.\n\nIt printed "hi".');
      });

      it('does not separate blocks split by a tool call', async () => {
        // The renderer starts a new message at a tool use, so these are
        // already two messages on screen; a separator would only put a blank
        // line at the top of the second.
        await textBlock("I'm about to check.");
        await block('tool_use');
        await textBlock('It printed "hi".');

        expect(streamed()).toBe('I\'m about to check.It printed "hi".');
      });

      it('does not separate when the model already ended the paragraph', async () => {
        await textBlock('First paragraph.\n\n');
        await block('thinking');
        await textBlock('Second paragraph.');

        expect(streamed()).toBe('First paragraph.\n\nSecond paragraph.');
      });

      it('does not separate mid-clause, even after thinking', async () => {
        // "…and will" is the model carrying on, not starting again. This is
        // the shape the report showed, with the break landing mid-sentence.
        await textBlock('another test run and will');
        await block('thinking');
        await textBlock(' continue when it finishes.');

        expect(streamed()).toBe('another test run and will continue when it finishes.');
      });

      it('does not separate mid-word, even after thinking', async () => {
        await textBlock('The chat bat');
        await block('thinking');
        await textBlock('ch has started another test run');

        expect(streamed()).toBe('The chat batch has started another test run');
      });

      it('starts each turn with no separator owed', async () => {
        // State from the previous turn must not make the next one open with a
        // blank line.
        await textBlock('Done.');
        handler.reset();
        await textBlock('Next answer.');

        expect(streamed()).toBe('Done.Next answer.');
      });

      it('still suppresses the result text once anything has streamed', async () => {
        // The flag the separator used is also what stops the final result
        // being appended on top of the streamed reply.
        await textBlock('streamed reply');

        await handler.handleMessage({
          type: 'result',
          subtype: 'success',
          num_turns: 1,
          duration_ms: 100,
          result: 'streamed reply',
        } as never);

        expect(streamed()).toBe('streamed reply');
      });
    });

    it('should not emit for non-text_delta events', async () => {
      await handler.handleMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          delta: {},
        },
      } as never);

      expect(callbacks.onChunk).not.toHaveBeenCalled();
    });
  });

  describe('handleMessage - result type', () => {
    it('should set querySucceeded on success', async () => {
      await handler.handleMessage({
        type: 'result',
        subtype: 'success',
        num_turns: 1,
        duration_ms: 100,
      } as never);

      expect(handler.didQuerySucceed()).toBe(true);
    });

    it('should emit result text on success (slash command output)', async () => {
      await handler.handleMessage({
        type: 'result',
        subtype: 'success',
        num_turns: 1,
        duration_ms: 100,
        result: 'Help output from /help command',
      } as never);

      expect(callbacks.onChunk).toHaveBeenCalledWith('Help output from /help command');
    });

    it('should not emit empty result text', async () => {
      await handler.handleMessage({
        type: 'result',
        subtype: 'success',
        num_turns: 1,
        duration_ms: 100,
        result: '   ',
      } as never);

      expect(callbacks.onChunk).not.toHaveBeenCalled();
    });

    it('should not set querySucceeded on non-success', async () => {
      await handler.handleMessage({
        type: 'result',
        subtype: 'error',
        num_turns: 0,
        duration_ms: 50,
      } as never);

      expect(handler.didQuerySucceed()).toBe(false);
    });

    it('should emit usage update with token counts', async () => {
      await handler.handleMessage({
        type: 'result',
        subtype: 'success',
        num_turns: 3,
        duration_ms: 5000,
        total_cost_usd: 0.05,
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 100,
        },
      } as never);

      expect(callbacks.onUsageUpdate).toHaveBeenCalledWith(expect.objectContaining({
        totalCostUSD: 0.05,
        numTurns: 3,
        durationMs: 5000,
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadInputTokens: 200,
          cacheCreationInputTokens: 100,
        },
      }));
    });

    it('should emit usage update with model-specific usage', async () => {
      await handler.handleMessage({
        type: 'result',
        subtype: 'success',
        num_turns: 1,
        duration_ms: 1000,
        total_cost_usd: 0.02,
        usage: {
          input_tokens: 500,
          output_tokens: 200,
        },
        modelUsage: {
          'claude-3-opus': {
            inputTokens: 500,
            outputTokens: 200,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.02,
            contextWindow: 200000,
            maxOutputTokens: 4096,
          },
        },
      } as never);

      expect(callbacks.onUsageUpdate).toHaveBeenCalledWith(expect.objectContaining({
        modelUsage: {
          'claude-3-opus': expect.objectContaining({
            inputTokens: 500,
            outputTokens: 200,
            contextWindow: 200000,
            maxOutputTokens: 4096,
            costUSD: 0.02,
          }),
        },
      }));
    });

    it('should emit usage update on error results too', async () => {
      await handler.handleMessage({
        type: 'result',
        subtype: 'error',
        num_turns: 1,
        duration_ms: 500,
        total_cost_usd: 0.01,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
        },
      } as never);

      expect(callbacks.onUsageUpdate).toHaveBeenCalledWith(expect.objectContaining({
        totalCostUSD: 0.01,
        usage: expect.objectContaining({
          inputTokens: 100,
          outputTokens: 50,
        }),
      }));
    });
  });

  // ===========================================================================
  // Auth Error Detection (onAuthError callback)
  // ===========================================================================
  describe('auth error detection', () => {
    let handlerWithAuth: SDKMessageHandler;
    let authCallbacks: MessageHandlerCallbacks;

    beforeEach(() => {
      authCallbacks = {
        onChunk: vi.fn(),
        onSlashCommands: vi.fn(),
        onTaskNotification: vi.fn(),
        onUsageUpdate: vi.fn(),
        onSystemNote: vi.fn(),
        onAuthError: vi.fn(),
      };
      handlerWithAuth = new SDKMessageHandler(authCallbacks);
    });

    // Assistant text is model output, not an API signal — the model can legitimately
    // discuss 401s, tokens, auth failures (security audits, code review, docs). Scanning
    // it for keywords produced catastrophic false positives that killed live sessions.
    // Only SDK-emitted result errors are trusted as auth signals.
    it('should NOT fire onAuthError when assistant text mentions auth keywords', async () => {
      const authy = [
        'Failed to authenticate. API Error: 401 Invalid bearer token',
        'Request failed: Unauthorized access',
        'Error: invalid bearer token provided',
        'Authentication failed: invalid token',
        "script emits KEY_NOT_FOUND and would return Unauthorized on the API",
      ];
      for (const text of authy) {
        await handlerWithAuth.handleMessage({
          type: 'assistant',
          message: { content: [{ type: 'text', text }] },
        } as never);
      }

      expect(authCallbacks.onAuthError).not.toHaveBeenCalled();
    });

    it('should NOT fire onAuthError for normal messages', async () => {
      await handlerWithAuth.handleMessage({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Here is the code you requested.' }] },
      } as never);

      expect(authCallbacks.onAuthError).not.toHaveBeenCalled();
    });

    it('should fire onAuthError on error result with 401', async () => {
      await handlerWithAuth.handleMessage({
        type: 'result',
        subtype: 'error',
        error: 'API returned 401 unauthorized',
        num_turns: 0,
        duration_ms: 0,
      } as never);

      expect(authCallbacks.onAuthError).toHaveBeenCalledTimes(1);
    });

    it('should fire onAuthError on error result with invalid bearer', async () => {
      await handlerWithAuth.handleMessage({
        type: 'result',
        subtype: 'error',
        error: 'Failed: invalid bearer token',
        num_turns: 0,
        duration_ms: 0,
      } as never);

      expect(authCallbacks.onAuthError).toHaveBeenCalledTimes(1);
    });

    it('should NOT fire onAuthError on non-auth error results', async () => {
      await handlerWithAuth.handleMessage({
        type: 'result',
        subtype: 'error',
        error: 'Rate limit exceeded',
        num_turns: 0,
        duration_ms: 0,
      } as never);

      expect(authCallbacks.onAuthError).not.toHaveBeenCalled();
    });

    it('should not crash when onAuthError is not provided', async () => {
      // handler (without onAuthError) should not throw on an auth-flagged result
      await expect(handler.handleMessage({
        type: 'result',
        subtype: 'error',
        error: 'API returned 401 unauthorized',
        num_turns: 0,
        duration_ms: 0,
      } as never)).resolves.not.toThrow();
    });
  });

  describe('native task lifecycle messages', () => {
    it('should emit running notification for task_started', async () => {
      // Captured from CLI 2.1.280, trimmed.
      await handler.handleMessage({
        type: 'system',
        subtype: 'task_started',
        task_id: 'a47ef0f60a29e8d14',
        tool_use_id: 'toolu_agent',
        description: 'Agent reads notes.txt',
        subagent_type: 'general-purpose',
        is_backgrounded: true,
        spawn_depth: 1,
        task_type: 'local_agent',
      } as never);

      expect(callbacks.onTaskNotification).toHaveBeenCalledWith({
        taskId: 'a47ef0f60a29e8d14',
        status: 'running',
        description: 'Agent reads notes.txt',
        toolUseId: 'toolu_agent',
        taskType: 'agent',
        agentType: 'general-purpose',
      });
    });

    it('names the agent that started a command, and none for the main conversation', async () => {
      // The agent, then a frame of the agent's that starts a background
      // command, then that command — the order the CLI sends them in.
      await handler.handleMessage({
        type: 'system', subtype: 'task_started', task_id: 'agent-1', tool_use_id: 'toolu_agent',
        description: 'Agent', task_type: 'local_agent',
      } as never);
      await handler.handleMessage({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'toolu_cmd', name: 'Bash', input: { command: 'make', run_in_background: true } }] },
        parent_tool_use_id: 'toolu_agent',
      } as never);
      await handler.handleMessage({
        type: 'system', subtype: 'task_started', task_id: 'bash-1', tool_use_id: 'toolu_cmd',
        owned_by_subagent: true, description: 'make', task_type: 'local_bash',
      } as never);
      await handler.handleMessage({
        type: 'system', subtype: 'task_started', task_id: 'bash-2', tool_use_id: 'toolu_main_cmd',
        description: 'npm test', task_type: 'local_bash',
      } as never);

      const notified = vi.mocked(callbacks.onTaskNotification).mock.calls.map(([n]) => n);
      expect(notified.find((n) => n.taskId === 'bash-1')).toMatchObject({ taskType: 'command', parentTaskId: 'agent-1' });
      expect(notified.find((n) => n.taskId === 'bash-2')?.parentTaskId).toBeUndefined();
    });

    it("takes a command's output file only from a structured field, never from the result's prose", async () => {
      // The prose names the file; the structured result does not. Reading it
      // out of the wording would break the day the wording changes, so a
      // running command's file is found by its ids instead (locateTaskOutput).
      await handler.handleMessage({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_cmd',
            content: 'Command running in background with ID: b3q51bvd7. Output is being written to: /tmp/x/tasks/b3q51bvd7.output.',
          }],
        },
        tool_use_result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b3q51bvd7' },
        parent_tool_use_id: null,
      } as never);
      expect(handler.getTaskOutputFile('b3q51bvd7')).toBeUndefined();

      await handler.handleMessage({
        type: 'system', subtype: 'task_notification', task_id: 'b3q51bvd7', status: 'completed',
        output_file: '/tmp/claude-1000/proj/sess/tasks/b3q51bvd7.output', summary: 'done',
      } as never);
      expect(handler.getTaskOutputFile('b3q51bvd7')).toBe('/tmp/claude-1000/proj/sess/tasks/b3q51bvd7.output');
    });

    it("knows a background agent's transcript file as soon as it starts", async () => {
      const file = '/tmp/claude-1000/proj/sess/tasks/a47ef0f60a29e8d14.output';
      await handler.handleMessage({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: [{ type: 'text', text: 'Async agent launched successfully.' }] }] },
        tool_use_result: { isAsync: true, status: 'async_launched', agentId: 'a47ef0f60a29e8d14', outputFile: file },
        parent_tool_use_id: null,
      } as never);

      expect(handler.getTaskOutputFile('a47ef0f60a29e8d14')).toBe(file);
    });

    it('should skip task_started with skip_transcript flag', async () => {
      await handler.handleMessage({
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-silent',
        description: 'Ambient task',
        skip_transcript: true,
      } as never);

      expect(callbacks.onTaskNotification).not.toHaveBeenCalled();
    });

    it('reports progress as the live activity, not as the description or summary', async () => {
      // Captured from CLI 2.1.280. `description` is what the agent is doing
      // now; writing it over the task's description lost what the task is for.
      await handler.handleMessage({
        type: 'system',
        subtype: 'task_progress',
        task_id: 'a47ef0f60a29e8d14',
        tool_use_id: 'toolu_agent',
        description: 'Reading notes.txt',
        subagent_type: 'general-purpose',
        usage: { total_tokens: 14063, tool_uses: 1, duration_ms: 2344 },
        last_tool_name: 'Read',
      } as never);

      expect(callbacks.onTaskNotification).toHaveBeenCalledWith({
        taskId: 'a47ef0f60a29e8d14',
        status: 'running',
        activity: 'Reading notes.txt',
        agentType: 'general-purpose',
        totalTokens: 14063,
        toolUses: 1,
        toolUseId: 'toolu_agent',
      });
    });

    it('prefers the model-written progress summary for the activity', async () => {
      await handler.handleMessage({
        type: 'system',
        subtype: 'task_progress',
        task_id: 'task-abc',
        description: 'Running tests',
        summary: 'Analyzing authentication module',
        usage: { total_tokens: 1, tool_uses: 0, duration_ms: 1 },
      } as never);

      expect(callbacks.onTaskNotification).toHaveBeenCalledWith(expect.objectContaining({
        activity: 'Analyzing authentication module',
      }));
      expect(vi.mocked(callbacks.onTaskNotification).mock.calls[0][0]).not.toHaveProperty('summary');
      expect(vi.mocked(callbacks.onTaskNotification).mock.calls[0][0]).not.toHaveProperty('description');
    });

    it('should emit completion for task_updated with completed status', async () => {
      await handler.handleMessage({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-abc',
        patch: { status: 'completed', description: 'Tests passed' },
      } as never);

      expect(callbacks.onTaskNotification).toHaveBeenCalledWith({
        taskId: 'task-abc',
        status: 'completed',
        description: 'Tests passed',
      });
    });

    it('should emit failure for task_updated with failed status and error', async () => {
      await handler.handleMessage({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-abc',
        patch: { status: 'failed', error: 'Timeout exceeded' },
      } as never);

      expect(callbacks.onTaskNotification).toHaveBeenCalledWith({
        taskId: 'task-abc',
        status: 'failed',
        error: 'Timeout exceeded',
      });
    });

    it('should map killed status to stopped', async () => {
      await handler.handleMessage({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-abc',
        patch: { status: 'killed' },
      } as never);

      expect(callbacks.onTaskNotification).toHaveBeenCalledWith({
        taskId: 'task-abc',
        status: 'stopped',
      });
    });

    it('should ignore task_updated with pending status', async () => {
      await handler.handleMessage({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-abc',
        patch: { status: 'pending' },
      } as never);

      expect(callbacks.onTaskNotification).not.toHaveBeenCalled();
    });

    it('should not emit task notification for session_state_changed', async () => {
      await handler.handleMessage({
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
        uuid: 'uuid-123',
        session_id: 'sess-123',
      } as never);

      expect(callbacks.onTaskNotification).not.toHaveBeenCalled();
    });
  });

  describe('resolveResultError', () => {
    it('extracts the canonical errors[] array used by SDKResultError', () => {
      expect(resolveResultError({ errors: ['No conversation found with session ID abc'] }))
        .toBe('No conversation found with session ID abc');
    });

    it('joins multiple errors with "; "', () => {
      expect(resolveResultError({ errors: ['first failure', 'second failure'] }))
        .toBe('first failure; second failure');
    });

    it('skips non-string entries when joining', () => {
      expect(resolveResultError({ errors: ['a', 42 as unknown as string, 'b'] }))
        .toBe('a; b');
    });

    it('falls back to legacy singular `error` when errors[] is missing', () => {
      expect(resolveResultError({ error: 'something broke' }))
        .toBe('something broke');
    });

    it('returns empty string when neither errors nor error is set', () => {
      expect(resolveResultError({})).toBe('');
    });

    it('prefers errors[] over error when both are present', () => {
      expect(resolveResultError({ errors: ['new shape'], error: 'old shape' }))
        .toBe('new shape');
    });

    it('returns empty string for empty errors[] array', () => {
      expect(resolveResultError({ errors: [] })).toBe('');
    });
  });

  describe('extractTaskCreateId', () => {
    it('extracts task.id from a structured object', () => {
      expect(extractTaskCreateId({ task: { id: 'task-abc', subject: 'x' } })).toBe('task-abc');
    });

    it('extracts task.id from a JSON string', () => {
      expect(extractTaskCreateId('{"task":{"id":"7","subject":"x"}}')).toBe('7');
    });

    it('extracts task.id from an array of text blocks whose joined text is JSON', () => {
      expect(extractTaskCreateId([{ type: 'text', text: '{"task":{"id":"9"}}' }])).toBe('9');
    });

    it('extracts the ID from the CLI human-readable text form', () => {
      // This is the shape the CLI actually delivers today — the JSON extraction
      // above never matches, so this fallback is what keeps TaskUpdate wiring intact.
      expect(extractTaskCreateId('Task #3 created successfully: Audit Entra script'))
        .toBe('3');
    });

    it('extracts the ID from human-readable text wrapped in a text block', () => {
      expect(extractTaskCreateId([{ type: 'text', text: 'Task #42 created successfully: something' }]))
        .toBe('42');
    });

    it('returns undefined when neither JSON nor the text pattern is present', () => {
      expect(extractTaskCreateId('Some unrelated tool output')).toBeUndefined();
    });

    it('returns undefined for empty content', () => {
      expect(extractTaskCreateId('')).toBeUndefined();
      expect(extractTaskCreateId(null)).toBeUndefined();
      expect(extractTaskCreateId(undefined)).toBeUndefined();
    });
  });
});

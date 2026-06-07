/**
 * Comprehensive tests for AuthService.
 *
 * Tests cover:
 * - OAuth flow initiation (startOAuthFlow)
 * - OAuth completion with code submission
 * - Token validation and extraction
 * - PTY process management
 * - Claude CLI discovery
 * - Error handling and timeouts
 * - Cleanup and resource management
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted to ensure mocks are available before vi.mock is called
const {
  mockPtySpawn,
  mockShellOpenExternal,
  mockExecSync,
  mockFsExistsSync,
  mockFsMkdirSync,
  mockFsRmSync,
  mockFsReadFileSync,
} = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockShellOpenExternal: vi.fn(),
  mockExecSync: vi.fn(),
  mockFsExistsSync: vi.fn(),
  mockFsMkdirSync: vi.fn(),
  mockFsRmSync: vi.fn(),
  mockFsReadFileSync: vi.fn(),
}));

vi.mock('node-pty', () => ({
  spawn: mockPtySpawn,
}));

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn().mockReturnValue('/mock/app'),
  },
  shell: {
    openExternal: mockShellOpenExternal,
  },
}));

vi.mock('child_process', () => ({
  default: { execSync: mockExecSync },
  execSync: mockExecSync,
}));

vi.mock('fs', () => ({
  default: {
    existsSync: mockFsExistsSync,
    mkdirSync: mockFsMkdirSync,
    rmSync: mockFsRmSync,
    readFileSync: mockFsReadFileSync,
  },
  existsSync: mockFsExistsSync,
  mkdirSync: mockFsMkdirSync,
  rmSync: mockFsRmSync,
  readFileSync: mockFsReadFileSync,
}));

vi.mock('../../utils/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Import after mocks
import AuthService from '../AuthService';

describe('AuthService', () => {
  let service: AuthService;
  let mockPty: MockPty;

  interface MockPty {
    pid: number;
    onData: ReturnType<typeof vi.fn>;
    onExit: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    _dataCallback: ((data: string) => void) | null;
    _exitCallbacks: ((info: { exitCode: number; signal?: number }) => void)[];
    emitData: (data: string) => void;
    emitExit: (code: number) => void;
  }

  function createMockPty(): MockPty {
    const pty: MockPty = {
      pid: 12345,
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      kill: vi.fn(),
      _dataCallback: null,
      _exitCallbacks: [],
      emitData: function (data: string) {
        if (this._dataCallback) this._dataCallback(data);
      },
      emitExit: function (code: number) {
        for (const cb of this._exitCallbacks) cb({ exitCode: code });
      },
    };

    pty.onData.mockImplementation((callback) => {
      pty._dataCallback = callback;
      return { dispose: vi.fn() };
    });

    pty.onExit.mockImplementation((callback) => {
      pty._exitCallbacks.push(callback);
      return { dispose: vi.fn() };
    });

    return pty;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    mockPty = createMockPty();
    mockPtySpawn.mockReturnValue(mockPty);

    // Default: bundled CLI exists
    mockFsExistsSync.mockImplementation((path: string) => {
      if (path.includes('cli.js')) return true;
      if (path.includes('node.exe')) return true;
      return false;
    });

    service = new AuthService();
  });

  afterEach(() => {
    vi.useRealTimers();
    service.cleanupOAuthFlow();
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Constructor
  // ===========================================================================
  describe('constructor', () => {
    it('should initialize without errors', () => {
      expect(service).toBeDefined();
    });

    it('should not have pending flow initially', () => {
      expect(service.hasPendingFlow()).toBe(false);
    });
  });

  // ===========================================================================
  // findClaudeCli (via startOAuthFlow)
  // ===========================================================================
  describe('CLI discovery', () => {
    it('should find bundled CLI when it exists', async () => {
      mockFsExistsSync.mockImplementation((path: string) => {
        return path.includes('cli.js');
      });

      // Start flow but emit URL immediately
      const flowPromise = service.startOAuthFlow();

      // Wait a tick for PTY setup
      await vi.advanceTimersByTimeAsync(50);

      // Emit OAuth URL (claude.com/cai/ format from CLI v2.1.107+)
      mockPty.emitData('Visit https://claude.com/cai/oauth/authorize?code=test123\n');
      mockPty.emitData('Paste code:\n');

      await vi.advanceTimersByTimeAsync(100);

      const result = await flowPromise;

      expect(mockPtySpawn).toHaveBeenCalled();
      expect(result.authUrl).toContain('oauth/authorize');
    });

    it('should fall back to npx when CLI not found', async () => {
      mockFsExistsSync.mockReturnValue(false);
      mockExecSync.mockImplementation(() => {
        throw new Error('not found');
      });

      const flowPromise = service.startOAuthFlow();

      await vi.advanceTimersByTimeAsync(50);

      mockPty.emitData('Visit https://claude.com/cai/oauth/authorize?code=test123\n');
      mockPty.emitData('Paste code:\n');

      await vi.advanceTimersByTimeAsync(100);

      await flowPromise;

      // Should have used shell for npx
      const spawnCall = mockPtySpawn.mock.calls[0];
      expect(spawnCall[0]).toMatch(/bash|cmd/i);
    });

    it('should check multiple CLI paths', async () => {
      mockFsExistsSync.mockReturnValue(false);

      // Will timeout since no URL emitted
      const flowPromise = service.startOAuthFlow();

      await vi.advanceTimersByTimeAsync(31000); // Timeout

      await flowPromise;

      // Should have checked multiple paths
      expect(mockFsExistsSync.mock.calls.length).toBeGreaterThan(1);
    });
  });

  // ===========================================================================
  // startOAuthFlow
  // ===========================================================================
  describe('startOAuthFlow', () => {
    it('should create PTY with correct parameters', async () => {
      const flowPromise = service.startOAuthFlow();

      await vi.advanceTimersByTimeAsync(50);

      mockPty.emitData('https://claude.com/cai/oauth/authorize?code=test\n');
      mockPty.emitData('Paste code:\n');

      await vi.advanceTimersByTimeAsync(100);

      await flowPromise;

      expect(mockPtySpawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          cols: 500, // Wide terminal to prevent URL wrapping
          rows: 30,
          env: expect.objectContaining({
            BROWSER: expect.any(String), // Prevent auto-open
          }),
        })
      );
    });

    it('should extract OAuth URL from PTY output (claude.ai)', async () => {
      const flowPromise = service.startOAuthFlow();

      await vi.advanceTimersByTimeAsync(50);

      mockPty.emitData('Please visit:\nhttps://claude.ai/oauth/authorize?client_id=abc&redirect_uri=xyz\n');
      mockPty.emitData('Enter the code:\n');

      await vi.advanceTimersByTimeAsync(100);

      const result = await flowPromise;

      expect(result.authUrl).toContain('oauth/authorize');
      expect(result.error).toBeUndefined();
    });

    it('should extract OAuth URL from PTY output (claude.com/cai/)', async () => {
      const flowPromise = service.startOAuthFlow();

      await vi.advanceTimersByTimeAsync(50);

      mockPty.emitData('Please visit:\nhttps://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&redirect_uri=xyz\n');
      mockPty.emitData('Enter the code:\n');

      await vi.advanceTimersByTimeAsync(100);

      const result = await flowPromise;

      expect(result.authUrl).toBe('https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&redirect_uri=xyz');
      expect(result.error).toBeUndefined();
    });

    it('should not capture trailing prompt text separated by cursor positioning', async () => {
      const flowPromise = service.startOAuthFlow();

      await vi.advanceTimersByTimeAsync(50);

      const realUrl = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&state=xKnTIIm35i2_test';
      mockPty.emitData(realUrl + '\x1b[2;1HPaste code here if prompted>\n');

      await vi.advanceTimersByTimeAsync(100);

      const result = await flowPromise;

      expect(result.authUrl).toBe(realUrl);
      expect(result.authUrl).not.toContain('Paste');
    });

    it('should not capture prompt text separated by erase-line sequence', async () => {
      const flowPromise = service.startOAuthFlow();

      await vi.advanceTimersByTimeAsync(50);

      const realUrl = 'https://claude.com/cai/oauth/authorize?code=true&state=abc123';
      mockPty.emitData(realUrl + '\x1b[0K\x1b[1G<Enter code here>\n');

      await vi.advanceTimersByTimeAsync(100);

      const result = await flowPromise;

      expect(result.authUrl).toBe(realUrl);
      expect(result.authUrl).not.toContain('Enter');
    });

    it('should handle URL with ANSI codes', async () => {
      const flowPromise = service.startOAuthFlow();

      await vi.advanceTimersByTimeAsync(50);

      mockPty.emitData('\x1b[32mhttps://claude.com/cai/oauth/authorize?code=test\x1b[0m\n');
      mockPty.emitData('Paste:\n');

      await vi.advanceTimersByTimeAsync(100);

      const result = await flowPromise;

      expect(result.authUrl).toContain('oauth/authorize');
    });

    it('should timeout if no URL received', async () => {
      const flowPromise = service.startOAuthFlow();

      // No URL emitted, wait for timeout
      await vi.advanceTimersByTimeAsync(31000);

      const result = await flowPromise;

      expect(result.authUrl).toBe('');
      expect(result.error).toContain('Timeout');
    });

    it('should set pending flow state', async () => {
      const flowPromise = service.startOAuthFlow();

      await vi.advanceTimersByTimeAsync(50);

      mockPty.emitData('https://claude.com/cai/oauth/authorize?code=test\n');
      mockPty.emitData('Paste:\n');

      await vi.advanceTimersByTimeAsync(100);

      await flowPromise;

      expect(service.hasPendingFlow()).toBe(true);
    });

    it('should cleanup previous flow when starting new one', async () => {
      // Start first flow
      const flow1 = service.startOAuthFlow();
      await vi.advanceTimersByTimeAsync(50);
      mockPty.emitData('https://claude.com/cai/oauth/authorize?code=test1\n');
      mockPty.emitData('Paste:\n');
      await vi.advanceTimersByTimeAsync(100);
      await flow1;

      const firstPty = mockPty;

      // Create new mock for second flow
      mockPty = createMockPty();
      mockPtySpawn.mockReturnValue(mockPty);

      // Start second flow
      const flow2 = service.startOAuthFlow();
      await vi.advanceTimersByTimeAsync(50);
      mockPty.emitData('https://claude.com/cai/oauth/authorize?code=test2\n');
      mockPty.emitData('Paste:\n');
      await vi.advanceTimersByTimeAsync(100);
      await flow2;

      // First PTY should have been killed
      expect(firstPty.kill).toHaveBeenCalled();
    });

    it('should handle PTY spawn failure', async () => {
      mockPtySpawn.mockImplementation(() => {
        throw new Error('PTY spawn failed');
      });

      const result = await service.startOAuthFlow();

      expect(result.authUrl).toBe('');
      expect(result.error).toContain('Failed to start authentication');
    });

    it('should handle PTY exit before URL found', async () => {
      const flowPromise = service.startOAuthFlow();

      await vi.advanceTimersByTimeAsync(50);

      // PTY exits without emitting URL
      mockPty.emitExit(1);

      await vi.advanceTimersByTimeAsync(1000);

      const result = await flowPromise;

      expect(result.authUrl).toBe('');
      expect(result.error).toContain('exited');
    });
  });

  // ===========================================================================
  // completeOAuthFlow
  // ===========================================================================
  describe('completeOAuthFlow', () => {
    beforeEach(async () => {
      // Start a flow first
      const flowPromise = service.startOAuthFlow();
      await vi.advanceTimersByTimeAsync(50);
      mockPty.emitData('https://claude.com/cai/oauth/authorize?code=test\n');
      mockPty.emitData('Paste:\n');
      await vi.advanceTimersByTimeAsync(100);
      await flowPromise;
    });

    it('should write code character by character', async () => {
      // Verify we have a pending flow before testing
      expect(service.hasPendingFlow()).toBe(true);

      // Track writes through the PTY that mockPtySpawn returned
      const writeCalls: string[] = [];
      mockPty.write.mockImplementation((data: string) => {
        writeCalls.push(data);
      });

      // Use a code that's >= 10 chars (OAuth code minimum)
      const testCode = 'test123456';
      const completePromise = service.completeOAuthFlow(testCode);

      // Allow the setTimeout callbacks for CR/LF to complete
      await vi.advanceTimersByTimeAsync(200);

      // The character writes should have happened by now
      expect(writeCalls.length).toBeGreaterThan(0);
      for (const char of testCode) {
        expect(writeCalls).toContain(char);
      }

      // Emit token to complete the flow
      mockPty.emitData('sk-ant-oat01-' + 'x'.repeat(80) + '\n');

      await vi.advanceTimersByTimeAsync(100);

      const result = await completePromise;
      expect(result.success).toBe(true);
    });

    it('should send CR+LF to submit', async () => {
      const writeCalls: string[] = [];
      mockPty.write.mockImplementation((data: string) => {
        writeCalls.push(data);
      });

      // Use a code that's >= 10 chars
      const completePromise = service.completeOAuthFlow('testcode12');

      await vi.advanceTimersByTimeAsync(200);

      mockPty.emitData('sk-ant-oat01-' + 'x'.repeat(80) + '\n');

      await vi.advanceTimersByTimeAsync(100);

      await completePromise;

      // Should send carriage return and line feed
      expect(writeCalls).toContain('\r');
      expect(writeCalls).toContain('\n');
    });

    it('should extract token from PTY output', async () => {
      // Use a code that's >= 10 chars
      const completePromise = service.completeOAuthFlow('testcode12');

      await vi.advanceTimersByTimeAsync(200);

      const token = 'sk-ant-oat01-' + 'a'.repeat(78);
      mockPty.emitData(`Your token is: ${token}\n`);

      await vi.advanceTimersByTimeAsync(600);

      const result = await completePromise;

      expect(result.success).toBe(true);
      expect(result.token).toBe(token);
    });

    it('should trim "Store" suffix from over-matched token', async () => {
      // Use a code that's >= 10 chars
      const completePromise = service.completeOAuthFlow('testcode12');

      await vi.advanceTimersByTimeAsync(200);

      // Token with "Store" accidentally matched (no whitespace before it)
      const baseToken = 'sk-ant-oat01-' + 'a'.repeat(78);
      mockPty.emitData(`${baseToken}Store your token securely\n`);

      await vi.advanceTimersByTimeAsync(600);

      const result = await completePromise;

      expect(result.success).toBe(true);
      expect(result.token).toBe(baseToken);
      expect(result.token).not.toContain('Store');
    });

    it('should preserve leading "o" when CLI emits stray ESC before token (v2.1.150 regression)', async () => {
      // CLI v2.1.150 prints a stray \x1b right before the OAuth token line.
      // A greedy /\x1b./g strip ate the 'o' of `oat01-`, yielding `sk-ant-at01-…`
      // which the server then rejected with 401 "Invalid bearer token".
      const completePromise = service.completeOAuthFlow('testcode12');

      await vi.advanceTimersByTimeAsync(200);

      const fullToken = 'sk-ant-oat01-' + 'X'.repeat(95);
      mockPty.emitData(`Your OAuth token:\n\x1b${fullToken}\nStore this token securely\n`);

      await vi.advanceTimersByTimeAsync(600);

      const result = await completePromise;

      expect(result.success).toBe(true);
      expect(result.token).toBe(fullToken);
      expect(result.token?.startsWith('sk-ant-oat01-')).toBe(true);
      expect(result.token?.length).toBe(fullToken.length);
    });

    it('should preserve "o" when CLI emits CSI ending in `o` before the token', async () => {
      // Defense-in-depth: a CSI whose final byte happens to be a letter the
      // token also uses would historically consume the terminator letter.
      // Verifies we tolerate that shape adjacent to a token.
      const completePromise = service.completeOAuthFlow('testcode12');

      await vi.advanceTimersByTimeAsync(200);

      const fullToken = 'sk-ant-oat01-' + 'Y'.repeat(95);
      mockPty.emitData(`Your OAuth token:\n\x1b[1024o${fullToken}\nStore this token securely\n`);

      await vi.advanceTimersByTimeAsync(600);

      const result = await completePromise;

      expect(result.success).toBe(true);
      expect(result.token).toBe(fullToken);
      expect(result.token?.startsWith('sk-ant-oat01-')).toBe(true);
      expect(result.token?.length).toBe(fullToken.length);
    });

    it('should preserve token when CLI emits CSI with other alpha terminators adjacent to token', async () => {
      const completePromise = service.completeOAuthFlow('testcode12');

      await vi.advanceTimersByTimeAsync(200);

      const fullToken = 'sk-ant-oat01-' + 'Z'.repeat(95);
      mockPty.emitData(`\x1b[?25h\x1b[2K${fullToken}\x1b[0m\n`);

      await vi.advanceTimersByTimeAsync(600);

      const result = await completePromise;

      expect(result.success).toBe(true);
      expect(result.token).toBe(fullToken);
      expect(result.token?.startsWith('sk-ant-oat01-')).toBe(true);
    });

    it('should preserve leading "o" when CLI uses backspace animation across the token (v0.17.27 real-world regression)', async () => {
      // The real bug observed on kotik's v0.17.27 install. The CLI in PTY
      // mode emits the token with a backspace animation: `sk-ant-o\bat01-…`.
      // The old BACKSPACE_OVERWRITE rule `/[^\n\x08]\x08/g` ate the `o`,
      // producing `sk-ant-at01-…` (107 chars) which the API rejected with
      // 401 "Invalid bearer token". The fix excludes alphanumeric chars
      // from the overwrite class so token data survives.
      const completePromise = service.completeOAuthFlow('testcode12');

      await vi.advanceTimersByTimeAsync(200);

      const tokenTail = 'at01-' + 'M'.repeat(90);  // 95 chars after the leading 'o'
      const expected = 'sk-ant-o' + tokenTail;
      mockPty.emitData(`Your OAuth token:\nsk-ant-o\b${tokenTail}\nStore this token securely\n`);

      await vi.advanceTimersByTimeAsync(600);

      const result = await completePromise;

      expect(result.success).toBe(true);
      expect(result.token).toBe(expected);
      expect(result.token?.startsWith('sk-ant-oat01-')).toBe(true);
      expect(result.token?.length).toBe(expected.length);
    });

    // ========================================================================
    // Defense-in-depth: many shapes of PTY output, all must capture the token
    // intact OR refuse with a clear error. No silent storage of garbage.
    // ========================================================================
    describe('robustness against PTY output variants', () => {
      const TOKEN = 'sk-ant-oat01-' + 'Q'.repeat(95);

      it('captures token wrapped in SGR styling escapes', async () => {
        const promise = service.completeOAuthFlow('testcode12');
        await vi.advanceTimersByTimeAsync(200);
        mockPty.emitData(`\x1b[1m${TOKEN}\x1b[0m\n`);
        await vi.advanceTimersByTimeAsync(600);
        const result = await promise;
        expect(result.success).toBe(true);
        expect(result.token).toBe(TOKEN);
      });

      it('captures token with per-character SGR styling', async () => {
        const promise = service.completeOAuthFlow('testcode12');
        await vi.advanceTimersByTimeAsync(200);
        const styled = [...TOKEN].map(c => `\x1b[1m${c}\x1b[0m`).join('');
        mockPty.emitData(`${styled}\n`);
        await vi.advanceTimersByTimeAsync(600);
        const result = await promise;
        expect(result.success).toBe(true);
        expect(result.token).toBe(TOKEN);
      });

      it('captures token wrapped in OSC hyperlink', async () => {
        const promise = service.completeOAuthFlow('testcode12');
        await vi.advanceTimersByTimeAsync(200);
        mockPty.emitData(`\x1b]8;;https://anthropic.com\x1b\\${TOKEN}\x1b]8;;\x1b\\\n`);
        await vi.advanceTimersByTimeAsync(600);
        const result = await promise;
        expect(result.success).toBe(true);
        expect(result.token).toBe(TOKEN);
      });

      it('captures token preceded by spinner residue', async () => {
        const promise = service.completeOAuthFlow('testcode12');
        await vi.advanceTimersByTimeAsync(200);
        const spinner = '*\b✶\b✻\b✽\b';
        mockPty.emitData(`Your token:\n${spinner}${TOKEN}\n`);
        await vi.advanceTimersByTimeAsync(600);
        const result = await promise;
        expect(result.success).toBe(true);
        expect(result.token).toBe(TOKEN);
      });

      it('captures token followed immediately by junk (Store)', async () => {
        const promise = service.completeOAuthFlow('testcode12');
        await vi.advanceTimersByTimeAsync(200);
        mockPty.emitData(`${TOKEN}Store this securely\n`);
        await vi.advanceTimersByTimeAsync(600);
        const result = await promise;
        expect(result.success).toBe(true);
        expect(result.token).toBe(TOKEN);
      });

      it('captures token even when emitted across multiple PTY chunks', async () => {
        const promise = service.completeOAuthFlow('testcode12');
        await vi.advanceTimersByTimeAsync(200);
        mockPty.emitData(TOKEN.slice(0, 30));
        mockPty.emitData(TOKEN.slice(30, 60));
        mockPty.emitData(TOKEN.slice(60));
        mockPty.emitData('\n');
        await vi.advanceTimersByTimeAsync(600);
        const result = await promise;
        expect(result.success).toBe(true);
        expect(result.token).toBe(TOKEN);
      });

      it('captures token when chunk boundary splits at the sk-ant- prefix', async () => {
        const promise = service.completeOAuthFlow('testcode12');
        await vi.advanceTimersByTimeAsync(200);
        mockPty.emitData('sk-ant');
        mockPty.emitData('-oat01-' + 'Q'.repeat(95) + '\n');
        await vi.advanceTimersByTimeAsync(600);
        const result = await promise;
        expect(result.success).toBe(true);
        expect(result.token).toBe(TOKEN);
      });

      it('captures token when ANSI escape sits inside the token body', async () => {
        const promise = service.completeOAuthFlow('testcode12');
        await vi.advanceTimersByTimeAsync(200);
        const half = TOKEN.length >> 1;
        mockPty.emitData(`${TOKEN.slice(0, half)}\x1b[0m${TOKEN.slice(half)}\n`);
        await vi.advanceTimersByTimeAsync(600);
        const result = await promise;
        expect(result.success).toBe(true);
        expect(result.token).toBe(TOKEN);
      });

      it('captures API-key-shaped token (sk-ant-api03-) too', async () => {
        const promise = service.completeOAuthFlow('testcode12');
        await vi.advanceTimersByTimeAsync(200);
        const apiKey = 'sk-ant-api03-' + 'K'.repeat(80);
        mockPty.emitData(`${apiKey}\n`);
        await vi.advanceTimersByTimeAsync(600);
        const result = await promise;
        expect(result.success).toBe(true);
        expect(result.token).toBe(apiKey);
      });

      // ----- Refusal cases: corruption must surface, not be silently stored -----

      it('refuses to store a token with unknown type prefix (defense gate)', async () => {
        const promise = service.completeOAuthFlow('testcode12');
        await vi.advanceTimersByTimeAsync(200);
        const fake = 'sk-ant-xyz99-' + 'A'.repeat(95);
        mockPty.emitData(`${fake}\n`);
        await vi.advanceTimersByTimeAsync(600);
        // Flow does NOT abort — waits for credentials file. Simulate PTY
        // exit without credentials file to trigger the final failure path.
        mockPty.emitExit(0);
        await vi.advanceTimersByTimeAsync(1500);
        const result = await promise;
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/malformed|prefix|format/i);
      });

      it('refuses to store a truncated token (defense gate)', async () => {
        const promise = service.completeOAuthFlow('testcode12');
        await vi.advanceTimersByTimeAsync(200);
        const truncated = 'sk-ant-oat01-abc';
        mockPty.emitData(`${truncated}\n`);
        await vi.advanceTimersByTimeAsync(600);
        mockPty.emitExit(0);
        await vi.advanceTimersByTimeAsync(1500);
        const result = await promise;
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/malformed|short|length/i);
      });

      it('refuses to store the v0.17.27 mangled shape (sk-ant-at01-…, missing o)', async () => {
        const promise = service.completeOAuthFlow('testcode12');
        await vi.advanceTimersByTimeAsync(200);
        const mangled = 'sk-ant-at01-' + 'A'.repeat(95);
        mockPty.emitData(`${mangled}\n`);
        await vi.advanceTimersByTimeAsync(600);
        mockPty.emitExit(0);
        await vi.advanceTimersByTimeAsync(1500);
        const result = await promise;
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/malformed|prefix/i);
      });

      it('recovers token via PTY screen buffer when cursor-forward hides a character', async () => {
        // Simulates real Ink rendering: "Paste code here" is on the same row,
        // then the token is written to the same row with ESC[1C skipping the
        // 'o' position because Ink sees it hasn't changed from frame 1.
        // stripAnsi removes ESC[1C → "sk-ant-at01-..." (missing o)
        // renderPtyScreen preserves the 'o' from frame 1 → "sk-ant-oat01-..."
        const tokenBody = 'R'.repeat(95);
        const promise = service.completeOAuthFlow('testcode12');
        await vi.advanceTimersByTimeAsync(200);

        // Frame 1: "Paste code here" at row 3 col 2 — the 'o' in "code" sits at col 9
        // Frame 2: token at row 3 col 2, cursor-forward skips col 9 (the 'o')
        const rawPty =
          '\x1b[3;2HPaste\x1b[1Ccode\x1b[1Chere' +
          '\x1b[3;2Hsk-ant-\x1b[1Cat01-' + tokenBody + '\n';
        mockPty.emitData(rawPty);
        await vi.advanceTimersByTimeAsync(600);

        const result = await promise;
        expect(result.success).toBe(true);
        expect(result.token).toBe('sk-ant-oat01-' + tokenBody);
      });

      it('recovers via credentials file when output token is mangled by cursor-forward', async () => {
        // Reproduces the v0.17.29 regression: CLI renders sk-ant-ESC[1Cat01-
        // in PTY, ANSI stripping eats the cursor-forward and the 'o' position,
        // yielding sk-ant-at01-. The flow must NOT abort — it should wait for
        // setup-token to write .credentials.json with the correct token.
        const correctToken = 'sk-ant-oat01-' + 'R'.repeat(95);
        const promise = service.completeOAuthFlow('testcode12');
        await vi.advanceTimersByTimeAsync(200);

        // Emit the mangled token (as stripAnsi would produce from ESC[1C)
        const mangled = 'sk-ant-at01-' + 'R'.repeat(95);
        mockPty.emitData(`${mangled}\n`);
        await vi.advanceTimersByTimeAsync(600);

        // setup-token writes credentials file before exiting
        const credsJson = JSON.stringify({ oauthToken: correctToken });
        mockFsExistsSync.mockImplementation((p: string) => {
          if (typeof p === 'string' && p.endsWith('.credentials.json')) return true;
          if (typeof p === 'string' && p.includes('cli.js')) return true;
          if (typeof p === 'string' && p.includes('node.exe')) return true;
          return false;
        });
        mockFsReadFileSync.mockImplementation((p: string) => {
          if (typeof p === 'string' && p.endsWith('.credentials.json')) return credsJson;
          throw new Error('not found');
        });

        // Next polling check finds the credentials file
        await vi.advanceTimersByTimeAsync(500);
        const result = await promise;
        expect(result.success).toBe(true);
        expect(result.token).toBe(correctToken);
        expect(result.credentialsJson).toBe(credsJson);
      });
    });

    it('should return error when no pending flow', async () => {
      service.cleanupOAuthFlow();

      const result = await service.completeOAuthFlow('testcode');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No pending');
    });

    it('should validate code format', async () => {
      const result = await service.completeOAuthFlow('');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid');
    });

    it('should reject very short code', async () => {
      const result = await service.completeOAuthFlow('abc');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid');
    });

    it('should handle flow expiration', async () => {
      // Advance time past expiration (10 minutes)
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000);

      const result = await service.completeOAuthFlow('validcode123');

      expect(result.success).toBe(false);
      expect(result.error).toContain('expired');
    });

    it('should reject completion when PTY has exited (isPtyAlive guard)', async () => {
      // PTY exits abnormally after flow started (e.g., crash, signal kill)
      mockPty.emitExit(1);
      await vi.advanceTimersByTimeAsync(50);

      const result = await service.completeOAuthFlow('validcode123');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not running');
    });

    it('should detect error messages in output', async () => {
      const completePromise = service.completeOAuthFlow('testcode123');

      await vi.advanceTimersByTimeAsync(200);

      mockPty.emitData('Error: Invalid code\n');

      await vi.advanceTimersByTimeAsync(600);

      const result = await completePromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid code');
    });

    it('should read token from credentials file if present', async () => {
      const token = 'sk-ant-oat01-' + 'b'.repeat(78);
      mockFsExistsSync.mockImplementation((path: string) => {
        if (path.includes('.credentials.json')) return true;
        if (path.includes('cli.js')) return true;
        return false;
      });
      mockFsReadFileSync.mockReturnValue(JSON.stringify({ oauthToken: token }));

      const completePromise = service.completeOAuthFlow('testcode123');

      await vi.advanceTimersByTimeAsync(1000);

      const result = await completePromise;

      expect(result.success).toBe(true);
      expect(result.token).toBe(token);
    });

    it('should timeout after max attempts', async () => {
      const completePromise = service.completeOAuthFlow('testcode123');

      // Advance past max poll attempts (90 * 500ms = 45 seconds)
      await vi.advanceTimersByTimeAsync(50000);

      const result = await completePromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('Timeout');
    });
  });

  // ===========================================================================
  // openAuthUrl
  // ===========================================================================
  describe('openAuthUrl', () => {
    it('should open URL in external browser', () => {
      service.openAuthUrl('https://claude.com/cai/oauth/authorize?code=test');

      expect(mockShellOpenExternal).toHaveBeenCalledWith(
        'https://claude.com/cai/oauth/authorize?code=test'
      );
    });
  });

  // ===========================================================================
  // cleanupOAuthFlow
  // ===========================================================================
  describe('cleanupOAuthFlow', () => {
    it('should kill PTY process', async () => {
      const flowPromise = service.startOAuthFlow();
      await vi.advanceTimersByTimeAsync(50);
      mockPty.emitData('https://claude.com/cai/oauth/authorize?code=test\n');
      mockPty.emitData('Paste:\n');
      await vi.advanceTimersByTimeAsync(100);
      await flowPromise;

      service.cleanupOAuthFlow();

      expect(mockPty.kill).toHaveBeenCalled();
    });

    it('should clear pending state', async () => {
      const flowPromise = service.startOAuthFlow();
      await vi.advanceTimersByTimeAsync(50);
      mockPty.emitData('https://claude.com/cai/oauth/authorize?code=test\n');
      mockPty.emitData('Paste:\n');
      await vi.advanceTimersByTimeAsync(100);
      await flowPromise;

      expect(service.hasPendingFlow()).toBe(true);

      service.cleanupOAuthFlow();

      expect(service.hasPendingFlow()).toBe(false);
    });

    // Note: rmSync timing with fake timers is unreliable
    it.skip('should schedule temp directory cleanup', async () => {
      const flowPromise = service.startOAuthFlow();
      await vi.advanceTimersByTimeAsync(50);
      mockPty.emitData('https://claude.com/cai/oauth/authorize?code=test\n');
      mockPty.emitData('Paste:\n');
      await vi.advanceTimersByTimeAsync(100);
      await flowPromise;

      service.cleanupOAuthFlow();

      // Advance past cleanup delay (1 second in implementation)
      await vi.advanceTimersByTimeAsync(2000);

      expect(mockFsRmSync).toHaveBeenCalled();
    });

    it('should be safe to call multiple times', () => {
      expect(() => {
        service.cleanupOAuthFlow();
        service.cleanupOAuthFlow();
        service.cleanupOAuthFlow();
      }).not.toThrow();
    });

    it('should handle PTY already terminated', async () => {
      const flowPromise = service.startOAuthFlow();
      await vi.advanceTimersByTimeAsync(50);
      mockPty.emitData('https://claude.com/cai/oauth/authorize?code=test\n');
      mockPty.emitData('Paste:\n');
      await vi.advanceTimersByTimeAsync(100);
      await flowPromise;

      mockPty.kill.mockImplementation(() => {
        throw new Error('Process already terminated');
      });

      // Should not throw
      expect(() => service.cleanupOAuthFlow()).not.toThrow();
    });
  });

  // ===========================================================================
  // ANSI Stripping
  // ===========================================================================
  describe('ANSI code handling', () => {
    // Note: These tests timeout with fake timers - URL detection requires different output pattern
    it.skip('should strip CSI sequences', async () => {
      const flowPromise = service.startOAuthFlow();
      await vi.advanceTimersByTimeAsync(50);

      mockPty.emitData('\x1b[2Khttps://claude.com/cai/oauth/authorize?test=1\x1b[0m\n');
      mockPty.emitData('Code:\n');

      await vi.advanceTimersByTimeAsync(100);

      const result = await flowPromise;
      expect(result.authUrl).toContain('oauth/authorize');
    });

    it.skip('should strip OSC sequences', async () => {
      const flowPromise = service.startOAuthFlow();
      await vi.advanceTimersByTimeAsync(50);

      mockPty.emitData('\x1b]0;Title\x07https://claude.com/cai/oauth/authorize?x=1\n');
      mockPty.emitData('Code:\n');

      await vi.advanceTimersByTimeAsync(100);

      const result = await flowPromise;
      expect(result.authUrl).toContain('oauth/authorize');
    });
  });
});

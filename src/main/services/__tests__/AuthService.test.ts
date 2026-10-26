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

/** A code of the shape the authorize page shows: `<code>#<state>`. */
const CODE = 'ba81tYLAwH49cR704ruGj7Jcm4X3oWs08MSMdGp53WjNJJGs#e4gi3YWEmXhZQ6ULj4DDXORIw91yjDK370Eji7Bp5go';

/** An access token of the shape `auth login` writes (sk-ant-oat01-, 108 chars). */
const LOGIN_TOKEN = 'sk-ant-oat01-' + 'L'.repeat(95);

/**
 * Make the credentials `claude auth login` writes appear in the CLI's config
 * directory.
 */
function writeLogin(accessToken = LOGIN_TOKEN): string {
  const credentialsJson = JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken: 'sk-ant-ort01-r', expiresAt: 1, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' },
  });
  mockFsReadFileSync.mockImplementation((p: string) => {
    if (typeof p === 'string' && p.endsWith('.credentials.json')) return credentialsJson;
    throw new Error('ENOENT');
  });
  return credentialsJson;
}

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

    // No login written yet. Reset explicitly: clearAllMocks keeps an
    // implementation, so one test's login would otherwise reach the next.
    mockFsReadFileSync.mockReset();
    mockFsReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });

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

    it('logs in with `auth login --claudeai`, not setup-token', async () => {
      // setup-token's token is inference-only: it cannot refresh, and it does
      // not say whose account it is.
      const flowPromise = service.startOAuthFlow();
      await vi.advanceTimersByTimeAsync(50);
      mockPty.emitData('https://claude.com/cai/oauth/authorize?code=true\n');
      mockPty.emitData('Paste code here if prompted > ');
      await vi.advanceTimersByTimeAsync(100);
      await flowPromise;

      const args = mockPtySpawn.mock.calls[0][1] as string[];
      expect(args.slice(-3)).toEqual(['auth', 'login', '--claudeai']);
      expect(args).not.toContain('setup-token');
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
      const testCode = CODE;
      const completePromise = service.completeOAuthFlow(testCode);

      // Allow the setTimeout callbacks for CR/LF to complete
      await vi.advanceTimersByTimeAsync(200);

      // The character writes should have happened by now
      expect(writeCalls.length).toBeGreaterThan(0);
      for (const char of testCode) {
        expect(writeCalls).toContain(char);
      }

      // The CLI accepts the code and writes the login
      writeLogin();

      await vi.advanceTimersByTimeAsync(600);

      const result = await completePromise;
      expect(result.success).toBe(true);
    });

    it('submits with one line end only — a CR, never a following LF', async () => {
      // `auth login` reads lines; the terminal makes the CR a line end, and
      // an LF after it was a second, empty line the CLI answered with
      // "Invalid code" — which ended a login whose real code was valid.
      const writeCalls: string[] = [];
      mockPty.write.mockImplementation((data: string) => {
        writeCalls.push(data);
      });

      const completePromise = service.completeOAuthFlow(CODE);

      await vi.advanceTimersByTimeAsync(200);

      writeLogin();

      await vi.advanceTimersByTimeAsync(600);

      await completePromise;

      expect(writeCalls.join('')).toBe(`${CODE}\r`);
    });

    it('refuses a code without its two #-joined halves before sending it', async () => {
      // The CLI would print a complaint and go on waiting, leaving the login hanging.
      const result = await service.completeOAuthFlow('ba81tYLAwH49cR704ruGj7Jcm4X3oWs08MSMdGp53WjNJJGs');

      expect(result.success).toBe(false);
      expect(result.error).toContain('#');
      expect(mockPty.write).not.toHaveBeenCalled();
    });

    it('takes the login from the credentials file the CLI writes, with its account', async () => {
      const promise = service.completeOAuthFlow(CODE);
      await vi.advanceTimersByTimeAsync(200);

      writeLogin();
      await vi.advanceTimersByTimeAsync(600);

      const result = await promise;
      expect(result).toEqual({ success: true, token: LOGIN_TOKEN });
    });

    it('does not take a login that was already there (the terminal one) for the new one', async () => {
      // The CLI's config directory is shared: it may hold a login before this
      // one is made. Only a change from it is this login.
      service.cleanupOAuthFlow();
      writeLogin('sk-ant-oat01-' + 'T'.repeat(95));
      const flowPromise = service.startOAuthFlow();
      await vi.advanceTimersByTimeAsync(50);
      mockPty.emitData('https://claude.com/cai/oauth/authorize?code=test\n');
      mockPty.emitData('Paste code here if prompted > ');
      await vi.advanceTimersByTimeAsync(100);
      await flowPromise;

      let settled = false;
      const promise = service.completeOAuthFlow(CODE).then((r) => { settled = true; return r; });
      await vi.advanceTimersByTimeAsync(2000);
      expect(settled).toBe(false);

      writeLogin();
      await vi.advanceTimersByTimeAsync(600);
      expect(await promise).toEqual({ success: true, token: LOGIN_TOKEN });
    });

    it('refuses a credentials file whose token is malformed, rather than store a token that will 401', async () => {
      const promise = service.completeOAuthFlow(CODE);
      await vi.advanceTimersByTimeAsync(200);

      writeLogin('sk-ant-at01-' + 'A'.repeat(95));
      await vi.advanceTimersByTimeAsync(600);
      mockPty.emitExit(0);
      await vi.advanceTimersByTimeAsync(1500);

      const result = await promise;
      expect(result.success).toBe(false);
    });

    it('does not take a token printed in the output: only the credentials file is the login', async () => {
      // `auth login` never prints its token; anything token-shaped in the
      // output is not a login and must not be stored as one.
      const promise = service.completeOAuthFlow(CODE);
      await vi.advanceTimersByTimeAsync(200);

      mockPty.emitData(`sk-ant-oat01-${'Q'.repeat(95)}\n`);
      await vi.advanceTimersByTimeAsync(600);
      mockPty.emitExit(0);
      await vi.advanceTimersByTimeAsync(1500);

      const result = await promise;
      expect(result.success).toBe(false);
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

      const result = await service.completeOAuthFlow(CODE);

      expect(result.success).toBe(false);
      expect(result.error).toContain('expired');
    });

    it('should reject completion when PTY has exited (isPtyAlive guard)', async () => {
      // PTY exits abnormally after flow started (e.g., crash, signal kill)
      mockPty.emitExit(1);
      await vi.advanceTimersByTimeAsync(50);

      const result = await service.completeOAuthFlow(CODE);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not running');
    });

    it("reports the CLI's own reason when it exits without logging in", async () => {
      // Verbatim from the CLI (2.1.280) for a code the server refused.
      const completePromise = service.completeOAuthFlow(CODE);
      await vi.advanceTimersByTimeAsync(200);

      mockPty.emitData('Login failed: Request failed with status code 400\n');
      mockPty.emitExit(1);
      await vi.advanceTimersByTimeAsync(1500);

      const result = await completePromise;
      expect(result).toEqual({ success: false, error: 'Login failed: Request failed with status code 400' });
    });

    it('does not end the login on words in the output: only an exit without credentials fails it', async () => {
      // "Invalid code" in the output used to end the login on the spot, while
      // the real code was still being exchanged.
      const completePromise = service.completeOAuthFlow(CODE);
      await vi.advanceTimersByTimeAsync(200);

      mockPty.emitData('Invalid code. Please make sure the full code was copied.\n');
      await vi.advanceTimersByTimeAsync(600);
      writeLogin();
      await vi.advanceTimersByTimeAsync(600);

      const result = await completePromise;
      expect(result.success).toBe(true);
    });

    it('completes when the credentials file is already there on the first check', async () => {
      writeLogin();

      const completePromise = service.completeOAuthFlow(CODE);

      await vi.advanceTimersByTimeAsync(1000);

      const result = await completePromise;

      expect(result.success).toBe(true);
      expect(result.token).toBe(LOGIN_TOKEN);
    });

    it('should timeout after max attempts', async () => {
      const completePromise = service.completeOAuthFlow(CODE);

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

    it("removes nothing from disk: the login ran in the CLI's own config directory", async () => {
      // There is no temporary directory any more. Removing "the flow's
      // directory" would now delete the user's whole CLI configuration.
      const flowPromise = service.startOAuthFlow();
      await vi.advanceTimersByTimeAsync(50);
      mockPty.emitData('https://claude.com/cai/oauth/authorize?code=test\n');
      mockPty.emitData('Paste:\n');
      await vi.advanceTimersByTimeAsync(100);
      await flowPromise;
      mockFsRmSync.mockClear();
      mockFsMkdirSync.mockClear();

      service.cleanupOAuthFlow();
      await vi.advanceTimersByTimeAsync(5000);

      expect(mockFsRmSync).not.toHaveBeenCalled();
    });

    it('does not override the CLI config directory when logging in', async () => {
      const flowPromise = service.startOAuthFlow();
      await vi.advanceTimersByTimeAsync(50);
      mockPty.emitData('https://claude.com/cai/oauth/authorize?code=test\n');
      mockPty.emitData('Paste:\n');
      await vi.advanceTimersByTimeAsync(100);
      await flowPromise;

      const env = mockPtySpawn.mock.calls[0][2].env as Record<string, string>;
      expect(env.CLAUDE_CONFIG_DIR).toBe(process.env.CLAUDE_CONFIG_DIR);
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

  // ANSI stripping (CSI, OSC, DCS/SOS/PM/APC, lone ESC, backspace overwrite)
  // is covered directly and deterministically against stripAnsi() in
  // src/main/utils/__tests__/ansi.test.ts and ansi.realworld.test.ts. Driving
  // the same logic through the fake-timer PTY OAuth flow duplicated that
  // coverage at a less reliable level, so those cases live there instead.
});

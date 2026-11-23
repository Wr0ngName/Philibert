#!/usr/bin/env node
/**
 * Run the app in development and drive it, to see a change working in the
 * real app rather than only in tests.
 *
 *   node scripts/dev/app.mjs start [--watch] [--fake-api]
 *                                               start it on a throwaway profile
 *   node scripts/dev/app.mjs main <expression>  evaluate in the main process
 *   node scripts/dev/app.mjs page <expression>  evaluate in the window
 *   node scripts/dev/app.mjs screenshot <file>  save the window as a PNG
 *   node scripts/dev/app.mjs stop               stop it, and delete the profile
 *
 * `start` runs `electron-forge start` headless (no display needed), or on the
 * desktop's display with --watch to look at it live. The profile is a fresh
 * folder of its own (XDG_CONFIG_HOME), never the real ~/.config/Philibert,
 * seeded with a fake API key to get past the login gate; nothing reaches
 * Claude. Claude Code gets a config folder of its own too (CLAUDE_CONFIG_DIR),
 * never the real ~/.claude: the sessions a message starts are written there.
 *
 * --fake-api answers Claude Code with scripts/dev/fake-api.mjs instead of
 * Anthropic's API, so a message sent in the app gets a streamed reply, and
 * each request is logged to fake-api.jsonl in the app's folder.
 *
 * `main` is the way to inject what the main process would send, e.g.
 *
 *   node scripts/dev/app.mjs main "process.mainModule.require('electron')
 *     .BrowserWindow.getAllWindows()[0].webContents
 *     .send('update:available', { version: '9.9.9', releaseNotes: '- New.' })"
 *
 * Expressions run with `await` available; their value is printed as JSON.
 * The renderer hot-reloads; a main-process change needs stop and start.
 *
 * A development tool: nothing here is part of the app or its packages.
 */

import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const STATE = join(tmpdir(), `philibert-dev-app-${process.getuid?.() ?? 'user'}`);
const PROFILE = join(STATE, 'profile');
const CLAUDE_CONFIG = join(STATE, 'claude');
const FAKE_API_PORT = 9334;
const FAKE_API_PID_FILE = join(STATE, 'fake-api.pid');
const FAKE_API_LOG = join(STATE, 'fake-api.jsonl');
const PROJECT = join(STATE, 'project');
const PID_FILE = join(STATE, 'app.pid');
const LOG_FILE = join(STATE, 'app.log');
const RENDERER_PORT = 9333;
const MAIN_INSPECTOR_PORT = 9229;
const START_TIMEOUT_MS = 180_000;

/**
 * logLevel stays off `debug`: debug builds a framed window with a menu bar,
 * which headless ozone cannot create, and the app then exits right after
 * "Creating main window" with nothing logged.
 */
function seedProfile() {
  rmSync(STATE, { recursive: true, force: true });
  mkdirSync(join(PROFILE, 'Philibert'), { recursive: true });
  mkdirSync(CLAUDE_CONFIG, { recursive: true });
  mkdirSync(PROJECT, { recursive: true });
  writeFileSync(join(PROFILE, 'Philibert', 'config.json'), JSON.stringify({
    authMethod: 'apiKey',
    // Where ConfigService keeps a key with no keyring to encrypt it, which a
    // headless session has none of: `apiKey` itself is never read back.
    encryptedApiKey: 'plain:sk-ant-api03-fake-key-for-the-dev-app-000000000000000000000000',
    hasCompletedInitialSetup: true,
    workingDirectory: PROJECT,
    logLevel: 'info',
  }, null, 2));
}

function runningPid(file = PID_FILE) {
  if (!existsSync(file)) return null;
  const pid = Number(readFileSync(file, 'utf8'));
  try {
    process.kill(-pid, 0);
    return pid;
  } catch {
    return null;
  }
}

async function reachable(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

async function start(args) {
  if (runningPid() !== null) throw new Error(`already running; stop it first (log: ${LOG_FILE})`);
  const watch = args.includes('--watch');
  const fakeApi = args.includes('--fake-api');
  seedProfile();
  if (fakeApi) startFakeApi();

  const display = watch ? { DISPLAY: process.env.DISPLAY || ':0', XAUTHORITY: join(homedir(), '.Xauthority') } : {};
  const electronArgs = ['--no-sandbox', `--remote-debugging-port=${RENDERER_PORT}`];
  if (!watch) electronArgs.unshift('--ozone-platform=headless');

  const log = openSync(LOG_FILE, 'a');
  // Its own process group, so stop ends forge, Vite and Electron together.
  const child = spawn('npx', ['electron-forge', 'start', '--inspect-electron', '--', ...electronArgs], {
    cwd: REPO,
    detached: true,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      ...display,
      XDG_CONFIG_HOME: PROFILE,
      CLAUDE_CONFIG_DIR: CLAUDE_CONFIG,
      ...(fakeApi ? { ANTHROPIC_BASE_URL: `http://127.0.0.1:${FAKE_API_PORT}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } : {}),
    },
  });
  closeSync(log);
  writeFileSync(PID_FILE, String(child.pid));
  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (runningPid() === null) throw new Error(`the app exited while starting; see ${LOG_FILE}`);
    if (await reachable(`http://127.0.0.1:${RENDERER_PORT}/json`) && await mounted()) {
      return `running${watch ? ' on the desktop' : ' headless'}; log: ${LOG_FILE}; project folder: ${PROJECT}`
        + (fakeApi ? `; fake API requests: ${FAKE_API_LOG}` : '');
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  await stop();
  throw new Error(`the window did not come up in ${START_TIMEOUT_MS / 1000}s; see ${LOG_FILE}`);
}

/** The fake API, in its own process group as the app is, until stop. */
function startFakeApi() {
  const log = openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [join(REPO, 'scripts/dev/fake-api.mjs'), String(FAKE_API_PORT), FAKE_API_LOG], {
    detached: true,
    stdio: ['ignore', log, log],
  });
  closeSync(log);
  writeFileSync(FAKE_API_PID_FILE, String(child.pid));
  child.unref();
}

async function stopGroup(file) {
  const pid = runningPid(file);
  if (pid === null) return null;
  process.kill(-pid, 'SIGTERM');
  for (let i = 0; i < 20 && runningPid(file) !== null; i++) await new Promise((r) => setTimeout(r, 250));
  if (runningPid(file) !== null) process.kill(-pid, 'SIGKILL');
  return pid;
}

async function stop() {
  const pid = await stopGroup(PID_FILE);
  await stopGroup(FAKE_API_PID_FILE);
  rmSync(STATE, { recursive: true, force: true });
  return pid === null ? 'not running' : 'stopped';
}

/** Whether the window shows the app: Vue has mounted into #app, not just the page loaded. */
async function mounted() {
  try {
    return await pageEval("(document.querySelector('#app')?.childElementCount ?? 0) > 0") === 'true';
  } catch {
    return false;
  }
}

/** The DevTools target of the app's window, not of DevTools itself. */
async function windowPage() {
  const targets = await (await fetch(`http://127.0.0.1:${RENDERER_PORT}/json`)).json();
  return targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://')) ?? null;
}

/** Evaluate through the Chrome DevTools Protocol, as the Node inspector and Chromium both speak it. */
async function evaluate(webSocketUrl, expression) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen);
    socket.addEventListener('error', () => reject(new Error(`cannot connect to ${webSocketUrl}`)));
  });
  try {
    socket.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true, replMode: true },
    }));
    const reply = await new Promise((r) => socket.addEventListener('message', (e) => r(JSON.parse(e.data))));
    if (reply.error) throw new Error(reply.error.message);
    if (reply.result.exceptionDetails) {
      throw new Error(reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text);
    }
    return JSON.stringify(reply.result.result.value ?? null);
  } finally {
    socket.close();
  }
}

async function mainEval(expression) {
  const [target] = await (await fetch(`http://127.0.0.1:${MAIN_INSPECTOR_PORT}/json`)).json();
  return evaluate(target.webSocketDebuggerUrl, expression);
}

async function pageEval(expression) {
  const page = await windowPage();
  if (!page) throw new Error('no app window');
  return evaluate(page.webSocketDebuggerUrl, expression);
}

async function screenshot(file) {
  const { chromium } = await import('playwright');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${RENDERER_PORT}`);
  try {
    const page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith('devtools://'));
    if (!page) throw new Error('no app window');
    await page.screenshot({ path: resolve(file) });
    return resolve(file);
  } finally {
    await browser.close();
  }
}

const USAGE = 'usage: app.mjs start [--watch] [--fake-api] | main <expression> | page <expression> | screenshot <file> | stop';

async function main([command, ...args]) {
  switch (command) {
    case 'start': return start(args);
    case 'stop': return stop();
    case 'main': if (args[0]) return mainEval(args.join(' ')); break;
    case 'page': if (args[0]) return pageEval(args.join(' ')); break;
    case 'screenshot': if (args[0]) return screenshot(args[0]); break;
  }
  throw new Error(USAGE);
}

try {
  console.log(await main(process.argv.slice(2)));
} catch (error) {
  console.error(`app: ${error.message}`);
  process.exit(1);
}

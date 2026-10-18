/**
 * Logger for the renderer process.
 *
 * Debug and info go to the console in development only. Warnings and errors
 * go to the console always, and to main.log through the main process: the
 * console is only visible with devtools open, so a failure that happened
 * entirely in the renderer used to leave nothing in the log a user can hand
 * over.
 */

const isDev = import.meta.env.DEV;

interface LogData {
  [key: string]: unknown;
}

/**
 * JSON for anything handed to the logger, and never a throw.
 *
 * `JSON.stringify` writes an Error as `{}` and throws on a cycle, and the
 * stringifying fallback this replaced wrote every object as
 * "[object Object]" — so the detail of most logged failures was lost exactly
 * where it was needed.
 */
export function serializeLogData(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, item: unknown) => {
      if (item instanceof Error) {
        return {
          ...item,
          name: item.name,
          message: item.message,
          stack: item.stack,
          ...(item.cause !== undefined ? { cause: item.cause } : {}),
        };
      }
      if (typeof item === 'bigint') return item.toString();
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    });
  } catch (err) {
    return `"[unserialisable: ${err instanceof Error ? err.message : String(err)}]"`;
  }
}

function formatMessage(level: string, message: string, data?: string): string {
  const timestamp = new Date().toISOString();
  return `[${timestamp}] [${level}] ${message}${data ? ` ${data}` : ''}`;
}

/** Hand a line to main.log. Logging must never be the thing that fails. */
function forward(level: 'warn' | 'error', message: string, data?: string): void {
  try {
    window.electron?.log?.write({ level, message, ...(data ? { data } : {}) });
  } catch {
    // Nowhere left to report it; the console line has already been written.
  }
}

export const logger = {
  debug(message: string, data?: LogData): void {
    if (isDev) {
      console.debug(formatMessage('debug', message, serializeLogData(data)));
    }
  },

  info(message: string, data?: LogData): void {
    if (isDev) {
      console.info(formatMessage('info', message, serializeLogData(data)));
    }
  },

  warn(message: string, data?: LogData): void {
    const serialized = serializeLogData(data);
    console.warn(formatMessage('warn', message, serialized));
    forward('warn', message, serialized);
  },

  error(message: string, error?: unknown): void {
    const serialized = serializeLogData(error);
    console.error(formatMessage('error', message, serialized));
    forward('error', message, serialized);
  },
};

/**
 * Log what Vue's error handler never sees.
 *
 * Errors thrown outside a component — an IPC listener, a timer — and promises
 * nobody awaited, which is how most async failures end. Without these they
 * reached the console only.
 */
export function installGlobalErrorLogging(target: Pick<Window, 'addEventListener'>): void {
  target.addEventListener('error', (event: ErrorEvent) => {
    logger.error('Uncaught error', {
      error: event.error ?? event.message,
      ...(event.filename ? { source: `${event.filename}:${event.lineno}:${event.colno}` } : {}),
    });
  });
  target.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    logger.error('Unhandled promise rejection', { reason: event.reason });
  });
}

export default logger;

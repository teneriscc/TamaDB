import { pino, type Logger } from 'pino';
import { createWriteStream } from 'node:fs';
import type { LogLevel } from '../config.js';

/**
 * Structured JSON logging subsystem (Component C14, T14.1–T14.6).
 *
 * Increment 1 requirements:
 * - Structured JSON output (T14.1)
 * - Configurable levels: debug/info/warn/error/silent (T14.2)
 * - Runtime-changeable level without restart (T14.3)
 * - Configurable destination: stdout, file, none (T14.4)
 * - Expose current level and destination via API-accessible state (T14.5)
 *
 * Integration points (T14.6):
 * - DEBUG: every store, merge, validation, delivery, retry
 * - INFO: document creation, schema changes, TTL expiry, subscription lifecycle
 * - WARN: history eviction, TTL floor adjustments, delivery failures, schema mismatches,
 *         identityKind conflicts, depth-0 concurrency warning
 * - ERROR: validation rejections, parse errors, quarantined documents
 */

export type LogDestination = 'stdout' | 'file' | 'none';

interface LoggingState {
  level: LogLevel;
  destination: LogDestination;
  filePath?: string;
}

let rootLogger: Logger | null = null;
let currentState: LoggingState = { level: 'debug', destination: 'stdout' };

/**
 * Create and initialise the root logger.
 */
export function createLogger(level: LogLevel, destination?: LogDestination, filePath?: string): Logger {
  const dest = destination ?? 'stdout';
  currentState = filePath !== undefined
    ? { level, destination: dest, filePath }
    : { level, destination: dest };

  const stream = resolveDestination(dest, filePath);

  rootLogger = pino({
    level,
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  }, stream);

  return rootLogger;
}

/**
 * Get the shared root logger (lazy-initialises to debug/stdout if not created).
 */
export function getLogger(): Logger {
  if (!rootLogger) {
    rootLogger = createLogger('debug');
  }
  return rootLogger;
}

/**
 * T14.3: Runtime-change the active log level without restarting the process.
 */
export function setLogLevel(level: LogLevel): void {
  getLogger().level = level;
  currentState.level = level;
}

/**
 * T14.4: Change the log destination at runtime.
 * Note: Changing to 'file' requires a filePath. Switching destination
 * re-creates the logger (new stream) but preserves the current level.
 */
export function setLogDestination(destination: LogDestination, filePath?: string): void {
  createLogger(currentState.level, destination, filePath);
}

/**
 * T14.5: Expose current logging state for API inspection.
 */
export function getLoggingState(): { level: LogLevel; destination: LogDestination; filePath?: string } {
  return { ...currentState };
}

/**
 * Resolve destination to a writable stream for Pino.
 */
function resolveDestination(destination: LogDestination, filePath?: string): NodeJS.WritableStream {
  switch (destination) {
    case 'stdout':
      return process.stdout;
    case 'file':
      if (!filePath) return process.stdout; // fallback
      return createWriteStream(filePath, { flags: 'a' });
    case 'none':
      // No-op stream that discards all output
      return {
        write: () => true,
        end: () => {},
        on: () => {},
        once: () => {},
        emit: () => false,
      } as unknown as NodeJS.WritableStream;
  }
}

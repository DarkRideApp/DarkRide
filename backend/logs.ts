import { EventEmitter } from 'events';

export interface LogEntry {
  system: string;
  datetime: string;
  severity: 'log' | 'error';
  message: string;
  file: string;
  line: number;
}

interface Logger {
  log: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(100);

const loggers = new Map<string, Logger>();

const LOG_BUFFER_SIZE = 200;
const logBuffer: LogEntry[] = [];

export function getRecentLogs(): LogEntry[] {
  return logBuffer.slice();
}

function getCallerInfo(): { file: string; line: number } {
  if (!process.env.DEBUG_LOGS) {
    return { file: '', line: 0 };
  }
  const stack = new Error().stack;
  if (!stack) return { file: '', line: 0 };

  const lines = stack.split('\n');
  // Skip Error, getCallerInfo, log/error, and the wrapper — find the actual caller
  for (let i = 3; i < lines.length; i++) {
    const line = lines[i];
    // Skip internal frames
    if (line.includes('backend/logs.ts')) continue;
    const match = line.match(/(?:at .+ \(|at )(.+):(\d+):\d+\)?/);
    if (match) {
      return { file: match[1].replace(/^.*\//, ''), line: parseInt(match[2], 10) };
    }
  }
  return { file: '', line: 0 };
}

export function createLoggers(systemId: string, _options?: { colour?: string }): Logger {
  const existing = loggers.get(systemId);
  if (existing) return existing;

  const makeHandler = (severity: 'log' | 'error') => (...args: any[]) => {
    const message = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    const { file, line } = getCallerInfo();
    const entry: LogEntry = {
      system: systemId,
      datetime: new Date().toISOString(),
      severity,
      message,
      file,
      line,
    };
    const prefix = `[${systemId}]`;
    if (severity === 'error') {
      originalConsoleError(prefix, message);
    } else {
      originalConsoleLog(prefix, message);
    }
    logBuffer.push(entry);
    if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
    emitter.emit(`log:${systemId}`, entry);
    emitter.emit('log:*', entry);
  };

  const logger: Logger = {
    log: makeHandler('log'),
    error: makeHandler('error'),
  };

  loggers.set(systemId, logger);
  return logger;
}

export function subscribe(logId: string, callback: (entry: LogEntry) => void): () => void {
  const handler = (entry: LogEntry) => callback(entry);
  emitter.on(`log:${logId}`, handler);
  return () => { emitter.off(`log:${logId}`, handler); };
}

export function subscribeAll(callback: (entry: LogEntry) => void): () => void {
  const handler = (entry: LogEntry) => callback(entry);
  emitter.on('log:*', handler);
  return () => { emitter.off('log:*', handler); };
}

// Override global console.log and console.error
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const consoleLogger = createLoggers('console');

console.log = (...args: any[]) => {
  originalConsoleLog(...args);
  consoleLogger.log(...args);
};

console.error = (...args: any[]) => {
  originalConsoleError(...args);
  consoleLogger.error(...args);
};

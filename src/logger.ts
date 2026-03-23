/**
 * Structured JSON logger.
 *
 * Every log line is a single JSON object written to stdout (info/warn/debug) or
 * stderr (error). This makes logs trivially parseable by log aggregators (Loki,
 * Datadog, CloudWatch, etc.) without a sidecar parser.
 *
 * Usage:
 *   log.info('Poll', 'fetched vehicles', { count: 24, route: '510' });
 *   log.error('DB', 'write failed', { err: e.message });
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

function write(level: Level, component: string, msg: string, meta?: Record<string, unknown>): void {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    component,
    msg,
    ...meta,
  };
  const line = JSON.stringify(entry) + '\n';
  if (level === 'error') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

export const log = {
  debug: (component: string, msg: string, meta?: Record<string, unknown>) => write('debug', component, msg, meta),
  info:  (component: string, msg: string, meta?: Record<string, unknown>) => write('info',  component, msg, meta),
  warn:  (component: string, msg: string, meta?: Record<string, unknown>) => write('warn',  component, msg, meta),
  error: (component: string, msg: string, meta?: Record<string, unknown>) => write('error', component, msg, meta),
};

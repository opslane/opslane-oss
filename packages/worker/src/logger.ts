/**
 * Structured JSON logger for the worker service.
 *
 * Replaces console.log/console.error with structured JSON output,
 * consistent with the Go ingestion service's slog JSON format.
 */

let workerId = process.env['WORKER_ID'] ?? 'unknown';

/** Update the worker ID used in all subsequent log entries. */
export function setWorkerId(id: string): void {
  workerId = id;
}

export function log(
  level: 'info' | 'warn' | 'error',
  message: string,
  fields?: Record<string, unknown>
): void {
  const entry: Record<string, unknown> = {
    time: new Date().toISOString(),
    level: level.toUpperCase(),
    msg: message,
    worker_id: workerId,
  };

  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (key !== 'time' && key !== 'level' && key !== 'msg' && key !== 'worker_id') {
        entry[key] = value;
      }
    }
  }

  const output = JSON.stringify(entry);
  if (level === 'error') {
    process.stderr.write(output + '\n');
  } else {
    process.stdout.write(output + '\n');
  }
}

export const logger = {
  info(message: string, fields?: Record<string, unknown>): void {
    log('info', message, fields);
  },
  warn(message: string, fields?: Record<string, unknown>): void {
    log('warn', message, fields);
  },
  error(message: string, fields?: Record<string, unknown>): void {
    log('error', message, fields);
  },
};

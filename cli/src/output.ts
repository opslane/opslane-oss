/**
 * JSON output utility for agent-first CLI.
 * All CLI commands output JSON by default.
 */

export function jsonOutput(data: object): void {
  console.log(JSON.stringify(data, null, 2));
}

export function exitWithError(message: string, details?: Record<string, unknown>): never {
  jsonOutput({ error: message, ...details });
  process.exit(1);
}

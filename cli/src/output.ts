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

/**
 * Emit a terminal state in the agent contract. Every agent-facing terminal
 * response carries a `status` field (unlike `exitWithError`'s `{error}` shape).
 * Exit code 0 means the state is not a failure (e.g. `pending`, `auth_required`,
 * `already_configured`); 1 means a terminal failure the agent must act on.
 * Exactly one JSON document is printed per invocation.
 */
export function exitWithStatus(
  status: AgentStatus,
  data: Record<string, unknown> = {},
  code = 1,
): never {
  jsonOutput({ status, ...data });
  process.exit(code);
}
import type { AgentStatus } from './contract.js';

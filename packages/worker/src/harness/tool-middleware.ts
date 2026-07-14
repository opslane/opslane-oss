import type { Sandbox } from 'e2b';
import type { ToolCall, ToolResult, AgentState, ToolMiddleware } from './types.js';

const TEST_COMMAND_PATTERNS = [/\bnpm test\b/, /\bvitest\b/, /\bjest\b/, /\bpytest\b/, /\bpnpm test\b/];
const TEST_FAILURE_PATTERNS = [/fail/i, /error/i, /Exit code: [^0]/];

const DANGEROUS_COMMAND_PATTERNS = [
  /\bgit\s+push\b/,
  /\bgit\s+remote\b/,
  /\bcurl\b/,
  /\bwget\b/,
  /\bssh\b/,
  /\bnc\b/,
  /\bscp\b/,
];

export function createDefaultMiddleware(sandbox?: Sandbox): ToolMiddleware {
  return {
    async preTool(call: ToolCall, state: AgentState) {
      // Block dangerous bash commands
      if (call.name === 'bash') {
        const command = call.input.command as string;
        for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
          if (pattern.test(command)) {
            return {
              allow: false,
              inject: `Command blocked: "${command}" is not allowed in the sandbox. Only local operations (read, edit, build, test) are permitted.`,
            };
          }
        }
      }

      if (call.name === 'edit' || call.name === 'write') {
        const path = (call.input.path as string) ?? '';
        const normalized = path.replace(/^\//, '');
        const count = state.editCounts.get(normalized) ?? 0;
        if (count >= 3) {
          return {
            allow: true,
            inject: `Warning: you have edited this file 3+ times (${count}). Consider a different approach.`,
          };
        }
      }
    },

    async postTool(call: ToolCall, result: ToolResult, state: AgentState) {
      if (call.name === 'edit' || call.name === 'write') {
        const path = (call.input.path as string) ?? '';
        const normalized = path.replace(/^\//, '');
        state.editCounts.set(normalized, (state.editCounts.get(normalized) ?? 0) + 1);
      }

      if (call.name === 'bash') {
        const command = call.input.command as string;
        const output = result.output ?? '';

        if (TEST_COMMAND_PATTERNS.some((p) => p.test(command))) {
          const failed = result.isError || TEST_FAILURE_PATTERNS.some((p) => p.test(output));
          if (!failed) {
            state.testsRan = true;
          }
        }
      }
    },

    async preCompletion(state: AgentState) {
      if (!state.testsRan) {
        return { inject: 'You have not run tests yet. Please run tests before completing.' };
      }

      // Scope review: check if agent modified files outside the stack trace
      // Set flag AFTER successful diff retrieval, not before
      if (!state.scopeReviewDone && sandbox && state.stackTraceFiles.length > 0) {
        try {
          // Include untracked files too
          const diffResult = await sandbox.commands.run(
            'cd /home/user/repo && { git diff HEAD --name-only; git ls-files --others --exclude-standard; } | sort -u',
            { timeoutMs: 10_000 },
          );
          state.scopeReviewDone = true;  // Set AFTER successful retrieval
          const modifiedFiles = (diffResult.stdout ?? '').trim().split('\n').filter(Boolean);
          // Use '/' + prefix for full path-segment matching
          const outOfScope = modifiedFiles.filter(
            f => !state.stackTraceFiles.some(stf =>
              f === stf || f.endsWith('/' + stf) || stf.endsWith('/' + f)
            ),
          );
          if (outOfScope.length > 0) {
            return {
              inject: `Before finishing, review your diff for scope. You modified files not referenced in the stack trace: [${outOfScope.join(', ')}]. The error only references: [${state.stackTraceFiles.join(', ')}]. For each extra file, confirm it is necessary to fix the reported error. If any change is not directly required, revert it with bash (git checkout <file>) and then finish.`,
            };
          }
        } catch {
          state.scopeReviewDone = true;  // Don't retry on failure
        }
      }
    },
  };
}

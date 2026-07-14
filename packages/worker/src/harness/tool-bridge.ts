import type { Sandbox } from 'e2b';
import type { ToolDefinition, AgentState } from './types.js';

/** Max characters per tool output to prevent context overflow. */
const MAX_OUTPUT_CHARS = 12_000;

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Truncate tool output to stay within context budget. */
function cap(output: string, limit = MAX_OUTPUT_CHARS): string {
  if (output.length <= limit) return output;
  const half = Math.max(Math.floor(limit / 2) - 50, 0);
  const omitted = output.length - limit;
  if (half === 0) return output.slice(0, limit) + `\n\n... [${omitted} chars omitted]`;
  return output.slice(0, half) + `\n\n... [${omitted} chars omitted] ...\n\n` + output.slice(-half);
}

export function createToolBridge(sandbox: Sandbox, state: AgentState): ToolDefinition[] {
  return [
    {
      name: 'read',
      description: 'Read a file from the repository. Returns the full file content.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute path to the file' } },
        required: ['path'],
      },
      execute: async (input) => {
        return cap(await sandbox.files.read(input.path as string));
      },
    },
    {
      name: 'write',
      description: 'Write content to a file. Creates the file if it does not exist, overwrites if it does.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file' },
          content: { type: 'string', description: 'Full file content to write' },
        },
        required: ['path', 'content'],
      },
      execute: async (input) => {
        await sandbox.files.write(input.path as string, input.content as string);
        return `Written to ${input.path}`;
      },
    },
    {
      name: 'edit',
      description: 'Find and replace a string in a file. The old_string must appear exactly once.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file' },
          old_string: { type: 'string', description: 'The exact string to find (must be unique in the file)' },
          new_string: { type: 'string', description: 'The replacement string' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
      execute: async (input) => {
        const path = input.path as string;
        const oldStr = input.old_string as string;
        const newStr = input.new_string as string;
        const content = await sandbox.files.read(path);
        const occurrences = content.split(oldStr).length - 1;
        if (occurrences === 0) return `Error: old_string not found in ${path}`;
        if (occurrences > 1) return `Error: old_string found ${occurrences} times in ${path}. Must be unique.`;
        const updated = content.replace(oldStr, () => newStr);
        await sandbox.files.write(path, updated);
        return `Applied edit to ${path}`;
      },
    },
    {
      name: 'bash',
      description: 'Run a shell command in the sandbox. Use for git, npm, test runners, etc.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute' },
          timeout: { type: 'number', description: 'Timeout in ms (default: 120000)' },
        },
        required: ['command'],
      },
      execute: async (input) => {
        const timeout = (input.timeout as number) ?? 120_000;
        const result = await sandbox.commands.run(input.command as string, { timeoutMs: timeout });
        if (result.exitCode === 0) return cap(result.stdout || '(no output)');
        return cap([
          `Exit code: ${result.exitCode}`,
          result.stdout ? `stdout:\n${result.stdout}` : '',
          result.stderr ? `stderr:\n${result.stderr}` : '',
        ].filter(Boolean).join('\n'));
      },
    },
    {
      name: 'read_many',
      description: 'Read multiple files at once. Returns a JSON object mapping path to content.',
      inputSchema: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: 'Array of absolute file paths to read' },
        },
        required: ['paths'],
      },
      execute: async (input) => {
        const paths = input.paths as string[];
        const perFile = Math.floor(MAX_OUTPUT_CHARS / Math.max(paths.length, 1));
        const results: Record<string, string> = {};
        await Promise.all(paths.map(async (p) => {
          try { results[p] = cap(await sandbox.files.read(p), perFile); }
          catch { results[p] = `Error: could not read ${p}`; }
        }));
        return cap(JSON.stringify(results, null, 2));
      },
    },
    {
      name: 'search',
      description: 'Search for a pattern in files using grep. Returns matching lines with file paths and line numbers.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          path: { type: 'string', description: 'Directory or file to search in (default: current directory)' },
          include: { type: 'string', description: 'Glob pattern to filter files (e.g., "*.ts")' },
        },
        required: ['pattern'],
      },
      execute: async (input) => {
        const pattern = input.pattern as string;
        const path = (input.path as string) || '.';
        const include = input.include ? `--include=${shellEscape(input.include as string)}` : '';
        const cmd = `grep -rn ${include} ${shellEscape(pattern)} ${shellEscape(path)} 2>/dev/null | head -100`;
        const result = await sandbox.commands.run(cmd, { timeoutMs: 30_000 });
        return cap(result.stdout || 'No matches found.');
      },
    },
    {
      name: 'patch',
      description: 'Apply a unified diff patch to the codebase.',
      inputSchema: {
        type: 'object',
        properties: { diff: { type: 'string', description: 'The unified diff to apply' } },
        required: ['diff'],
      },
      execute: async (input) => {
        const diff = input.diff as string;
        const patchFile = `/tmp/agent-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`;
        await sandbox.files.write(patchFile, diff);
        const result = await sandbox.commands.run(`cd /home/user/repo && patch -p1 < ${patchFile}`, { timeoutMs: 30_000 });
        if (result.exitCode === 0) return `Patch applied successfully.\n${result.stdout}`;
        return `Patch failed (exit ${result.exitCode}):\n${result.stderr}\n${result.stdout}`;
      },
    },
    {
      name: 'give_up',
      description: 'Call this when the error cannot be fixed by code changes. Examples: infrastructure issues (CDN down, DNS failure, timeouts), errors originating from third-party code in node_modules, minified/obfuscated stack traces with no sourcemap available, errors caused by external service outages, errors thrown from the browser console or devtools (stack trace only shows <anonymous>), errors not traceable to any application source code after investigation, test/synthetic errors deliberately thrown for monitoring validation.',
      inputSchema: {
        type: 'object',
        properties: {
          reason_code: { type: 'string', description: 'Machine-readable reason code (e.g., worker_runtime_error, sourcemap_unresolved)' },
          reason_message: { type: 'string', description: 'Human-readable explanation of why this cannot be fixed' },
          remediation: { type: 'string', description: 'What a human should do to resolve this' },
        },
        required: ['reason_code', 'reason_message', 'remediation'],
      },
      execute: async (input) => {
        state.gaveUp = true;
        state.giveUpReason = {
          reason_code: input.reason_code as string,
          reason_message: input.reason_message as string,
          remediation: input.remediation as string,
        };
        return 'Acknowledged. Ending agent loop.';
      },
    },
  ];
}

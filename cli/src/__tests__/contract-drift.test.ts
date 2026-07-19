import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_STATUSES, type AgentStatusContract } from '../contract.js';

const START = '<!-- BEGIN AGENT_STATUS_CONTRACT -->';
const END = '<!-- END AGENT_STATUS_CONTRACT -->';

function unquoteCode(value: string): string {
  const match = value.match(/^`([\s\S]*)`$/);
  if (!match) throw new Error(`expected a backticked table value, got ${value}`);
  return match[1];
}

export function parseAgentStatusTable(markdown: string): AgentStatusContract[] {
  const start = markdown.indexOf(START);
  const end = markdown.indexOf(END);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('CLI agent contract status-table markers are missing or out of order');
  }

  const rows: AgentStatusContract[] = [];
  const table = markdown.slice(start + START.length, end);
  for (const line of table.split('\n')) {
    if (!line.startsWith('| `')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 5) throw new Error(`invalid CLI contract row: ${line}`);

    const exitCode = Number(cells[2]);
    const stream = unquoteCode(cells[3]);
    if ((exitCode !== 0 && exitCode !== 1) || (stream !== 'stdout' && stream !== 'stderr')) {
      throw new Error(`invalid CLI contract exit or stream: ${line}`);
    }

    rows.push({
      command: unquoteCode(cells[0]),
      status: unquoteCode(cells[1]),
      exitCode,
      stream,
      meaning: cells[4],
    });
  }
  return rows;
}

describe('CLI agent contract documentation', () => {
  it('matches the canonical runtime status table exactly', () => {
    const markdown = readFileSync(
      new URL('../../../docs/reference/cli-agent-contract.md', import.meta.url),
      'utf8',
    );

    expect(parseAgentStatusTable(markdown)).toEqual(AGENT_STATUSES);
  });

  it('covers every literal exitWithStatus call in CLI source', () => {
    const sourceDir = dirname(fileURLToPath(new URL('../contract.ts', import.meta.url)));
    const usedStatuses = new Set<string>();

    for (const entry of readdirSync(sourceDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.parentPath.includes('__tests__')) {
        continue;
      }
      const source = readFileSync(join(entry.parentPath, entry.name), 'utf8');
      for (const match of source.matchAll(/exitWithStatus\(\s*['"]([a-z0-9_]+)['"]/g)) {
        usedStatuses.add(match[1]);
      }
    }

    const documentedStatuses = new Set<string>(AGENT_STATUSES.map((entry) => entry.status));
    expect([...usedStatuses].filter((status) => !documentedStatuses.has(status)).sort()).toEqual([]);
  });
});

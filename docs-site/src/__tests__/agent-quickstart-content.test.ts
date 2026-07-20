import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { AGENT_STATUSES } from '../../../cli/src/contract';
import { parseDraft } from '../../scripts/frontmatter.mjs';
import { extractTitle } from '../loaders/repo-docs';

const quickstartPath = new URL('../../../docs/quickstart/agent.md', import.meta.url);
const agentSetupPath = new URL('../../../packages/ingestion/handler/agent_setup.go', import.meta.url);
const markdown = readFileSync(quickstartPath, 'utf8');

function stripFencedCode(source: string): string {
  const visible: string[] = [];
  let fence: { marker: string; length: number } | undefined;

  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(`{3,}|~{3,})/);
    if (match?.[1]) {
      const marker = match[1][0]!;
      if (!fence) fence = { marker, length: match[1].length };
      else if (marker === fence.marker && match[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (!fence) visible.push(line);
  }

  return visible.join('\n');
}

describe('agent quickstart content', () => {
  it('uses absolute canonical HTTPS links outside code blocks', () => {
    const prose = stripFencedCode(markdown);
    const markdownLinks = [...prose.matchAll(/\[[^\]]+\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)].map(
      (match) => match[1]!,
    );
    const autolinks = [...prose.matchAll(/<(https?:\/\/[^>]+)>/g)].map((match) => match[1]!);
    const links = [...markdownLinks, ...autolinks];

    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toMatch(/^https:\/\//);
      if (link.startsWith('https://docs.opslane.com/')) expect(link).toMatch(/\/$/);
    }
  });

  it('is a covered draft with exactly one H1', () => {
    expect(parseDraft(markdown)).toBe(true); // PR 7 deletes this line.
    expect(markdown).toMatch(/^---\n[\s\S]*\ncovers:\n(?:\s+-\s+[^\n]+\n)+[\s\S]*?\n---\n/);
    expect(extractTitle(markdown, 'docs/quickstart/agent.md')).toBe('Agent quickstart');
  });

  it('only documents statuses from the CLI agent contract', () => {
    const documented = [...markdown.matchAll(/"?status"?:\s*"([^"]+)"/g)].map(
      (match) => match[1]!,
    );
    const contracted = new Set(AGENT_STATUSES.map(({ status }) => status));

    expect(documented.length).toBeGreaterThan(0);
    for (const status of documented) expect(contracted.has(status)).toBe(true);
  });

  it('only documents failure reasons emitted by agent setup', () => {
    const serverSource = readFileSync(agentSetupPath, 'utf8');
    const documented = [...markdown.matchAll(/failure_reason:\s*"([^"]+)"/g)].map(
      (match) => match[1]!,
    );

    expect(documented.length).toBeGreaterThan(0);
    for (const reason of documented) expect(serverSource).toContain(`"${reason}"`);
  });
});

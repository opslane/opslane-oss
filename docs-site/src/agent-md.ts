import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parseDraft } from '../scripts/frontmatter.mjs';

export interface AgentQuickstart {
  draft: boolean;
  body: string;
}

// Package scripts run with docs-site as cwd. Unlike import.meta.url, this stays
// stable when Astro bundles this module under dist/.prerender during a build.
const canonicalDoc = path.resolve(process.cwd(), '../docs/quickstart/agent.md');

function stripFrontmatter(markdown: string): string {
  const normalized = markdown.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  return normalized.replace(/^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/, '');
}

export function loadAgentQuickstart(): AgentQuickstart {
  const markdown = readFileSync(canonicalDoc, 'utf8');
  let draft = true;

  try {
    draft = parseDraft(markdown);
  } catch {
    // The endpoint fails closed: malformed or missing frontmatter never publishes.
  }

  return { draft, body: stripFrontmatter(markdown) };
}

export function agentQuickstartResponse({ draft, body }: AgentQuickstart): Response {
  if (draft) return new Response(null, { status: 404 });

  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
}

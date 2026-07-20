import { describe, expect, it } from 'vitest';

import { parseDraft } from '../../scripts/frontmatter.mjs';
import { agentQuickstartResponse, loadAgentQuickstart } from '../agent-md';

describe('parseDraft', () => {
  it('parses explicit draft flags, tolerating CRLF', () => {
    expect(parseDraft('---\ndraft: true\n---\n# T\n')).toBe(true);
    expect(parseDraft('---\r\ndraft: false\r\n---\r\n# T\r\n')).toBe(false);
  });

  it('fails closed on missing, duplicate, or malformed draft', () => {
    expect(() => parseDraft('---\ncovers: []\n---\n# T\n')).toThrow();
    expect(() => parseDraft('---\ndraft: true\ndraft: false\n---\n')).toThrow();
    expect(() => parseDraft('---\ndraft: maybe\n---\n')).toThrow();
    expect(() => parseDraft('---\ndraft: true\ndraft: maybe\n---\n')).toThrow();
    expect(() => parseDraft('# no frontmatter\n')).toThrow();
  });
});

describe('agent quickstart endpoint', () => {
  it('reads the real canonical doc', () => {
    const doc = loadAgentQuickstart();
    expect(doc.body).toContain('# Agent quickstart');
    expect(doc.body.startsWith('---')).toBe(false);
  });

  it('404s (null body) while draft; serves markdown when live', async () => {
    const dark = agentQuickstartResponse({ draft: true, body: 'x' });
    expect(dark.status).toBe(404);
    expect(await dark.text()).toBe('');

    const live = agentQuickstartResponse({ draft: false, body: '# T' });
    expect(live.status).toBe(200);
    expect(live.headers.get('content-type')).toContain('text/markdown');
    expect(await live.text()).toBe('# T');
  });
});

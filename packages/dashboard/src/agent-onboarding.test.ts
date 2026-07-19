import { describe, expect, it } from 'vitest';

import {
  AGENT_ONBOARDING_ENABLED,
  buildAgentPrompt,
  HOSTED_ORIGINS,
} from './agent-onboarding';

describe('buildAgentPrompt', () => {
  it('emits the bare prompt on hosted origins', () => {
    for (const origin of HOSTED_ORIGINS) {
      const prompt = buildAgentPrompt(origin);

      expect(prompt).not.toContain('OPSLANE_API_URL');
      expect(prompt).toContain('docs.opslane.com/agent.md');
      expect(prompt).toContain('npx -y @opslane/cli setup --start');
    }
  });

  it('prefixes OPSLANE_API_URL on self-hosted origins', () => {
    const prompt = buildAgentPrompt('http://localhost:8082');

    expect(prompt.startsWith('OPSLANE_API_URL=http://localhost:8082 — ')).toBe(true);
  });

  it('normalizes the origin it embeds', () => {
    expect(buildAgentPrompt('HTTP://MyHost:80/x')).toContain('OPSLANE_API_URL=http://myhost');
  });

  it('ships flag-off until the activation PR', () => {
    expect(AGENT_ONBOARDING_ENABLED).toBe(false);
  });
});

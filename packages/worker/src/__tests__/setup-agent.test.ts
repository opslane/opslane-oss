import { describe, it, expect } from 'vitest';
import { buildSetupSystemPrompt } from '../setup-agent.js';

describe('buildSetupSystemPrompt', () => {
  const p = buildSetupSystemPrompt({
    apiKeyEnvVar: 'VITE_OPSLANE_API_KEY',
    releaseEnvVar: 'VITE_OPSLANE_RELEASE',
  });

  it('names the SDK package and the real init API', () => {
    expect(p).toContain('@opslane/sdk');
    expect(p).toContain('init(');
  });

  it('instructs env-var references, not a hardcoded key', () => {
    expect(p).toContain('VITE_OPSLANE_API_KEY');
    expect(p).toContain('VITE_OPSLANE_RELEASE');
    expect(p.toLowerCase()).toContain('do not hardcode');
  });

  it('forbids the environment field and demands a build check', () => {
    expect(p).toContain('environment');
    expect(p.toLowerCase()).toContain('build');
  });
});

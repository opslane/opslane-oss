import { describe, expect, it } from 'vitest';

import { renderSpec } from '../spec.js';

describe('onboarding agent specification', () => {
  it('frames the goal, requires repository investigation, and bakes in no convention', () => {
    const spec = renderSpec({ cwd: '/repo/x' });

    expect(spec).toContain('/repo/x');
    expect(spec).not.toContain('VITE_OPSLANE_');
    expect(spec.toLowerCase()).toContain('read the repository');
    expect(spec).toMatch(/name the opslane variables after opslane/i);
    expect(spec).toMatch(/never name them after another product/i);
    for (const required of [
      'goal',
      'follow',
      'endpoint',
      'ask_user',
      'migrate',
      'finish_onboarding',
      'never write',
      'do not run installs',
    ]) {
      expect(spec.toLowerCase()).toContain(required);
    }
  });

  it('states the SDK contract and single-app completion constraints', () => {
    const spec = renderSpec({ cwd: '/repo/x' });

    expect(spec).toContain('@opslane/sdk');
    expect(spec).toContain('init({ apiKey, endpoint })');
    expect(spec).toMatch(/exactly one app/i);
    expect(spec).toMatch(/existing script/i);
    expect(spec).toMatch(/exactly once/i);
    expect(spec).toMatch(/more than one|multiple/i);
    expect(spec).toMatch(/pick|select/i);
    expect(spec).not.toMatch(/npm install|pnpm install|yarn add|bun add/);
  });
});

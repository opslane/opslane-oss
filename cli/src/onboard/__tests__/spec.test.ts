import { describe, expect, it } from 'vitest';

import { renderDetectSpec } from '../spec.js';

describe('detect-stage agent specification', () => {
  it('frames a read-only repository investigation and report', () => {
    const spec = renderDetectSpec({ cwd: '/repo/x' });

    expect(spec).toContain('/repo/x');
    expect(spec.toLowerCase()).toContain('read the repository');
    expect(spec).toMatch(/name them after opslane/i);
    expect(spec).toMatch(/never borrow another product/i);
    expect(spec).toMatch(/use the repo's own prefix/i);
    for (const required of [
      'goal',
      'read',
      'report_plan',
      'ask_user',
      'primary user-facing web app',
      'multi:false',
      'no edit tools',
      'unsupported',
    ]) {
      expect(spec.toLowerCase()).toContain(required);
    }
  });

  it('requires one structured report grounded in the selected app', () => {
    const spec = renderDetectSpec({ cwd: '/repo/x' });

    expect(spec).toContain('@opslane/sdk');
    expect(spec).toMatch(/select exactly one/i);
    expect(spec).toMatch(/exactly once/i);
    expect(spec).toMatch(/coexist/i);
    expect(spec).toContain('import_line');
    expect(spec).toContain('init_block');
    expect(spec).not.toMatch(/\bedit or write\b/i);
  });
});

import { describe, expect, it } from 'vitest';
import { evaluateCI } from '../ci-watch.js';

describe('evaluateCI', () => {
  it('requires at least one success and no pending work', () => {
    expect(evaluateCI([
      { name: 'tests', status: 'completed', conclusion: 'success' },
    ], [])).toEqual({ state: 'green', checkNames: ['tests'], failingChecks: [] });

    expect(evaluateCI([
      { name: 'tests', status: 'in_progress', conclusion: null },
    ], [])).toEqual({ state: 'pending', checkNames: [], failingChecks: [] });
  });

  it('never treats zero checks or neutral-only checks as green', () => {
    expect(evaluateCI([], [])).toMatchObject({ state: 'pending' });
    expect(evaluateCI([
      { name: 'lint', status: 'completed', conclusion: 'neutral' },
      { name: 'docs', status: 'completed', conclusion: 'skipped' },
    ], [])).toMatchObject({ state: 'pending' });
  });

  it('blocks on any negative check or commit status', () => {
    expect(evaluateCI([
      { name: 'tests', status: 'completed', conclusion: 'success' },
      { name: 'typecheck', status: 'completed', conclusion: 'timed_out' },
    ], [])).toEqual({
      state: 'red',
      checkNames: ['tests'],
      failingChecks: ['typecheck'],
    });
    expect(evaluateCI([], [{ context: 'legacy-ci', state: 'error' }])).toMatchObject({
      state: 'red',
      failingChecks: ['legacy-ci'],
    });
  });

  it('waits when a success exists alongside a pending check', () => {
    expect(evaluateCI([
      { name: 'tests', status: 'completed', conclusion: 'success' },
      { name: 'deploy', status: 'queued', conclusion: null },
    ], [])).toMatchObject({ state: 'pending', checkNames: ['tests'] });
  });
});

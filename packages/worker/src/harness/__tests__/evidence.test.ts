import { describe, expect, it } from 'vitest';
import type { EvidenceCheck } from '@opslane/shared';
import { computeTier, createEvidenceRecorder } from '../evidence.js';

const check = (name: string, outcome: EvidenceCheck['outcome']): EvidenceCheck =>
  ({ name, outcome, command: 'cmd', output_tail: '' });

describe('computeTier', () => {
  it('is null when nothing passed', () => {
    expect(computeTier([check('build', 'failed')])).toBeNull();
  });

  it('E0 when only the build passed', () => {
    expect(computeTier([
      check('build', 'passed'),
      check('suite_post_patch', 'failed'),
    ])).toBe('E0');
  });

  it('E1 requires a recorded, comparable baseline — post-patch pass alone is only E0', () => {
    expect(computeTier([
      check('build', 'passed'),
      check('suite_post_patch', 'passed'),
    ])).toBe('E0');
  });

  it('E1 when build, recorded baseline, and post-patch suite all line up', () => {
    expect(computeTier([
      check('build', 'passed'),
      check('suite_baseline', 'failed'),
      check('suite_post_patch', 'passed'),
    ])).toBe('E1');
  });

  it('E1 reachable when the build was skipped (no build script) but baseline + suite passed', () => {
    expect(computeTier([
      check('build', 'skipped_no_runner'),
      check('suite_baseline', 'passed'),
      check('suite_post_patch', 'passed'),
    ])).toBe('E1');
  });

  it('an infra_error baseline is NOT comparable — caps at E0', () => {
    expect(computeTier([
      check('build', 'passed'),
      check('suite_baseline', 'infra_error'),
      check('suite_post_patch', 'passed'),
    ])).toBe('E0');
  });

  it('uses the LAST entry per check name (retries append)', () => {
    expect(computeTier([
      check('build', 'passed'),
      check('suite_baseline', 'passed'),
      check('suite_post_patch', 'failed'),
      check('suite_post_patch', 'passed'),
    ])).toBe('E1');
  });

  it('E2 requires red AND green AND reversal — green+reversal without red stays E1', () => {
    const e1Checks = [
      check('build', 'passed'),
      check('suite_baseline', 'passed'),
      check('suite_post_patch', 'passed'),
    ];
    expect(computeTier([
      ...e1Checks,
      check('repro_green', 'passed'),
      check('repro_reversal', 'passed'),
    ])).toBe('E1');
    expect(computeTier([
      ...e1Checks,
      check('repro_red', 'passed'),
      check('repro_green', 'passed'),
      check('repro_reversal', 'passed'),
    ])).toBe('E2');
  });

  it('infra_error is never evidence — suite infra_error caps at E0', () => {
    expect(computeTier([
      check('build', 'passed'),
      check('suite_post_patch', 'infra_error'),
    ])).toBe('E0');
  });
});

describe('createEvidenceRecorder', () => {
  it('records checks with scrubbed, bounded output tails', () => {
    const recorder = createEvidenceRecorder();
    recorder.addCheck('build', 'failed', {
      command: 'npm run build',
      exitCode: 1,
      output: `${'x'.repeat(5000)} ghp_secret123`,
    });

    const record = recorder.record();
    expect(record.version).toBe(1);
    expect(record.checks).toHaveLength(1);
    expect(record.checks[0]?.output_tail.length).toBeLessThanOrEqual(2000);
    expect(record.checks[0]?.output_tail).toContain('[REDACTED]');
    expect(record.checks[0]?.exit_code).toBe(1);
  });

  it('carries the suite comparison and computes the tier', () => {
    const recorder = createEvidenceRecorder();
    recorder.addCheck('build', 'passed', { command: 'npm run build' });
    recorder.addCheck('suite_baseline', 'failed', { command: 'vitest run' });
    recorder.addCheck('suite_post_patch', 'passed', { command: 'vitest run' });
    recorder.setSuiteComparison({ baseline_failed_tests: ['a::t1'], new_failures: [] });

    const record = recorder.record();
    expect(record.tier).toBe('E1');
    expect(record.suite?.baseline_failed_tests).toEqual(['a::t1']);
  });

  it('bounds and scrubs suite test identifiers (max 50 per list, secrets redacted)', () => {
    const recorder = createEvidenceRecorder();
    recorder.setSuiteComparison({
      baseline_failed_tests: Array.from(
        { length: 80 },
        (_, index) => `f.test.ts::t${index} ghp_leaked123`,
      ),
      new_failures: [],
    });

    const suite = recorder.record().suite!;
    expect(suite.baseline_failed_tests).toHaveLength(51);
    expect(suite.baseline_failed_tests[50]).toBe('... 30 more');
    expect(suite.baseline_failed_tests[0]).toContain('[REDACTED]');
  });
});

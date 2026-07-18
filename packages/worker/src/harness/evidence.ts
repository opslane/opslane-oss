import type { CheckOutcome, EvidenceCheck, EvidenceRecord, EvidenceTier } from '@opslane/shared';
import { scrubSecrets } from './redact.js';

const MAX_OUTPUT_TAIL = 2000;

export interface EvidenceRecorder {
  addCheck(
    name: string,
    outcome: CheckOutcome,
    opts?: { command?: string; exitCode?: number; output?: string },
  ): void;
  setSuiteComparison(comparison: {
    baseline_failed_tests: string[];
    new_failures: string[];
  }): void;
  record(): EvidenceRecord;
}

/** Compute the strongest verification tier established by the recorded checks. */
export function computeTier(checks: EvidenceCheck[]): EvidenceTier | null {
  const last = (name: string) =>
    [...checks].reverse().find((check) => check.name === name)?.outcome;

  const build = last('build');
  const baseline = last('suite_baseline');
  const suite = last('suite_post_patch');
  const e0 = build === 'passed';
  const buildOk = e0 || build === 'skipped_no_runner';
  const baselineComparable = baseline === 'passed' || baseline === 'failed';
  const e1 = buildOk && baselineComparable && suite === 'passed';
  const e2 =
    e1 &&
    last('repro_red') === 'passed' &&
    last('repro_green') === 'passed' &&
    last('repro_reversal') === 'passed';

  if (e2) return 'E2';
  if (e1) return 'E1';
  if (e0) return 'E0';
  return null;
}

export function createEvidenceRecorder(): EvidenceRecorder {
  const checks: EvidenceCheck[] = [];
  let suite: EvidenceRecord['suite'];

  return {
    addCheck(
      name: string,
      outcome: CheckOutcome,
      opts?: { command?: string; exitCode?: number; output?: string },
    ): void {
      checks.push({
        name,
        outcome,
        command: opts?.command ?? '',
        ...(opts?.exitCode !== undefined ? { exit_code: opts.exitCode } : {}),
        output_tail: scrubSecrets(opts?.output ?? '').slice(-MAX_OUTPUT_TAIL),
      });
    },
    setSuiteComparison(comparison): void {
      const boundList = (identifiers: string[]): string[] => {
        const scrubbed = identifiers
          .slice(0, 50)
          .map((identifier) => scrubSecrets(identifier).slice(0, 300));
        return identifiers.length > 50
          ? [...scrubbed, `... ${identifiers.length - 50} more`]
          : scrubbed;
      };
      suite = {
        baseline_failed_tests: boundList(comparison.baseline_failed_tests),
        new_failures: boundList(comparison.new_failures),
      };
    },
    record(): EvidenceRecord {
      return {
        version: 1,
        tier: computeTier(checks),
        checks: [...checks],
        ...(suite ? { suite } : {}),
      };
    },
  };
}

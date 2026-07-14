import { describe, it, expect } from 'vitest';
import { DEFAULT_REMEDIATION, buildReason } from '../reason-codes.js';

// Compile-time exhaustiveness is enforced by the Record<ReasonCode, string> type;
// this asserts message quality at runtime.
const ALL_CODES = Object.keys(DEFAULT_REMEDIATION);

describe('DEFAULT_REMEDIATION registry', () => {
  it('has an actionable remediation for every reason code', () => {
    expect(ALL_CODES.length).toBeGreaterThanOrEqual(22); // 21 original + low_confidence_fix
    for (const [code, remediation] of Object.entries(DEFAULT_REMEDIATION)) {
      expect(remediation.length, `${code} remediation too short`).toBeGreaterThanOrEqual(20);
      expect(remediation, `${code} has placeholder text`).not.toMatch(/TODO|FIXME|tbd/i);
    }
  });
});

describe('buildReason', () => {
  it('fills remediation from the registry when omitted', () => {
    const r = buildReason('budget_exhausted', 'Agent ran out of budget');
    expect(r.reason_code).toBe('budget_exhausted');
    expect(r.reason_message).toBe('Agent ran out of budget');
    expect(r.remediation).toBe(DEFAULT_REMEDIATION.budget_exhausted);
  });

  it('lets the caller override remediation', () => {
    const r = buildReason('tests_failed', 'msg', 'custom remediation here, long enough');
    expect(r.remediation).toBe('custom remediation here, long enough');
  });

  it('falls back to the registry message when no message is given', () => {
    const r = buildReason('low_confidence_fix');
    expect(r.reason_message.length).toBeGreaterThanOrEqual(20);
    expect(r.remediation).toBe(DEFAULT_REMEDIATION.low_confidence_fix);
  });
});

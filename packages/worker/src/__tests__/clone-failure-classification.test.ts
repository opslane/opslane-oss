import { describe, expect, it } from 'vitest';
import {
  CloneResolutionError,
  cloneFailureReason,
} from '../repo-clone.js';

describe('cloneFailureReason', () => {
  it('does not blame permissions for an empty repository', () => {
    const reason = cloneFailureReason(
      new CloneResolutionError('empty_repository', 'o/r'),
    );
    expect(reason.reason_code).toBe('empty_repository');
    expect(reason.remediation).not.toMatch(/read access|permission/i);
  });

  it('names the missing default branch and repository', () => {
    const reason = cloneFailureReason(
      new CloneResolutionError('invalid_default_branch', 'o/r', 'gone'),
    );
    expect(reason.reason_code).toBe('invalid_default_branch');
    expect(reason.reason_message).toContain('gone');
    expect(reason.reason_message).toContain('o/r');
  });

  it('keeps genuine access failures classified as access failures', () => {
    expect(
      cloneFailureReason(new Error('remote: Repository not found')).reason_code,
    ).toBe('repo_access_denied');
  });

  it('detects a missing token', () => {
    expect(
      cloneFailureReason(new Error('GITHUB_TOKEN is not set')).reason_code,
    ).toBe('missing_github_token');
  });
});

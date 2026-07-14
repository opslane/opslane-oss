import type { ReasonCode, NeedsHumanReason } from '@opslane/shared';

/**
 * Default, human-actionable remediation for every reason code.
 * The Record<ReasonCode, string> type makes this exhaustive at COMPILE TIME:
 * adding a ReasonCode to shared without an entry here is a type error.
 */
export const DEFAULT_REMEDIATION: Record<ReasonCode, string> = {
  missing_github_token:
    'Connect the GitHub App to this repository (Settings → GitHub) so Opslane can read and open PRs.',
  repo_access_denied:
    'Confirm the GitHub App is installed on this repository and has read + pull-request permissions.',
  token_decrypt_failed:
    'Re-connect the GitHub integration — the stored credential could not be decrypted.',
  auth_invalid:
    'Re-authenticate the GitHub connection; the existing token was rejected as invalid.',
  policy_blocked:
    'A repository or org policy blocked the change. Review branch-protection / app permissions, then retry.',
  missing_llm_key:
    'Set the ANTHROPIC_API_KEY environment variable on the worker with a valid Anthropic API key.',
  malformed_diff:
    'Review the error manually — the agent could not produce a valid, applicable diff.',
  verification_failed:
    'Review the candidate fix manually — Opslane could not verify it satisfied the failing behavior.',
  sourcemap_unresolved:
    'Upload source maps for this release (see the SDK build plugin) so the stack trace resolves to original source.',
  artifact_fetch_failed:
    'Retry later — Opslane could not fetch a stored artifact (screenshot/replay) needed to analyze this error.',
  insufficient_context:
    'Add a replay, breadcrumbs, or a reproduction so Opslane has enough context to investigate.',
  worker_runtime_error:
    'Review the error manually — the Opslane worker hit an unexpected internal error while processing this incident.',
  lease_lost:
    'No action needed — the job lease expired mid-run and the incident will be retried automatically.',
  budget_exhausted:
    'Review the error manually — the agent could not complete within its turn/budget limits. Consider guiding it with more context.',
  tests_failed:
    'Review the candidate diff manually — the agent produced a fix but the test suite still fails, so it may be partial or cause regressions.',
  low_confidence_fix:
    'Review the candidate diff and root-cause writeup, then apply or refine the fix manually — it did not clear the bar for an automatic PR.',
  triage_unfixable:
    'Review the error manually — triage determined it cannot be fixed with application code changes.',
  unfixable_no_app_frames:
    'Add the `crossorigin` attribute to your <script> tags (with CORS headers) and throw Error objects (not strings) so the SDK captures real stack frames.',
  unfixable_test_error:
    'No action needed — this looks like a deliberate test error thrown to exercise Opslane.',
  unfixable_third_party:
    'Review manually — the error originates entirely in third-party code, so the fix is not in your application source.',
  unfixable_infra:
    'Investigate infrastructure/network (CORS, DNS, timeouts, 5xx) — this is not an application code bug.',
  unfixable_no_sourcemap:
    'Upload source maps for this release so the minified stack trace resolves to original source, then retry.',
};

/**
 * Build a NeedsHumanReason, defaulting the message and/or remediation from the
 * registry so every needs_human writeup is consistent and actionable.
 */
export function buildReason(
  code: ReasonCode,
  message?: string,
  remediation?: string,
): NeedsHumanReason {
  return {
    reason_code: code,
    reason_message: message ?? DEFAULT_REMEDIATION[code],
    remediation: remediation ?? DEFAULT_REMEDIATION[code],
  };
}

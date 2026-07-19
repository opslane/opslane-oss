package db

import "testing"

// Stackless / no-app-frame errors are inherently unfixable by the agent. Once a
// group lands in needs_human for that reason, recurrence must NOT auto-reopen it —
// otherwise the single collapsed "Script error." group reopens forever.
func TestIsRequeueEligible_StacklessReasonCodesAreNonRetriable(t *testing.T) {
	cases := []struct {
		name       string
		status     string
		reasonCode string
		want       bool
	}{
		{"unfixable_no_app_frames is terminal", "needs_human", "unfixable_no_app_frames", false},
		{"triage_unfixable is terminal", "needs_human", "triage_unfixable", false},
		{"low_confidence_fix is terminal (preserve writeup)", "needs_human", "low_confidence_fix", false},
		{"tests_failed is terminal (preserve writeup)", "needs_human", "tests_failed", false},
		{"repro_not_achievable is terminal (preserve writeup)", "needs_human", "repro_not_achievable", false},
		{"verification_infra_error requeues", "needs_human", "verification_infra_error", true},
		{"policy_blocked still terminal", "needs_human", "policy_blocked", false},
		{"a fixable needs_human reason still requeues", "needs_human", "missing_github_token", true},
		{"resolved still requeues", "resolved", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rc := tc.reasonCode
			got := isRequeueEligible(tc.status, &rc)
			if got != tc.want {
				t.Errorf("isRequeueEligible(%q, %q) = %v, want %v", tc.status, tc.reasonCode, got, tc.want)
			}
		})
	}
}

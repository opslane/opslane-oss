<script setup lang="ts">
import type { EvidenceRecord } from '../types/api';

defineProps<{
  evidence: EvidenceRecord;
}>();

const externalOutcomeLabel: Record<NonNullable<EvidenceRecord['external_ci']>['outcome'], string> = {
  passed: 'Repository CI passed',
  failed: 'Repository CI failed',
  no_ci_observed: 'No repository CI observed',
  head_moved: 'Draft branch changed',
  permission_denied: 'Checks permission required',
};
</script>

<template>
  <div class="p-4 bg-surface border border-border rounded-lg space-y-3">
    <p class="text-xs font-medium text-text-muted uppercase tracking-wide">
      Verification evidence
      <span
        v-if="evidence.tier"
        class="ml-2 px-1.5 py-0.5 rounded bg-indigo/10 text-indigo normal-case"
        v-text="evidence.tier"
      ></span>
    </p>
    <ul class="space-y-1">
      <li
        v-for="(check, index) in evidence.checks"
        :key="index"
        class="text-sm text-text"
      >
        <span v-text="check.name"></span>:
        <span
          :class="check.outcome === 'passed' ? 'text-indigo' : check.outcome === 'failed' ? 'text-amber' : 'text-text-muted'"
          v-text="check.outcome"
        ></span>
      </li>
    </ul>
    <p
      v-if="evidence.suite && evidence.suite.baseline_failed_tests.length > 0"
      class="text-xs text-text-faint"
    >
      {{ evidence.suite.baseline_failed_tests.length }} test(s) already failed before the patch (excluded from the gate).
    </p>
    <div
      v-if="evidence.external_ci"
      class="border-t border-border pt-3 space-y-2"
    >
      <p class="text-xs font-medium text-text-muted uppercase tracking-wide">External CI</p>
      <p
        class="text-sm font-medium"
        :class="evidence.external_ci.outcome === 'passed' ? 'text-green' : evidence.external_ci.outcome === 'failed' ? 'text-red' : 'text-amber'"
        v-text="externalOutcomeLabel[evidence.external_ci.outcome]"
      ></p>
      <ul v-if="evidence.external_ci.check_names.length > 0" class="space-y-1">
        <li
          v-for="name in evidence.external_ci.check_names"
          :key="name"
          class="text-xs text-text-muted"
          v-text="name"
        ></li>
      </ul>
      <p
        v-if="evidence.external_ci.failing_checks?.length"
        class="text-xs text-red"
      >
        Failing: <span v-text="evidence.external_ci.failing_checks.join(', ')"></span>
      </p>
      <p class="text-xs text-text-faint">
        PR #{{ evidence.external_ci.pr_number }} · commit
        <span class="font-mono" v-text="evidence.external_ci.head_sha.slice(0, 8)"></span>
      </p>
    </div>
  </div>
</template>

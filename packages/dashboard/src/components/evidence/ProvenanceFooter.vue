<script setup lang="ts">
import { computed } from 'vue';
import type { EvidenceRecord } from '../../types/api';

type ExternalCi = NonNullable<EvidenceRecord['external_ci']>;
const props = defineProps<{ externalCi: ExternalCi }>();

function externalOutcomeLabel(outcome: ExternalCi['outcome']): string {
  switch (outcome) {
    case 'passed': return 'Repository CI passed';
    case 'failed': return 'Repository CI failed';
    case 'no_ci_observed': return 'No repository CI observed';
    case 'head_moved': return 'Draft branch changed';
    case 'permission_denied': return 'Checks permission required';
  }
  // An outcome the union does not know about must not render a blank heading.
  return 'Repository CI status unknown';
}

const label = computed(() => externalOutcomeLabel(props.externalCi.outcome));
</script>

<template>
  <footer class="border-t border-evidence-border pt-3 text-xs text-evidence-muted">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <strong class="font-medium text-evidence-text">{{ label }}</strong>
      <span>PR #{{ externalCi.pr_number }} · <span class="font-mono">{{ externalCi.head_sha.slice(0, 8) }}</span></span>
    </div>
    <p v-if="externalCi.check_names.length" class="mt-2">Checks: <span v-text="externalCi.check_names.join(', ')"></span></p>
    <p v-if="externalCi.failing_checks?.length" class="mt-1 text-danger">Failing: <span v-text="externalCi.failing_checks.join(', ')"></span></p>
  </footer>
</template>

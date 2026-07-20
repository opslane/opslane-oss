<script setup lang="ts">
import { computed } from 'vue';
import type { CheckOutcome, EvidenceCheck as EvidenceCheckRecord } from '../../types/api';

const props = defineProps<{ check: EvidenceCheckRecord }>();

function outcomeLabel(outcome: CheckOutcome): string {
  switch (outcome) {
    case 'passed': return 'Passed';
    case 'failed': return 'Failed';
    case 'skipped_no_runner': return 'Skipped — no runner';
    case 'infra_error': return 'Infrastructure error';
  }
  // Never render an empty outcome: an unlabelled check reads as "no result".
  return 'Unknown outcome';
}

function outcomeClass(outcome: CheckOutcome): string {
  switch (outcome) {
    case 'passed': return 'text-success';
    case 'failed': return 'text-danger';
    case 'skipped_no_runner': return 'text-evidence-muted';
    case 'infra_error': return 'text-warning';
  }
  return 'text-evidence-muted';
}

const label = computed(() => outcomeLabel(props.check.outcome));
const labelClass = computed(() => outcomeClass(props.check.outcome));
</script>

<template>
  <li class="border-b border-evidence-border py-3 last:border-b-0">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <span class="font-medium text-evidence-text" v-text="check.name"></span>
      <span class="text-xs font-semibold uppercase tracking-wide" :class="labelClass">{{ label }}</span>
    </div>
    <code v-if="check.command" class="mt-2 block select-text overflow-x-auto whitespace-pre rounded-sm bg-evidence px-3 py-2 font-mono text-xs text-evidence-muted" v-text="check.command"></code>
    <pre v-if="check.output_tail" class="mt-2 max-h-48 select-text overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-evidence-muted" v-text="check.output_tail"></pre>
  </li>
</template>

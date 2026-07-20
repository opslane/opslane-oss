<script setup lang="ts">
import type { EvidenceRecord } from '../../types/api';
import EvidenceCheck from './EvidenceCheck.vue';
import ProvenanceFooter from './ProvenanceFooter.vue';

defineProps<{ evidence: EvidenceRecord }>();
</script>

<template>
  <section class="min-w-0 rounded-md border border-evidence-border bg-evidence-surface text-evidence-text" aria-labelledby="evidence-title">
    <header class="flex flex-wrap items-center justify-between gap-2 border-b border-evidence-border px-4 py-3">
      <h2 id="evidence-title" class="text-sm font-semibold uppercase tracking-[0.12em]">Verification evidence</h2>
      <span v-if="evidence.tier" class="rounded-sm border border-evidence-border bg-evidence px-2 py-1 font-mono text-xs text-evidence-muted" v-text="evidence.tier"></span>
    </header>
    <div class="px-4 py-2">
      <ul v-if="evidence.checks.length">
        <EvidenceCheck v-for="(check, index) in evidence.checks" :key="`${check.name}-${index}`" :check="check" />
      </ul>
      <p v-if="evidence.suite?.baseline_failed_tests.length" class="border-t border-evidence-border py-3 text-xs text-evidence-muted">
        {{ evidence.suite.baseline_failed_tests.length }} pre-existing test failure(s) excluded from this gate.
      </p>
      <ProvenanceFooter v-if="evidence.external_ci" class="my-3" :external-ci="evidence.external_ci" />
    </div>
  </section>
</template>

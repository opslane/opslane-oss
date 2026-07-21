<script setup lang="ts">
// Three bullets covering the four documented terminal states: pr_created,
// pr_draft, then investigated and needs_human sharing the last bullet.
const outcomes = [
  'A ready-for-review fix PR, backed by executed verification evidence',
  'Or an opt-in draft PR, clearly labeled as not yet verified',
  'Or a root-cause analysis, or an incident with a reason code and next steps',
];
</script>

<template>
  <div class="hidden lg:flex flex-col justify-center bg-surface-subtle px-12 py-16">
    <div class="max-w-md">
      <h2 class="text-3xl font-semibold text-text leading-tight">
        Every production error gets an answer.
      </h2>
      <p class="mt-4 text-base text-muted">
        Opslane ingests browser errors from your frontend, investigates the root
        cause, and takes each one to an explicit outcome.
      </p>
      <ul class="mt-8 space-y-4">
        <li v-for="outcome in outcomes" :key="outcome" class="flex gap-3 text-sm text-muted">
          <svg class="h-5 w-5 shrink-0 text-accent" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
          </svg>
          <span>{{ outcome }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>

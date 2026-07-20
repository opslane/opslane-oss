<script setup lang="ts">
import { computed } from 'vue';
import type { ErrorGroupStatus } from '../../types/api';
import StatusLabel from '../ui/StatusLabel.vue';
import { incidentStatusRecipe } from '../../status-recipes';

const props = defineProps<{ status: ErrorGroupStatus }>();
const recipe = computed(() => incidentStatusRecipe(props.status));

const summary = computed((): string => {
  switch (props.status) {
    case 'candidate': return 'Awaiting classification.';
    case 'new': return 'Ready for investigation.';
    case 'queued': return 'Queued for investigation.';
    case 'analyzing': return 'Investigation is in progress.';
    case 'investigated': return 'Investigation is complete.';
    case 'awaiting_approval': return 'A proposed fix is waiting for approval.';
    case 'fixing': return 'A fix is being prepared.';
    case 'pr_draft': return 'A draft pull request is available.';
    case 'pr_created': return 'A pull request is ready for review.';
    case 'needs_human': return 'Human action is required.';
    case 'insight': return 'Investigation produced a product insight.';
    case 'resolved': return 'The incident is resolved.';
    case 'merged': return 'The fix has been merged.';
    case 'archived': return 'The incident is archived.';
  }
  // Unknown wire value: fall back to the recipe label rather than blank text.
  return recipe.value.label;
});
</script>

<template>
  <section aria-labelledby="lifecycle-heading" class="border-y border-border py-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 id="lifecycle-heading" class="text-xs font-semibold uppercase tracking-[0.16em] text-muted">Current state</h2>
        <p class="mt-1 text-sm text-text" v-text="summary"></p>
      </div>
      <StatusLabel :tone="recipe.tone" :label="recipe.label" />
    </div>
  </section>
</template>

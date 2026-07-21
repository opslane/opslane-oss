<script setup lang="ts">
import { computed } from 'vue';
import type { Incident } from '../../types/api';
import { formatDate } from '../../utils';
import { kindBadge } from '../incident-kind';
import { platformBadge } from '../platform-badge';
import StatusLabel from '../ui/StatusLabel.vue';
import { incidentStatusRecipe } from '../../status-recipes';

const props = defineProps<{
  incident: Incident;
  projectId: string;
}>();

const kind = computed(() => kindBadge(props.incident.kind, props.incident.adjudication_status));
const platform = computed(() => platformBadge(props.incident.platform));
const status = computed(() => incidentStatusRecipe(props.incident.status));
</script>

<template>
  <tr class="group border-b border-border last:border-b-0 hover:bg-surface-subtle">
    <td class="min-w-0 px-4 py-4 sm:px-5">
      <router-link
        :to="{ name: 'incident', params: { id: incident.id }, query: { project_id: projectId } }"
        class="block max-w-xl text-sm font-semibold leading-5 text-text decoration-accent underline-offset-4 hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        v-text="incident.title"
      />
      <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span class="font-mono" v-text="incident.fingerprint"></span>
        <span aria-hidden="true">·</span>
        <span>Last seen {{ formatDate(incident.last_seen) }}</span>
      </div>
    </td>
    <td class="hidden px-4 py-4 md:table-cell">
      <div class="flex flex-wrap items-center gap-2">
        <span class="border border-border-strong bg-surface px-2 py-1 text-xs font-medium text-muted" v-text="kind.label"></span>
        <span v-if="platform" class="border border-border bg-surface-subtle px-2 py-1 text-xs text-muted" v-text="platform.label"></span>
      </div>
    </td>
    <td class="px-4 py-4"><StatusLabel :tone="status.tone" :label="status.label" /></td>
    <td class="hidden px-4 py-4 text-right text-sm tabular-nums text-muted sm:table-cell">{{ incident.occurrence_count }}</td>
    <td class="hidden px-4 py-4 text-right text-sm tabular-nums text-muted lg:table-cell">{{ incident.affected_users_count }}</td>
    <td class="hidden px-4 py-4 text-right text-sm text-muted xl:table-cell">{{ formatDate(incident.last_seen) }}</td>
  </tr>
</template>

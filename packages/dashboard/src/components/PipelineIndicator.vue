<script setup lang="ts">
import type { ErrorGroupStatus } from '../types/api';

const props = defineProps<{
  status: ErrorGroupStatus;
}>();

const steps: { key: ErrorGroupStatus; label: string }[] = [
  { key: 'new', label: 'New' },
  { key: 'queued', label: 'Queued' },
  { key: 'analyzing', label: 'Analyzing' },
  { key: 'investigated', label: 'Investigated' },
  { key: 'fixing', label: 'Fixing' },
];

const statusIndex: Record<ErrorGroupStatus, number> = {
  candidate: -1,
  new: 0,
  queued: 1,
  analyzing: 2,
  investigated: 3,
  fixing: 4,
  awaiting_approval: 5,
  pr_created: 5,
  needs_human: 5,
  insight: 5,
  resolved: 5,
  merged: 5,
  archived: 5,
};

const terminalLabels: Partial<Record<ErrorGroupStatus, string>> = {
  awaiting_approval: 'Awaiting approval',
  pr_created: 'PR Created',
  needs_human: 'Needs Human',
  insight: 'Insight',
  resolved: 'Resolved',
  merged: 'Merged',
  archived: 'Archived',
};

function stepClass(stepIdx: number): string {
  const currentIdx = statusIndex[props.status] ?? 0;
  if (stepIdx < currentIdx) return 'bg-teal text-background';
  if (stepIdx === currentIdx) return 'bg-teal text-background ring-2 ring-teal/30';
  return 'bg-surface-2 text-text-faint';
}

function connectorClass(stepIdx: number): string {
  const currentIdx = statusIndex[props.status] ?? 0;
  return stepIdx < currentIdx ? 'bg-teal' : 'bg-surface-2';
}
</script>

<template>
  <div class="flex items-center gap-0">
    <template v-for="(step, i) in steps" :key="step.key">
      <div class="flex flex-col items-center">
        <div
          class="h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-medium transition-colors"
          :class="stepClass(i)"
        >
          {{ i + 1 }}
        </div>
        <span class="mt-1 text-[10px] text-text-faint whitespace-nowrap" v-text="step.label"></span>
      </div>
      <div
        v-if="i < steps.length - 1"
        class="h-0.5 w-6 -mt-4 transition-colors"
        :class="connectorClass(i)"
      ></div>
    </template>
    <!-- Terminal status -->
    <div
      v-if="terminalLabels[status]"
      class="flex flex-col items-center ml-0"
    >
      <div class="h-0.5 w-6 -mt-4 transition-colors" :class="statusIndex[status] >= 5 ? 'bg-teal' : 'bg-surface-2'"></div>
    </div>
    <div
      v-if="terminalLabels[status]"
      class="flex flex-col items-center"
    >
      <div
        class="h-6 px-2 rounded-full flex items-center justify-center text-[10px] font-medium ring-2"
        :class="status === 'needs_human' ? 'bg-amber text-background ring-amber/30' : 'bg-teal text-background ring-teal/30'"
      >
        {{ terminalLabels[status] }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { AdminHourlyEventBucket } from '../types/api';

const props = defineProps<{ buckets: AdminHourlyEventBucket[] }>();

const hourLabelFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  timeZone: 'UTC',
});

const width = 960;
const height = 190;
const chartTop = 12;
const chartBottom = 34;
const chartHeight = height - chartTop - chartBottom;
const maxCount = computed(() => Math.max(1, ...props.buckets.map((bucket) => bucket.count)));

const bars = computed(() => {
  const slotWidth = width / Math.max(1, props.buckets.length);
  return props.buckets.map((bucket, index) => {
    const scaledHeight = (bucket.count / maxCount.value) * chartHeight;
    return {
      ...bucket,
      x: index * slotWidth + 2,
      y: chartTop + chartHeight - Math.max(1, scaledHeight),
      width: Math.max(1, slotWidth - 4),
      height: Math.max(1, scaledHeight),
      label: hourLabelFormat.format(new Date(bucket.hour)),
    };
  });
});
</script>

<template>
  <svg
    :viewBox="`0 0 ${width} ${height}`"
    class="block h-48 w-full"
    role="img"
    aria-label="Events ingested per hour over the last 48 hours"
  >
    <line
      x1="0"
      :y1="chartTop + chartHeight"
      :x2="width"
      :y2="chartTop + chartHeight"
      class="stroke-border"
    />
    <g v-for="(bar, index) in bars" :key="bar.hour">
      <rect
        :x="bar.x"
        :y="bar.y"
        :width="bar.width"
        :height="bar.height"
        rx="2"
        class="fill-accent/70 hover:fill-accent"
      >
        <title>{{ bar.label }} UTC: {{ bar.count.toLocaleString() }} events</title>
      </rect>
      <text
        v-if="index % 6 === 0"
        :x="bar.x"
        :y="height - 8"
        class="fill-muted text-[10px]"
      >
        {{ bar.label }}
      </text>
    </g>
  </svg>
</template>

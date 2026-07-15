<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { Replayer } from 'rrweb';
import type { eventWithTime } from '@rrweb/types';
import 'rrweb/dist/style.css';
import { crashSeekMs, ensureReplayMeta, formatTime, replayDurationMs, sortedReplayEvents } from './replay-utils';

const props = defineProps<{
  events: eventWithTime[];
  crashTimestamp?: number;
}>();

const SPEEDS = [1, 2, 4, 8];

const containerRef = ref<HTMLDivElement | null>(null);
const replayer = ref<Replayer | null>(null);
const currentTime = ref(0);
const duration = ref(0);
const isPlaying = ref(false);
const speed = ref(1);
const showSpeedMenu = ref(false);
let timer: ReturnType<typeof setInterval> | null = null;

function buildPlayer() {
  if (!containerRef.value || !props.events || props.events.length === 0) return;
  containerRef.value.innerHTML = '';

  const events = ensureReplayMeta(sortedReplayEvents(props.events));
  const r = new Replayer(events, {
    root: containerRef.value,
    skipInactive: false,
    showWarning: false,
    blockClass: 'rr-block',
    mouseTail: false,
    speed: speed.value,
  });

  replayer.value = r;
  const metaTotal = r.getMetaData().totalTime;
  duration.value = Math.max(0, (metaTotal > 0 ? metaTotal : replayDurationMs(events)) / 1000);

  const seekMs = crashSeekMs(events, props.crashTimestamp);
  r.pause(seekMs);
  currentTime.value = seekMs / 1000;

  timer = setInterval(() => {
    const rp = replayer.value;
    if (rp && isPlaying.value) {
      const t = Math.max(0, (rp.getCurrentTime() || 0) / 1000);
      if (!Number.isNaN(t)) currentTime.value = t;
      if (t >= duration.value) isPlaying.value = false;
    }
  }, 100);
}

function destroyPlayer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (replayer.value) {
    try {
      replayer.value.pause();
      replayer.value.destroy();
    } catch {
      // rrweb may already be torn down during route changes.
    }
    replayer.value = null;
  }
  if (containerRef.value) containerRef.value.innerHTML = '';
}

function play() {
  const r = replayer.value;
  if (!r) return;
  r.play(Math.max(0, r.getCurrentTime()));
  isPlaying.value = true;
}

function pause() {
  const r = replayer.value;
  if (!r) return;
  r.pause();
  currentTime.value = Math.max(0, r.getCurrentTime() / 1000);
  isPlaying.value = false;
}

function seek(seconds: number) {
  const r = replayer.value;
  if (!r) return;
  const clamped = Math.min(Math.max(0, seconds), duration.value);
  r.pause(clamped * 1000);
  isPlaying.value = false;
  currentTime.value = clamped;
}

function jumpToCrash() {
  seek(crashSeekMs(sortedReplayEvents(props.events), props.crashTimestamp) / 1000);
}

function setSpeed(s: number) {
  speed.value = s;
  showSpeedMenu.value = false;
  replayer.value?.setConfig({ speed: s });
}

onMounted(buildPlayer);
onUnmounted(destroyPlayer);

watch(
  () => props.events,
  () => {
    destroyPlayer();
    buildPlayer();
  }
);
</script>

<template>
  <div class="space-y-3">
    <div ref="containerRef" class="replay-container bg-black/5 rounded-lg overflow-hidden" />
    <div class="flex flex-wrap items-center gap-3">
      <button class="btn-secondary text-sm" :disabled="!replayer" @click="isPlaying ? pause() : play()">
        {{ isPlaying ? 'Pause' : 'Play' }}
      </button>
      <button class="btn-secondary text-sm" :disabled="!replayer" @click="jumpToCrash">
        Jump to crash
      </button>
      <div class="relative">
        <button class="btn-secondary text-sm" :disabled="!replayer" @click="showSpeedMenu = !showSpeedMenu">
          {{ speed }}x
        </button>
        <div v-if="showSpeedMenu" class="absolute bottom-full mb-1 bg-surface border border-border rounded-lg py-1">
          <button
            v-for="s in SPEEDS"
            :key="s"
            class="block w-full px-3 py-1 text-sm text-left hover:bg-border/30"
            :class="{ 'font-semibold': s === speed }"
            @click="setSpeed(s)"
          >
            {{ s }}x
          </button>
        </div>
      </div>
      <input
        type="range"
        class="min-w-48 flex-1"
        :min="0"
        :max="duration"
        :step="0.1"
        :value="currentTime"
        :disabled="!replayer"
        @input="seek(parseFloat(($event.target as HTMLInputElement).value))"
      />
      <span class="text-sm text-text-muted min-w-[96px] text-right">
        {{ formatTime(currentTime) }} / {{ formatTime(duration) }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.replay-container {
  min-height: 360px;
}

.replay-container :deep(iframe) {
  width: 100%;
  border: 0;
}
</style>

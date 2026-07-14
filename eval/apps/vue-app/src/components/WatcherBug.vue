<script setup lang="ts">
import { ref, watch, reactive, onMounted, onUnmounted } from 'vue';

const count = ref(0);
const message = ref('');

// Deep watcher state
const mode = reactive<{ level: number; config: { nested: { value: string | null } } }>({
  level: 1,
  config: { nested: { value: 'default' } },
});
const deepWatchResult = ref<string | null>(null);
const deepWatchError = ref<string | null>(null);

// Timer state
const timerTicks = ref(0);
const timerError = ref<string | null>(null);
let timerId: ReturnType<typeof setInterval> | null = null;

watch(count, (newVal) => {
  if (newVal > 10) {
    message.value = 'Count exceeds limit';
  } else if (newVal < 0) {
    message.value = 'Count is negative';
  } else {
    message.value = '';
  }
});

// Deep watcher — checks for null before calling .toString()
watch(
  () => mode.level,
  (newLevel) => {
    if (newLevel > 1) {
      const val = mode.config.nested.value;
      if (val !== null) {
        deepWatchResult.value = val.toString().toUpperCase();
      } else {
        deepWatchResult.value = 'NULL';
      }
      deepWatchError.value = null;
    }
  },
);

function increment() {
  count.value++;
}

function decrement() {
  count.value--;
}

function toggleMode() {
  mode.config.nested.value = null;
  mode.level++;
}

// Timer — checks for null before accessing .status
function startTimer() {
  if (timerId !== null) return;
  let ticks = 0;
  timerId = setInterval(() => {
    ticks++;
    timerTicks.value = ticks;
    if (ticks >= 3) {
      const staleRef: { connection?: { status: string } } = {};
      if (staleRef.connection) {
        console.log('Timer health check:', staleRef.connection.status);
      } else {
        console.log('Timer health check: no connection');
      }
    }
  }, 100);
}

onMounted(() => {
  // Timer does NOT auto-start — started via button
});

onUnmounted(() => {
  if (timerId !== null) clearInterval(timerId);
});
</script>

<template>
  <div class="watcher-bug">
    <span data-testid="count">{{ count }}</span>
    <button data-testid="increment" @click="increment">+</button>
    <button data-testid="decrement" @click="decrement">-</button>
    <span v-if="message" data-testid="message">{{ message }}</span>
    <button data-testid="toggle-mode" @click="toggleMode">Toggle Mode</button>
    <span v-if="deepWatchResult" data-testid="deep-watch-result">{{ deepWatchResult }}</span>
    <span v-if="deepWatchError" data-testid="deep-watch-error">{{ deepWatchError }}</span>
    <button data-testid="start-timer" @click="startTimer">Start Timer</button>
    <span data-testid="timer-ticks">{{ timerTicks }}</span>
    <span v-if="timerError" data-testid="timer-error">{{ timerError }}</span>
  </div>
</template>

<script setup lang="ts">
/**
 * Batch 4 manual dogfood controls (issue #56).
 *
 * Rage target: a visibly dead button — clicks change nothing and trigger no
 * request, so three fast clicks produce one rage_click signal.
 * Stepper: every click is answered by a real fetch within the response
 * window, so it must never produce a signal.
 *
 * The synthetic user select drives SDK identity so an operator can replay
 * the five-distinct-users scenario without touching browser storage. The
 * run id banner ties screenshots to the evidence manifest.
 */
import { ref } from 'vue';
import { setUser } from '@opslane/sdk';

const runId = ref(`dogfood-${new Date().toISOString().slice(0, 10)}`);
const syntheticUser = ref('batch4-user-1');
const users = ['batch4-user-1', 'batch4-user-2', 'batch4-user-3', 'batch4-user-4', 'batch4-user-5'];
const stepperStep = ref(0);
const stepperBusy = ref(false);

function applyUser(): void {
  setUser({ id: syntheticUser.value, email: `${syntheticUser.value}@example.test` });
}

function deadClick(): void {
  // Intentionally and TOTALLY inert. The analyzer treats any DOM mutation
  // within 1s of a click as "answered" (the page responded), so even a
  // click counter would disqualify the rage signal. Nothing may change here.
}

async function stepperNext(): Promise<void> {
  if (stepperBusy.value) return;
  stepperBusy.value = true;
  try {
    // A real network response within the SDK's response window: this click
    // is "answered" and must never count as friction.
    await fetch(`/api/stepper-step?step=${stepperStep.value + 1}`).catch(() => undefined);
    stepperStep.value += 1;
  } finally {
    stepperBusy.value = false;
  }
}
</script>

<template>
  <div data-testid="friction-lab">
    <h2>Friction Lab</h2>
    <p data-testid="friction-run-id">Run: {{ runId }}</p>

    <fieldset>
      <legend>Synthetic user</legend>
      <select v-model="syntheticUser" data-testid="friction-user-select">
        <option v-for="u in users" :key="u" :value="u">{{ u }}</option>
      </select>
      <button data-testid="friction-user-apply" @click="applyUser">Sign in as user</button>
    </fieldset>

    <fieldset>
      <legend>Rage target (dead button)</legend>
      <!-- Realistic identity: the SDK derives the signal selector from this
           element, and the adjudicator (a real model) reads it as evidence.
           Test-flavored selectors read as synthetic and get rejected. -->
      <button id="complete-purchase" class="checkout-cta" @click="deadClick">
        Complete purchase
      </button>
      <p>Click it three times fast — nothing will happen. That is the point.</p>
    </fieldset>

    <fieldset>
      <legend>Stepper (healthy control)</legend>
      <button data-testid="friction-stepper-next" :disabled="stepperBusy" @click="stepperNext">
        Next step
      </button>
      <p data-testid="friction-stepper-step">Step: {{ stepperStep }}</p>
      <p>Each click gets a real response; this must never become an incident.</p>
    </fieldset>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const diagnosticsResult = ref<string | null>(null);
const configResult = ref<string | null>(null);
const diagnosticsError = ref<string | null>(null);
const configError = ref<string | null>(null);

function checkPermissions(depth: number): boolean {
  console.log('[Diagnostics] Checking permissions at depth', depth);
  return verifyAccess(depth);
}

function verifyAccess(depth: number): boolean {
  console.log('[Diagnostics] Verifying access at depth', depth);
  return true;
}

function runDiagnostics() {
  try {
    const result = checkPermissions(0);
    diagnosticsResult.value = result ? 'Diagnostics passed' : 'Diagnostics failed';
    diagnosticsError.value = null;
  } catch (err: unknown) {
    diagnosticsError.value = err instanceof Error ? err.message : String(err);
  }
}

function parseConfig() {
  try {
    const raw = '{"feature":"dark_mode","enabled":true}';
    const config = JSON.parse(raw);
    configResult.value = `Config loaded: ${config.feature}`;
    configError.value = null;
  } catch (err: unknown) {
    configError.value = err instanceof Error ? err.message : String(err);
  }
}
</script>

<template>
  <div data-testid="app-home">
    <button data-testid="run-diagnostics-btn" @click="runDiagnostics">Run Diagnostics</button>
    <button data-testid="parse-config-btn" @click="parseConfig">Parse Config</button>
    <p v-if="diagnosticsResult" data-testid="diagnostics-result">{{ diagnosticsResult }}</p>
    <p v-if="diagnosticsError" data-testid="diagnostics-error">{{ diagnosticsError }}</p>
    <p v-if="configResult" data-testid="config-result">{{ configResult }}</p>
    <p v-if="configError" data-testid="config-error">{{ configError }}</p>
  </div>
</template>

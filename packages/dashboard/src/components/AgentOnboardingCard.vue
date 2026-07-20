<script setup lang="ts">
import { buildAgentPrompt } from '../agent-onboarding';
import CopyButton from './CopyButton.vue';

const props = defineProps<{ origin: string }>();
const prompt = buildAgentPrompt(props.origin);
</script>

<template>
  <div class="rounded-lg border border-border bg-surface-subtle p-4 text-left">
    <div class="mb-2 flex items-center justify-between">
      <p class="text-sm font-medium text-text">Let your agent do it</p>
      <CopyButton :text="prompt" />
    </div>
    <p class="mb-3 text-xs text-muted">
      Paste this into Claude Code or Codex — it signs you up, gets an API key, and
      installs the SDK. You approve one GitHub authorization step.
    </p>
    <code class="block whitespace-pre-wrap break-words rounded border border-border bg-background p-3 text-xs text-muted">{{ prompt }}</code>
  </div>
</template>

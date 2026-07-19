# Agent Onboarding PR 4 — Dashboard Cards Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add the "Let your agent do it" card to `Login.vue` and SetupWizard Step 1, flag-off by default (design decision 13 — PR 7 flips it on), with the one-liner templated for self-hosted origins (F15).

**Architecture:** One shared module (`agent-onboarding.ts`) exports the prompt builder and a build-time flag const; one presentational component (`AgentOnboardingCard.vue`) rendered behind `v-if` in both views. No router changes, no new views, no flag infrastructure (none exists in the dashboard — a const flipped by the activation PR is the whole mechanism).

**Tech Stack:** Vue 3 `<script setup>`, Tailwind tokens from `src/style.css`, vitest + @vue/test-utils (jsdom per-file).

**Context you need:**
- Design doc v5: PR 4 section, decision 13, F15/R4 (origin prefix), F17 ("one GitHub authorization step", never "one click").
- `packages/dashboard/src/views/Login.vue` — 32 lines, single centered `max-w-sm` card (`bg-surface rounded-lg border border-border p-8`); the card goes below the sign-in button inside that card, after an "or" divider.
- `packages/dashboard/src/views/SetupWizard.vue` — Step 1 template is lines ~213-256 (`<div v-if="step === 1">`); the card goes after the "Skip for now" button inside the `v-else` (not-installed) block AND after the Continue button in the installed block? **No — one placement only:** at the bottom of the Step 1 `<div>`, outside the installed/not-installed branches, so it shows in both states.
- `src/components/CopyButton.vue` takes a single prop `text: string`.
- Tokens: `bg-surface`, `bg-surface-2`, `border-border`, `text-text`, `text-text-muted`, `text-teal`; component classes `.btn-primary`/`.btn-secondary` exist in `style.css`.
- Dashboard is served same-origin by ingestion → `window.location.origin` IS the API origin (pattern precedent: `InvitationsPanel.vue:37`).
- Component-test pattern: `// @vitest-environment jsdom` + `mount` from `@vue/test-utils` — copy `src/components/__tests__/pipeline-indicator.test.ts`. `pnpm --filter @opslane/dashboard test` runs vitest; build is `vue-tsc && vite build`.
- The one-liner (design doc §The one-liner) references `https://docs.opslane.com/agent.md` — fine to embed now; the card is flag-off until PR 7, which only merges once that URL is live.

---

## Task 1: `agent-onboarding.ts` — prompt builder + flag

**Files:** Create `packages/dashboard/src/agent-onboarding.ts`, `packages/dashboard/src/agent-onboarding.test.ts`.

**Step 1: Failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { AGENT_ONBOARDING_ENABLED, buildAgentPrompt, HOSTED_ORIGINS } from './agent-onboarding';

describe('buildAgentPrompt', () => {
  it('emits the bare prompt on hosted origins', () => {
    for (const origin of HOSTED_ORIGINS) {
      const p = buildAgentPrompt(origin);
      expect(p).not.toContain('OPSLANE_API_URL');
      expect(p).toContain('docs.opslane.com/agent.md');
      expect(p).toContain('npx -y @opslane/cli setup --start');
    }
  });
  it('prefixes OPSLANE_API_URL on self-hosted origins', () => {
    const p = buildAgentPrompt('http://localhost:8082');
    expect(p.startsWith('OPSLANE_API_URL=http://localhost:8082 — ')).toBe(true);
  });
  it('normalizes the origin it embeds', () => {
    expect(buildAgentPrompt('HTTP://MyHost:80/x')).toContain('OPSLANE_API_URL=http://myhost');
  });
  it('ships flag-off until the activation PR', () => {
    expect(AGENT_ONBOARDING_ENABLED).toBe(false);
  });
});
```

**Step 2:** `pnpm --filter @opslane/dashboard test` → FAIL.

**Step 3: Implement**

```ts
/**
 * Agent-first onboarding card (design doc: 2026-07-18-agent-first-onboarding-design.md).
 * AGENT_ONBOARDING_ENABLED is the dark-launch switch (decision 13): it ships
 * false and is flipped to true by the activation PR (PR 7) once the CLI is on
 * npm and docs.opslane.com/agent.md is live. There is deliberately no runtime
 * flag system — a one-line diff is the mechanism.
 */
export const AGENT_ONBOARDING_ENABLED = false;

export const HOSTED_ORIGINS = ['https://api.opslane.com', 'https://app.opslane.com'];

const PROMPT =
  'Set up Opslane error monitoring in this repo. Fetch https://docs.opslane.com/agent.md ' +
  'and follow it exactly: run `npx -y @opslane/cli setup --start` to create an account and ' +
  'get an API key (I\'ll complete one GitHub authorization step when you show me the link), ' +
  'then install `@opslane/sdk` and verify the first event arrives.';

/** Self-hosted dashboards prefix the API origin so the agent targets THIS
 *  server, not hosted Opslane (F15). The dashboard is served same-origin by
 *  ingestion, so window.location.origin is the API origin. */
export function buildAgentPrompt(origin: string): string {
  const normalized = new URL(origin).origin.toLowerCase();
  if (HOSTED_ORIGINS.includes(normalized)) return PROMPT;
  return `OPSLANE_API_URL=${normalized} — ${PROMPT}`;
}
```

**Step 4:** Test → PASS. **Step 5:** Commit: `feat(dashboard): agent onboarding prompt builder behind dark-launch flag`

---

## Task 2: `AgentOnboardingCard.vue`

**Files:** Create `packages/dashboard/src/components/AgentOnboardingCard.vue`, `packages/dashboard/src/components/__tests__/agent-onboarding-card.test.ts`.

**Step 1: Failing test**

```ts
// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import AgentOnboardingCard from '../AgentOnboardingCard.vue';

describe('AgentOnboardingCard', () => {
  it('renders the prompt for the given origin with a copy button', () => {
    const wrapper = mount(AgentOnboardingCard, { props: { origin: 'http://localhost:8082' } });
    expect(wrapper.text()).toContain('Let your agent do it');
    expect(wrapper.text()).toContain('OPSLANE_API_URL=http://localhost:8082');
    expect(wrapper.text()).toContain('npx -y @opslane/cli setup --start');
    expect(wrapper.findComponent({ name: 'CopyButton' }).props('text')).toContain('npx -y @opslane/cli');
    // Wording contract (F17): an authorization step, never "one click".
    expect(wrapper.text()).not.toMatch(/one click/i);
  });
});
```

**Step 2:** FAIL. **Step 3: Implement**

```vue
<script setup lang="ts">
import CopyButton from './CopyButton.vue';
import { buildAgentPrompt } from '../agent-onboarding';

const props = defineProps<{ origin: string }>();
const prompt = buildAgentPrompt(props.origin);
</script>

<template>
  <div class="rounded-lg border border-border bg-surface-2 p-4 text-left">
    <div class="flex items-center justify-between mb-2">
      <p class="text-sm font-medium text-text">Let your agent do it</p>
      <CopyButton :text="prompt" />
    </div>
    <p class="text-xs text-text-muted mb-3">
      Paste this into Claude Code or Codex — it signs you up, gets an API key, and
      installs the SDK. You approve one GitHub authorization step.
    </p>
    <code class="block whitespace-pre-wrap break-words rounded bg-background border border-border-subtle p-3 text-xs text-text-muted">{{ prompt }}</code>
  </div>
</template>
```

**Step 4:** PASS. **Step 5:** Commit: `feat(dashboard): AgentOnboardingCard component`

---

## Task 3: Wire into `Login.vue` and `SetupWizard.vue` (flag-off)

**Files:** Modify `packages/dashboard/src/views/Login.vue`, `packages/dashboard/src/views/SetupWizard.vue`.

**Step 1: Login.vue.** In `<script setup>` add:

```ts
import AgentOnboardingCard from '../components/AgentOnboardingCard.vue';
import { AGENT_ONBOARDING_ENABLED } from '../agent-onboarding';
const agentCardEnabled = AGENT_ONBOARDING_ENABLED;
const origin = window.location.origin;
```

In the template, after the sign-in `<button>` (inside the same card `div`):

```vue
      <template v-if="agentCardEnabled">
        <div class="my-6 flex items-center gap-3">
          <div class="h-px flex-1 bg-border"></div>
          <span class="text-xs text-text-faint">or</span>
          <div class="h-px flex-1 bg-border"></div>
        </div>
        <AgentOnboardingCard :origin="origin" />
      </template>
```

**Step 2: SetupWizard.vue.** Same imports; at the END of the Step 1 block (after the `v-else` div, still inside `<div v-if="step === 1">`):

```vue
          <div v-if="agentCardEnabled" class="mt-6">
            <p class="text-xs text-text-muted mb-2">Prefer your terminal?</p>
            <AgentOnboardingCard :origin="origin" />
          </div>
```

**Step 3: Flag-off render test.** Add `packages/dashboard/src/views/__tests__/login-agent-card.test.ts` (jsdom): mount `Login.vue`; with the shipped flag value (false), assert the text does NOT contain "Let your agent do it". (This pins the dark launch — the test flips when PR 7 flips the const, which is intentional and PR 7 updates it.)

**Step 4:** `pnpm --filter @opslane/dashboard build && pnpm --filter @opslane/dashboard test` → PASS (build proves `vue-tsc` is happy; unused-component warnings acceptable only if vue-tsc is silent).

**Step 5:** Visual check (flag flipped locally, not committed): temporarily set the const to `true`, `docker compose up -d` + `pnpm --filter @opslane/dashboard dev`, eyeball `/login` and `/setup` step 1, flip back. State in the commit message that the visual check was done.

**Step 6:** Commit: `feat(dashboard): agent onboarding cards on login + setup wizard (flag-off)`

## Handoff note for PR 7

Activation flips exactly one line (`AGENT_ONBOARDING_ENABLED = true`), updates the flag-off render test to flag-on expectations, and re-runs the visual check — record this in the PR 7 checklist.

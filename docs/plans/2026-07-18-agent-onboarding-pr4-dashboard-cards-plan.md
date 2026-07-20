# Agent Onboarding PR 4 — Dashboard Cards Implementation Plan

> **Execution:** Execute task-by-task with a commit per task (Claude: use the `superpowers:executing-plans` sub-skill; Codex/other executors: follow the same task-by-task flow — the sub-skill is not required).

> **Status:** Revised after round-4 review (3 P1, 1 P2, all plan-scoped). Enabled-state integration tests, correct self-hosted-origin visual check, and Step 1 installed-state clarification folded in below.

**Goal:** Add the "Let your agent do it" card to `Login.vue` and SetupWizard Step 1, flag-off by default (design decision 13 — PR 7 flips it on), with the one-liner templated for self-hosted origins (F15).

**Architecture:** One shared module (`agent-onboarding.ts`) exports the prompt builder and a build-time flag const; one presentational component (`AgentOnboardingCard.vue`) rendered behind `v-if` in both views. No router changes, no new views, no flag infrastructure (none exists in the dashboard — a const flipped by the activation PR is the whole mechanism).

**Tech Stack:** Vue 3 `<script setup>`, Tailwind tokens from `src/style.css`, vitest + @vue/test-utils (jsdom per-file).

**Context you need:**
- Design doc v5: PR 4 section, decision 13, F15/R4 (origin prefix), F17 ("one GitHub authorization step", never "one click").
- `packages/dashboard/src/views/Login.vue` — 32 lines, single centered `max-w-sm` card (`bg-surface rounded-lg border border-border p-8`); the card goes below the sign-in button inside that card, after an "or" divider.
- `packages/dashboard/src/views/SetupWizard.vue` — Step 1 template is lines ~213-256 (`<div v-if="step === 1">`). **Placement + coverage (R4-3):** the card goes at the bottom of the Step 1 `<div>`. Note that `onMounted` **auto-advances to Step 2 when GitHub is already installed** (`SetupWizard.vue:50-54`), so in practice Step 1 only renders in the *loading* and *not-installed* states — which is exactly when the terminal alternative is useful. Do NOT claim the card shows in the installed state; installed users never see Step 1. If installed users must also see it, that's a separate change to the auto-advance/placement and is out of scope here.
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

**Step 3: Wiring integration tests (R4-1).** A flag-off-only render test is insufficient — it passes even if the card is never imported or is placed wrong, and it duplicates Task 1's default-off unit assertion. Instead, prove the wiring in both states with a partial mock of the flag module. Add `packages/dashboard/src/views/__tests__/agent-card-wiring.test.ts` (jsdom):

```ts
// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, it, expect, vi } from 'vitest';

// Partial-mock only the flag; keep the real buildAgentPrompt.
vi.mock('../../agent-onboarding', async (orig) => ({
  ...(await orig<typeof import('../../agent-onboarding')>()),
  AGENT_ONBOARDING_ENABLED: true,
}));

import Login from '../Login.vue';
import SetupWizard from '../SetupWizard.vue';

describe('agent card wiring (flag enabled)', () => {
  it('Login renders the divider and card', () => {
    const w = mount(Login);
    expect(w.findComponent({ name: 'AgentOnboardingCard' }).exists()).toBe(true);
    expect(w.text()).toContain('Let your agent do it');
  });

  it('SetupWizard Step 1 (not installed) renders the card', async () => {
    // getGitHubAppStatus is async in onMounted; stub it to "not installed"
    // so the wizard stays on Step 1. Mock ../../api accordingly.
    const w = mount(SetupWizard);
    await flushPromises(); // import { flushPromises } from '@vue/test-utils'
    expect(w.findComponent({ name: 'AgentOnboardingCard' }).exists()).toBe(true);
  });
});
```

Stub `../../api` (`getGitHubAppStatus` → `{ installed: false, install_url: '...' }`, plus whatever else `onMounted` calls) so the wizard remains on Step 1; assert the card mounts. The **default-off** guarantee stays as the unit assertion in Task 1 (`AGENT_ONBOARDING_ENABLED === false`) — not duplicated here. These integration tests are flag-agnostic in intent: PR 7 flips the shipped const and only Task 1's unit expectation changes; these keep passing.

**Step 4:** `pnpm --filter @opslane/dashboard build && pnpm --filter @opslane/dashboard test` → PASS (build proves `vue-tsc` is happy; unused-component warnings acceptable only if vue-tsc is silent).

**Step 5: Visual acceptance (R4-2, R4-4) — flag flipped locally, not committed.** The card reads `window.location.origin`, so it MUST be viewed through the **same-origin production path**, not the Vite dev server: `pnpm --filter @opslane/dashboard build`, then `docker compose up -d` and open the ingestion-served dashboard (its own origin, e.g. `http://localhost:8082`). Do NOT use `pnpm dev` for this check — Vite serves on `:3000` and proxies only `/api` + `/auth/*` (`vite.config.ts`), so the card would render `OPSLANE_API_URL=http://localhost:3000`, which is not the API origin and would ship a broken prompt. (If a dev-server check is ever wanted, add an explicit API-origin override prop rather than trusting `window.location.origin` under Vite.)

Acceptance checks (verify the copied value, not just appearance):
- **Clipboard content is exact:** click Copy, paste, confirm the prompt matches `buildAgentPrompt(<ingestion origin>)` character-for-character — including that on this self-hosted origin it is prefixed `OPSLANE_API_URL=http://localhost:8082 — …`.
- **Layout:** `/login` and `/setup` (Step 1, not-installed) at mobile (~375px) and desktop widths, in both light and dark themes; the long prompt wraps with **no horizontal overflow** inside the `max-w-sm` (Login) / `max-w-lg` (wizard) card.
- Per the workspace visual-task contract, run `$visual-verdict` during iteration and record the verdict in the commit message; flip the const back to `false` before committing.

**Step 6:** Commit: `feat(dashboard): agent onboarding cards on login + setup wizard (flag-off)`

## Handoff note for PR 7

Activation flips exactly one line (`AGENT_ONBOARDING_ENABLED = true`), updates the flag-off render test to flag-on expectations, and re-runs the visual check — record this in the PR 7 checklist.

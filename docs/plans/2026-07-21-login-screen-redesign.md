# Login Screen Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild the dashboard login screen as a split-screen layout with branded social buttons, a "Last used" method badge, and a password visibility toggle — and fix a wrong-brand icon bug on the generic IdP button.

**Architecture:** All changes are confined to `packages/dashboard`. The auth state machine (`useLoginFlow.ts`) is deliberately **not** modified: every "last used" write happens in `Login.vue`, which already owns each point of user intent, so no persistence side effect is hidden inside the state machine. A new `useLastAuthMethod` composable wraps `localStorage` with total failure tolerance. Provider→icon mapping lives in the renderer as an exhaustive `Record`, so adding a provider becomes a compile error until an icon exists.

**Tech Stack:** Vue 3 (`<script setup>`, Composition API), TypeScript (strict), Tailwind CSS with CSS-variable design tokens, Vitest + `@vue/test-utils` (jsdom), Playwright for E2E.

---

## Context you need before starting

You are working in `packages/dashboard`, a Vue 3 app served by the Go ingestion
service. Read `packages/dashboard/AGENTS.md` first.

**Conventions that are easy to get wrong here:**

1. **Test file location differs by directory.** Component tests go in
   `src/components/__tests__/*.test.ts`. Composable tests are **flat and
   colocated**: `src/composables/useLoginFlow.test.ts`, not in a `__tests__`
   subfolder. Follow the neighbours in whichever directory you are in.
2. **Component tests need a jsdom pragma.** Put `// @vitest-environment jsdom` as
   the literal first line of the file. See
   `src/components/__tests__/agent-onboarding-card.test.ts`.
3. **Never hardcode colours.** The theme is token-driven through
   `src/styles/theme.css` (`--color-accent`, `--color-surface-subtle`, etc.). Any
   hex literal breaks dark mode. Use only existing Tailwind token classes:
   `bg-background`, `bg-surface`, `bg-surface-subtle`, `text-text`, `text-muted`,
   `text-faint`, `text-accent`, `border-border`, `border-border-strong`.
4. **`localStorage` throws.** In Safari private mode and some embedded webviews,
   even *reading* it raises. A login screen is the worst possible place for an
   unhandled exception, because it locks the user out entirely.
5. **Test files are type-checked by the build.** `tsconfig.json` has
   `include: ["src/**/*.ts", "src/**/*.vue", ...]` and the build script is
   `vue-tsc && vite build`. Your `.test.ts` files live under `src/`, so they are
   compiled by `vue-tsc`. A loosely-typed test helper passes `vitest run` and
   then fails `pnpm build`. `noUnusedLocals: true` is also on, so an unused
   import is a build error, not a warning.

**Domain glossary:** "social login" = Google/GitHub OAuth buttons.
"redirect mode" = the deployment has no password auth, so the whole page is a
single button to a hosted identity provider (`/auth/login`). Per `README.md`,
that provider is GitHub OAuth by default but can be WorkOS.

**Verify your environment before Task 1:**

```bash
cd /Users/abhishekray/orca/workspaces/opslane-oss/imporve-login
pnpm --filter @opslane/dashboard test
```
Expected: all tests pass. If they don't, stop — you have a pre-existing problem.

---

## Why this work exists

**The bug:** `Login.vue:91-93` renders the GitHub octocat next to a button
labelled "Continue to sign in". That button targets `/auth/login`, the generic
hosted-IdP redirect. `README.md` documents `AUTH_PROVIDER=workos` as a supported
configuration — so on a WorkOS deployment we currently show a GitHub logo for a
WorkOS login.

**The gaps:** text-only social buttons (all 20 Mobbin reference screens use brand
icons); no password show/hide; no memory of the last-used method; no product
story.

**Two claims from an earlier draft were withdrawn as factually wrong.** Do not
reintroduce them:

- *"Social buttons have the same visual weight as the primary CTA."* False.
  `Button.vue` `primary` is `border-accent bg-accent text-on-accent`; social
  buttons are `bg-surface-subtle border-border`. Already distinct. No work needed.
- An earlier wireframe showed an "Opslane" wordmark. Introducing one is a
  branding decision outside this plan. The header stays icon-only.

---

## Design decision: what "Last used" means

Read this before Task 2 — it explains why the code looks the way it does.

**Semantics: "last selected", uniformly.** The value is written when the user
commits to a method, *before* any network result is known. This is the only
definition achievable for all methods: social and IdP logins are full-page
redirects out of the SPA, so the dashboard never observes their success and
cannot record it client-side. Defining it as "last successful" would force social
to mean one thing and password another.

**Be honest about what this means: it is really "last attempted."** A failed
sign-in, a failed signup, and a signup still pending email verification all
overwrite the previous value. That is an accepted tradeoff, not an oversight —
the badge is a convenience hint, not an audit trail, and a user who *tried*
email last is well served by the email form being unbadged. The user-facing
label stays "Last used" because that is the established wording in the
reference implementations (Lovable, Neon) and "Last attempted" would read as an
error message.

**Both the stored value and the on-screen badge must move together.** Writing to
storage without updating the reactive ref leaves a stale badge on screen: the
user submits the email form, the login fails, they stay on the same page, and a
"Last used" badge is still sitting on the Google button while storage now says
`password`. Every write therefore goes through one setter that does both.

**Consequence: `useLoginFlow.ts` is not touched.** All three writes happen in
`Login.vue`, which already owns the social click, the redirect click, and the
form submit. No new `LoginFlowDependencies` entry, no hidden side effect in the
state machine.

**Rendering table — `'password'` is stored but never rendered. This is
deliberate, not an oversight:**

| Stored value | Badge shown |
| --- | --- |
| `'google'` / `'github'` | On that social button |
| `'redirect'` | On the "Continue to sign in" button |
| `'password'` | **Nowhere, by design** |

`'password'` is what *clears* the badge from social buttons. Without storing it,
a user who used Google once and email ever since would see a stale "Last used"
badge on Google forever. Absence of a badge correctly signals "you last used the
email form" — which is already the visually dominant affordance.

---

## Task 1: Brand and eye icon components

Pure presentational SFCs. No behaviour to test in isolation — they are covered
through `SocialLoginButtons` in Task 3.

**Files:**
- Create: `packages/dashboard/src/components/icons/GoogleIcon.vue`
- Create: `packages/dashboard/src/components/icons/GitHubIcon.vue`
- Create: `packages/dashboard/src/components/icons/EyeIcon.vue`
- Create: `packages/dashboard/src/components/icons/EyeSlashIcon.vue`

**Step 1: Create `GoogleIcon.vue`**

Google's mark must keep its four brand colours, so these fills are intentionally
hardcoded — this is the one legitimate exception to the no-hex rule, because a
recoloured Google logo violates their brand terms.

```vue
<template>
  <svg class="h-5 w-5 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#4285F4" d="M23.06 12.25c0-.85-.08-1.67-.22-2.45H12v4.64h6.2a5.3 5.3 0 0 1-2.3 3.48v2.89h3.72c2.18-2 3.44-4.96 3.44-8.56Z" />
    <path fill="#34A853" d="M12 24c3.11 0 5.72-1.03 7.62-2.79l-3.72-2.89c-1.03.69-2.35 1.1-3.9 1.1-3 0-5.54-2.03-6.45-4.75H1.71v2.98A11.5 11.5 0 0 0 12 24Z" />
    <path fill="#FBBC05" d="M5.55 14.67a6.9 6.9 0 0 1 0-4.41V7.28H1.71a11.51 11.51 0 0 0 0 10.37l3.84-2.98Z" />
    <path fill="#EA4335" d="M12 4.75c1.69 0 3.21.58 4.4 1.72l3.3-3.3C17.71 1.28 15.1.25 12 .25A11.5 11.5 0 0 0 1.71 7.28l3.84 2.98C6.46 7.54 9 4.75 12 4.75Z" />
  </svg>
</template>
```

**Step 2: Create `GitHubIcon.vue`**

This path is moved verbatim from `Login.vue:92`. It is the correct GitHub mark —
it was simply used on the wrong button. `currentColor` makes it inherit the
button's text colour, so it works in both light and dark themes.

```vue
<template>
  <svg class="h-5 w-5 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    <path fill-rule="evenodd" d="M10 0C4.477 0 0 4.477 0 10c0 4.42 2.865 8.166 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.564 9.564 0 0110 4.844c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C17.137 18.163 20 14.418 20 10c0-5.523-4.477-10-10-10z" clip-rule="evenodd" />
  </svg>
</template>
```

**Step 3: Create `EyeIcon.vue`**

Heroicons outline, matching the stroke style already used at `Login.vue:59-61`.

```vue
<template>
  <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true">
    <path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
    <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
  </svg>
</template>
```

**Step 4: Create `EyeSlashIcon.vue`**

```vue
<template>
  <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true">
    <path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243" />
  </svg>
</template>
```

**Step 5: Verify they compile**

Run: `pnpm --filter @opslane/dashboard build`
Expected: build succeeds. Nothing imports these yet, so nothing else changes.

**Step 6: Commit**

```bash
git add packages/dashboard/src/components/icons/
git commit -m "feat(dashboard): add brand and eye icon components for login"
```

---

## Task 2: `useLastAuthMethod` composable (TDD)

**Files:**
- Create: `packages/dashboard/src/composables/useLastAuthMethod.ts`
- Test: `packages/dashboard/src/composables/useLastAuthMethod.test.ts`
  (flat, **not** in `__tests__/` — match the neighbouring composable tests)

**Step 1: Write the failing test**

Note the jsdom pragma on line 1 — without it there is no `localStorage` and
every test errors rather than failing meaningfully.

```ts
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readLastAuthMethod, writeLastAuthMethod } from './useLastAuthMethod';

const KEY = 'opslane.last_auth_method';

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('useLastAuthMethod', () => {
  it('round-trips every valid method', () => {
    for (const method of ['google', 'github', 'redirect', 'password'] as const) {
      writeLastAuthMethod(method);
      expect(readLastAuthMethod()).toBe(method);
    }
  });

  it('returns null when nothing has been stored', () => {
    expect(readLastAuthMethod()).toBeNull();
  });

  it('returns null for an unrecognised stored value', () => {
    window.localStorage.setItem(KEY, 'myspace');
    expect(readLastAuthMethod()).toBeNull();
  });

  // Safari private mode throws on access. The badge is cosmetic; the login
  // screen must still render.
  it('returns null when reading from storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => readLastAuthMethod()).not.toThrow();
    expect(readLastAuthMethod()).toBeNull();
  });

  it('swallows a write failure instead of propagating it', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => writeLastAuthMethod('google')).not.toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/dashboard test -- useLastAuthMethod`
Expected: FAIL — `Failed to resolve import "./useLastAuthMethod"`.

**Step 3: Write minimal implementation**

```ts
import type { SocialProviderId } from '../types/api';

export type LastAuthMethod = SocialProviderId | 'redirect' | 'password';

const STORAGE_KEY = 'opslane.last_auth_method';
const VALID_METHODS: readonly string[] = ['google', 'github', 'redirect', 'password'];

function isLastAuthMethod(value: string | null): value is LastAuthMethod {
  return value !== null && VALID_METHODS.includes(value);
}

/**
 * Which sign-in method the user last selected, or null if unknown.
 *
 * "Selected", not "succeeded": social and hosted-IdP logins redirect out of the
 * SPA, so their success is never observable here.
 */
export function readLastAuthMethod(): LastAuthMethod | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isLastAuthMethod(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeLastAuthMethod(method: LastAuthMethod): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, method);
  } catch {
    // localStorage throws in Safari private mode and some embedded webviews.
    // A missing "Last used" badge is a far better outcome than a login screen
    // that fails to render.
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @opslane/dashboard test -- useLastAuthMethod`
Expected: PASS, 5 tests.

**Step 5: Commit**

```bash
git add packages/dashboard/src/composables/useLastAuthMethod.ts \
        packages/dashboard/src/composables/useLastAuthMethod.test.ts
git commit -m "feat(dashboard): remember the last selected auth method"
```

---

## Task 3: Icons and "Last used" badge in `SocialLoginButtons` (TDD)

**Do not modify `socialProviders.ts`.** An earlier draft added an `icon` field to
`SocialButton`, duplicating `id` (already typed `SocialProviderId`) and creating
two values that can disagree. It also breaks `socialProviders.test.ts`, which
asserts the exact object shape with `toEqual`. The mapping belongs in the
renderer.

**Files:**
- Modify: `packages/dashboard/src/components/SocialLoginButtons.vue`
- Test: `packages/dashboard/src/components/__tests__/social-login-buttons.test.ts`

**Step 1: Write the failing test**

```ts
// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import SocialLoginButtons from '../SocialLoginButtons.vue';
import GitHubIcon from '../icons/GitHubIcon.vue';
import GoogleIcon from '../icons/GoogleIcon.vue';
import { socialProviderButtons } from '../../composables/socialProviders';
import type { LastAuthMethod } from '../../composables/useLastAuthMethod';

const buttons = socialProviderButtons(['github', 'google']);

// Type this as LastAuthMethod, NOT string. Test files are compiled by vue-tsc
// during `pnpm build`, so a loose `string` here passes `vitest run` and then
// fails the build with a type error.
function mountButtons(lastUsed?: LastAuthMethod | null) {
  return mount(SocialLoginButtons, {
    props: { buttons, dividerLabel: 'or continue with email', lastUsed },
  });
}

describe('SocialLoginButtons', () => {
  it('renders the matching brand icon for each provider', () => {
    const wrapper = mountButtons();
    expect(wrapper.findComponent(GitHubIcon).exists()).toBe(true);
    expect(wrapper.findComponent(GoogleIcon).exists()).toBe(true);
  });

  it('preserves the provider hrefs the e2e suite selects on', () => {
    const links = mountButtons().findAll('a[href^="/auth/login?provider="]');
    expect(links).toHaveLength(2);
    expect(links[0].attributes('href')).toBe('/auth/login?provider=github');
  });

  it('badges only the button matching lastUsed', () => {
    const wrapper = mountButtons('github');
    const badges = wrapper.findAll('[data-testid="last-used-badge"]');
    expect(badges).toHaveLength(1);
    expect(wrapper.findAll('a')[0].text()).toContain('Last used');
  });

  it('shows no badge when lastUsed is undefined', () => {
    expect(mountButtons().findAll('[data-testid="last-used-badge"]')).toHaveLength(0);
  });

  // 'password' is a stored value with no rendered badge — absence is the signal.
  it('shows no badge when the last method was the email form', () => {
    expect(mountButtons('password').findAll('[data-testid="last-used-badge"]')).toHaveLength(0);
  });

  it('emits the provider id when a button is clicked', async () => {
    const wrapper = mountButtons();
    await wrapper.findAll('a')[1].trigger('click');
    expect(wrapper.emitted('select')).toEqual([['google']]);
  });

  it('renders nothing when no providers are configured', () => {
    const wrapper = mount(SocialLoginButtons, {
      props: { buttons: [], dividerLabel: 'or' },
    });
    expect(wrapper.find('a').exists()).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/dashboard test -- social-login-buttons`
Expected: FAIL — no `GitHubIcon` component found, no badge, no `select` event.

**Step 3: Write the implementation**

Replace the whole file:

```vue
<script setup lang="ts">
import type { Component } from 'vue';

import GitHubIcon from './icons/GitHubIcon.vue';
import GoogleIcon from './icons/GoogleIcon.vue';
import type { SocialButton } from '../composables/socialProviders';
import type { LastAuthMethod } from '../composables/useLastAuthMethod';
import type { SocialProviderId } from '../types/api';

defineProps<{
  buttons: SocialButton[];
  dividerLabel: string;
  lastUsed?: LastAuthMethod | null;
}>();

defineEmits<{ select: [id: SocialProviderId] }>();

// Exhaustive over SocialProviderId on purpose: adding a provider to the union
// in types/api.ts becomes a compile error here until an icon is supplied.
const ICONS: Record<SocialProviderId, Component> = {
  google: GoogleIcon,
  github: GitHubIcon,
};
</script>

<template>
  <div v-if="buttons.length" class="mb-6 space-y-2">
    <a
      v-for="button in buttons"
      :key="button.id"
      :href="button.href"
      class="w-full flex items-center gap-3 rounded-md bg-surface-subtle border border-border px-4 py-3 text-sm font-medium text-text hover:bg-border focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-background transition-colors"
      @click="$emit('select', button.id)"
    >
      <component :is="ICONS[button.id]" />
      <span>{{ button.label }}</span>
      <span
        v-if="button.id === lastUsed"
        data-testid="last-used-badge"
        class="ml-auto rounded bg-accent/10 px-1.5 py-0.5 text-xs text-accent"
      >Last used</span>
    </a>
    <div class="flex items-center gap-3 pt-2 text-xs text-muted">
      <span class="h-px flex-1 bg-border"></span>
      {{ dividerLabel }}
      <span class="h-px flex-1 bg-border"></span>
    </div>
  </div>
</template>
```

The row changes from `justify-center` to a leading icon with `items-center
gap-3`, so labels start at the same x-position across providers instead of
shifting with label length. The click handler does **not** call
`preventDefault` — the anchor must still navigate.

**Step 4: Run tests to verify they pass**

```bash
pnpm --filter @opslane/dashboard test -- social-login-buttons
pnpm --filter @opslane/dashboard test -- socialProviders
```
Expected: both PASS. `socialProviders.test.ts` must be untouched and still green —
that is the proof you did not change the composable's contract.

**Step 5: Commit**

```bash
git add packages/dashboard/src/components/SocialLoginButtons.vue \
        packages/dashboard/src/components/__tests__/social-login-buttons.test.ts
git commit -m "feat(dashboard): add brand icons and last-used badge to social login"
```

---

## Task 4: Fix the wrong-brand icon on the generic IdP button

This is the actual bug. Isolated into its own commit so it can be cherry-picked
or reverted independently of the redesign.

**Files:**
- Modify: `packages/dashboard/src/views/Login.vue:87-95`

**Step 1: Replace the octocat with a neutral lock glyph**

The GitHub mark now lives in `GitHubIcon.vue` (Task 1). This button targets
`/auth/login`, whose provider may be WorkOS, so it must not claim any brand.

Replace the `<svg>` at `Login.vue:91-93` with:

```html
<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true">
  <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
</svg>
```

Keep the label "Continue to sign in" exactly — `test-e2e/login-social.test.ts:114`
selects it with `getByRole('button', { name: 'Continue to sign in' })`.

**Step 2: Add a regression test so the octocat cannot come back**

Without this, nothing stops a future edit from putting a brand icon back on the
generic button. Add to `login-password-toggle.test.ts` (or a
`login-redirect-button.test.ts` using the same mocks), mounting with a
password-less config so `mode` resolves to `redirect`:

```ts
it('does not put a brand icon on the generic IdP button', async () => {
  // Config with supports_password: false → mode === 'redirect'
  const wrapper = await mountLoginInRedirectMode();
  const idpButton = wrapper.get('[data-testid="idp-redirect-button"]');
  expect(idpButton.findComponent(GitHubIcon).exists()).toBe(false);
  expect(idpButton.findComponent(GoogleIcon).exists()).toBe(false);
});
```

Add `data-testid="idp-redirect-button"` to that button so the test can target it
without depending on label text.

**Step 3: Verify the build and existing tests**

```bash
pnpm --filter @opslane/dashboard build
pnpm --filter @opslane/dashboard test
```
Expected: PASS.

**Step 4: Commit**

```bash
git add packages/dashboard/src/views/Login.vue
git commit -m "fix(dashboard): stop showing the GitHub logo on the generic IdP button

The 'Continue to sign in' button targets /auth/login, whose provider may be
WorkOS (see README AUTH_PROVIDER). Showing the GitHub octocat there claimed a
brand that may not be in use. Replaced with a neutral lock glyph."
```

---

## Task 5: Wire last-used tracking into `Login.vue`

**Files:**
- Modify: `packages/dashboard/src/views/Login.vue`

**Step 1: Update the `<script setup>` block**

Add these imports. **Do not import `LoginShowcase` yet** — that file does not
exist until Task 7, and importing it here breaks this task's own build gate
twice over: `vue-tsc` cannot resolve the module, and even if you pre-created the
file, `noUnusedLocals: true` rejects an import you do not yet render.

```ts
import { computed, onMounted, ref } from 'vue';
import {
  readLastAuthMethod,
  writeLastAuthMethod,
  type LastAuthMethod,
} from '../composables/useLastAuthMethod';
import type { SocialProviderId } from '../types/api';
```

Add state and handlers. Note the single setter — storage and the on-screen badge
must never drift apart (see the design decision above):

```ts
// Read once on mount. Nothing can change storage without a navigation.
const lastAuthMethod = ref<LastAuthMethod | null>(null);

// Single write path: persist AND update the badge. Writing only to storage
// leaves a stale badge on screen after a failed login.
function recordAuthMethod(method: LastAuthMethod): void {
  writeLastAuthMethod(method);
  lastAuthMethod.value = method;
}

function handleSocialSelect(id: SocialProviderId): void {
  recordAuthMethod(id);
}

function handleCredentialsSubmit(): void {
  recordAuthMethod('password');
  void submitCredentials();
}
```

Update `redirectSignIn` (currently `Login.vue:48-50`):

```ts
function redirectSignIn(): void {
  recordAuthMethod('redirect');
  window.location.href = '/auth/login';
}
```

Replace `onMounted(loadConfig)` (currently `Login.vue:52`):

```ts
onMounted(() => {
  lastAuthMethod.value = readLastAuthMethod();
  void loadConfig();
});
```

**Step 2: Pass the prop to BOTH `SocialLoginButtons` instances**

There are two, and missing either one is the easiest mistake in this task.

At `Login.vue:85` (redirect mode):
```html
<SocialLoginButtons
  :buttons="socialButtons"
  divider-label="or"
  :last-used="lastAuthMethod"
  @select="handleSocialSelect"
/>
```

At `Login.vue:202` (signin/signup mode):
```html
<SocialLoginButtons
  :buttons="socialButtons"
  divider-label="or continue with email"
  :last-used="lastAuthMethod"
  @select="handleSocialSelect"
/>
```

**Step 3: Badge the redirect button**

Inside the "Continue to sign in" button, after the label text:

```html
<span
  v-if="lastAuthMethod === 'redirect'"
  class="ml-auto rounded bg-accent/10 px-1.5 py-0.5 text-xs text-accent"
>Last used</span>
```

Change that button's classes from `justify-center` to `justify-start` so the
badge can sit right with `ml-auto`, matching the social buttons.

**Step 4: Route the credentials form through the new handler**

At `Login.vue:204`, change:
```html
<form class="space-y-4" @submit.prevent="submitCredentials">
```
to:
```html
<form class="space-y-4" @submit.prevent="handleCredentialsSubmit">
```

Leave the `verify-code` and `forgot` forms alone — they are continuations of a
method already recorded.

**Step 5: Verify, including the stale-badge path**

```bash
pnpm --filter @opslane/dashboard test
pnpm --filter @opslane/dashboard build
```
Expected: PASS. `useLoginFlow.test.ts` must still be green and **unmodified** —
that is the proof the state machine was not touched.

Then add this case to `login-password-toggle.test.ts` (Task 6 creates that file;
if you are doing Task 5 first, put it in a `login-last-used.test.ts` using the
same mount helper). It is the regression test for the stale badge:

```ts
it('clears the social badge as soon as the email form is submitted', async () => {
  window.localStorage.setItem('opslane.last_auth_method', 'github');
  const wrapper = await mountLogin();
  expect(wrapper.findAll('[data-testid="last-used-badge"]')).toHaveLength(1);

  await wrapper.get('form').trigger('submit');

  // Badge must disappear immediately, without waiting for the request to
  // resolve or the page to reload.
  expect(wrapper.findAll('[data-testid="last-used-badge"]')).toHaveLength(0);
});
```

**Step 6: Commit**

```bash
git add packages/dashboard/src/views/Login.vue
git commit -m "feat(dashboard): show which sign-in method was last used"
```

---

## Task 6: Password visibility toggle (TDD)

Implement inline in `Login.vue`, **not** by extending shared `TextInput.vue`.
`Login.vue` already uses raw `<input>` elements, and adding a trailing-slot API
to the shared component would touch every other dashboard form for no benefit.

**Files:**
- Modify: `packages/dashboard/src/views/Login.vue:230-238`
- Test: `packages/dashboard/src/components/__tests__/login-password-toggle.test.ts`

**Step 1: Write the failing test**

`Login.vue` calls `fetchAuthConfig` on mount, so the API module must be mocked or
the test hits the network and hangs.

```ts
// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api', () => ({
  fetchAuthConfig: vi.fn().mockResolvedValue({
    supports_password: true,
    supports_signup: true,
    supports_reset: true,
    social_providers: ['github', 'google'],
  }),
  passwordLogin: vi.fn(),
  signup: vi.fn(),
  verifyEmail: vi.fn(),
  forgotPassword: vi.fn(),
}));
vi.mock('../../post-auth', () => ({ completePostAuth: vi.fn() }));

// Login.vue calls useRouter(), which resolves through Vue's inject(), NOT
// through `global.mocks.$router`. A $router mock does not satisfy it — the
// composable returns undefined, Vue logs an injection warning, and any test
// that reaches the post-auth path breaks. Mock the module instead.
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

import Login from '../../views/Login.vue';

async function mountLogin() {
  const wrapper = mount(Login);
  await vi.waitFor(() => {
    expect(wrapper.find('#auth-password').exists()).toBe(true);
  });
  return wrapper;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('Login password toggle', () => {
  it('starts masked', async () => {
    const wrapper = await mountLogin();
    expect(wrapper.get('#auth-password').attributes('type')).toBe('password');
  });

  it('reveals and re-masks the password', async () => {
    const wrapper = await mountLogin();
    const toggle = wrapper.get('[data-testid="password-toggle"]');

    await toggle.trigger('click');
    expect(wrapper.get('#auth-password').attributes('type')).toBe('text');
    expect(toggle.attributes('aria-pressed')).toBe('true');
    expect(toggle.attributes('aria-label')).toBe('Hide password');

    await toggle.trigger('click');
    expect(wrapper.get('#auth-password').attributes('type')).toBe('password');
    expect(toggle.attributes('aria-label')).toBe('Show password');
  });

  // A revealed password must never survive into another mode.
  it('re-masks when switching from sign in to sign up', async () => {
    const wrapper = await mountLogin();
    await wrapper.get('[data-testid="password-toggle"]').trigger('click');
    expect(wrapper.get('#auth-password').attributes('type')).toBe('text');

    await wrapper.get('[role="tab"][aria-selected="false"]').trigger('click');
    expect(wrapper.get('#auth-password').attributes('type')).toBe('password');
  });

  it('leaves room for the toggle so the value cannot sit underneath it', async () => {
    const wrapper = await mountLogin();
    expect(wrapper.get('#auth-password').classes()).toContain('pr-10');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/dashboard test -- login-password-toggle`
Expected: FAIL — no `[data-testid="password-toggle"]` element.

**Step 3: Implement**

In `<script setup>`, add `watch` to the `vue` import and:

```ts
const showPassword = ref(false);

// Never leave a password revealed when the user moves to another mode.
watch(mode, () => {
  showPassword.value = false;
});
```

Replace the password `<input>` at `Login.vue:230-238` with:

```html
<div class="relative">
  <input
    id="auth-password"
    v-model="password"
    :type="showPassword ? 'text' : 'password'"
    :autocomplete="mode === 'signup' ? 'new-password' : 'current-password'"
    required
    class="w-full rounded-md border border-border bg-surface-subtle px-3 py-2.5 pr-10 text-text placeholder:text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
    placeholder="Enter your password"
  />
  <button
    type="button"
    data-testid="password-toggle"
    :aria-label="showPassword ? 'Hide password' : 'Show password'"
    :aria-pressed="showPassword"
    class="absolute inset-y-0 right-0 flex items-center px-3 text-muted hover:text-text rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    @click="showPassword = !showPassword"
  >
    <EyeSlashIcon v-if="showPassword" />
    <EyeIcon v-else />
  </button>
</div>
```

Two details that are easy to skip and both matter:
- **`pr-10` on the input.** Without it a long password renders underneath the
  button. This is the standard failure of this pattern.
- **`focus-visible:outline-*` on the button.** It sits inside the input's visual
  bounds, so a missing focus ring is very easy to miss in review. This matches
  `Button.vue`'s convention.

Add the icon imports:
```ts
import EyeIcon from '../components/icons/EyeIcon.vue';
import EyeSlashIcon from '../components/icons/EyeSlashIcon.vue';
```

**Step 4: Run tests to verify they pass**

Run: `pnpm --filter @opslane/dashboard test -- login-password-toggle`
Expected: PASS, 4 tests.

**Step 5: Commit**

```bash
git add packages/dashboard/src/views/Login.vue \
        packages/dashboard/src/components/__tests__/login-password-toggle.test.ts
git commit -m "feat(dashboard): add a password visibility toggle to login"
```

---

## Task 7: Split-screen shell and showcase panel

**Files:**
- Create: `packages/dashboard/src/components/LoginShowcase.vue`
- Modify: `packages/dashboard/src/views/Login.vue:56-57` and `255-256`
- Test: `packages/dashboard/src/components/__tests__/login-showcase.test.ts`

### Copy is constrained by `README.md` — do not improvise

An earlier draft proposed "Production errors, fixed while you sleep" with two
outcomes. That overpromised automatic resolution and contradicted `README.md`,
which documents **four** terminal states: `pr_created`, `pr_draft`,
`investigated`, `needs_human`. Use exactly this copy; each bullet maps to a
documented state, and the headline derives from README's "Every run reaches an
explicit state".

**Step 1: Write the failing test**

This test exists to stop the copy from drifting back into overpromising.

```ts
// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import LoginShowcase from '../LoginShowcase.vue';

describe('LoginShowcase', () => {
  it('states the outcome promise from the README', () => {
    expect(mount(LoginShowcase).text()).toContain('Every production error gets an answer');
  });

  it('describes all four documented terminal states', () => {
    const text = mount(LoginShowcase).text();
    expect(text).toContain('fix PR');
    expect(text).toContain('draft');
    expect(text).toContain('analysis');
    expect(text).toContain('incident');
  });

  // The product does not resolve errors unattended; do not imply that it does.
  it('does not overpromise automatic resolution', () => {
    const text = mount(LoginShowcase).text();
    expect(text).not.toMatch(/while you sleep/i);
    expect(text).not.toMatch(/automatically fix/i);
    expect(text).not.toMatch(/already triaged/i);
  });

  it('contains nothing focusable, so it cannot disrupt tab order', () => {
    const wrapper = mount(LoginShowcase);
    expect(wrapper.findAll('a, button, input, [tabindex]')).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @opslane/dashboard test -- login-showcase`
Expected: FAIL — cannot resolve `../LoginShowcase.vue`.

**Step 3: Create `LoginShowcase.vue`**

```vue
<script setup lang="ts">
// Copy is traceable to README.md: each bullet maps to one documented terminal
// state (pr_created, pr_draft, investigated, needs_human). Do not add product
// claims here that the pipeline does not actually make.
const outcomes = [
  'A ready-for-review fix PR, backed by executed verification evidence',
  'Or an opt-in draft PR, clearly labeled as not yet verified',
  'Or a root-cause analysis, or an incident with a reason code and next steps',
];
</script>

<template>
  <div class="hidden lg:flex flex-col justify-center bg-surface-subtle px-12 py-16">
    <div class="max-w-md">
      <h2 class="text-3xl font-semibold text-text leading-tight">
        Every production error gets an answer.
      </h2>
      <p class="mt-4 text-base text-muted">
        Opslane ingests browser errors from your frontend, investigates the root
        cause, and takes each one to an explicit outcome.
      </p>
      <ul class="mt-8 space-y-4">
        <li v-for="outcome in outcomes" :key="outcome" class="flex gap-3 text-sm text-muted">
          <svg class="h-5 w-5 shrink-0 text-accent" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
          </svg>
          <span>{{ outcome }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>
```

The `hidden lg:flex` lives on the component root, so `Login.vue` does not need to
pass a class for it.

**Step 4: Restructure the `Login.vue` root**

Add the import now — this is the task that both creates and renders the
component, so it is the first point where the import resolves and is used:

```ts
import LoginShowcase from '../components/LoginShowcase.vue';
```

Change the outer wrapper at `Login.vue:56-57` from:
```html
<div class="min-h-screen bg-background flex items-center justify-center px-4 py-8">
  <div class="max-w-sm w-full bg-surface rounded-lg border border-border p-8">
```
to:
```html
<div class="min-h-screen bg-background lg:grid lg:grid-cols-2">
  <div class="flex min-h-screen items-center justify-center px-4 py-8">
    <div class="max-w-sm w-full bg-surface rounded-lg border border-border p-8 lg:border-0 lg:bg-transparent lg:p-0">
```

And close it at the end of the template (currently `Login.vue:255-256`):
```html
    </div>
  </div>
  <LoginShowcase />
</div>
```

The card keeps its background, border, and padding below `lg` so the mobile view
is byte-identical to today, and sheds them at `lg` where the panel split already
provides separation. Every mode branch stays inside the left column untouched;
the showcase is constant across all of them.

**Step 5: Run tests and build**

```bash
pnpm --filter @opslane/dashboard test
pnpm --filter @opslane/dashboard build
```
Expected: PASS. Check your closing-tag nesting carefully if the build fails —
adding a wrapper `<div>` to a 200-line template is where this task breaks.

**Step 6: Commit**

```bash
git add packages/dashboard/src/components/LoginShowcase.vue \
        packages/dashboard/src/components/__tests__/login-showcase.test.ts \
        packages/dashboard/src/views/Login.vue
git commit -m "feat(dashboard): add split-screen login layout with outcome showcase"
```

---

## Task 8: Full verification gate

Do not skip this because the unit tests are green. Per the repo's verification
rules, "done" means you ran it and watched it work.

**Step 1: Automated suite**

```bash
cd /Users/abhishekray/orca/workspaces/opslane-oss/imporve-login
pnpm --filter @opslane/dashboard test
pnpm --filter @opslane/dashboard build
```
Expected: all PASS.

**Step 2: E2E social login**

```bash
pnpm --filter @opslane/test-e2e test -- login-social.test.ts
```

Expected: PASS **without modification**. This suite selects on
`a[href^="/auth/login?provider="]` and href attributes
(`test-e2e/login-social.test.ts:77-80`), plus
`getByRole('button', { name: 'Continue to sign in' })` (line 114) — none of which
this plan changes. If it fails, you altered the anchor structure, the hrefs, or
the redirect button label, and that is a regression to fix rather than a test to
update.

**Do not mistake this for coverage of the redesign.** This suite passing proves
only that you did not *break* the pre-existing social-login flow. It asserts
nothing about icons, the last-used badge, persistence, the password toggle, or
the split layout — all of that is covered by the component tests in Tasks 2, 3,
6, and 7, and by the manual pass below. E2E here is a regression guard, not the
verification gate.

Two specific things to watch:
- Line 116 uses `getByText('or', { exact: true })`. The showcase copy contains
  "Or an opt-in draft PR…", which is a longer text node and will not match an
  exact query — but if you reword the copy to a bare "or", you will cause a
  strict-mode violation.
- Line 123 asserts the last social button sits above the redirect button. The
  `justify-start` change does not affect vertical order.

**Step 3: Manual UI pass**

Reading the diff is not evidence. Start the app and check.

**Prerequisites — several modes need setup, so plan for it:**

- `docker compose up -d`; the dashboard serves at <http://localhost:8082>.
- **Real social login needs OAuth credentials.** Per `README.md`, GitHub OAuth
  requires `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`,
  `AUTH_CALLBACK_ORIGIN=http://localhost:8082`, and
  `DASHBOARD_ORIGIN=http://localhost:8082` set before `docker compose up`.
- **If you cannot get OAuth credentials**, everything except the live round-trip
  is still verifiable: the badge is driven purely by `localStorage`, so set it by
  hand in DevTools
  (`localStorage.setItem('opslane.last_auth_method', 'github')`) and reload. If
  you do it this way, say so in your report rather than implying a live login.
- **`redirect` mode** needs `supports_password: false`. Stubbing the auth-config
  response in DevTools is easier than reconfiguring the backend.
- **`verify-code` mode** needs a signup that triggers email verification. If local
  email is not wired up, stub the `signup` response to return
  `email_verification_required` and confirm the branch renders.

Then check:

- Light and dark theme.
- Breakpoints `375px` (mobile card unchanged from today), `1024px` (split
  appears), `1440px`.
- Type a long password, toggle visibility — the value must never run underneath
  the eye button. Tab to the toggle and confirm a visible focus ring.
- Sign in with a social provider, sign out, reload — badge appears on that
  button. Then sign in with email and reload — badge is gone from all social
  buttons. This is the `'password'` invalidation path from the design decision.
- Walk every mode: `redirect`, `signin`, `signup`, `verify-code`, `forgot`,
  `forgot-sent`, and the `config-error` retry.

**Step 4: Keyboard tab order, per mode**

An earlier draft specified one universal sequence starting at the logo. That is
impossible — the logo is a decorative `<svg>` with no `tabindex`. The real
sequence varies by mode and by `AuthConfig`. Every element below must show a
visible focus ring.

**"Forgot password?" comes BEFORE the password input.** It lives inside the
label row (`Login.vue:219-229`), which precedes the `<input>` in the DOM. Tab
order follows the DOM, so it is reached between email and password. An earlier
draft of this plan asserted the opposite in both the table and a footnote; both
were wrong. Verify against the real markup, not against this table, if they ever
disagree.

| Mode | Expected tab order |
| --- | --- |
| `signin` | [Sign in / Sign up tabs, only if `supports_signup`] → social buttons in config order → email → [Forgot password?, only if `supports_reset`] → password → password toggle → Sign in → [`CopyButton`, only if `AGENT_ONBOARDING_ENABLED`] |
| `signup` | tabs → social buttons → email → password → password toggle → Create account → [`CopyButton`] (no Forgot link: it is gated on `mode === 'signin'`) |
| `redirect` | social buttons → Continue to sign in → [`CopyButton`] |
| `verify-code` | code input → Verify email → "Sign in again" button |
| `forgot` | email → Send reset link → Back to sign in |
| `forgot-sent` | Back to sign in |
| `config-error` | Try again |

`AgentOnboardingCard` contains exactly one focusable element (`CopyButton.vue`)
and renders only in `redirect`, `signin`, and `signup`.

Reaching "Forgot password?" before the password field is slightly unusual but
matches the visual order (it renders to the right of the "Password" label,
above the input). Leave the DOM alone — it is visually and semantically
coherent, and reordering would churn tested markup for no accessibility gain.

**Step 5: No commit here**

Tasks 1-7 already committed everything. This task is verification only, so there
is normally nothing to commit and `git add -A` would be actively harmful: it
sweeps up unrelated worktree changes, which `AGENTS.md` explicitly forbids
("Preserve unrelated worktree changes").

If verification uncovered a fix, commit only the files you actually changed:

```bash
git status                      # confirm what you touched
git add packages/dashboard/src/...   # explicit paths only, never -A
git commit -m "fix(dashboard): <what verification caught>"
```

---

## Out of scope

- Any change to `useLoginFlow.ts` — see the design decision above.
- Any change to `socialProviders.ts` — see Task 3.
- Backend, `/auth/login`, `packages/ingestion`.
- SSO as a separate button; no SSO provider is distinct from the generic
  redirect today.
- Terms & Privacy footer, customer logo wall, header wordmark.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | not run | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | 10 findings (5 P1, 5 P2), 10/10 addressed |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | not run | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | not run | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | not run | — |

**CODEX:** Found 5 blocking defects, all verified against source and fixed.
(1) Task 5 imported `LoginShowcase.vue` before Task 7 created it — its own build
gate could not pass, and `noUnusedLocals: true` would reject it even if
pre-created; import moved to Task 7. (2) Task 3's test helper typed `lastUsed` as
`string`, which passes `vitest run` but fails `vue-tsc` because `tsconfig.json`
compiles `src/**/*.ts` including tests; retyped to `LastAuthMethod | null`.
(3) The badge went stale — `writeLastAuthMethod` persisted without updating the
reactive ref, so a failed email login left a "Last used" badge on Google;
replaced with a single `recordAuthMethod` setter plus a regression test.
(4) The tab-order table had "Forgot password?" after the password input in both
the table and a footnote; the real DOM puts it inside the label row *before* the
input — corrected. (5) Task 8's `git add -A` violated the AGENTS.md rule on
preserving unrelated worktree changes and would usually produce an empty commit;
removed. Advisory fixes: replaced the ineffective `global.mocks.$router` with a
`vi.mock('vue-router')` module mock (`useRouter` resolves via `inject`, not
`$router`), added a regression test pinning the wrong-brand bug, documented that
"Last used" really means "last attempted", downgraded the E2E claim from
verification gate to regression guard, and added OAuth/stub prerequisites to the
manual pass.

**VERDICT:** CODEX CLEARED — all 5 P1 and 5 P2 findings addressed. Eng review
required before implementing (`/plan-eng-review` has not run).

**UNRESOLVED DECISIONS:**
- Badge label wording: kept "Last used" (matches Lovable/Neon) although the
  semantics are "last attempted". Codex advised renaming; I documented the gap
  instead. Reversible in one string change if you disagree.

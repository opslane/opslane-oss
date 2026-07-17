---
covers:
  - packages/sdk/src/index.ts
  - packages/sdk/src/config.ts
---
# Install Opslane

If you use hosted Opslane, follow the web setup flow below. If you self-host, follow [Manual Fallback](#manual-fallback) and set the SDK's [`endpoint` init option](reference/sdk-options.md) to your ingestion URL.

> **Privacy:** Session recording is on by default since SDK 1.0.0; review [replay privacy and masking](guides/replay-privacy.md) before deploying.

## Web Setup

1. Sign in to Opslane.
2. Install the Opslane GitHub App.
3. Pick the repository you want Opslane to monitor.
4. Save the generated ingest key as a build or deploy secret.
5. Merge the setup PR Opslane opens for your repo.
6. Deploy, trigger a test error, and wait for the dashboard to confirm the first event.

For Vite apps, set:

```bash
VITE_OPSLANE_API_KEY=<your Opslane ingest key>
VITE_OPSLANE_RELEASE=<your git SHA>
```

For Next.js apps, set:

```bash
NEXT_PUBLIC_OPSLANE_API_KEY=<your Opslane ingest key>
NEXT_PUBLIC_OPSLANE_RELEASE=<your git SHA>
```

`release` should match the source maps you upload for that deploy. In CI, use the commit SHA or another immutable build identifier.

## Manual Fallback

If Opslane cannot open a setup PR for an unusual repository, install the SDK manually:

```bash
npm install @opslane/sdk
```

Then initialize it in your browser entry point:

```ts
import { init } from '@opslane/sdk';

init({
  apiKey: import.meta.env.VITE_OPSLANE_API_KEY,
  release: import.meta.env.VITE_OPSLANE_RELEASE,
});
```

For Vue apps, also register the Vue plugin before mounting:

```ts
import { createApp } from 'vue';
import { init, opslaneVuePlugin } from '@opslane/sdk';
import App from './App.vue';

init({
  apiKey: import.meta.env.VITE_OPSLANE_API_KEY,
  release: import.meta.env.VITE_OPSLANE_RELEASE,
});

createApp(App).use(opslaneVuePlugin).mount('#app');
```

Do not commit your ingest key to the repository. Keep it in your deploy platform or CI secret store.

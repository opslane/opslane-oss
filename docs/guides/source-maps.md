# Source maps

Without source maps, production stack traces point at minified bundles and investigations end in `sourcemap_unresolved` or `unfixable_no_sourcemap`. With them, the worker sees your original source. This guide covers the Vite plugin and CI.

## The Vite plugin

```ts
// vite.config.ts
import { opslaneSourceMapPlugin } from '@opslane/sdk/vite-plugin';

export default {
  plugins: [
    opslaneSourceMapPlugin({
      endpoint: 'https://your-opslane-instance.example.com',
      apiKey: process.env.OPSLANE_API_KEY!,
      release: process.env.GIT_SHA,   // or omit and set VITE_OPSLANE_RELEASE
    }),
  ],
};
```

What it does during `vite build` (build-only; it never touches dev serving):

1. Forces `build.sourcemap: 'hidden'` — maps are generated but **not referenced** from the bundles.
2. Collects every `.map` asset and **removes it from the output bundle**, so maps are never deployed to your CDN or exposed to users.
3. After the bundle closes, uploads each map to `POST /api/v1/sourcemaps` with your API key and the release identifier.

## The release contract

The plugin refuses to upload without a release — a map filed under the wrong release is worse than no map. Resolution order:

1. `release` plugin option, else
2. `VITE_OPSLANE_RELEASE` environment variable, else
3. **warn loudly and skip the upload.**

The value must be byte-identical to what your app passes to `init({ release })`. Using the git SHA for both is the reliable pattern; the [install guide](../install.md) shows the per-framework env vars.

## In CI

Source maps should upload from CI, where the release is unambiguous:

```yaml
# e.g. GitHub Actions
- run: npm run build
  env:
    OPSLANE_API_KEY: ${{ secrets.OPSLANE_API_KEY }}
    VITE_OPSLANE_API_KEY: ${{ secrets.OPSLANE_API_KEY }}
    VITE_OPSLANE_RELEASE: ${{ github.sha }}
```

The sourcemap upload endpoint is authenticated by API key but **not** origin-gated (unlike browser endpoints), precisely so build machines can call it.

## Verifying

After a deploy, trigger a test error from the built app. In the incident, resolved frames show original file paths; if you instead see minified paths or a `needs_human` with `sourcemap_unresolved`, the release strings don't match — compare what the SDK sent (`release` in the event payload) with what CI uploaded.

## Other bundlers

Only Vite has a first-party plugin today. From any other build, POST each map yourself:

```bash
curl -X POST "$OPSLANE_ENDPOINT/api/v1/sourcemaps" \
  -H "X-API-Key: $OPSLANE_API_KEY" \
  -F "release=$GIT_SHA" \
  -F "file=@dist/assets/index-abc123.js.map"
```

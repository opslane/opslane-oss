# Replay privacy and masking

Session replay shows you what the user saw and did around an error. It is the most privacy-sensitive feature in the SDK, which is why it is **off by default** and layered with masking. This guide covers how it works, what leaves the browser, and how to control it. (Policy summary: [replay privacy](../replay-privacy.md); data-flow context: [trust](../architecture/trust.md).)

## How capture works

```ts
init({
  apiKey: '...',
  replay: { enabled: true },   // opt-in — default is false
});
```

When enabled, the SDK keeps a **rolling in-memory buffer** of DOM events (via rrweb) with ~30-second snapshots. Nothing is uploaded continuously. Only when an error occurs — an uncaught error or an explicit `captureException` — is the buffered window packaged and uploaded, tagged with the trigger type and linked to the error group.

## What is masked, by default

- **Every input value** (`maskAllInputs: true`): passwords, emails, card fields, search boxes — all rendered as masked characters in the replay.
- **Anything you mark**: add the `opslane-mask` class to any element whose *text content* should be masked (account numbers, balances, PII rendered as text):

```html
<div class="opslane-mask">{{ accountNumber }}</div>
```

- **Scrubbed text and URLs**: independent of replay, all captured text is scrubbed of JWTs, `Bearer` tokens, and `password`/`secret`/`api_key`-style pairs; URLs lose query strings and embedded credentials.
- **Server-side backstop**: ingestion re-masks sensitive headers and well-known API-key prefixes before anything is persisted.

## What a replay may still contain

Masking is not anonymization. A replay can include page URLs and titles, visible page text not marked with `opslane-mask`, click/navigation timing, console signals, and network status metadata. If a screen renders personal data as plain text, mask it explicitly or don't enable replay on that flow.

## Scoping and dropping

- **Scope by flow:** call `init` with `replay.enabled` conditionally (e.g. disable on `/billing` routes).
- **Sample:** `sampleRate` applies to events; an event that is dropped uploads no replay.
- **Last-line veto:** the `beforeSend` hook sees every outgoing error event and can return `null` to drop it entirely.

## Retention — read before enabling in production

Stated plainly, as in the [trust page](../architecture/trust.md#honest-gaps-current-state): **there is currently no automated retention policy.** Replay payloads stay in your object storage and their rows in Postgres until you delete them. Self-hosters enabling replay on sensitive applications should schedule their own cleanup until retention ships.

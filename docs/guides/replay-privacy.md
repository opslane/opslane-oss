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

## What is masked in a replay, by default

- **Every input value** (`maskAllInputs: true`): passwords, emails, card fields, search boxes — all rendered as masked characters in the replay.
- **Anything you mark**: add the `opslane-mask` class to any element whose *text content* should be masked (account numbers, balances, PII rendered as text):

```html
<div class="opslane-mask">{{ accountNumber }}</div>
```

**And that is the complete list for replay DOM content.** The SDK's text/URL scrubbing (JWTs, `Bearer` tokens, `password`/`secret`-style pairs, URL query strings) applies to **error events and console breadcrumbs** — it does *not* run over the replay's serialized DOM. A token or personal data rendered as visible page text is captured verbatim unless the element carries `opslane-mask`.

## How replay data is persisted — read carefully

The upload path matters for privacy:

1. The SDK asks ingestion to start an upload and receives a pre-signed URL.
2. The browser PUTs the recording **directly to object storage** — at this moment the stored object is exactly what the browser captured.
3. On the completion call, ingestion reads the object back, runs server-side redaction over the recording, and **rewrites** it.

If the completion step never happens (tab closed mid-upload, network drop — and note the SDK's failure-report endpoint is currently broken, [#13](https://github.com/opslane/opslane-oss/issues/13)), the un-redacted object remains in storage, and there is no automated retention cleanup. Server-side redaction is a completion-time rewrite, not a gate in front of storage.

## What a replay may still contain

Masking is not anonymization. A replay can include page URLs and titles, visible page text not marked with `opslane-mask`, click/navigation timing, console signals, and network status metadata. If a screen renders personal data as plain text, mask it explicitly or don't enable replay on that flow.

## Scoping and dropping

- **Scope per page load, not per route.** `init` runs once; on a SPA, navigating to `/billing` after an earlier `init({ replay: { enabled: true } })` does **not** stop the recorder. Conditional init only works across full page loads. To stop capture mid-session, call `destroy()` (which tears down replay along with the rest of the SDK) before entering the sensitive flow, and `init` again after leaving it.
- **Sample:** `sampleRate` applies to events; an event that is dropped uploads no replay.
- **Last-line veto:** the `beforeSend` hook sees every outgoing error event and can return `null` to drop it entirely.

## Retention — read before enabling in production

Stated plainly, as in the [trust page](../architecture/trust.md#honest-gaps-current-state): **there is currently no automated retention policy.** Replay payloads stay in your object storage and their rows in Postgres until you delete them. Self-hosters enabling replay on sensitive applications should schedule their own cleanup until retention ships.

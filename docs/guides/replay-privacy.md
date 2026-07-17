---
covers:
  - packages/sdk/src/replay.ts
  - packages/sdk/src/session.ts
  - packages/sdk/src/chunk-upload.ts
  - packages/sdk/src/scrub.ts
---
# Replay privacy and masking

Session replay shows what a user saw and did around an error. It is the most privacy-sensitive feature in the SDK, and session recording is **on by default since SDK 1.0.0**. This guide explains when recording actually starts, what leaves the browser, how masking works, and how to turn recording off.

Default-on does not mean every page load produces a stored recording. The browser must support `CompressionStream`, ingestion must have object storage configured, and `/api/v1/sessions/init` must approve recording for the project. If any of those checks fail, the SDK does not create a usable recording.

## How capture and storage work

The current SDK records a continuous rrweb session stream rather than creating a separate replay only when an error occurs:

1. The SDK registers the browser session with `/api/v1/sessions/init`. The server returns whether recording is allowed.
2. The SDK cuts the stream into independently playable chunks roughly every 30 seconds. When an error is accepted, it also flushes the current chunk so the incident can point into that same session.
3. The browser gzips each chunk and uploads it directly to private object storage through a size-capped presigned POST policy, then commits the chunk to ingestion.
4. A server-side scrubber inflates the chunk under a hard size ceiling, redacts it, rewrites the stored object, and sets `scrubbed_at`.

The browser-side masks described below are the protection applied before upload. Server-side scrubbing happens after the raw gzipped chunk reaches object storage, but the raw chunk is fail-closed for application reads: no dashboard, API, or worker read path serves it until scrubbing succeeds and `scrubbed_at` is set. A chunk that never scrubs stays unreadable through the application. This gate does not apply to the storage layer itself — anyone holding the object-storage credentials can read raw chunks directly, so treat those credentials as access to pre-scrub recordings.

Errors refer to the continuous recording with a session pointer; the current SDK does not create `/api/v1/replays/*` one-shot uploads. See the [session replay contract](../contracts/C4-amendments.md) for the exact read and compatibility contracts.

## What is masked in the browser

- **Every input value** (`maskAllInputs: true`): passwords, emails, card fields, search boxes, and other form values render as masked characters.
- **Text you mark**: add `opslane-mask` to an element whose rendered text should be masked.
- **Subtrees you exclude**: add `opslane-block` to keep an element and its descendants out of the recording entirely.

```html
<div class="opslane-mask">alice@example.com</div>
<section class="opslane-block">Sensitive account details</section>
```

That is the complete browser-side masking list for replay DOM content. The SDK's text and URL scrubbing for error events and console breadcrumbs does **not** run over the serialized replay DOM before upload.

Masking is not anonymization. A recording may include page URLs and titles, visible page text not marked with `opslane-mask`, click and navigation timing, console signals, and network status metadata. Rendered email addresses, invoices, support tickets, and other personal data are captured as displayed unless you mask or block them.

Separately from the DOM recording: if your application calls `setUser()`, the SDK sends that user's id, email, account id, and account name **unmasked** when it registers the session with `/api/v1/sessions/init`, and ingestion persists them to associate recordings with the person who hit an error. Masking never applies to these fields — if you identify users, say so in your privacy notice.

## Turn recording off

Opt out in one integration:

```ts
init({
  apiKey: '...',
  replay: { enabled: false },
});
```

To stop recording for a whole project without redeploying the application, set `projects.recording_enabled` to `false` through your database or admin tooling. The server then declines new sessions and rejects the next chunk upload for an active session, which tells the SDK to stop its recorder.

## Tell your users

Recording user interactions may require an update to your privacy notice. This sample is only a starting point; adapt it to your jurisdiction and have your own counsel review it:

> We record how you interact with this application — pages viewed, clicks, and
> form interactions — to diagnose errors and fix problems you run into. Values
> you type into forms are masked before the recording leaves your browser.
> Recordings are deleted after 30 days.

Adjust the retention figure to the project's actual `session_retention_days` value, and if you call `setUser()`, disclose that recordings are linked to the signed-in user. The deletion promise holds for the current chunked-session path; if your deployment still accepts uploads from pre-1.0 SDKs, the [legacy one-shot path below](#retention) has no automated deletion yet — schedule your own cleanup before making this promise.

## Retention

Chunked sessions are deleted on a per-project clock. The default is 30 days, configured by `projects.session_retention_days`; deletion removes the Postgres rows and the session's object-storage prefix. Sessions linked as incident evidence can survive the normal window, but every session has a hard 90-day cap. Deleted session IDs are tombstoned and their storage prefixes are swept repeatedly so late uploads cannot recreate retained data.

The **legacy one-shot replay path** remains available for older SDKs and incidents. It rewrites the object with redacted data only when the upload completes, so an interrupted upload can leave raw data in storage, and those `session_replays` rows currently have no automated retention policy. The current SDK's chunked path does not use it.

For the broader data-flow and remaining security gaps, read the [trust and security model](../architecture/trust.md).

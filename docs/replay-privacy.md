# Replay Privacy

Opslane session replay is intended for debugging production errors, not for collecting sensitive user content.

By default, applications should mask text input values, password fields, payment fields, and other user-entered secrets before replay data leaves the browser. Teams should also avoid adding breadcrumbs or custom context fields that contain access tokens, credentials, full request bodies, or regulated personal data.

Captured replay data may include page URLs, click/navigation timing, console signals, network status metadata, and masked DOM or screenshot artifacts used to explain what the user saw around an error. Keep retention narrow and review custom SDK configuration before enabling replay on sensitive flows.

## Recording is on by default (SDK 1.0.0+)

Every session is recorded, not just sessions that hit an error. Two things
follow.

**Review your masking before upgrading.** Input values are masked
automatically. Rendered text is not — a page that displays an email address, an
invoice, or a support ticket body captures that text as shown. Mark those
regions:

```html
<div class="opslane-mask">alice@example.com</div>   <!-- text is masked -->
<div class="opslane-block">…</div>                  <!-- subtree not recorded -->
```

**Tell your users.** Recording every session changes what you collect, which
usually means your privacy notice needs to say so. A starting point — adapt it
to your jurisdiction and have your own counsel review it; this is not legal
advice:

> We record how you interact with this application — pages viewed, clicks, and
> form interactions — to diagnose errors and fix problems you run into. Values
> you type into forms are masked before the recording leaves your browser.
> Recordings are deleted after 30 days.

Adjust the retention figure to your project's actual `session_retention_days`.

### Turning recording off

Per integration:

```js
init({ apiKey: '...', replay: { enabled: false } });
```

Per project, set `projects.recording_enabled` to `false` with your database or
admin tooling. This needs no application redeploy: it stops new sessions
immediately and stops in-flight ones at their next chunk upload. A dashboard
toggle is not included in Batch 1.

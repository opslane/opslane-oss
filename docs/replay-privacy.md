# Replay Privacy

Opslane session replay is intended for debugging production errors, not for collecting sensitive user content.

By default, applications should mask text input values, password fields, payment fields, and other user-entered secrets before replay data leaves the browser. Teams should also avoid adding breadcrumbs or custom context fields that contain access tokens, credentials, full request bodies, or regulated personal data.

Captured replay data may include page URLs, click/navigation timing, console signals, network status metadata, and masked DOM or screenshot artifacts used to explain what the user saw around an error. Keep retention narrow and review custom SDK configuration before enabling replay on sensitive flows.

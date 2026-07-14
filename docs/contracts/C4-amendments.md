# C4 amendments proposed by Project D (2026-05-30)

These amendments define the public C4 contract. Apply them to the
canonical parent plan and notify Project A (co-owner of C4).

1. Retrieval endpoint is PROJECT-SCOPED:
   GET /api/v1/projects/{projectID}/replays/{replayID}  (session/JWT auth)
   (was: GET /api/v1/replays/{id}). Reuses verifyProjectAccess + matches dashboard routes.

2. recording.json `events` MUST be sorted ascending by `timestamp`.
   `meta.crash_timestamp` is epoch milliseconds, same clock as rrweb event timestamps.

3. rrweb version pin: rrweb@2.0.0-alpha.18, @rrweb/types@2.0.0-alpha.18 -- Project A must match.

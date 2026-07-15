# Reliability harness

This package verifies Opslane orchestration and durable correctness without
judging model-response quality.

## Fast checks

`pnpm --filter @opslane/test-reliability test` runs the read-only invariant
scanner tests. The worker's ordinary suite also runs the provider-protocol and
core fix/delivery tracer.

## Full deterministic success path

Run from the repository root:

```bash
pnpm test:reliability:system
```

The command recreates the disposable `opslane_reliability` database, applies
migrations, runs the worker's real-Postgres queue and lease suite, starts
ingestion on port `18082`, and deliberately does not start the worker poller.
The system test then steps production queue operations directly and proves:

- real ingestion authentication creates one event, group, and investigate job;
- an expired investigate claim is reaped and reclaimed under the same worker ID;
- stale-generation heartbeat, completion, and failure writes are all rejected;
- the recovered claim processes one investigate and one fix job;
- the real agent loop edits a genuinely failing fixture and its test passes;
- the real Git transport pushes one branch;
- real Octokit serialization sends exactly one pull-request request;
- ingestion returns a complete `pr_created` incident;
- both jobs are completed and the invariant scanner returns no violations.

Only provider boundaries are scripted. The Anthropic SDK talks to a local
protocol server, the sandbox transport executes trusted fixture commands in a
disposable directory, Git uses a local bare repository, and GitHub uses a local
recording HTTP server. The local command transport is not a security boundary.

For non-default local ports, set `INGESTION_PORT`. External database or ingestion
endpoints can be supplied explicitly with `RELIABILITY_DATABASE_URL` and
`RELIABILITY_INGESTION_URL`; generic production environment variables are not
reused by the orchestration script.

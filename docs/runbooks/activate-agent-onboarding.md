# Activate agent onboarding

Agent onboarding has two independent activation controls. Change them manually and separately so each has a narrow rollback.

## Preconditions

1. Deploy a build where both the browser and agent GitHub installation flows pass under `AUTH_PROVIDER=workos`.
2. Confirm the legacy GitHub Setup URL handler is non-mutating and redirects users back to the dashboard.
3. Confirm the new ingestion migrations have applied and migration reapplication is green.

## 1. Route GitHub App installs through authorization

In the GitHub App settings, enable **Request user authorization (OAuth) during installation**.

This changes GitHub's post-install behavior: installation callbacks now arrive at the shared OAuth callback with a GitHub authorization code. It also makes the legacy Setup URL inactive. The deployed callback must therefore exchange that code directly with GitHub, verify the installing user, and persist the installation before this setting changes.

Rollback: disable **Request user authorization (OAuth) during installation**. Do not change this setting from CI.

## 2. Expose agent onboarding

After the GitHub App setting is verified in production, enable the agent-onboarding product flag and remove `draft: true` from `docs/quickstart/agent.md` when that page is ready to publish.

This changes product visibility only. It does not change GitHub callback routing.

Rollback: disable the agent-onboarding product flag and restore the documentation draft state. Do not change either from CI.

## Smoke check

Run one browser install and one agent install with hosted WorkOS authentication. Confirm both installation records have matching `installation_landed` audit rows, the agent session reaches its expected terminal state, and no GitHub authorization code is sent to WorkOS.

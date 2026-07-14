# Connecting GitHub

The worker needs GitHub access for two things: cloning the repository during investigation and opening the fix PR. There are two credential modes; pick one.

## Mode 1: personal access token (fastest for self-host)

Create a fine-grained PAT with **Contents: read/write** and **Pull requests: read/write** on the repositories you want Opslane to work on, then:

```bash
export GITHUB_TOKEN=github_pat_...
docker compose up -d
```

That's the whole mode. Suitable for trying things out; the token is a standing credential with your identity, so prefer Mode 2 for a team install.

## Mode 2: GitHub App

A GitHub App gives you short-lived installation tokens scoped to explicitly selected repositories, dashboard sign-in (OAuth), and webhooks.

**Hosted Opslane** already has the App — you just install it: Dashboard → Settings → GitHub → *Install*, which sends you to `github.com/apps/<slug>/installations/new`; pick the repositories; you land back in the dashboard with status connected.

**Self-host** requires creating your own App once (GitHub → Settings → Developer settings → GitHub Apps):

- Permissions: **Contents** read/write, **Pull requests** read/write
- Callback URL: `https://your-instance/auth/github/callback`
- Setup URL: `https://your-instance/api/v1/github/setup`
- Webhook URL: `https://your-instance/api/v1/github/webhook` + a webhook secret

Then provide its identity to both services before `docker compose up`:

```bash
export GITHUB_APP_ID=...
export GITHUB_APP_PRIVATE_KEY="$(cat your-app.private-key.pem)"
export GITHUB_APP_CLIENT_ID=...        # OAuth sign-in
export GITHUB_APP_CLIENT_SECRET=...    # OAuth sign-in
export GITHUB_APP_SLUG=your-app-slug
export GITHUB_WEBHOOK_SECRET=...
export DASHBOARD_ORIGIN=http://localhost:8082   # Compose setup
```

## Point a project at a repository

Each Opslane project maps to one repository: Dashboard → project → Settings → GitHub → choose from the repositories your installation can see. (API: `PUT /api/v1/projects/{projectID}/github` — only the repo name is stored; authentication always comes from the App installation or token at use time.)

## The setup PR

Once connected, Opslane can open a **setup PR** against your repo that adds the SDK initialization for you (Dashboard → project → *Open setup PR*). Merge it, deploy, trigger a test error, and confirm the first event arrives — same flow as the [install guide](../install.md).

## What Opslane will and won't do with this access

Covered precisely in [trust](../architecture/trust.md): clones for investigation, pushes only newly created fix branches (no force pushes, never to existing branches), opens PRs, and never merges. Access failures surface as explicit incident states: `missing_github_token`, `repo_access_denied`, `auth_invalid`, `policy_blocked` — each with remediation ([reason codes](../reference/reason-codes.md)).

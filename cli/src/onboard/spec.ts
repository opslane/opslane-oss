export function renderDetectSpec({ cwd }: { cwd: string }): string {
  return `# Goal

Inspect the repository at ${cwd} and REPORT how @opslane/sdk should be wired in.
You have no edit tools; only read and report. Do not attempt to change any file.

# Investigate

Read the repository and use the secret-aware search tool to determine:
- the one web app to onboard; in a monorepo, select the primary user-facing web app;
- whether the repository is unsupported because it has no web app;
- the selected app's framework and real entry point;
- the environment-variable naming convention and prefix this app actually uses;
- the package manager, based on the repository lock file; and
- any existing error or monitoring SDK, including Sentry, PostHog, @defender-dev/sdk,
  or @opslane/sdk.

If several web apps are genuinely equally plausible, call ask_user with multi:false and
have the user select exactly one. Base every field on what the repository files show.

# Report

Call report_plan exactly once and make no further tool calls afterward.
- If there is no web app to onboard, report status "unsupported" with a concrete reason.
- Otherwise report status "ok" with the complete typed plan.
- Use the repo's own prefix for both Opslane variables. Name them after Opslane, such as
  VITE_OPSLANE_API_KEY or NEXT_PUBLIC_OPSLANE_API_KEY, and never borrow another product's
  name from the repository.
- Provide exact import_line and init_block code plus an exact anchor, position, and
  zero-based occurrence for the entry file. Do not compute any hash; the tool records
  the entry file hash itself.
- Keep Opslane initialization able to coexist with any existing monitoring SDK, and set
  existing_sdk.action to exactly one of:
  - "none" when the repository has no error or monitoring SDK at all (name: null);
  - "keep" when another SDK is present and Opslane should run alongside it (name: that SDK);
  - "migrate" when the named SDK should be replaced by Opslane (name: that SDK);
  - "no_op" only when @opslane/sdk is already installed and nothing should change.
- Never report secret values. Report environment-variable names only.
`;
}

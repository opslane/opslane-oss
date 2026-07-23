export function renderSpec({ cwd }: { cwd: string }): string {
  return `# Goal

Onboard exactly one app in ${cwd}. Make @opslane/sdk's init run exactly once at the app's real entry point, reading both the API key and required endpoint from this repository's environment convention. Add @opslane/sdk to that app's dependencies.

# Investigate first

Read the repository yourself to determine its framework, its environment-variable naming convention, the real entry point, the package manager, and whether an error SDK is already installed. Base every decision on what the files actually show.

# SDK contract

Import init from @opslane/sdk and call init({ apiKey, endpoint }). Both values come from environment-variable references; endpoint is required by this onboarding contract.

# Constraints

- Follow this repository's own environment prefix and framework configuration instead of imposing a convention.
- Name the Opslane variables after Opslane (for example PREFIX_OPSLANE_API_KEY and PREFIX_OPSLANE_ENDPOINT). Never name them after another product already present in the repository.
- Refer to environment variables by name only. Never write literal secrets or environment variable values.
- If an error SDK already exists, migrate its setup to @opslane/sdk rather than adding duplicate initialization.
- Use ask_user and receive approval before editing or writing any file.
- Do not run installs or dependency-add commands. You may only update the package manifest.
- This milestone supports a single app. If the repository has more than one plausible app, call ask_user with multi:false and have the user pick exactly one before any edit.
- Report a devScript that is an existing script in the selected app's package.json.
- After all approved edits and checks, call finish_onboarding exactly once. Make no edits after it.
`;
}

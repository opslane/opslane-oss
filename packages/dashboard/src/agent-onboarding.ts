/**
 * Agent-first onboarding card (design doc: 2026-07-18-agent-first-onboarding-design.md).
 * AGENT_ONBOARDING_ENABLED is the dark-launch switch (decision 13): it ships
 * false and is flipped to true by the activation PR once the CLI is on npm and
 * docs.opslane.com/agent.md is live. There is deliberately no runtime flag
 * system; a one-line diff is the mechanism.
 */
export const AGENT_ONBOARDING_ENABLED = false;

export const HOSTED_ORIGINS = ['https://api.opslane.com', 'https://app.opslane.com'];

const PROMPT =
  'Set up Opslane error monitoring in this repo. Fetch https://docs.opslane.com/agent.md ' +
  'and follow it exactly: run `npx -y @opslane/cli setup --start` to create an account and ' +
  'get an API key (I\'ll complete one GitHub authorization step when you show me the link), ' +
  'then install `@opslane/sdk` and verify the first event arrives.';

/**
 * Self-hosted dashboards prefix the API origin so the agent targets this
 * server, not hosted Opslane. The dashboard is served same-origin by ingestion,
 * so window.location.origin is the API origin.
 */
export function buildAgentPrompt(origin: string): string {
  const normalized = new URL(origin).origin.toLowerCase();
  if (HOSTED_ORIGINS.includes(normalized)) return PROMPT;
  return `OPSLANE_API_URL=${normalized} — ${PROMPT}`;
}

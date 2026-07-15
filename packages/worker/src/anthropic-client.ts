import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/**
 * Builds the shared Anthropic client configuration.
 *
 * The base URL seam keeps the real SDK request serialization, streaming/error
 * behavior, and worker agent loop in deterministic system tests. Production
 * remains on Anthropic's default endpoint unless ANTHROPIC_BASE_URL is set.
 */
export function getAnthropicClientOptions(apiKey: string): ConstructorParameters<typeof Anthropic>[0] {
  const configuredBaseUrl = process.env['ANTHROPIC_BASE_URL']?.trim();
  return {
    apiKey,
    ...(configuredBaseUrl ? { baseURL: configuredBaseUrl } : {}),
  };
}

export function createAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic(getAnthropicClientOptions(apiKey));
}

export function getAnthropicBaseUrl(): string {
  return process.env['ANTHROPIC_BASE_URL']?.trim() || DEFAULT_ANTHROPIC_BASE_URL;
}

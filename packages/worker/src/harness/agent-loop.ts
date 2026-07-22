import { createAnthropicModelPort, toolLoop } from '@opslane/agent-core';
import { createAnthropicClient } from '../anthropic-client.js';
import { getToolSpanAttributes, traceSpan } from '../tracing.js';
import type { AgentCompletionResult, AgentLoopConfig } from './types.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

const MODEL_PRICING: Record<string, {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}> = {
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-sonnet-4-20250514': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.10 },
  'claude-opus-4-6': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.50 },
};
const DEFAULT_PRICING = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 };

export async function runAgentLoop(
  config: AgentLoopConfig,
  userMessage: string,
): Promise<AgentCompletionResult> {
  const client = createAnthropicClient(config.apiKey);
  const model = config.model ?? DEFAULT_MODEL;
  const port = createAnthropicModelPort(client, { maxTokens: 16384 });

  return toolLoop(port, {
    model,
    systemPrompt: config.systemPrompt,
    userMessage,
    maxTurns: config.maxTurns,
    tools: config.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: tool.inputSchema,
      execute: tool.execute,
    })),
    state: config.externalState,
    middleware: config.middleware,
    onEvent: config.onEvent,
    signal: config.abortSignal,
    budgetUsd: config.budgetUsd,
    pricing: MODEL_PRICING[model] ?? DEFAULT_PRICING,
    traceTool: (name, input, execute) => traceSpan(
      `tool:${name}`,
      getToolSpanAttributes(name, input),
      execute,
    ),
  });
}

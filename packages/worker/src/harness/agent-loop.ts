import type Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient } from '../anthropic-client.js';
import { traceSpan, getToolSpanAttributes } from '../tracing.js';
import type {
  AgentLoopConfig,
  AgentCompletionResult,
  AgentState,
  ToolCall,
  ToolResult,
  ToolDefinition,
} from './types.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

const MODEL_PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-sonnet-4-20250514': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.10 },
  'claude-opus-4-6': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.50 },
};
const DEFAULT_PRICING = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 };

/**
 * Mark the last user message block with cache_control so Anthropic caches
 * the entire conversation prefix up to this point. On the next turn the
 * prefix is read from cache at 10% of input price.
 *
 * Only one block gets the marker at a time — previous markers are removed
 * so we stay within the 4-breakpoint limit (1 system + 1 conversation).
 */
function markLastUserMessageForCaching(messages: Anthropic.MessageParam[]): void {
  // Remove previous conversation cache markers
  for (const msg of messages) {
    if (msg.role !== 'user' || typeof msg.content === 'string') continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if ('cache_control' in block) {
        delete (block as unknown as Record<string, unknown>)['cache_control'];
      }
    }
  }

  // Find the last user message and mark its last block
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;

    if (typeof msg.content === 'string') {
      // Convert string content to block array so we can add cache_control
      msg.content = [{
        type: 'text' as const,
        text: msg.content,
        cache_control: { type: 'ephemeral' as const },
      }];
    } else if (Array.isArray(msg.content) && msg.content.length > 0) {
      const lastBlock = msg.content[msg.content.length - 1];
      (lastBlock as unknown as Record<string, unknown>)['cache_control'] = { type: 'ephemeral' };
    }
    break;
  }
}

export async function runAgentLoop(
  config: AgentLoopConfig,
  userMessage: string,
): Promise<AgentCompletionResult> {
  const client = createAnthropicClient(config.apiKey);
  const model = config.model ?? DEFAULT_MODEL;
  const emit = config.onEvent;
  const pricing = MODEL_PRICING[model] ?? DEFAULT_PRICING;

  // Use external state if provided (shared with tool bridge), otherwise create internal
  const state: AgentState = config.externalState ?? {
    turnCount: 0,
    toolCallCount: 0,
    editCounts: new Map(),
    testsRan: false,
    gaveUp: false,
    tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stackTraceFiles: [],
    scopeReviewDone: false,
    toolHistoryEntries: [],
  };

  const anthropicTools = config.tools.map(toAnthropicTool);
  const toolMap = new Map(config.tools.map((t) => [t.name, t]));

  // Explicit cache_control on system prompt — always cached
  const systemMessages: Anthropic.TextBlockParam[] = [{
    type: 'text',
    text: config.systemPrompt,
    cache_control: { type: 'ephemeral' },
  }];

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMessage }];

  let lastAssistantText = '';

  while (state.turnCount < config.maxTurns) {
    state.turnCount++;
    emit({ type: 'turn_start', turnNumber: state.turnCount });

    if (config.abortSignal?.aborted) {
      emit({ type: 'error', code: 'CANCELLED', message: 'Run was cancelled' });
      return toResult(false, 'Cancelled', state);
    }

    let response: Anthropic.Message;
    try {
      // Mark the last user message with cache_control so the conversation
      // prefix (system + tools + all prior messages) is cached incrementally.
      // Each turn, everything up to this breakpoint is a cache read at 10%
      // of input price; only the new content after it is a cache write.
      markLastUserMessageForCaching(messages);

      response = await client.messages.create(
        {
          model,
          max_tokens: 16384,
          system: systemMessages,
          messages,
          tools: anthropicTools,
        },
        { signal: config.abortSignal },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: 'error', code: classifyApiError(err), message });
      return toResult(false, message, state);
    }

    state.tokenUsage.input += response.usage.input_tokens;
    state.tokenUsage.output += response.usage.output_tokens;
    state.tokenUsage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
    state.tokenUsage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0;

    // Budget check
    if (config.budgetUsd != null) {
      const cost =
        (state.tokenUsage.input / 1_000_000) * pricing.input +
        (state.tokenUsage.output / 1_000_000) * pricing.output +
        (state.tokenUsage.cacheWrite / 1_000_000) * pricing.cacheWrite +
        (state.tokenUsage.cacheRead / 1_000_000) * pricing.cacheRead;
      if (cost > config.budgetUsd) {
        emit({ type: 'error', code: 'BUDGET_EXCEEDED', message: `Budget exceeded: $${cost.toFixed(4)} > $${config.budgetUsd}` });
        return toResult(false, 'Budget exceeded', state);
      }
    }

    const toolCalls: { id: string; name: string; input: Record<string, unknown> }[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        lastAssistantText = block.text;
        emit({ type: 'message', content: block.text });
      } else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, input: block.input as Record<string, unknown> });
        emit({ type: 'tool_call', id: block.id, name: block.name, input: block.input as Record<string, unknown> });
      }
    }

    messages.push({ role: 'assistant', content: response.content });

    // No tool calls — model is done
    if (response.stop_reason === 'end_turn' || toolCalls.length === 0) {
      if (config.middleware?.preCompletion) {
        const check = await config.middleware.preCompletion(state);
        if (check?.inject) {
          messages.push({ role: 'user', content: check.inject });
          emit({ type: 'turn_end', turnNumber: state.turnCount, tokenUsage: { ...state.tokenUsage } });
          continue;
        }
      }

      emit({ type: 'completed', summary: lastAssistantText });
      emit({ type: 'turn_end', turnNumber: state.turnCount, tokenUsage: { ...state.tokenUsage } });
      return toResult(true, lastAssistantText, state);
    }

    // Execute tool calls
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const tc of toolCalls) {
      state.toolCallCount++;
      state.toolHistoryEntries.push({ name: tc.name, input: tc.input });
      const tool = toolMap.get(tc.name);

      if (!tool) {
        const errOutput = `Error: Unknown tool "${tc.name}"`;
        emit({ type: 'tool_result', id: tc.id, name: tc.name, output: errOutput, isError: true });
        toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: errOutput, is_error: true });
        continue;
      }

      // Pre-tool middleware
      if (config.middleware?.preTool) {
        const call: ToolCall = { id: tc.id, name: tc.name, input: tc.input };
        const pre = await config.middleware.preTool(call, state);
        if (pre?.allow === false) {
          const blocked = pre.inject ?? 'Tool call blocked by middleware.';
          emit({ type: 'tool_result', id: tc.id, name: tc.name, output: blocked, isError: true });
          toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: blocked, is_error: true });
          continue;
        }
      }

      let output: string;
      let isError = false;
      try {
        output = await traceSpan(
          `tool:${tc.name}`,
          getToolSpanAttributes(tc.name, tc.input),
          () => tool.execute(tc.input),
        );
      } catch (err) {
        output = `Error: ${err instanceof Error ? err.message : String(err)}`;
        isError = true;
      }

      emit({ type: 'tool_result', id: tc.id, name: tc.name, output, isError });
      toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: output, is_error: isError });

      // Post-tool middleware
      if (config.middleware?.postTool) {
        const call: ToolCall = { id: tc.id, name: tc.name, input: tc.input };
        const toolResult: ToolResult = { id: tc.id, output, isError };
        await config.middleware.postTool(call, toolResult, state);
      }

      // Early exit if agent gave up (give_up tool sets state.gaveUp)
      if (state.gaveUp) {
        emit({ type: 'completed', summary: state.giveUpReason?.reason_message ?? 'Agent gave up' });
        emit({ type: 'turn_end', turnNumber: state.turnCount, tokenUsage: { ...state.tokenUsage } });
        return toResult(true, state.giveUpReason?.reason_message ?? 'Agent gave up', state);
      }
    }

    messages.push({ role: 'user', content: toolResults });
    emit({ type: 'turn_end', turnNumber: state.turnCount, tokenUsage: { ...state.tokenUsage } });
  }

  emit({ type: 'error', code: 'MAX_TURNS_EXCEEDED', message: `Reached maximum of ${config.maxTurns} turns` });
  return toResult(false, lastAssistantText || 'Max turns exceeded', state);
}

function toResult(success: boolean, summary: string, state: AgentState): AgentCompletionResult {
  return {
    success,
    summary,
    toolCallCount: state.toolCallCount,
    turnCount: state.turnCount,
    testsRan: state.testsRan,
    tokenUsage: { ...state.tokenUsage },
    toolHistory: state.toolHistoryEntries,
  };
}

function toAnthropicTool(tool: ToolDefinition): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  };
}

function classifyApiError(err: unknown): string {
  if (!(err instanceof Error)) return 'AGENT_CRASHED';
  const msg = err.message.toLowerCase();
  if (msg.includes('rate') || msg.includes('429')) return 'API_RATE_LIMITED';
  if (msg.includes('auth') || msg.includes('401') || msg.includes('invalid api key')) return 'API_KEY_INVALID';
  if (msg.includes('timeout') || msg.includes('timed out')) return 'TIMEOUT';
  return 'AGENT_CRASHED';
}

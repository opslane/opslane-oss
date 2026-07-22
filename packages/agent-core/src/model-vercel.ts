import { createOpenAICompatible, type OpenAICompatibleProviderSettings } from '@ai-sdk/openai-compatible';
import {
  generateText,
  jsonSchema,
  tool,
  type AssistantContent,
  type LanguageModel,
  type ModelMessage as VercelMessage,
  type ToolSet,
} from 'ai';
import type { ModelMessage, ModelPort, ModelRequest, ToolUsePart } from './model-port.js';

export interface VercelModelPortOptions {
  resolve(model: string): LanguageModel;
}

export interface OpenAICompatibleResolverOptions
  extends Omit<OpenAICompatibleProviderSettings, 'name'> {
  name?: string;
}

export function createOpenAICompatibleModelResolver(
  options: OpenAICompatibleResolverOptions,
): (model: string) => LanguageModel {
  const provider = createOpenAICompatible({
    ...options,
    name: options.name ?? 'opslane-proxy',
  });
  return (model) => provider.languageModel(model);
}

export function createVercelModelPort(options: VercelModelPortOptions): ModelPort {
  return {
    async generate(request) {
      const result = await generateText({
        model: options.resolve(request.model),
        abortSignal: request.signal,
        system: request.system.map((block) => block.text).join('\n\n'),
        messages: toVercelMessages(request.messages),
        tools: toVercelTools(request),
      });

      const content = [] as Array<{ type: 'text'; text: string } | ToolUsePart>;
      for (const part of result.content) {
        if (part.type === 'text') content.push({ type: 'text', text: part.text });
        if (part.type === 'tool-call') {
          content.push({
            type: 'tool_use',
            id: part.toolCallId,
            name: part.toolName,
            input: asRecord(part.input),
          });
        }
      }

      return {
        content,
        usage: {
          inputTokens: result.usage.inputTokenDetails.noCacheTokens ?? result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
          cacheReadTokens: result.usage.inputTokenDetails.cacheReadTokens ?? 0,
          cacheWriteTokens: result.usage.inputTokenDetails.cacheWriteTokens ?? 0,
        },
        stopReason: result.finishReason === 'tool-calls'
          ? 'tool_use'
          : result.finishReason === 'stop' ? 'end_turn' : result.finishReason,
      };
    },
  };
}

function toVercelTools(request: ModelRequest): ToolSet {
  return Object.fromEntries(request.tools.map((spec) => [
    spec.name,
    tool({
      description: spec.description,
      inputSchema: jsonSchema(spec.schema),
    }),
  ]));
}

function toVercelMessages(messages: ModelMessage[]): VercelMessage[] {
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === 'tool_use') toolNames.set(part.id, part.name);
    }
  }

  return messages.flatMap((message): VercelMessage[] => {
    if (message.role === 'assistant') {
      const content: Exclude<AssistantContent, string> = [];
      for (const part of message.content) {
        if (part.type === 'text') content.push({ type: 'text', text: part.text });
        if (part.type === 'tool_use') {
          content.push({
            type: 'tool-call',
            toolCallId: part.id,
            toolName: part.name,
            input: part.input,
          });
        }
      }
      return [{
        role: 'assistant',
        content,
      }];
    }

    const output: VercelMessage[] = [];
    const textParts = message.content.filter((part) => part.type === 'text');
    if (textParts.length > 0) {
      output.push({
        role: 'user',
        content: textParts.map((part) => ({ type: 'text', text: part.text })),
      });
    }
    const resultParts = message.content.filter((part) => part.type === 'tool_result');
    if (resultParts.length > 0) {
      output.push({
        role: 'tool',
        content: resultParts.map((part) => ({
          type: 'tool-result',
          toolCallId: part.toolUseId,
          toolName: toolNames.get(part.toolUseId) ?? 'unknown',
          output: part.isError
            ? { type: 'error-text', value: part.output }
            : { type: 'text', value: part.output },
        })),
      });
    }
    return output;
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

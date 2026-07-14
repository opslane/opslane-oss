/**
 * OpenTelemetry tracing with Langfuse exporter for agent harness observability.
 *
 * Graceful degradation: if LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY are not set,
 * all exports are no-ops with zero overhead.
 *
 * Must call initTracing() before any `new Anthropic()` instantiation so that
 * manuallyInstrument() patches the class prototype in time.
 */

// @opentelemetry/api is the lightweight facade (~50KB) — always loaded so that
// traceSpan/withJobTrace can reference SpanStatusCode without dynamic imports.
// The heavy SDK + Langfuse + instrumentation packages are loaded lazily in initTracing().
import { trace, SpanStatusCode, context, type Tracer, type Span } from '@opentelemetry/api';

let sdk: { shutdown(): Promise<void> } | null = null;
let tracer: Tracer | null = null;

/**
 * Initialize OpenTelemetry tracing with Langfuse exporter.
 * No-op if LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY is not set.
 * Must be awaited before any `new Anthropic()` call.
 */
export async function initTracing(): Promise<void> {
  const publicKey = process.env['LANGFUSE_PUBLIC_KEY'];
  const secretKey = process.env['LANGFUSE_SECRET_KEY'];
  if (!publicKey || !secretKey) return;

  // Dynamic imports to avoid loading the heavy OTel SDK, Langfuse exporter,
  // and Anthropic instrumentation when tracing is disabled.
  const [{ NodeSDK }, { LangfuseSpanProcessor }, { AnthropicInstrumentation }, AnthropicModule] =
    await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@langfuse/otel'),
      import('@arizeai/openinference-instrumentation-anthropic'),
      import('@anthropic-ai/sdk'),
    ]);

  const instrumentation = new AnthropicInstrumentation();
  instrumentation.manuallyInstrument(AnthropicModule.default ?? AnthropicModule);

  const nodeSdk = new NodeSDK({
    spanProcessors: [new LangfuseSpanProcessor({
      flushAt: 50,
      flushInterval: 5, // seconds
    })],
    instrumentations: [instrumentation],
  });
  nodeSdk.start();

  sdk = nodeSdk;
  tracer = trace.getTracer('opslane-worker');
}

/**
 * Flush pending spans and shut down OTel SDK.
 * Times out after 5s to avoid blocking worker shutdown.
 */
export async function shutdownTracing(): Promise<void> {
  if (!sdk) return;
  try {
    await Promise.race([
      sdk.shutdown(),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Tracing shutdown timeout')), 5000);
        timer.unref(); // Don't block process exit
      }),
    ]);
  } catch {
    // Best effort — do not block worker shutdown
  }
}

/**
 * Wrap a job execution in a root OTel trace with job metadata.
 * No-op pass-through if tracing is not initialized.
 */
export async function withJobTrace<T>(
  jobId: string,
  errorGroupId: string,
  projectId: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!tracer) return fn();
  return tracer.startActiveSpan('process-job', async (span: Span) => {
    span.setAttribute('job.id', jobId);
    span.setAttribute('job.error_group_id', errorGroupId);
    span.setAttribute('job.project_id', projectId);
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Wrap an async function in a child OTel span with attributes.
 * No-op pass-through if tracing is not initialized.
 */
export async function traceSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: () => Promise<T>,
): Promise<T> {
  if (!tracer) return fn();
  return tracer.startActiveSpan(name, async (span: Span) => {
    for (const [key, value] of Object.entries(attributes)) {
      span.setAttribute(key, value);
    }
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Returns the trace ID of the currently active span, or null if no span is active.
 */
export function getActiveTraceId(): string | null {
  const span = trace.getSpan(context.active());
  return span?.spanContext().traceId ?? null;
}

/**
 * Constructs a Langfuse trace URL from a trace ID.
 * Returns null if LANGFUSE_BASE_URL or LANGFUSE_PROJECT_ID env vars are missing.
 */
export function buildLangfuseTraceUrl(traceId: string): string | null {
  const baseUrl = process.env['LANGFUSE_BASE_URL'];
  const projectId = process.env['LANGFUSE_PROJECT_ID'];
  if (!baseUrl || !projectId) return null;
  return `${baseUrl}/project/${projectId}/traces/${traceId}`;
}

/**
 * Extract safe-to-log span attributes for a tool call.
 * Never includes raw file content, bash output, or write content.
 */
export function getToolSpanAttributes(
  toolName: string,
  input: Record<string, unknown>,
  output?: string,
  isError?: boolean,
): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {
    'tool.name': toolName,
  };
  if (output !== undefined) attrs['tool.output_length'] = output.length;
  if (isError !== undefined) attrs['tool.is_error'] = isError;

  switch (toolName) {
    case 'read':
    case 'write':
    case 'edit':
      if (typeof input['path'] === 'string') attrs['tool.file_path'] = input['path'];
      break;
    case 'bash':
      if (typeof input['command'] === 'string') {
        attrs['tool.command'] = input['command'].slice(0, 200);
      }
      break;
    case 'search':
      if (typeof input['pattern'] === 'string') attrs['tool.pattern'] = input['pattern'];
      if (typeof input['path'] === 'string') attrs['tool.search_path'] = input['path'];
      break;
    case 'read_many':
      if (Array.isArray(input['paths'])) {
        attrs['tool.paths'] = (input['paths'] as string[]).map(String).join(', ');
      }
      break;
    case 'patch':
      break;
    case 'give_up':
      if (typeof input['reason_code'] === 'string') attrs['tool.reason_code'] = input['reason_code'];
      break;
  }

  return attrs;
}

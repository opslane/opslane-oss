import { pollSessionOnce, type PollResult } from '../agent-protocol.js';

export interface WaitOptions {
  apiUrl: string;
  sessionId: string;
  pollToken: string;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxUnreachable?: number;
  nowFn?: () => number;
}

const WAITING = new Set(['pending', 'provisioned', 'key_ok']);

export async function waitForAppReporting(options: WaitOptions): Promise<PollResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const sleepFn = options.sleepFn
    ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.nowFn ?? Date.now;
  const interval = options.pollIntervalMs ?? 3_000;
  const deadline = now() + (options.timeoutMs ?? 15 * 60_000);
  const maxUnreachable = options.maxUnreachable ?? 20;
  let unreachable = 0;

  async function pause(ms: number): Promise<void> {
    const remaining = deadline - now();
    if (remaining > 0) await sleepFn(Math.min(ms, remaining));
  }

  while (now() < deadline) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remaining);
    const result = await pollSessionOnce({
      apiUrl: options.apiUrl,
      sessionId: options.sessionId,
      pollToken: options.pollToken,
      fetchFn,
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (result.status === 'app_reporting' || result.status === 'completed') return result;
    if (result.status === 'failed') {
      throw new Error(
        `onboarding session failed: ${result.failureReason ?? result.message ?? 'unknown'}`,
      );
    }
    if (result.status === 'expired') {
      throw new Error(
        `session ${options.sessionId} expired — re-run onboarding to mint a new key`,
      );
    }
    if (result.status === 'not_found') {
      throw new Error(`session ${options.sessionId} was not found — re-run onboarding`);
    }
    if (result.status === 'internal_error' || result.status === 'unknown') {
      throw new Error(
        `server error while waiting: ${'message' in result ? result.message ?? 'unknown' : 'unknown'}`,
      );
    }
    if (result.status === 'unreachable') {
      unreachable += 1;
      if (unreachable >= maxUnreachable) {
        throw new Error(
          `API unreachable after ${unreachable} attempts while waiting for session ${options.sessionId}`,
        );
      }
      await pause(Math.min(interval * unreachable, 30_000));
      continue;
    }
    unreachable = 0;
    if (result.status === 'rate_limited') {
      await pause((result.retryAfterSeconds ?? 60) * 1_000);
      continue;
    }
    if (WAITING.has(result.status)) {
      await pause(interval);
      continue;
    }
  }
  throw new Error(
    `timed out waiting for your app to report (session ${options.sessionId}). `
      + 'Start your app, then re-run onboarding — it will resume this session.',
  );
}

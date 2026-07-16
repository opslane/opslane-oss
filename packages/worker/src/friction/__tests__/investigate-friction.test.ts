import { describe, expect, it, vi } from 'vitest';
import type { ErrorGroupData } from '../../db.js';

const mockMessagesCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockMessagesCreate },
  })),
}));
vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { investigateFriction } = await import('../investigate-friction.js');

function group(): ErrorGroupData {
  return {
    id: 'g1', title: 'Rage click on save', fingerprint: 'fp', sample_event_id: '',
    occurrence_count: 1, status: 'queued', kind: 'friction',
    signal_type: 'rage_click', element_selector: '[data-testid="save"]',
    page_url_normalized: 'https://app.example.com/checkout/:id', confidence: null,
  };
}

function classifyResponse(input: Record<string, unknown>) {
  return { content: [{ type: 'tool_use', id: 'c1', name: 'classify_friction', input }] };
}

describe('investigateFriction', () => {
  // No shared beforeEach: each test fully replaces the mock behavior below, and a
  // vi.fn that throws synchronously under a beforeEach hook is surfaced by vitest
  // as a test error even when the code under test catches it.
  it('rethrows infrastructure failures so the poller can retry (never buries as insight)', async () => {
    mockMessagesCreate.mockReset();
    mockMessagesCreate.mockRejectedValue(new Error('429 rate limited'));

    await expect(investigateFriction('key', group(), null, '/tmp/repo')).rejects.toThrow(
      /Friction investigation API call failed: 429 rate limited/,
    );
  });

  it('routes a genuine classification through without throwing', async () => {
    mockMessagesCreate.mockResolvedValue(
      classifyResponse({ codeCause: true, confidence: 'high', reason: 'dead handler', remediation: 'wire it' }),
    );

    const result = await investigateFriction('key', group(), null, '/tmp/repo');
    expect(result).toMatchObject({ codeCause: true, confidence: 'high', remediation: 'wire it' });
  });

  it('clamps an unknown confidence to low and never invents codeCause on a malformed result', async () => {
    mockMessagesCreate.mockResolvedValue(
      classifyResponse({ codeCause: 'yes', confidence: 'bogus', reason: '' }),
    );

    const result = await investigateFriction('key', group(), null, '/tmp/repo');
    expect(result.codeCause).toBe(false);
    expect(result.confidence).toBe('low');
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

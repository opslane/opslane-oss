import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AdjudicationInput, Adjudicator } from '../adjudicator.js';

const mockPoolQuery = vi.fn();
const mockClient = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() };
vi.mock('../../db.js', () => ({
  getPool: () => ({ query: mockPoolQuery, connect: async () => mockClient }),
}));

type LooseAsyncMock = ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;
const looseAsyncMock = (): LooseAsyncMock =>
  vi.fn<(...args: unknown[]) => Promise<unknown>>();

const db = {
  findFoldTarget: looseAsyncMock(),
  claimSignalsForAdjudication: looseAsyncMock(),
  applyFoldOutcome: looseAsyncMock(),
  countEligibleUsers: looseAsyncMock(),
  listEligibleSignals: looseAsyncMock(),
  ensureCandidate: looseAsyncMock(),
  claimGeneration: looseAsyncMock(),
  findValidAcceptedGeneration: looseAsyncMock(),
  attachInheritedSignal: looseAsyncMock(),
  applyBucketOutcome: looseAsyncMock(),
};
vi.mock('../promotion-db.js', () => ({
  findFoldTarget: (...a: unknown[]) => db.findFoldTarget(...a),
  claimSignalsForAdjudication: (...a: unknown[]) => db.claimSignalsForAdjudication(...a),
  applyFoldOutcome: (...a: unknown[]) => db.applyFoldOutcome(...a),
  countEligibleUsers: (...a: unknown[]) => db.countEligibleUsers(...a),
  listEligibleSignals: (...a: unknown[]) => db.listEligibleSignals(...a),
  ensureCandidate: (...a: unknown[]) => db.ensureCandidate(...a),
  claimGeneration: (...a: unknown[]) => db.claimGeneration(...a),
  findValidAcceptedGeneration: (...a: unknown[]) => db.findValidAcceptedGeneration(...a),
  attachInheritedSignal: (...a: unknown[]) => db.attachInheritedSignal(...a),
  applyBucketOutcome: (...a: unknown[]) => db.applyBucketOutcome(...a),
}));

import { processFrictionOutcomes } from '../promotion.js';

const SESSION = {
  id: 'sess-1',
  project_id: 'proj-1',
  environment_id: 'env-1',
  end_user_id: 'eu-1',
  status: 'analyzing',
};

function signalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: `sig-${Math.random().toString(36).slice(2, 8)}`,
    project_id: 'proj-1',
    environment_id: 'env-1',
    end_user_id: 'eu-1',
    session_id: 'sess-1',
    fingerprint: 'fp-1',
    occurred_at: '2026-07-15T12:00:00Z',
    signal_type: 'rage_click',
    page_url_normalized: '/checkout',
    element_selector: 'INJECT<script>alert(1)</script>',
    occurrence_count: 3,
    rule_version: 1,
    ...overrides,
  };
}

function stubAdjudicator(accepted = true): Adjudicator & { calls: AdjudicationInput[] } {
  const calls: AdjudicationInput[] = [];
  return {
    modelId: 'stub',
    promptVersion: 1,
    calls,
    async adjudicate(input) {
      calls.push(input);
      return { accepted, reason: 'stubbed' };
    },
  };
}

function setPendingSignals(rows: Record<string, unknown>[]): void {
  mockPoolQuery.mockResolvedValue({ rows });
}

const logLines: string[] = [];
vi.mock('../../logger.js', () => ({
  logger: {
    info: (msg: string, meta?: object) => logLines.push(JSON.stringify({ msg, ...meta })),
    warn: (msg: string, meta?: object) => logLines.push(JSON.stringify({ msg, ...meta })),
    error: (msg: string, meta?: object) => logLines.push(JSON.stringify({ msg, ...meta })),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  logLines.length = 0;
  db.findFoldTarget.mockResolvedValue(null);
  db.claimSignalsForAdjudication.mockResolvedValue(1);
  db.applyFoldOutcome.mockResolvedValue('attached');
  db.countEligibleUsers.mockResolvedValue(0);
  db.listEligibleSignals.mockResolvedValue({ ids: [], totalOccurrences: 0 });
  db.ensureCandidate.mockResolvedValue('candidate-id');
  db.claimGeneration.mockResolvedValue(null);
  db.findValidAcceptedGeneration.mockResolvedValue(null);
  db.attachInheritedSignal.mockResolvedValue('attached');
  db.applyBucketOutcome.mockResolvedValue('promoted');
});

describe('processFrictionOutcomes', () => {
  it('adjudicates eagerly when a fold target exists (one call, fold scope)', async () => {
    const sig = signalRow();
    setPendingSignals([sig]);
    db.findFoldTarget.mockResolvedValue({ errorGroupId: 'g1', status: 'queued', title: 'boom', secondsAway: 5 });
    const adjudicator = stubAdjudicator(true);

    await processFrictionOutcomes(SESSION, 'job-1', adjudicator);

    expect(adjudicator.calls).toHaveLength(1);
    expect(adjudicator.calls[0]!.scope).toBe('fold');
    expect(db.claimSignalsForAdjudication).toHaveBeenCalledWith(expect.anything(), [sig.id], 'job-1');
    expect(db.applyFoldOutcome).toHaveBeenCalledTimes(1);
    expect(db.applyBucketOutcome).not.toHaveBeenCalled();
  });

  it('below threshold with no fold target: no model call, candidate ensured', async () => {
    setPendingSignals([signalRow()]);
    db.countEligibleUsers.mockResolvedValue(3);
    const adjudicator = stubAdjudicator();

    await processFrictionOutcomes(SESSION, 'job-1', adjudicator);

    expect(adjudicator.calls).toHaveLength(0);
    expect(db.ensureCandidate).toHaveBeenCalledTimes(1);
    expect(db.claimGeneration).not.toHaveBeenCalled();
  });

  it('at five users: exactly one bucket call through the claimed generation', async () => {
    const sig = signalRow();
    setPendingSignals([sig]);
    db.countEligibleUsers.mockResolvedValue(5);
    db.listEligibleSignals.mockResolvedValue({ ids: [sig.id, 'a', 'b', 'c', 'd'], totalOccurrences: 11 });
    db.claimGeneration.mockResolvedValue({ id: 'gen-1', status: 'adjudicating', claim_job_id: 'job-1', model_id: null, prompt_version: 1, promoted_incident_id: null });
    const adjudicator = stubAdjudicator(true);

    await processFrictionOutcomes(SESSION, 'job-1', adjudicator);

    expect(adjudicator.calls).toHaveLength(1);
    expect(adjudicator.calls[0]!.scope).toBe('bucket');
    expect(adjudicator.calls[0]!.bucketSummary).toEqual({ distinctUsers: 5, totalOccurrences: 11, windowDays: 7 });
    expect(db.applyBucketOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ generationId: 'gen-1' })
    );
  });

  it('loses the generation race: no model call', async () => {
    setPendingSignals([signalRow()]);
    db.countEligibleUsers.mockResolvedValue(5);
    db.claimGeneration.mockResolvedValue(null);
    const adjudicator = stubAdjudicator();

    await processFrictionOutcomes(SESSION, 'job-1', adjudicator);
    expect(adjudicator.calls).toHaveLength(0);
    expect(db.applyBucketOutcome).not.toHaveBeenCalled();
  });

  it('inherits a valid accepted generation without a model call', async () => {
    const sig = signalRow();
    setPendingSignals([sig]);
    const gen = { id: 'gen-9', status: 'accepted', claim_job_id: 'j', model_id: 'm', prompt_version: 1, promoted_incident_id: 'inc-1' };
    db.findValidAcceptedGeneration.mockResolvedValue(gen);
    const adjudicator = stubAdjudicator();

    await processFrictionOutcomes(SESSION, 'job-1', adjudicator);

    expect(adjudicator.calls).toHaveLength(0);
    expect(db.attachInheritedSignal).toHaveBeenCalledWith(
      expect.objectContaining({ id: sig.id }),
      gen
    );
  });

  it('anonymous signals: fold path allowed, bucket path skipped entirely', async () => {
    const anonFold = signalRow({ end_user_id: null, fingerprint: 'fp-fold' });
    const anonBucket = signalRow({ end_user_id: null, fingerprint: 'fp-bucket' });
    setPendingSignals([anonFold, anonBucket]);
    db.findFoldTarget.mockImplementation(async (_c: unknown, _p: unknown, _s: unknown) => null);
    db.findFoldTarget
      .mockResolvedValueOnce({ errorGroupId: 'g1', status: 'queued', title: 'boom', secondsAway: 2 })
      .mockResolvedValueOnce(null);
    const adjudicator = stubAdjudicator(true);

    await processFrictionOutcomes(SESSION, 'job-1', adjudicator);

    // One eager fold call for the first anonymous signal; the second anonymous
    // signal reaches neither threshold counting nor candidate creation.
    expect(adjudicator.calls).toHaveLength(1);
    expect(db.countEligibleUsers).not.toHaveBeenCalled();
    expect(db.ensureCandidate).not.toHaveBeenCalled();
  });

  it('adjudicator failures propagate so the job retry/dead-letter path owns them', async () => {
    setPendingSignals([signalRow()]);
    db.findFoldTarget.mockResolvedValue({ errorGroupId: 'g1', status: 'queued', title: 'boom', secondsAway: 2 });
    const adjudicator: Adjudicator = {
      modelId: 'stub',
      promptVersion: 1,
      adjudicate: async () => {
        throw new Error('model unavailable');
      },
    };

    await expect(processFrictionOutcomes(SESSION, 'job-1', adjudicator)).rejects.toThrow(
      'model unavailable'
    );
  });

  it('logs carry ids but never raw selector text', async () => {
    const sig = signalRow();
    setPendingSignals([sig]);
    db.findFoldTarget.mockResolvedValue({ errorGroupId: 'g1', status: 'queued', title: 'boom', secondsAway: 2 });
    await processFrictionOutcomes(SESSION, 'job-1', stubAdjudicator(true));

    const combined = logLines.join('\n');
    expect(combined).toContain(sig.id);
    expect(combined).not.toContain('INJECT<script>');
  });
});

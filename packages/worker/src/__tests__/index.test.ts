import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClaimedJob, ErrorGroupData, ErrorEventData, ProjectData } from '../db.js';

// index.ts is the worker entrypoint: it imports the whole world and calls main()
// at module load. We mock every dependency so importing it is side-effect free,
// and main() is guarded behind !process.env.VITEST so the poller/servers never
// boot here. The ONE module we deliberately leave real is harness/stack-trace-utils
// (hasNoAppFrames) — that's the decision under test.
vi.mock('../db.js', () => ({
  LeaseLostError: class LeaseLostError extends Error {},
  getErrorGroup: vi.fn(),
  getErrorEvent: vi.fn(),
  getProject: vi.fn(),
  getProjectGitHubInstallation: vi.fn(),
  updateGroupStatus: vi.fn(),
  updateGroupInvestigation: vi.fn(),
  updateGroupAndCreateFixJob: vi.fn(),
  getGroupInvestigation: vi.fn(),
  getReplayForGroup: vi.fn(),
  getSessionPointerForGroup: vi.fn(),
  getPlayableChunkMetas: vi.fn(),
  getReplayArtifacts: vi.fn(),
  getSourceMaps: vi.fn(),
  requeueStaleJobs: vi.fn(),
  resolveSilentMergedGroups: vi.fn(),
  updateJobTraceUrl: vi.fn(),
  closePool: vi.fn(),
  getFrictionSignalsForGroup: vi.fn(),
  getScrubbedChunksForSession: vi.fn(),
  getSessionForAnalysis: vi.fn(),
  setSessionAnalysisStatus: vi.fn(),
  assertJobLease: vi.fn(),
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  setWorkerId: vi.fn(),
}));
vi.mock('../repo-clone.js', () => ({
  cloneRepo: vi.fn(),
  buildRepoUrl: vi.fn((githubRepo: string) => `https://github.com/${githubRepo}.git`),
}));
vi.mock('../minio-client.js', () => ({ fetchObject: vi.fn(), getMinIOConfig: vi.fn(() => null) }));
vi.mock('../investigate.js', () => ({ investigateError: vi.fn() }));
vi.mock('../pipeline.js', () => ({ runPipeline: vi.fn() }));
vi.mock('../poller.js', () => ({ createPoller: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })) }));
vi.mock('../github-app.js', () => ({ getInstallationToken: vi.fn() }));
vi.mock('../setup-pr.js', () => ({ processSetupPrJob: vi.fn() }));
vi.mock('../pr.js', () => ({}));
vi.mock('../source-map.js', () => ({ parseStackFrames: vi.fn(() => []), resolveFrame: vi.fn() }));
vi.mock('../tracing.js', () => ({
  initTracing: vi.fn(),
  shutdownTracing: vi.fn(),
  withJobTrace: vi.fn(),
  getActiveTraceId: vi.fn(() => null),
  buildLangfuseTraceUrl: vi.fn(() => null),
}));
vi.mock('../visual-analysis.js', () => ({ runVisualAnalysis: vi.fn() }));
vi.mock('../friction/friction-evidence.js', () => ({ gatherFrictionEvidence: vi.fn() }));
vi.mock('../friction/investigate-friction.js', () => ({ investigateFriction: vi.fn() }));
vi.mock('../friction/chunk-reader.js', () => ({ readChunksBounded: vi.fn() }));
vi.mock('../friction/analyzer.js', () => ({ analyzeSession: vi.fn(), RULE_VERSION: 1 }));
vi.mock('../friction/persist.js', () => ({ writeFrictionSignals: vi.fn() }));
vi.mock('../friction/promotion.js', () => ({ processFrictionOutcomes: vi.fn() }));
vi.mock('../friction/adjudicator.js', () => ({
  createAnthropicAdjudicator: vi.fn(() => ({ modelId: 'real', promptVersion: 1, adjudicate: vi.fn() })),
}));

const db = await import('../db.js');
const { cloneRepo } = await import('../repo-clone.js');
const { runPipeline } = await import('../pipeline.js');
const { processJobInner, processInvestigateJob, processFixJob, processSessionAnalysisJob } = await import('../index.js');
const { gatherFrictionEvidence } = await import('../friction/friction-evidence.js');
const { investigateFriction } = await import('../friction/investigate-friction.js');
const { readChunksBounded } = await import('../friction/chunk-reader.js');
const { analyzeSession } = await import('../friction/analyzer.js');
const { writeFrictionSignals } = await import('../friction/persist.js');
const { processFrictionOutcomes } = await import('../friction/promotion.js');

const mockGetErrorGroup = vi.mocked(db.getErrorGroup);
const mockGetErrorEvent = vi.mocked(db.getErrorEvent);
const mockGetProject = vi.mocked(db.getProject);
const mockUpdateGroupStatus = vi.mocked(db.updateGroupStatus);
const mockCloneRepo = vi.mocked(cloneRepo);
const mockRunPipeline = vi.mocked(runPipeline);
const mockGetSessionPointerForGroup = vi.mocked(db.getSessionPointerForGroup);
const mockGetPlayableChunkMetas = vi.mocked(db.getPlayableChunkMetas);

function makeJob(): ClaimedJob & { errorGroupId: string } {
  return {
    id: 'job-1',
    workerId: 'worker-1',
    errorGroupId: 'grp-1',
    sourceId: null,
    projectId: 'proj-1',
    jobType: 'investigate',
    attempts: 0,
    guidance: null,
    leaseGeneration: '1',
    triggeredBy: null,
    sessionId: null,
  };
}

function makeGroup(overrides?: Partial<ErrorGroupData>): ErrorGroupData {
  return {
    id: 'grp-1',
    title: 'Script error.',
    fingerprint: 'fp-1',
    sample_event_id: 'evt-1',
    occurrence_count: 3,
    status: 'queued',
    kind: 'error',
    signal_type: null,
    element_selector: null,
    page_url_normalized: null,
    ...overrides,
  };
}

function makeEvent(stack: string): ErrorEventData {
  return {
    id: 'evt-1',
    error_type: 'Error',
    error_message: 'Script error.',
    stack_trace_raw: stack,
    stack_trace_resolved: null,
    breadcrumbs: '[]',
    context: '{}',
    release: null,
    session_id: null,
  };
}

/** The needs_human call carrying the unfixable_no_app_frames disposition, if any. */
function unfixableCall() {
  return mockUpdateGroupStatus.mock.calls.find(
    (c) => c[2] === 'needs_human' && c[3]?.reason?.reason_code === 'unfixable_no_app_frames',
  );
}

describe('processInvestigateJob — pre-clone guard for stackless errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionPointerForGroup.mockResolvedValue(null);
  });

  it('short-circuits a stackless event to needs_human WITHOUT cloning the repo', async () => {
    mockGetErrorGroup.mockResolvedValue(makeGroup());
    mockGetErrorEvent.mockResolvedValue(makeEvent('')); // empty stack = cross-origin "Script error."

    await processInvestigateJob(makeJob(), new AbortController().signal);

    // The expensive path (repo clone → LLM/sandbox) must never run.
    expect(mockCloneRepo).not.toHaveBeenCalled();

    // The group must be parked as a non-retriable needs_human with the full
    // reason contract (reason_code + reason_message + remediation).
    const call = unfixableCall();
    expect(call).toBeDefined();
    const reason = call![3]?.reason;
    expect(reason?.reason_code).toBe('unfixable_no_app_frames');
    expect(reason?.reason_message).toBeTruthy();
    expect(reason?.remediation).toBeTruthy();
  });

  it('does NOT fire the guard when the stack has real application frames', async () => {
    mockGetErrorGroup.mockResolvedValue(makeGroup());
    mockGetErrorEvent.mockResolvedValue(makeEvent('TypeError: x\n    at Proxy.render (src/App.vue:9:30)'));
    // Force a throw right after the guard (getProject is reached before cloneRepo),
    // proving the flow continued past the guard rather than short-circuiting.
    mockGetProject.mockResolvedValue(null);

    await expect(processInvestigateJob(makeJob(), new AbortController().signal)).rejects.toThrow(/not found/i);

    // The stackless disposition must NOT have been applied to a real app-frame error.
    expect(unfixableCall()).toBeUndefined();
  });

  it('treats a group with no sample event as unfixable (no event fetch, no clone)', async () => {
    // sample_event_id is falsy → event is null → hasNoAppFrames('') is true.
    mockGetErrorGroup.mockResolvedValue(makeGroup({ sample_event_id: '' }));

    await processInvestigateJob(makeJob(), new AbortController().signal);

    expect(mockGetErrorEvent).not.toHaveBeenCalled();
    expect(mockCloneRepo).not.toHaveBeenCalled();
    expect(unfixableCall()).toBeDefined();
  });

  it('adopts an already-started fix instead of re-running a recovered investigation', async () => {
    mockGetErrorGroup.mockResolvedValue(makeGroup({ status: 'fixing' }));

    await processInvestigateJob(makeJob(), new AbortController().signal);

    expect(mockUpdateGroupStatus).not.toHaveBeenCalled();
    expect(mockGetErrorEvent).not.toHaveBeenCalled();
    expect(mockCloneRepo).not.toHaveBeenCalled();
  });
});

describe('processFixJob — preserves writeup on failure (no revert/null)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionPointerForGroup.mockResolvedValue(null);
    mockGetPlayableChunkMetas.mockResolvedValue([]);
    mockGetErrorGroup.mockResolvedValue({
      id: 'g1', title: 'Null deref', fingerprint: 'fp', sample_event_id: 'e1',
      occurrence_count: 3, status: 'fixing',
    } as ErrorGroupData);
    mockGetErrorEvent.mockResolvedValue({
      id: 'e1', error_type: 'TypeError', error_message: 'x of undefined',
      stack_trace_raw: 'at App.vue:42', stack_trace_resolved: null,
      breadcrumbs: '[]', context: '{}', release: null, session_id: null,
    } as ErrorEventData);
    mockGetProject.mockResolvedValue({ id: 'p1', name: 'app', github_repo: 'org/app', default_branch: 'main' } as ProjectData);
    mockCloneRepo.mockResolvedValue({ repoDir: '/tmp/r', cleanup: vi.fn() } as never);
    vi.mocked(db.getProjectGitHubInstallation).mockResolvedValue(null as never);
    vi.mocked(db.getReplayForGroup).mockResolvedValue(null as never);
    vi.mocked(db.getReplayArtifacts).mockResolvedValue([] as never);
    vi.mocked(db.getSourceMaps).mockResolvedValue([] as never);
    vi.mocked(db.getGroupInvestigation).mockResolvedValue({ rootCause: 'null deref in App.vue', suggestedMitigation: 'guard' });
    process.env['GITHUB_TOKEN'] = 'gh-test';
  });

  function fixJob(): ClaimedJob & { errorGroupId: string } {
    return {
      id: 'j1',
      workerId: 'worker-1',
      errorGroupId: 'g1',
      sourceId: null,
      projectId: 'p1',
      jobType: 'fix',
      attempts: 0,
      guidance: null,
      leaseGeneration: '1',
      triggeredBy: null,
      sessionId: null,
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['INGESTION_BASE_URL'];
    delete process.env['INTERNAL_READ_TOKEN'];
  });

  it('terminates as needs_human with all reason fields + confidence when the fix is below floor', async () => {
    mockRunPipeline.mockResolvedValue({
      status: 'needs_human',
      confidence: 'medium',
      reason: {
        reason_code: 'low_confidence_fix',
        reason_message: 'Candidate fix could not be verified',
        remediation: 'Review the candidate diff manually',
      },
    });

    await processFixJob(fixJob(), new AbortController().signal);

    const call = mockUpdateGroupStatus.mock.calls.find((c) => c[2] === 'needs_human');
    expect(call, 'expected an updateGroupStatus(needs_human) call').toBeTruthy();
    expect(call![3]?.reason?.reason_code).toBe('low_confidence_fix');
    expect(call![3]?.reason?.reason_message).toBeTruthy();
    expect(call![3]?.reason?.remediation).toBeTruthy();
    expect(call![3]?.confidence).toBe('medium');
  });

  it('sets pr_created on a successful high-confidence fix', async () => {
    mockRunPipeline.mockResolvedValue({
      status: 'pr_created', confidence: 'high',
      pr_url: 'https://github.com/org/app/pull/7', pr_number: 7,
    });

    await processFixJob(fixJob(), new AbortController().signal);

    const call = mockUpdateGroupStatus.mock.calls.find((c) => c[2] === 'pr_created');
    expect(call).toBeTruthy();
    expect(call![3]?.pr_url).toBe('https://github.com/org/app/pull/7');
  });

  it('prefers session-pointer evidence fetched through ingestion', async () => {
    const errorAt = '2026-07-15T12:00:00.000Z';
    const errorAtMs = Date.parse(errorAt);
    mockGetSessionPointerForGroup.mockResolvedValue({ session_id: 'sess/a', error_at: errorAt });
    mockGetPlayableChunkMetas.mockResolvedValue([{
      seq: 3,
      size_bytes: 100,
      decoded_size_bytes: 500,
      has_full_snapshot: true,
      first_event_ms: errorAtMs - 1_000,
      last_event_ms: errorAtMs + 1_000,
    }]);
    process.env['INGESTION_BASE_URL'] = 'http://ingestion:8080';
    process.env['INTERNAL_READ_TOKEN'] = 'secret';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ events: [
      { type: 2, timestamp: errorAtMs - 500, data: { node: {
        type: 0, id: 1, childNodes: [{
          type: 2, tagName: 'button', id: 2,
          childNodes: [{ type: 3, id: 3, textContent: 'Save profile' }],
        }],
      } } },
      { type: 3, timestamp: errorAtMs - 100, data: { source: 2, type: 2, id: 2 } },
    ] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    mockRunPipeline.mockResolvedValue({
      status: 'pr_created', confidence: 'high', pr_url: 'https://github.com/org/app/pull/8', pr_number: 8,
    });

    await processFixJob(fixJob(), new AbortController().signal);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://ingestion:8080/internal/v1/projects/p1/sessions/sess%2Fa/chunks/3',
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({ headers: { 'X-Internal-Token': 'secret' } });
    const pipelineInput = mockRunPipeline.mock.calls[0]?.[0];
    expect(pipelineInput?.visualAnalysis?.failureMoment).toContain('Save profile');
  });
});

describe('friction worker path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    mockGetErrorGroup.mockResolvedValue(makeGroup({
      kind: 'friction',
      status: 'candidate',
      sample_event_id: '',
      signal_type: 'dead_click',
      element_selector: '[data-testid="save"]',
      page_url_normalized: 'https://app.example.com/settings',
    }));
    mockGetProject.mockResolvedValue({
      id: 'proj-1', name: 'app', github_repo: 'org/app', default_branch: 'main',
    });
    vi.mocked(db.getProjectGitHubInstallation).mockResolvedValue(null);
    mockCloneRepo.mockResolvedValue({ repoDir: '/tmp/repo', cleanup: vi.fn() } as never);
    vi.mocked(gatherFrictionEvidence).mockResolvedValue({ signals: [], timeline: '', truncated: false });
  });

  it('skips error-only guards and never auto-fixes a code-caused friction incident', async () => {
    vi.mocked(investigateFriction).mockResolvedValue({
      codeCause: true, confidence: 'high', reason: 'save handler is disconnected', remediation: 'wire the handler',
    });

    await processInvestigateJob(makeJob(), new AbortController().signal);

    expect(mockGetErrorEvent).not.toHaveBeenCalled();
    expect(db.getReplayForGroup).not.toHaveBeenCalled();
    expect(db.getSourceMaps).not.toHaveBeenCalled();
    expect(db.updateGroupAndCreateFixJob).not.toHaveBeenCalled();
    expect(db.updateGroupInvestigation).toHaveBeenCalledWith(
      'grp-1', 'proj-1', 'awaiting_approval', expect.objectContaining({ confidence: 'high' }),
      makeJob(),
    );
  });

  it('records friction without a code cause as an insight', async () => {
    vi.mocked(investigateFriction).mockResolvedValue({
      codeCause: false, confidence: 'medium', reason: 'The workflow is confusing but functional.',
    });

    await processInvestigateJob(makeJob(), new AbortController().signal);

    expect(db.updateGroupInvestigation).toHaveBeenCalledWith(
      'grp-1', 'proj-1', 'insight', expect.objectContaining({ rootCause: expect.any(String) }),
      makeJob(),
    );
    expect(db.updateGroupAndCreateFixJob).not.toHaveBeenCalled();
  });

  it('refuses a non-human friction fix before cloning or running the pipeline', async () => {
    const job = { ...makeJob(), jobType: 'fix' as const, triggeredBy: 'auto' as const };

    await processFixJob(job, new AbortController().signal);

    expect(mockUpdateGroupStatus).toHaveBeenCalledWith(
      'grp-1', 'proj-1', 'awaiting_approval', undefined, job,
    );
    expect(mockCloneRepo).not.toHaveBeenCalled();
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });
});

describe('session_analysis handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const job: ClaimedJob & { sessionId: string } = {
    id: 'analysis-1', workerId: 'worker-1', leaseGeneration: '1',
    errorGroupId: null, sourceId: null, projectId: 'proj-1',
    jobType: 'session_analysis', attempts: 0, guidance: null, triggeredBy: 'auto', sessionId: 'session-1',
  };

  it('dispatches before the error-group-required guard', async () => {
    vi.mocked(db.getSessionForAnalysis).mockResolvedValue({
      id: 'session-1', project_id: 'proj-1', environment_id: 'env-1', end_user_id: null, status: 'closed',
    });
    vi.mocked(db.getScrubbedChunksForSession).mockResolvedValue([]);
    vi.mocked(readChunksBounded).mockResolvedValue({ envelopes: [], inflatedBytes: 0, truncated: false });
    vi.mocked(analyzeSession).mockReturnValue([]);

    await expect(processJobInner(job, new AbortController().signal)).resolves.toBeUndefined();
    expect(writeFrictionSignals).toHaveBeenCalled();
  });

  it('analyzes scrubbed chunks, persists signals, and marks the session analyzed', async () => {
    const session = {
      id: 'session-1', project_id: 'proj-1', environment_id: 'env-1', end_user_id: null, status: 'closed',
    };
    vi.mocked(db.getSessionForAnalysis).mockResolvedValue(session);
    vi.mocked(db.getScrubbedChunksForSession).mockResolvedValue([]);
    vi.mocked(readChunksBounded).mockResolvedValue({ envelopes: [], inflatedBytes: 0, truncated: false });
    vi.mocked(analyzeSession).mockReturnValue([]);

    await processSessionAnalysisJob(job, new AbortController().signal);

    expect(db.setSessionAnalysisStatus).toHaveBeenNthCalledWith(1, 'session-1', 'proj-1', 'analyzing', undefined, job);
    expect(db.assertJobLease).toHaveBeenCalledWith(job);
    expect(writeFrictionSignals).toHaveBeenCalledWith(session, [], 1);
    expect(db.setSessionAnalysisStatus).toHaveBeenLastCalledWith('session-1', 'proj-1', 'analyzed', 1, job);
    expect(db.updateGroupAndCreateFixJob).not.toHaveBeenCalled();
  });

  it('runs friction adjudication after signal persistence when a key is set', async () => {
    const session = {
      id: 'session-1', project_id: 'proj-1', environment_id: 'env-1', end_user_id: null, status: 'closed',
    };
    vi.mocked(db.getSessionForAnalysis).mockResolvedValue(session);
    vi.mocked(db.getScrubbedChunksForSession).mockResolvedValue([]);
    vi.mocked(readChunksBounded).mockResolvedValue({ envelopes: [], inflatedBytes: 0, truncated: false });
    vi.mocked(analyzeSession).mockReturnValue([]);
    const prevKey = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    try {
      await processSessionAnalysisJob(job, new AbortController().signal);
    } finally {
      if (prevKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = prevKey;
    }
    expect(processFrictionOutcomes).toHaveBeenCalledWith(
      session,
      'analysis-1',
      expect.objectContaining({ modelId: 'real' }),
    );
    // Ordering: adjudication runs after persistence, before 'analyzed'.
    expect(vi.mocked(writeFrictionSignals).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(processFrictionOutcomes).mock.invocationCallOrder[0]!,
    );
  });

  it('skips friction adjudication without a key (keyless mode) and still analyzes', async () => {
    const session = {
      id: 'session-1', project_id: 'proj-1', environment_id: 'env-1', end_user_id: null, status: 'closed',
    };
    vi.mocked(db.getSessionForAnalysis).mockResolvedValue(session);
    vi.mocked(db.getScrubbedChunksForSession).mockResolvedValue([]);
    vi.mocked(readChunksBounded).mockResolvedValue({ envelopes: [], inflatedBytes: 0, truncated: false });
    vi.mocked(analyzeSession).mockReturnValue([]);
    const prevKey = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      await processSessionAnalysisJob(job, new AbortController().signal);
    } finally {
      if (prevKey !== undefined) process.env['ANTHROPIC_API_KEY'] = prevKey;
    }
    expect(processFrictionOutcomes).not.toHaveBeenCalled();
    expect(db.setSessionAnalysisStatus).toHaveBeenLastCalledWith('session-1', 'proj-1', 'analyzed', 1, job);
  });

  it('marks analysis_failed and rethrows corrupt chunk failures', async () => {
    vi.mocked(db.getSessionForAnalysis).mockResolvedValue({
      id: 'session-1', project_id: 'proj-1', environment_id: 'env-1', end_user_id: null, status: 'closed',
    });
    vi.mocked(db.getScrubbedChunksForSession).mockResolvedValue([]);
    vi.mocked(readChunksBounded).mockRejectedValue(new Error('corrupt gzip'));

    await expect(processSessionAnalysisJob(job, new AbortController().signal)).rejects.toThrow('corrupt gzip');
    expect(db.setSessionAnalysisStatus).toHaveBeenLastCalledWith(
      'session-1', 'proj-1', 'analysis_failed', undefined, job,
    );
  });
});

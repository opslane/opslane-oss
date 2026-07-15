import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClaimedJob, ErrorGroupData, ErrorEventData, ProjectData } from '../db.js';

// index.ts is the worker entrypoint: it imports the whole world and calls main()
// at module load. We mock every dependency so importing it is side-effect free,
// and main() is guarded behind !process.env.VITEST so the poller/servers never
// boot here. The ONE module we deliberately leave real is harness/stack-trace-utils
// (hasNoAppFrames) — that's the decision under test.
vi.mock('../db.js', () => ({
  getErrorGroup: vi.fn(),
  getErrorEvent: vi.fn(),
  getProject: vi.fn(),
  getProjectGitHubInstallation: vi.fn(),
  updateGroupStatus: vi.fn(),
  updateGroupInvestigation: vi.fn(),
  updateGroupAndCreateFixJob: vi.fn(),
  getGroupInvestigation: vi.fn(),
  getReplayForGroup: vi.fn(),
  getReplayArtifacts: vi.fn(),
  getSourceMaps: vi.fn(),
  requeueStaleJobs: vi.fn(),
  resolveSilentMergedGroups: vi.fn(),
  updateJobTraceUrl: vi.fn(),
  closePool: vi.fn(),
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

const db = await import('../db.js');
const { cloneRepo } = await import('../repo-clone.js');
const { runPipeline } = await import('../pipeline.js');
const { processInvestigateJob, processFixJob } = await import('../index.js');

const mockGetErrorGroup = vi.mocked(db.getErrorGroup);
const mockGetErrorEvent = vi.mocked(db.getErrorEvent);
const mockGetProject = vi.mocked(db.getProject);
const mockUpdateGroupStatus = vi.mocked(db.updateGroupStatus);
const mockCloneRepo = vi.mocked(cloneRepo);
const mockRunPipeline = vi.mocked(runPipeline);

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
    };
  }

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
});

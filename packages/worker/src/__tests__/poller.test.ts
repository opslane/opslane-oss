import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ClaimedJob } from '../db.js';

// Mock the db module before importing poller
vi.mock('../db.js', () => ({
  claimJob: vi.fn(),
  heartbeat: vi.fn(),
  completeJob: vi.fn(),
  failJob: vi.fn(),
}));

// Import after mock setup
const { claimJob, heartbeat, completeJob, failJob } = await import('../db.js');
const { createPoller } = await import('../poller.js');

const mockClaimJob = vi.mocked(claimJob);
const mockHeartbeat = vi.mocked(heartbeat);
const mockCompleteJob = vi.mocked(completeJob);
const mockFailJob = vi.mocked(failJob);

function makeJob(overrides?: Partial<ClaimedJob>): ClaimedJob {
  return {
    id: 'job-1',
    errorGroupId: 'eg-1',
    sourceId: null,
    projectId: 'proj-1',
    jobType: 'investigate',
    attempts: 0,
    guidance: null,
    triggeredBy: null,
    sessionId: null,
    ...overrides,
  };
}

describe('poller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockHeartbeat.mockResolvedValue(true);
    mockCompleteJob.mockResolvedValue(undefined);
    mockFailJob.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  it('should call processJob when a job is available', async () => {
    const job = makeJob();
    mockClaimJob.mockResolvedValueOnce(job);

    const processJob = vi.fn<(j: ClaimedJob, signal: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

    const poller = createPoller({
      intervalMs: 1000,
      leaseDurationMs: 30_000,
      workerId: 'test-worker',
      processJob,
    });

    poller.start();

    // Let microtasks flush (the immediate tick is async)
    await vi.advanceTimersByTimeAsync(0);

    expect(mockClaimJob).toHaveBeenCalledWith('test-worker', 30_000);
    expect(processJob).toHaveBeenCalledWith(job, expect.any(AbortSignal));

    // Let the async job processing complete
    await vi.advanceTimersByTimeAsync(0);

    expect(mockCompleteJob).toHaveBeenCalledWith('job-1', 'test-worker');

    await poller.stop();
  });

  it('should not call processJob when no job is available', async () => {
    mockClaimJob.mockResolvedValueOnce(null);

    const processJob = vi.fn<(j: ClaimedJob, signal: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

    const poller = createPoller({
      intervalMs: 1000,
      leaseDurationMs: 30_000,
      workerId: 'test-worker',
      processJob,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(mockClaimJob).toHaveBeenCalled();
    expect(processJob).not.toHaveBeenCalled();

    await poller.stop();
  });

  it('should call failJob when processJob throws', async () => {
    const job = makeJob();
    mockClaimJob.mockResolvedValueOnce(job);

    const processJob = vi.fn<(j: ClaimedJob, signal: AbortSignal) => Promise<void>>().mockRejectedValue(
      new Error('Pipeline exploded')
    );

    const poller = createPoller({
      intervalMs: 1000,
      leaseDurationMs: 30_000,
      workerId: 'test-worker',
      processJob,
    });

    poller.start();

    // Let microtasks flush
    await vi.advanceTimersByTimeAsync(0);
    // Let the error handling complete
    await vi.advanceTimersByTimeAsync(0);

    expect(mockFailJob).toHaveBeenCalledWith('job-1', 'test-worker', 'Pipeline exploded');
    expect(mockCompleteJob).not.toHaveBeenCalled();

    await poller.stop();
  });

  it('should start heartbeat interval for active jobs', async () => {
    const job = makeJob();
    // processJob will take a while (we'll resolve it manually)
    let resolveProcessJob: (() => void) | undefined;
    const processJobPromise = new Promise<void>((resolve) => {
      resolveProcessJob = resolve;
    });

    mockClaimJob.mockResolvedValueOnce(job);

    const processJob = vi.fn<(j: ClaimedJob, signal: AbortSignal) => Promise<void>>().mockReturnValue(processJobPromise);

    const poller = createPoller({
      intervalMs: 1000,
      leaseDurationMs: 30_000,
      workerId: 'test-worker',
      processJob,
    });

    poller.start();

    // Let claim + processJob start
    await vi.advanceTimersByTimeAsync(0);

    expect(processJob).toHaveBeenCalledWith(job, expect.any(AbortSignal));

    // Advance past one heartbeat interval (30000/3 = 10000ms)
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mockHeartbeat).toHaveBeenCalledWith('job-1', 'test-worker', 30_000);

    // Resolve the job so cleanup happens
    resolveProcessJob!();
    await vi.advanceTimersByTimeAsync(0);

    await poller.stop();
  });

  it('should poll on recurring interval', async () => {
    mockClaimJob.mockResolvedValue(null);

    const processJob = vi.fn<(j: ClaimedJob, signal: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

    const poller = createPoller({
      intervalMs: 1000,
      leaseDurationMs: 30_000,
      workerId: 'test-worker',
      processJob,
    });

    poller.start();

    // Immediate tick
    await vi.advanceTimersByTimeAsync(0);
    expect(mockClaimJob).toHaveBeenCalledTimes(1);

    // After 1s interval
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockClaimJob).toHaveBeenCalledTimes(2);

    // After another 1s interval
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockClaimJob).toHaveBeenCalledTimes(3);

    await poller.stop();
  });

  it('should stop polling after stop() is called', async () => {
    mockClaimJob.mockResolvedValue(null);

    const processJob = vi.fn<(j: ClaimedJob, signal: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

    const poller = createPoller({
      intervalMs: 1000,
      leaseDurationMs: 30_000,
      workerId: 'test-worker',
      processJob,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    await poller.stop();

    const callCount = mockClaimJob.mock.calls.length;

    // Advance time — should NOT trigger more claims
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockClaimJob).toHaveBeenCalledTimes(callCount);
  });
});

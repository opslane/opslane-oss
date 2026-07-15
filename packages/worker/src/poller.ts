import type { ClaimedJob } from './db.js';
import { claimJob, heartbeat, completeJob, failJob } from './db.js';
import { logger } from './logger.js';

export interface Poller {
  start(): void;
  stop(): Promise<void>;
}

export interface PollerOptions {
  /** How often to poll for new jobs (ms). */
  intervalMs: number;
  /** How long the lease is valid (ms). */
  leaseDurationMs: number;
  /** Unique identifier for this worker instance. */
  workerId: string;
  /** Callback invoked when a job is claimed. */
  processJob: (job: ClaimedJob, signal: AbortSignal) => Promise<void>;
  /**
   * Fault-injection seam for reliability tests only. Runs after processJob
   * resolves and before the completion write, so a test can simulate a crash
   * or lease loss at that exact boundary. Never set in production.
   */
  beforeComplete?: (job: ClaimedJob) => Promise<void>;
}

export function createPoller(options: PollerOptions): Poller {
  const { intervalMs, leaseDurationMs, workerId, processJob, beforeComplete } = options;

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let activeJobPromise: Promise<void> | null = null;

  async function tick(): Promise<void> {
    if (!running || activeJobPromise) return;

    let job: ClaimedJob | null;
    try {
      job = await claimJob(workerId, leaseDurationMs);
    } catch (err: unknown) {
      logger.error('Failed to claim job', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (!job) return;

    logger.info('Claimed job', {
      job_id: job.id,
      error_group_id: job.errorGroupId,
      project_id: job.projectId,
    });

    // AbortController: abort processing if heartbeat detects lease lost
    const controller = new AbortController();
    let heartbeatInFlight = false;

    // Start heartbeat: extend lease every leaseDurationMs/3
    const heartbeatInterval = setInterval(async () => {
      if (heartbeatInFlight || controller.signal.aborted) return;
      heartbeatInFlight = true;
      try {
        const stillOwned = await heartbeat(
          job.id,
          workerId,
          job.leaseGeneration,
          leaseDurationMs
        );
        if (!stillOwned) {
          logger.warn('Heartbeat: lease lost, aborting job', {
            job_id: job.id,
          });
          controller.abort();
        }
      } catch (err: unknown) {
        logger.error('Heartbeat failed, aborting job', {
          job_id: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
        controller.abort();
      } finally {
        heartbeatInFlight = false;
      }
    }, Math.floor(leaseDurationMs / 3));

    activeJobPromise = (async () => {
      try {
        await processJob(job, controller.signal);
        if (controller.signal.aborted) {
          logger.warn('Processing stopped: lease lost', {
            job_id: job.id,
            lease_generation: job.leaseGeneration,
          });
          return;
        }
        if (beforeComplete) await beforeComplete(job);
        const completed = await completeJob(job.id, workerId, job.leaseGeneration);
        if (!completed) {
          logger.warn('Completion rejected: lease lost', {
            job_id: job.id,
            lease_generation: job.leaseGeneration,
          });
          controller.abort();
          return;
        }
        logger.info('Completed job', {
          job_id: job.id,
          error_group_id: job.errorGroupId,
        });
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : String(err);
        logger.error('Job failed', {
          job_id: job.id,
          error_group_id: job.errorGroupId,
          error: message,
        });
        try {
          const failed = await failJob(job.id, workerId, job.leaseGeneration, message);
          if (!failed) {
            logger.warn('Failure update rejected: lease lost', {
              job_id: job.id,
              lease_generation: job.leaseGeneration,
            });
          }
        } catch (failErr: unknown) {
          logger.error('Failed to record job failure', {
            job_id: job.id,
            error: failErr instanceof Error ? failErr.message : String(failErr),
          });
        }
      } finally {
        clearInterval(heartbeatInterval);
        activeJobPromise = null;
      }
    })();
  }

  return {
    start(): void {
      running = true;
      logger.info('Poller started', {
        interval_ms: intervalMs,
        lease_duration_ms: leaseDurationMs,
        worker_id: workerId,
      });
      void tick();
      pollTimer = setInterval(() => void tick(), intervalMs);
    },

    async stop(): Promise<void> {
      running = false;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (activeJobPromise) {
        logger.info('Waiting for active job to finish');
        await activeJobPromise;
      }
      logger.info('Poller stopped');
    },
  };
}

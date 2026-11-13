import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { LighthouseEngineService } from '../../lighthouse/application/lighthouse-engine.service';
import { LighthouseExecutionError } from '../../lighthouse/domain/lighthouse-execution.error';
import { LIGHTHOUSE_QUEUE } from '../../../infrastructure/queue/queue.constants';
import { ScanWorkflowService } from '../application/scan-workflow.service';
import { BrowserExecutionLockService } from './browser-execution-lock.service';

export interface EngineJobData {
  scanId: string;
  engineRunId: string;
  engine: 'lighthouse' | 'network';
}

@Processor(LIGHTHOUSE_QUEUE, { concurrency: 1 })
export class LighthouseProcessor extends WorkerHost {
  private readonly logger = new Logger(LighthouseProcessor.name);

  constructor(
    private readonly engine: LighthouseEngineService,
    private readonly workflow: ScanWorkflowService,
    private readonly browserLock: BrowserExecutionLockService,
  ) {
    super();
  }

  async process(job: Job<EngineJobData>): Promise<unknown> {
    return this.browserLock.runExclusive(async () => {
      try {
        await this.workflow.markEngineStarted(job.data.scanId);
        const result = await this.engine.execute({
          scanId: job.data.scanId,
          engineRunId: job.data.engineRunId,
        });
        await this.workflow.onLighthouseSucceeded(job.data.scanId);
        return result;
      } catch (error) {
        const code = error instanceof LighthouseExecutionError
          ? error.code
          : 'LIGHTHOUSE_ENGINE_FAILED';
        const outcome = await this.workflow.onEngineFailure({
          scanId: job.data.scanId,
          engineRunId: job.data.engineRunId,
          engine: 'lighthouse',
          safeErrorCode: code,
        });
        this.logger.warn(`Lighthouse run ${job.data.engineRunId} failed (${code}); retryScheduled=${outcome.retryScheduled}.`);
        return { failed: true, errorCode: code, retryScheduled: outcome.retryScheduled };
      }
    });
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<EngineJobData> | undefined, error: Error): Promise<void> {
    if (!job?.data?.scanId || !job.data.engineRunId) return;
    if (job.attemptsMade < (job.opts.attempts ?? 1)) return;
    // The processor normally handles engine failures itself. This listener is
    // the fallback for exhausted BullMQ-level retries (e.g. transient DB faults).
    await this.workflow.onEngineFailure({
      scanId: job.data.scanId,
      engineRunId: job.data.engineRunId,
      engine: 'lighthouse',
      safeErrorCode: 'LIGHTHOUSE_WORKER_JOB_FAILED',
    });
    this.logger.error(`Lighthouse job ${job.id ?? 'unknown'} exhausted queue retries.`);
  }
}

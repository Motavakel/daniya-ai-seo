import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { NetworkEngineService } from '../../network/application/network-engine.service';
import { NetworkEngineError } from '../../network/domain/network-engine.error';
import { NetworkDiagnosticsService } from '../../diagnostics/application/network-diagnostics.service';
import { NETWORK_QUEUE } from '../../../infrastructure/queue/queue.constants';
import { ScanWorkflowService } from '../application/scan-workflow.service';
import { BrowserExecutionLockService } from './browser-execution-lock.service';
import type { EngineJobData } from './lighthouse.processor';

@Processor(NETWORK_QUEUE, { concurrency: 1 })
export class NetworkProcessor extends WorkerHost {
  private readonly logger = new Logger(NetworkProcessor.name);

  constructor(
    private readonly engine: NetworkEngineService,
    private readonly diagnostics: NetworkDiagnosticsService,
    private readonly workflow: ScanWorkflowService,
    private readonly browserLock: BrowserExecutionLockService,
  ) {
    super();
  }

  async process(job: Job<EngineJobData>): Promise<unknown> {
    return this.browserLock.runExclusive(async () => {
      let result: Awaited<ReturnType<NetworkEngineService['execute']>>;

      try {
        await this.workflow.markEngineStarted(job.data.scanId);
        result = await this.engine.execute({
          scanId: job.data.scanId,
          engineRunId: job.data.engineRunId,
        });
      } catch (error) {
        const code = error instanceof NetworkEngineError ? error.code : 'NETWORK_ENGINE_FAILED';
        const outcome = await this.workflow.onEngineFailure({
          scanId: job.data.scanId,
          engineRunId: job.data.engineRunId,
          engine: 'network',
          safeErrorCode: code,
        });
        this.logger.warn(`Network run ${job.data.engineRunId} failed (${code}); retryScheduled=${outcome.retryScheduled}.`);
        return { failed: true, errorCode: code, retryScheduled: outcome.retryScheduled };
      }

      try {
        await this.diagnostics.analyze(result.networkRunId);
        await this.workflow.onNetworkSucceeded(job.data.scanId);
      } catch {
        // Capture is already persisted. Do not repeat an expensive Chrome run
        // merely because deterministic rule/report persistence had a problem.
        this.logger.error(`Network capture ${result.networkRunId} was saved but report finalization failed.`);
        await this.workflow.onPostNetworkFailure(job.data.scanId);
      }

      return result;
    });
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<EngineJobData> | undefined, error: Error): Promise<void> {
    if (!job?.data?.scanId || !job.data.engineRunId) return;
    if (job.attemptsMade < (job.opts.attempts ?? 1)) return;
    await this.workflow.onEngineFailure({
      scanId: job.data.scanId,
      engineRunId: job.data.engineRunId,
      engine: 'network',
      safeErrorCode: 'NETWORK_WORKER_JOB_FAILED',
    });
    this.logger.error(`Network job ${job.id ?? 'unknown'} exhausted queue retries.`);
  }
}

import {
  Logger,
} from '@nestjs/common';
import {
  Processor,
  WorkerHost,
} from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import {
  PROCESS_SCAN_JOB_NAME,
  SCAN_QUEUE_NAME,
} from '../infrastructure/queue/queue.constants';

import { ScanOrchestratorService } from './scan-orchestrator.service';

interface ProcessScanJobData {
  scanId: string;
}

@Processor(SCAN_QUEUE_NAME, {
  concurrency: 1,
})
export class ScanProcessor extends WorkerHost {
  private readonly logger = new Logger(ScanProcessor.name);

  constructor(
    private readonly orchestrator: ScanOrchestratorService,
  ) {
    super();
  }

  async process(job: Job<ProcessScanJobData>): Promise<void> {
    if (job.name !== PROCESS_SCAN_JOB_NAME) {
      throw new Error(`Unsupported job: ${job.name}`);
    }

    const scanId = job.data?.scanId;

    if (
      typeof scanId !== 'string' ||
      scanId.length === 0
    ) {
      throw new Error('Invalid scan job payload.');
    }

    this.logger.log(`Starting scan ${scanId}`);

    try {
      await this.orchestrator.process(scanId);

      this.logger.log(`Finished scan ${scanId}`);
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      this.logger.error(
        `Scan ${scanId} processing failed: ${message}`,
      );

      throw error;
    }
  }
}
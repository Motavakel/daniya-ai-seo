import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';

import { DrizzleService } from '../database/drizzle.service';
import { WorkflowRepository } from '../../modules/workflow/workflow.repository';
import {
  PROCESS_SCAN_JOB_NAME,
  SCAN_QUEUE_NAME,
} from '../queue/queue.constants';

const OUTBOX_MAX_ATTEMPTS = 10;

@Injectable()
export class OutboxPublisherService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(
    OutboxPublisherService.name,
  );

  private timer?: ReturnType<typeof setTimeout>;
  private currentPoll?: Promise<void>;
  private stopping = false;

  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly leaseMs: number;

  constructor(
    private readonly drizzle: DrizzleService,
    private readonly workflowRepository: WorkflowRepository,
    private readonly config: ConfigService,

    @InjectQueue(SCAN_QUEUE_NAME)
    private readonly queue: Queue,
  ) {
    this.pollIntervalMs = this.config.get<number>(
      'OUTBOX_POLL_INTERVAL_MS',
      1_000,
    );

    this.batchSize = this.config.get<number>(
      'OUTBOX_CLAIM_BATCH_SIZE',
      20,
    );

    this.leaseMs =
      this.config.get<number>('OUTBOX_LEASE_SECONDS', 60) *
      1_000;
  }

  onModuleInit(): void {
    this.schedule(0);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;

    if (this.timer) {
      clearTimeout(this.timer);
    }

    await this.currentPoll;
  }

  private schedule(delayMs: number): void {
    if (this.stopping) {
      return;
    }

    this.timer = setTimeout(() => {
      this.currentPoll = this.poll();
    }, delayMs);

    this.timer.unref();
  }

  private async poll(): Promise<void> {
    try {
      const publishedCount = await this.publishPendingEvents();

      this.schedule(
        publishedCount >= this.batchSize
          ? 0
          : this.pollIntervalMs,
      );
    } catch (error: unknown) {
      this.logger.error(
        `Outbox polling failed: ${this.toError(error).message}`,
      );

      this.schedule(this.pollIntervalMs);
    }
  }

  private async publishPendingEvents(): Promise<number> {
    const staleBefore = new Date(
      Date.now() - this.leaseMs,
    );

    const events = await this.drizzle.db.transaction((tx) =>
      this.workflowRepository.claimOutboxEvents(
        this.batchSize,
        staleBefore,
        tx,
      ),
    );

    for (const event of events) {
      await this.publishEvent(event);
    }

    return events.length;
  }

  private async publishEvent(
    event: Awaited<
      ReturnType<WorkflowRepository['claimOutboxEvents']>
    >[number],
  ): Promise<void> {
    const lockToken = event.lockToken;

    if (!lockToken) {
      this.logger.warn(
        `Outbox event ${event.id} has no lock token.`,
      );
      return;
    }

    try {
      if (event.eventType !== 'scan.requested') {
        throw new Error('Unsupported outbox event type.');
      }

      const scanId = this.getScanId(event.payload);

      await this.queue.add(
        PROCESS_SCAN_JOB_NAME,
        { scanId },
        {
          jobId: `scan-${scanId}`,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5_000,
          },
          removeOnComplete: {
            age: 86_400,
            count: 1_000,
          },
          removeOnFail: {
            age: 604_800,
            count: 5_000,
          },
        },
      );

      const published =
        await this.drizzle.db.transaction((tx) =>
          this.workflowRepository.markOutboxPublished(
            event.id,
            lockToken,
            tx,
          ),
        );

      if (!published) {
        this.logger.warn(
          `Outbox event ${event.id} was published but its lease was lost.`,
        );
      }
    } catch (error: unknown) {
      const message = this.toError(error).message;

      const exhausted =
        event.attempts >= OUTBOX_MAX_ATTEMPTS;

      const delayMs = Math.min(
        15 * 60_000,
        1_000 * 2 ** Math.min(event.attempts, 10),
      );

      await this.drizzle.db.transaction((tx) =>
        this.workflowRepository.retryOutboxEvent(
          event.id,
          lockToken,
          exhausted ? 'failed' : 'pending',
          new Date(Date.now() + delayMs),
          message,
          tx,
        ),
      );

      this.logger.warn(
        `Outbox event ${event.id} ${exhausted ? 'failed permanently' : 'scheduled for retry'}.`,
      );
    }
  }

  private getScanId(payload: unknown): string {
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload)
    ) {
      throw new Error('Invalid outbox payload.');
    }

    const scanId = (
      payload as Record<string, unknown>
    ).scanId;

    if (
      typeof scanId !== 'string' ||
      scanId.length === 0
    ) {
      throw new Error('Outbox payload has no scanId.');
    }

    return scanId;
  }

  private toError(error: unknown): Error {
    return error instanceof Error
      ? error
      : new Error(String(error));
  }
}
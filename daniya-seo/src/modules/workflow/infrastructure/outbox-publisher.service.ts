import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { LIGHTHOUSE_QUEUE, NETWORK_QUEUE } from '../../../infrastructure/queue/queue.constants';
import { OutboxEventsRepository } from '../../../infrastructure/database/repositories/outbox-events.repository';
import { ScanWorkflowService } from '../application/scan-workflow.service';
import type { JsonObject } from '../../../infrastructure/database/schema/schema.types';

interface EngineJobPayload extends JsonObject {
  scanId: string;
  engineRunId: string;
  engine: 'lighthouse' | 'network';
}

function isEngineJobPayload(value: unknown): value is EngineJobPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record['scanId'] === 'string' &&
    typeof record['engineRunId'] === 'string' &&
    (record['engine'] === 'lighthouse' || record['engine'] === 'network');
}

@Injectable()
export class OutboxPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private timer: NodeJS.Timeout | undefined;
  private active = false;
  private stopping = false;

  constructor(
    private readonly outbox: OutboxEventsRepository,
    private readonly config: ConfigService,
    private readonly workflow: ScanWorkflowService,
    @InjectQueue(LIGHTHOUSE_QUEUE) private readonly lighthouseQueue: Queue,
    @InjectQueue(NETWORK_QUEUE) private readonly networkQueue: Queue,
  ) {}

  onModuleInit(): void {
    this.stopping = false;
    void this.tick();
    const interval = this.boundedInteger('OUTBOX_POLL_INTERVAL_MS', 1_000, 250, 10_000);
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    // Allow an in-flight publish call to return before Nest closes dependencies.
    while (this.active) await new Promise((resolve) => setTimeout(resolve, 50));
  }

  private async tick(): Promise<void> {
    if (this.active || this.stopping) return;
    this.active = true;
    try {
      const workerId = (this.config.get<string>('WORKER_ID') ?? `${process.env['HOSTNAME'] ?? 'worker'}-${process.pid}`).slice(0, 128);
      const batch = await this.outbox.claimBatch({
        workerId,
        limit: this.boundedInteger('OUTBOX_CLAIM_BATCH_SIZE', 20, 1, 100),
        leaseSeconds: this.boundedInteger('OUTBOX_LEASE_SECONDS', 60, 10, 900),
      });

      for (const event of batch) {
        if (this.stopping) break;
        await this.publishOne(event, workerId);
      }
    } catch {
      this.logger.error('Outbox polling failed.');
    } finally {
      this.active = false;
    }
  }

  private async publishOne(
    event: Awaited<ReturnType<OutboxEventsRepository['claimBatch']>>[number],
    workerId: string,
  ): Promise<void> {
    try {
      if (!isEngineJobPayload(event.payload)) {
        await this.outbox.releaseForRetry({
          eventId: event.id,
          workerId,
          error: 'OUTBOX_INVALID_ENGINE_PAYLOAD',
          retryAt: new Date(Date.now() + 60_000),
        });
        return;
      }

      const queue = event.payload.engine === 'lighthouse'
        ? this.lighthouseQueue
        : this.networkQueue;
      const jobId = `outbox-${event.id.replace(/-/g, '')}`;
      await queue.add(event.eventType, event.payload, {
        jobId,
        // Queue-level retries cover transient process/connection failures.
        // Engine/domain failures are converted into a new DB EngineRun + Outbox event.
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 1_000,
        removeOnFail: 2_000,
      });

      await this.outbox.markPublished({ eventId: event.id, workerId });
    } catch {
      const retryAt = new Date(Date.now() + this.retryDelayMs(event.attempts));
      const outcome = await this.outbox.releaseForRetry({
        eventId: event.id,
        workerId,
        error: 'OUTBOX_QUEUE_PUBLISH_FAILED',
        retryAt,
      }).catch(() => undefined);
      if (outcome === 'dead_lettered' && isEngineJobPayload(event.payload)) {
        await this.workflow.onOutboxDeliveryFailed({
          scanId: event.payload.scanId,
          engineRunId: event.payload.engineRunId,
          engine: event.payload.engine,
        }).catch(() => undefined);
      }
      this.logger.warn(`Outbox event ${event.id} could not be published.`);
    }
  }

  private retryDelayMs(attempt: number): number {
    return Math.min(60_000, 1_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 6));
  }

  private boundedInteger(key: string, fallback: number, min: number, max: number): number {
    const raw = this.config.get<string | number>(key, fallback);
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
  }
}

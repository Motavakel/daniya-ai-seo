import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ScansRepository } from '../../../infrastructure/database/repositories/scans.repository';
import { ScanWorkflowRepository, type CreateWorkflowScanInput } from '../../../infrastructure/database/repositories/scan-workflow.repository';
import { TargetUrlValidator } from '../../security/target-url.validator';
import { ReportFinalizerService } from '../api/report-finalizer.service';

export interface TrustedScanContext {
  /** Must come from verified Gateway authentication context. */
  callerRef: string;
  /** Must come from trusted entitlement data, never the request body. */
  profile: 'basic' | 'detailed';
}

export interface CreateScanCommand {
  context: TrustedScanContext;
  targetUrl: string;
  idempotencyKey?: string | null;
  requestOptions?: CreateWorkflowScanInput['requestOptions'];
}

@Injectable()
export class ScanWorkflowService {
  constructor(
    private readonly workflowRepository: ScanWorkflowRepository,
    private readonly scans: ScansRepository,
    private readonly targetValidator: TargetUrlValidator,
    private readonly reportFinalizer: ReportFinalizerService,
    private readonly config: ConfigService,
  ) {}

  async createScan(command: CreateScanCommand) {
    const target = await this.targetValidator.validate(command.targetUrl);
    return this.workflowRepository.createScan({
      callerRef: command.context.callerRef,
      profile: command.context.profile,
      idempotencyKey: command.idempotencyKey ?? null,
      targetUrl: target.url,
      hostname: target.hostname,
      requestOptions: command.requestOptions ?? {},
      expiresAt: new Date(Date.now() + this.boundedInteger('SCAN_RETENTION_DAYS', 90, 7, 365) * 86_400_000),
    });
  }

  async getScan(scanId: string, callerRef: string) {
    const scan = await this.scans.findByIdAndCallerRef(scanId, callerRef);
    if (!scan) throw new NotFoundException('Scan not found.');
    return scan;
  }

  async markEngineStarted(scanId: string): Promise<void> {
    await this.workflowRepository.setScanRunning(scanId);
  }

  async onLighthouseSucceeded(scanId: string): Promise<void> {
    const scan = await this.scans.findById(scanId);
    if (!scan) throw new NotFoundException('Scan not found.');

    if (scan.profile === 'basic') {
      await this.reportFinalizer.finalize(scanId, 'completed');
      return;
    }

    await this.workflowRepository.enqueueNetworkAfterLighthouse(scanId);
  }

  async onNetworkSucceeded(scanId: string): Promise<void> {
    await this.reportFinalizer.finalize(scanId, 'completed');
  }

  async onPostNetworkFailure(scanId: string): Promise<void> {
    await this.reportFinalizer.finalize(scanId, 'completed_with_warnings');
  }

  async onEngineFailure(input: {
    scanId: string;
    engineRunId: string;
    engine: 'lighthouse' | 'network';
    safeErrorCode: string;
  }): Promise<{ retryScheduled: boolean; finalStatus?: 'failed' | 'completed_with_warnings' }> {
    const maxAttempts = this.boundedInteger('ENGINE_MAX_ATTEMPTS', 3, 1, 5);
    const result = await this.workflowRepository.scheduleEngineRetry({
      scanId: input.scanId,
      engineRunId: input.engineRunId,
      maxAttempts,
      safeErrorCode: input.safeErrorCode,
    });

    if (!result.retryScheduled && result.finalStatus === 'completed_with_warnings') {
      await this.reportFinalizer.finalize(input.scanId, 'completed_with_warnings');
    }

    return {
      retryScheduled: result.retryScheduled,
      finalStatus: result.finalStatus,
    };
  }


  async onOutboxDeliveryFailed(input: {
    scanId: string;
    engineRunId: string;
    engine: 'lighthouse' | 'network';
  }): Promise<void> {
    const status = await this.workflowRepository.markOutboxDeliveryFailed({
      ...input,
      safeErrorCode: 'OUTBOX_DELIVERY_EXHAUSTED',
    });
    if (status === 'completed_with_warnings') {
      await this.reportFinalizer.finalize(input.scanId, 'completed_with_warnings');
    }
  }

  private boundedInteger(key: string, fallback: number, min: number, max: number): number {
    const raw = this.config.get<string | number>(key, fallback);
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
  }
}

import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';

import { DrizzleService } from '../../../infrastructure/database/drizzle.service';

import { AccessService } from '../../access/services/access.service';
import type { PlanLevel } from '../../access/access.repository';

import { WorkflowRepository } from '../workflow.repository';
import type { ScanEngineType } from '../workflow.repository';

import { IdempotencyService } from './idempotency.service';
import { PageResolverService } from './page-resolver.service';
import { SlotReservationService } from './slot-reservation.service';

export interface CreateScanInput {
  customerId: string;
  gatewayTokenId: string;
  targetUrl: string;
  idempotencyKey: string;
}

export interface CreateScanResult {
  scanId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  alreadyExisted: boolean;
  createdAt: Date;
}

export interface GetScanStatusInput {
  scanId: string;
  customerId: string;
}

const PLAN_ENGINE_TYPES = {
  basic: ['lighthouse'],
  pro: ['lighthouse', 'network', 'console', 'chrome_performance'],
} satisfies Record<PlanLevel, readonly ScanEngineType[]>;

@Injectable()
export class WorkflowService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly accessService: AccessService,
    private readonly workflowRepository: WorkflowRepository,
    private readonly idempotencyService: IdempotencyService,
    private readonly pageResolverService: PageResolverService,
    private readonly slotReservationService: SlotReservationService,
  ) {}

  async createScan( input: CreateScanInput): Promise<CreateScanResult> {

    const normalizedUrl = this.pageResolverService.normalizeUrl(
      input.targetUrl,
    );

    const requestHash = this.idempotencyService.createRequestHash({
      targetUrl: normalizedUrl,
    });

    return this.drizzle.db.transaction(async (tx) => {
      const existingScan =
        await this.idempotencyService.findExistingScan(
          {
            customerId: input.customerId,
            idempotencyKey: input.idempotencyKey,
            requestHash,
          },
          tx,
        );

      if (existingScan) {
        return this.toCreateScanResult(existingScan, true);
      }

      const cycle =
        await this.accessService.getActiveCycleOrCreateInitial(
          input.customerId,
          tx,
        );
      const plan = this.accessService.resolvePlan(cycle);
      const { page } = await this.pageResolverService.resolve(
        input.customerId,
        normalizedUrl,
        tx,
      );
      const { slot } = await this.slotReservationService.reserve(
        {
          pageId: page.id,
          cycleId: cycle.id,
        },
        tx,
      );

      if (!slot) {
        throw new ConflictException(
          'Page quota is not available.',
        );
      }

      const attemptNo =
        await this.workflowRepository.getNextScanAttemptNo(
          slot.id,
          tx,
        );

      const scan = await this.workflowRepository.createScan(
        {
          customerId: input.customerId,
          pageId: page.id,
          cycleId: cycle.id,
          slotId: slot.id,
          attemptNo,
          planLevelAtRequest: plan.planLevel,
          gatewayTokenId: input.gatewayTokenId,
          targetUrl: normalizedUrl,
          status: 'queued',
        },
        tx,
      );

      if (!scan) {
        throw new InternalServerErrorException(
          'Failed to create scan.',
        );
      }

      // 8. Create engine runs.
      const engineTypes = this.getEngineTypes(plan.planLevel);

      const engineRuns =
        await this.workflowRepository.createScanEngineRuns(
          scan.id,
          engineTypes,
          tx,
        );

      if (engineRuns.length !== engineTypes.length) {
        throw new InternalServerErrorException(
          'Failed to initialize scan engines.',
        );
      }

      // 9. Save idempotency record.
      await this.idempotencyService.createRecord(
        {
          customerId: input.customerId,
          idempotencyKey: input.idempotencyKey,
          requestHash,
          scanId: scan.id,
        },
        tx,
      );

      // 10. Create outbox event.
      const outboxEvent =
        await this.workflowRepository.createOutboxEvent(
          scan.id,
          tx,
        );

      if (!outboxEvent) {
        throw new InternalServerErrorException(
          'Failed to create scan event.',
        );
      }

      return this.toCreateScanResult(scan, false);
    });
  }

  async getScanStatus(input: GetScanStatusInput) {
    return this.drizzle.db.transaction(async (tx) => {
      // 1. Find scan owned by customer.
      const scan =
        await this.workflowRepository.findScanByIdForCustomer(
          input.scanId,
          input.customerId,
          tx,
        );

      if (!scan) {
        throw new NotFoundException('Scan not found.');
      }

      // 2. Get engine statuses.
      const engineRuns =
        await this.workflowRepository.findScanEngineRuns(
          scan.id,
          tx,
        );

      return {
        scanId: scan.id,
        status: scan.status,
        createdAt: scan.createdAt,
        startedAt: scan.startedAt,
        completedAt: scan.completedAt,
        failureCode: scan.failureCode,

        engines: engineRuns.map((engine) => ({
          engineType: engine.engineType,
          status: engine.status,
          attempts: engine.attempts,
          startedAt: engine.startedAt,
          completedAt: engine.completedAt,
          errorCode: engine.errorCode,
        })),
      };
    });
  }

  private getEngineTypes(
    planLevel: PlanLevel,
  ): ScanEngineType[] {
    return [...PLAN_ENGINE_TYPES[planLevel]];
  }

  private toCreateScanResult(
    scan: {
      id: string;
      status: CreateScanResult['status'];
      createdAt: Date;
    },
    alreadyExisted: boolean,
  ): CreateScanResult {
    return {
      scanId: scan.id,
      status: scan.status,
      alreadyExisted,
      createdAt: scan.createdAt,
    };
  }
}
import { Injectable } from '@nestjs/common';
import { DrizzleService } from '../../../infrastructure/database/drizzle.service';
import { AccessService } from '../../access/services/access.service';
import { WorkflowRepository } from '../workflow.repository';
import { IdempotencyService } from './idempotency.service';
import { PageResolverService } from './page-resolver.service';
import { SlotReservationService } from './slot-reservation.service';

export interface CreateScanInput {
  customerId: string;
  gatewayTokenId: string;
  targetUrl: string;
  idempotencyKey: string;
}

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

  async createScan(input: CreateScanInput) {
    const normalizedUrl = this.pageResolverService.normalizeUrl(
      input.targetUrl,
    );

    const requestHash = this.idempotencyService.createRequestHash({
      targetUrl: normalizedUrl,
    });

    return this.drizzle.db.transaction(async (tx) => {
      // 1. Check idempotency.
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
        return {
          scan: existingScan,
          reused: true,
        };
      }

      // 2. Get active plan cycle.
      const cycle =
        await this.accessService.getActiveCycleOrCreateInitial(
          input.customerId,
          tx,
        );

      // 3. Resolve page.
      const { page } = await this.pageResolverService.resolve(
        input.customerId,
        normalizedUrl,
        tx,
      );

      // 4. Resolve plan and enabled engines.
      const plan = this.accessService.resolvePlan(cycle);

      // 5. Reserve or reuse page slot.
      const { slot } = await this.slotReservationService.reserve(
        {
          pageId: page.id,
          cycleId: cycle.id,
        },
        tx,
      );

      // 6. Determine scan attempt number.
      const attemptNo =
        await this.workflowRepository.getNextScanAttemptNo(
          slot.id,
          tx,
        );

      // 7. Create scan.
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

      // 8. Create engine runs.
      await this.workflowRepository.createScanEngineRuns(
        scan.id,
        plan.engines,
        tx,
      );

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
      await this.workflowRepository.createOutboxEvent(
        scan.id,
        tx,
      );

      return {
        scan,
        reused: false,
      };
    });
  }
}
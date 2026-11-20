import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AccessService } from '../../access/services/access.service';
import {
  WorkflowRepository,
  type DbTransaction,
} from '../workflow.repository';

@Injectable()
export class SlotReservationService {
  constructor(
    private readonly workflowRepository: WorkflowRepository,
    private readonly accessService: AccessService,
  ) {}

  async reserve(
    input: {
      pageId: string;
      cycleId: string;
    },
    tx: DbTransaction,
  ) {
    // Lock the cycle to prevent concurrent quota reservations.
    const cycle = await this.workflowRepository.lockPlanCycle(
      input.cycleId,
      tx,
    );

    if (!cycle) {
      throw new NotFoundException('Plan cycle not found.');
    }

    // Check whether this page already has a slot in this cycle.
    const existingSlot =
      await this.workflowRepository.findPageCycleSlot(
        input.pageId,
        input.cycleId,
        tx,
      );

    // A previous scan is still holding this reservation.
    if (existingSlot?.status === 'RESERVED') {
      throw new ConflictException(
        'A scan for this page is already being processed.',
      );
    }

    // The page has already consumed its quota in this cycle.
    if (existingSlot?.status === 'CONSUMED') {
      return {
        slot: existingSlot,
        quotaReserved: false,
      };
    }

    // A previous scan failed and released its reservation.
    if (existingSlot?.status === 'RELEASED') {
      await this.accessService.reservePageQuota(
        input.cycleId,
        tx,
      );

      const slot =
        await this.workflowRepository.reReservePageCycleSlot(
          existingSlot.id,
          tx,
        );

      if (!slot) {
        throw new ConflictException(
          'Unable to reserve page slot again.',
        );
      }

      return {
        slot,
        quotaReserved: true,
      };
    }

    // This is a new page in the current cycle.
    await this.accessService.reservePageQuota(
      input.cycleId,
      tx,
    );

    const slot =
      await this.workflowRepository.createPageCycleSlot(
        input.pageId,
        input.cycleId,
        tx,
      );

    return {
      slot,
      quotaReserved: true,
    };
  }
}
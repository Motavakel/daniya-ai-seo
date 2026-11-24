import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';

import { DrizzleService } from '../../../infrastructure/database/drizzle.service';
import { AccessRepository, type DbTransaction } from '../access.repository';

import { PlanResolverService } from './plan-resolver.service';

@Injectable()
export class CycleLifecycleService {
  constructor(
    private readonly drizzleService: DrizzleService,
    private readonly accessRepository: AccessRepository,
    private readonly planResolver: PlanResolverService,
  ) {}

  async createInitialFreeCycle(customerId: string, tx: DbTransaction) {
    await this.accessRepository.ensureCustomer(customerId, tx);

    const customerLocked =
      await this.accessRepository.lockCustomerForCycleChange(customerId, tx);

    if (!customerLocked) {
      throw new NotFoundException('Customer not found.');
    }

    const cycleNo = await this.accessRepository.getNextCycleNo(customerId, tx);

    if (cycleNo !== 1) {
      throw new ConflictException(
        'The initial free Basic cycle has already been used.',
      );
    }

    const plan = this.planResolver.resolve('basic');

    return this.accessRepository.createNewCycle(
      {
        customerId,
        cycleNo: 1,
        planLevel: plan.planLevel,
        pageLimit: plan.pageLimit,
      },
      tx,
    );
  }

  async upgradePlan(input: { customerId: string; targetPlan: 'pro' }) {
    return this.drizzleService.db.transaction(async (tx) => {
      const customerLocked =
        await this.accessRepository.lockCustomerForCycleChange(
          input.customerId,
          tx,
        );

      if (!customerLocked) {
        throw new NotFoundException('Customer not found.');
      }

      const cycle = await this.accessRepository.findActiveCycleForUpdate(
        input.customerId,
        tx,
      );

      if (!cycle) {
        throw new NotFoundException('Active plan cycle not found.');
      }

      if (cycle.currentPlanLevel === 'pro') {
        throw new ConflictException('The current cycle is already Pro.');
      }

      const upgradedCycle = await this.accessRepository.upgradeToPro(
        cycle.id,
        tx,
      );

      if (!upgradedCycle) {
        throw new ConflictException('The plan upgrade could not be completed.');
      }

      if (!upgradedCycle.upgradedAt) {
        throw new InternalServerErrorException(
          'Plan upgrade timestamp is missing.',
        );
      }

      return {
        cycleId: upgradedCycle.id,
        cycleNo: upgradedCycle.cycleNo,
        planLevel: upgradedCycle.currentPlanLevel,
        pageLimit: upgradedCycle.pageLimit,
        pagesCommitted: upgradedCycle.pagesCommitted,
        pendingNewPages: upgradedCycle.pendingNewPages,
        upgradedAt: upgradedCycle.upgradedAt,
      };
    });
  }
  async repurchase(input: { customerId: string }) {
    return this.drizzleService.db.transaction(async (tx) => {
      await this.accessRepository.ensureCustomer(input.customerId, tx);

      const customerLocked =
        await this.accessRepository.lockCustomerForCycleChange(
          input.customerId,
          tx,
        );

      if (!customerLocked) {
        throw new NotFoundException('Customer not found.');
      }

      const activeCycle = await this.accessRepository.findActiveCycleForUpdate(
        input.customerId,
        tx,
      );

      if (activeCycle) {
        const isExhausted =
          activeCycle.pagesCommitted === activeCycle.pageLimit &&
          activeCycle.pendingNewPages === 0;

        if (!isExhausted) {
          throw new ConflictException(
            'The current cycle still has available or pending quota.',
          );
        }

        const closed = await this.accessRepository.closeExhaustedCycle(
          activeCycle.id,
          tx,
        );

        if (!closed) {
          throw new ConflictException(
            'The previous cycle could not be closed.',
          );
        }
      }

      const cycleNo = await this.accessRepository.getNextCycleNo(
        input.customerId,
        tx,
      );

      if (cycleNo === 1) {
        throw new ConflictException(
          'The initial free Basic cycle must be created before repurchase.',
        );
      }

      const plan = this.planResolver.resolve('pro');

      const cycle = await this.accessRepository.createNewCycle(
        {
          customerId: input.customerId,
          cycleNo,
          planLevel: plan.planLevel,
          pageLimit: plan.pageLimit,
        },
        tx,
      );

      return {
        cycleId: cycle.id,
        cycleNo: cycle.cycleNo,
        planLevel: cycle.currentPlanLevel,
        pageLimit: cycle.pageLimit,
        startedAt: cycle.startedAt,
      };
    });
  }
}

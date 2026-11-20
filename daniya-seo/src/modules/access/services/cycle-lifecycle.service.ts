import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  AccessRepository,
  DbTransaction,
} from '../access.repository';

import { PlanResolverService } from './plan-resolver.service';

@Injectable()
export class CycleLifecycleService {
  constructor(
    private readonly accessRepository: AccessRepository,
    private readonly planResolver: PlanResolverService,
  ) {}

  /**
   * Creates the first free Basic cycle.
   * A customer can receive this cycle only once.
   */
  async createInitialFreeCycle(
    customerId: string,
    tx: DbTransaction,
  ) {
    await this.accessRepository.ensureCustomer(customerId, tx);

    const customerLocked =
      await this.accessRepository.lockCustomerForCycleChange(
        customerId,
        tx,
      );

    if (!customerLocked) {
      throw new NotFoundException('Customer not found.');
    }

    const cycleNo = await this.accessRepository.getNextCycleNo(
      customerId,
      tx,
    );

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

  /**
   * Upgrades the current Basic cycle to Pro.
   * Existing quota counters are preserved.
   */
  async upgradePlan(
    input: {
      customerId: string;
      targetPlan: 'pro';
    },
    tx: DbTransaction,
  ) {
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
      throw new ConflictException(
        'The current cycle is already Pro.',
      );
    }

    const upgradedCycle = await this.accessRepository.upgradeToPro(
      cycle.id,
      tx,
    );

    if (!upgradedCycle) {
      throw new ConflictException(
        'The plan upgrade could not be completed.',
      );
    }

    return upgradedCycle;
  }

  /**
   * Creates a new Pro cycle.
   * Basic is never available through repurchase.
   */
  async repurchase(
    input: {
      customerId: string;
    },
    tx: DbTransaction,
  ) {
    await this.accessRepository.ensureCustomer(
      input.customerId,
      tx,
    );

    const customerLocked =
      await this.accessRepository.lockCustomerForCycleChange(
        input.customerId,
        tx,
      );

    if (!customerLocked) {
      throw new NotFoundException('Customer not found.');
    }

    const activeCycle =
      await this.accessRepository.findActiveCycleForUpdate(
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

      const closed =
        await this.accessRepository.closeExhaustedCycle(
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

    return this.accessRepository.createNewCycle(
      {
        customerId: input.customerId,
        cycleNo,
        planLevel: plan.planLevel,
        pageLimit: plan.pageLimit,
      },
      tx,
    );
  }
}
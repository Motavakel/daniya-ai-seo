import {
  ConflictException,
  Injectable,
} from '@nestjs/common';

import {
  AccessRepository,
  CustomerPlanCycle,
  DbTransaction,
} from '../access.repository';

import { PlanResolverService } from './plan-resolver.service';
import { QuotaService } from './quota.service';
import { CycleLifecycleService } from './cycle-lifecycle.service';

@Injectable()
export class AccessService {
  constructor(
    private readonly accessRepository: AccessRepository,
    private readonly planResolver: PlanResolverService,
    private readonly quotaService: QuotaService,
    private readonly cycleLifecycle: CycleLifecycleService,
  ) {}

  /**
   * Returns the active cycle.
   * Creates the initial free Basic cycle if this is the customer's first use.
   */
  async getActiveCycleOrCreateInitial(
    customerId: string,
    tx: DbTransaction,
  ): Promise<CustomerPlanCycle> {
    await this.accessRepository.ensureCustomer(customerId, tx);

    const activeCycle =
      await this.accessRepository.findActiveCycle(customerId, tx);

    if (activeCycle) {
      return activeCycle;
    }

    try {
      return await this.cycleLifecycle.createInitialFreeCycle(
        customerId,
        tx,
      );
    } catch (error) {
      // Handle concurrent first-time requests.
      if (!(error instanceof ConflictException)) {
        throw error;
      }

      const existingCycle =
        await this.accessRepository.findActiveCycle(customerId, tx);

      if (existingCycle) {
        return existingCycle;
      }

      throw error;
    }
  }

  /**
   * Resolves the current plan and its page limit.
   */
  resolvePlan(cycle: CustomerPlanCycle) {
    return this.planResolver.resolve(cycle.currentPlanLevel);
  }

  /**
   * Reserves one page from the active cycle quota.
   */
  async reservePageQuota(
    cycleId: string,
    tx: DbTransaction,
  ): Promise<void> {
    await this.quotaService.reservePage(cycleId, tx);
  }

  /**
   * Commits a previously reserved page.
   */
  async commitPageQuota(
    cycleId: string,
    tx: DbTransaction,
  ): Promise<void> {
    await this.quotaService.commitPage(cycleId, tx);
  }

  /**
   * Releases a previously reserved page.
   */
  async releasePageQuota(
    cycleId: string,
    tx: DbTransaction,
  ): Promise<void> {
    await this.quotaService.releasePage(cycleId, tx);
  }
}
import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { customerPlanCycles } from '../../infrastructure/database/schema/access/customer-plan-cycles.schema';
import { customers } from '../../infrastructure/database/schema/access/customers.schema';
import type * as schema from '../../infrastructure/database/schema';

type Database = NodePgDatabase<typeof schema>;
export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type CustomerPlanCycle = typeof customerPlanCycles.$inferSelect;
export type PlanLevel = CustomerPlanCycle['currentPlanLevel'];

export interface CreateCycleInput {
  customerId: string;
  cycleNo: number;
  planLevel: PlanLevel;
  pageLimit: number;
}

@Injectable()
export class AccessRepository {
  async ensureCustomer(
    customerId: string,
    tx: DbTransaction,
  ): Promise<void> {
    await tx
      .insert(customers)
      .values({ id: customerId })
      .onConflictDoNothing({
        target: customers.id,
      });
  }

  async findActiveCycle(
    customerId: string,
    tx: DbTransaction,
  ): Promise<CustomerPlanCycle | null> {
    const [cycle] = await tx
      .select()
      .from(customerPlanCycles)
      .where(
        and(
          eq(customerPlanCycles.customerId, customerId),
          eq(customerPlanCycles.status, 'active'),
        ),
      )
      .limit(1);

    return cycle ?? null;
  }


  async findActiveCycleForUpdate(
    customerId: string,
    tx: DbTransaction,
  ): Promise<CustomerPlanCycle | null> {
    const [cycle] = await tx
      .select()
      .from(customerPlanCycles)
      .where(
        and(
          eq(customerPlanCycles.customerId, customerId),
          eq(customerPlanCycles.status, 'active'),
        ),
      )
      .limit(1)
      .for('update');

    return cycle ?? null;
  }

  async lockCustomerForCycleChange(
    customerId: string,
    tx: DbTransaction,
  ): Promise<boolean> {
    const [customer] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1)
      .for('update');

    return Boolean(customer);
  }


  async getNextCycleNo(
    customerId: string,
    tx: DbTransaction,
  ): Promise<number> {
    const [result] = await tx
      .select({
        maxCycleNo: sql<number>`
          COALESCE(MAX(${customerPlanCycles.cycleNo}), 0)::int
        `,
      })
      .from(customerPlanCycles)
      .where(eq(customerPlanCycles.customerId, customerId));

    return (result?.maxCycleNo ?? 0) + 1;
  }


  async tryReservePageQuota(
    cycleId: string,
    tx: DbTransaction,
  ): Promise<boolean> {
    const rows = await tx
      .update(customerPlanCycles)
      .set({
        pendingNewPages: sql`
          ${customerPlanCycles.pendingNewPages} + 1
        `,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(customerPlanCycles.id, cycleId),
          eq(customerPlanCycles.status, 'active'),
          sql`
            ${customerPlanCycles.pagesCommitted}
            + ${customerPlanCycles.pendingNewPages}
            < ${customerPlanCycles.pageLimit}
          `,
        ),
      )
      .returning({
        id: customerPlanCycles.id,
      });

    return rows.length > 0;
  }


  async commitReservedPageQuota(
    cycleId: string,
    tx: DbTransaction,
  ): Promise<boolean> {
    const rows = await tx
      .update(customerPlanCycles)
      .set({
        pendingNewPages: sql`
          ${customerPlanCycles.pendingNewPages} - 1
        `,
        pagesCommitted: sql`
          ${customerPlanCycles.pagesCommitted} + 1
        `,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(customerPlanCycles.id, cycleId),
          eq(customerPlanCycles.status, 'active'),
          sql`${customerPlanCycles.pendingNewPages} > 0`,
        ),
      )
      .returning({
        id: customerPlanCycles.id,
      });

    return rows.length > 0;
  }

  /**
   * Releases one existing reservation.
   * Call only after Workflow changes the Slot
   * from RESERVED to RELEASED in the same transaction.
   */
  async releaseReservedPageQuota(
    cycleId: string,
    tx: DbTransaction,
  ): Promise<boolean> {
    const rows = await tx
      .update(customerPlanCycles)
      .set({
        pendingNewPages: sql`
          ${customerPlanCycles.pendingNewPages} - 1
        `,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(customerPlanCycles.id, cycleId),
          eq(customerPlanCycles.status, 'active'),
          sql`${customerPlanCycles.pendingNewPages} > 0`,
        ),
      )
      .returning({
        id: customerPlanCycles.id,
      });

    return rows.length > 0;
  }

  /**
   * Closes a cycle after all quota has been consumed
   * and all pending reservations have been resolved.
   */
  async closeExhaustedCycle(
    cycleId: string,
    tx: DbTransaction,
  ): Promise<boolean> {
    const rows = await tx
      .update(customerPlanCycles)
      .set({
        status: 'closed',
        closedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(customerPlanCycles.id, cycleId),
          eq(customerPlanCycles.status, 'active'),
          eq(
            customerPlanCycles.pagesCommitted,
            customerPlanCycles.pageLimit,
          ),
          eq(customerPlanCycles.pendingNewPages, 0),
        ),
      )
      .returning({
        id: customerPlanCycles.id,
      });

    return rows.length > 0;
  }

  /**
   * Closes an active cycle before re-purchase.
   * Remaining unused quota is not carried into the new cycle.
   */
  async closeCycleForRepurchase(
    cycleId: string,
    tx: DbTransaction,
  ): Promise<boolean> {
    const rows = await tx
      .update(customerPlanCycles)
      .set({
        status: 'closed',
        closedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(customerPlanCycles.id, cycleId),
          eq(customerPlanCycles.status, 'active'),
          eq(customerPlanCycles.pendingNewPages, 0),
        ),
      )
      .returning({
        id: customerPlanCycles.id,
      });

    return rows.length > 0;
  }

  /**
   * Upgrades Basic to Pro in the same cycle.
   * Existing counters are intentionally preserved.
   */
  async upgradeToPro(
    cycleId: string,
    tx: DbTransaction,
  ): Promise<CustomerPlanCycle | null> {
    const [cycle] = await tx
      .update(customerPlanCycles)
      .set({
        currentPlanLevel: 'pro',
        pageLimit: 30,
        upgradedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(customerPlanCycles.id, cycleId),
          eq(customerPlanCycles.status, 'active'),
          eq(customerPlanCycles.currentPlanLevel, 'basic'),
        ),
      )
      .returning();

    return cycle ?? null;
  }

  /**
   * Creates a new plan cycle.
   * Customer locking and payment authorization must be handled
   * by CycleLifecycleService before calling this method.
   */
  async createNewCycle(
    input: CreateCycleInput,
    tx: DbTransaction,
  ): Promise<CustomerPlanCycle> {
    const [cycle] = await tx
      .insert(customerPlanCycles)
      .values({
        customerId: input.customerId,
        cycleNo: input.cycleNo,
        currentPlanLevel: input.planLevel,
        pageLimit: input.pageLimit,
        status: 'active',
      })
      .returning();

    if (!cycle) {
      throw new Error('Failed to create customer plan cycle.');
    }

    return cycle;
  }

  
}
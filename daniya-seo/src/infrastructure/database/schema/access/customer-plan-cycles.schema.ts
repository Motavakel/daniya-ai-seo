import { sql } from 'drizzle-orm';

import {
  check,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { customerPlanCycleStatusEnum, planLevelEnum } from '../enums.schema';
import { customers } from './customers.schema';

export const customerPlanCycles = pgTable(
  'customer_plan_cycles',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, {
        onDelete: 'restrict',
      }),

    cycleNo: integer('cycle_no').notNull(),

    currentPlanLevel: planLevelEnum('current_plan_level')
      .notNull()
      .default('basic'),

    pageLimit: integer('page_limit').notNull().default(5),
    pagesCommitted: integer('pages_committed').notNull().default(0),
    pendingNewPages: integer('pending_new_pages').notNull().default(0),
    status: customerPlanCycleStatusEnum('status').notNull().default('active'),
    
    startedAt: timestamp('started_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    upgradedAt: timestamp('upgraded_at', {
      withTimezone: true,
    }),

    closedAt: timestamp('closed_at', {
      withTimezone: true,
    }),

    updatedAt: timestamp('updated_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('customer_plan_cycles_customer_cycle_unique').on(
      table.customerId,
      table.cycleNo,
    ),

    check(
      'customer_plan_cycles_cycle_no_check',
      sql`${table.cycleNo} > 0`,
    ),

    check(
      'customer_plan_cycles_plan_limit_check',
      sql`(
        (${table.currentPlanLevel} = 'basic' AND ${table.pageLimit} = 5)
        OR
        (${table.currentPlanLevel} = 'pro' AND ${table.pageLimit} = 30)
      )`,
    ),

    check(
      'customer_plan_cycles_counters_check',
      sql`${table.pagesCommitted} >= 0 AND ${table.pendingNewPages} >= 0`,
    ),

    check(
      'customer_plan_cycles_quota_check',
      sql`${table.pagesCommitted} + ${table.pendingNewPages} <= ${table.pageLimit}`,
    ),
  ],
);
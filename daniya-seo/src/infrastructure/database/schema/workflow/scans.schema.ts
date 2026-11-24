import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { customers } from '../access/customers.schema';
import { customerPlanCycles } from '../access/customer-plan-cycles.schema';
import { planLevelEnum, scanStatusEnum } from '../enums.schema';
import { pageCycleSlots } from '../access/page-cycle-slots.schema';
import { pages } from '../access/pages.schema';

export const scans = pgTable(
  'scans',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),

    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'restrict' }),

    cycleId: uuid('cycle_id')
      .notNull()
      .references(() => customerPlanCycles.id, {
        onDelete: 'restrict',
      }),

    slotId: uuid('slot_id')
      .notNull()
      .references(() => pageCycleSlots.id, { onDelete: 'restrict' }),

    attemptNo: integer('attempt_no').notNull().default(1),

    planLevelAtRequest: planLevelEnum('plan_level_at_request').notNull(),

    gatewayTokenId: uuid('gateway_token_id').notNull(),

    targetUrl: text('target_url').notNull(),

    status: scanStatusEnum('status').notNull().default('queued'),

    startedAt: timestamp('started_at', { withTimezone: true }),

    completedAt: timestamp('completed_at', { withTimezone: true }),

    failureCode: varchar('failure_code', { length: 100 }),

    failureMessage: text('failure_message'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('scans_slot_attempt_no_uidx').on(table.slotId, table.attemptNo),

    index('scans_customer_created_at_idx').on(
      table.customerId,
      table.createdAt,
    ),

    index('scans_page_created_at_idx').on(table.pageId, table.createdAt),

    check('scans_attempt_no_positive_chk', sql`${table.attemptNo} > 0`),

    check(
      'scans_status_timestamps_chk',
      sql`
        (
          ${table.status} = 'queued'
          AND ${table.startedAt} IS NULL
          AND ${table.completedAt} IS NULL
        )
        OR
        (
          ${table.status} = 'running'
          AND ${table.startedAt} IS NOT NULL
          AND ${table.completedAt} IS NULL
        )
        OR
        (
          ${table.status} IN ('completed', 'failed')
          AND ${table.startedAt} IS NOT NULL
          AND ${table.completedAt} IS NOT NULL
        )
      `,
    ),
    check(
      'scans_completed_at_check',
      sql`
    ${table.completedAt} IS NULL
    OR ${table.completedAt} >= ${table.startedAt}
  `,
    ),
  ],
);

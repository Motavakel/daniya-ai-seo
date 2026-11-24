import { pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { pages } from './pages.schema';
import { customerPlanCycles } from '../access/customer-plan-cycles.schema';
import { pageCycleSlotStatusEnum } from '../enums.schema';

export const pageCycleSlots = pgTable(
  'page_cycle_slots',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, {
        onDelete: 'restrict',
      }),

    cycleId: uuid('cycle_id')
      .notNull()
      .references(() => customerPlanCycles.id, {
        onDelete: 'restrict',
      }),

    status: pageCycleSlotStatusEnum('status').notNull().default('RESERVED'),

    createdAt: timestamp('created_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp('updated_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    reservedAt: timestamp('reserved_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    consumedAt: timestamp('consumed_at', {
      withTimezone: true,
    }),

    releasedAt: timestamp('released_at', {
      withTimezone: true,
    }),
  },
  (table) => [
    uniqueIndex('page_cycle_slots_page_cycle_unique').on(
      table.pageId,
      table.cycleId,
    ),
  ],
);

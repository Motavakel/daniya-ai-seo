import { pgEnum } from 'drizzle-orm/pg-core';

export const planLevelEnum = pgEnum('plan_level', [
  'basic',
  'pro',
]);

export const customerPlanCycleStatusEnum = pgEnum(
  'customer_plan_cycle_status',
  ['active', 'closed'],
);

export const pageCycleSlotStatusEnum = pgEnum(
  'page_cycle_slot_status',
  ['RESERVED', 'CONSUMED', 'RELEASED'],
);

export const scanStatusEnum = pgEnum('scan_status', [
  'queued',
  'running',
  'completed',
  'failed',
]);

export const scanEngineTypeEnum = pgEnum('scan_engine_type', [
  'lighthouse',
  'chrome_performance',
  'network',
  'console',
]);

export const scanEngineRunStatusEnum = pgEnum(
  'scan_engine_run_status',
  ['queued', 'running', 'succeeded', 'failed'],
);

export const outboxEventTypeEnum = pgEnum('outbox_event_type', [
  'scan.requested',
]);

export const outboxEventStatusEnum = pgEnum(
  'outbox_event_status',
  ['pending', 'processing', 'published', 'failed'],
);
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
  ['queued', 'running', 'completed', 'failed'],
);

export const outboxEventTypeEnum = pgEnum('outbox_event_type', [
  'scan.requested',
]);

export const outboxEventStatusEnum = pgEnum(
  'outbox_event_status',
  ['pending', 'processing', 'published', 'failed'],
);

export const reportArtifactTypeEnum = pgEnum(
  'report_artifact_type',
  [
    'lighthouse_json',
    'lighthouse_html',
    'network_netlog',
    'network_report',
    'performance_trace',
    'console_report',
    'scan_report',
  ],
);

export const storageProviderEnum = pgEnum('storage_provider', [
  'local',
  's3',
]);

export const compressionTypeEnum = pgEnum('compression_type', [
  'gzip',
  'br',
  'none',
]);

export const lighthouseFormFactorEnum = pgEnum(
  'lighthouse_form_factor',
  ['mobile', 'desktop'],
);

export const lighthouseThrottlingMethodEnum = pgEnum(
  'lighthouse_throttling_method',
  ['simulate', 'devtools', 'provided'],
);
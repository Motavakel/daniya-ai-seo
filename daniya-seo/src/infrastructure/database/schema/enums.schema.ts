import { pgEnum } from 'drizzle-orm/pg-core';

export const scanProfileEnum = pgEnum('scan_profile', [
  'basic',
  'detailed',
]);

export const scanStrategyEnum = pgEnum('scan_strategy', [
  'lighthouse_only',
  'lighthouse_then_network',
]);

export const scanStatusEnum = pgEnum('scan_status', [
  'queued',
  'running',
  'network_queued',
  'completed',
  'completed_with_warnings',
  'failed',
  'cancelled',
  'expired',
]);

export const engineTypeEnum = pgEnum('engine_type', [
  'lighthouse',
  'network',
]);

export const engineRunStatusEnum = pgEnum('engine_run_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
]);

export const networkResourceTypeEnum = pgEnum('network_resource_type', [
  'document',
  'stylesheet',
  'script',
  'image',
  'font',
  'media',
  'xhr',
  'fetch',
  'websocket',
  'other',
  'unknown',
]);

export const resourceTypeSourceEnum = pgEnum('resource_type_source', [
  'netlog',
  'content_type',
  'url_extension',
  'inferred',
  'unknown',
]);

export const networkCacheStatusEnum = pgEnum('network_cache_status', [
  'hit',
  'miss',
  'revalidated',
  'bypass',
  'unknown',
]);

export const reportFindingSeverityEnum = pgEnum('report_finding_severity', [
  'info',
  'low',
  'medium',
  'high',
  'critical',
]);

export const artifactKindEnum = pgEnum('artifact_kind', [
  'lighthouse_json',
  'lighthouse_html',
  'chrome_netlog',
  'network_normalized_json',
  'report_json',
]);

export const outboxStatusEnum = pgEnum('outbox_status', [
  'pending',
  'processing',
  'published',
  'dead_lettered',
]);

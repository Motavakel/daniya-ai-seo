export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface LighthouseAuditSummary {
  id: string;
  title: string;
  score: number | null;
  displayValue?: string | null;
  numericValue?: number | null;
  numericUnit?: string | null;
}

export interface LighthouseAuditSummaries {
  [auditId: string]: LighthouseAuditSummary;
}

export interface LighthouseAuditCategoryRef {
  categoryId: string;
  weight: number;
  group?: string | null;
}

export type FieldAvailability = Record<
  string,
  'available' | 'not_observed' | 'not_applicable' | 'inferred'
>;

/** Only allowlisted response headers may be persisted. */
export interface SafeResponseHeaders {
  'cache-control'?: string;
  age?: string;
  etag?: string;
  'last-modified'?: string;
  'content-encoding'?: string;
  vary?: string;
  'content-type'?: string;
  'content-length'?: string;
  server?: string;
  'x-cache'?: string;
  'cf-cache-status'?: string;
  [key: string]: string | undefined;
}

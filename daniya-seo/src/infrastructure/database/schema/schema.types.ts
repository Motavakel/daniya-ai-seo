export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonObject
  | JsonValue[];

export type JsonObject = {
  [key: string]: JsonValue;
};

export type FieldAvailability = Record<string, boolean>;

export type LighthouseAuditSummary = {
  title: string;
  score: number | null;
  displayValue?: string;
  description?: string;
};

export type LighthouseAuditSummaries = Record<
  string,
  LighthouseAuditSummary
>;
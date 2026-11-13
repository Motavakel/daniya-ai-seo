import { Injectable } from '@nestjs/common';
import type {
  CreateLighthouseAuditInput,
  CreateLighthouseReportInput,
} from '../../../infrastructure/database/repositories/lighthouse-reports.repository';
import type {
  JsonObject,
  LighthouseAuditCategoryRef,
  LighthouseAuditSummaries,
  JsonValue,
} from '../../../infrastructure/database/schema/schema.types';
import { LighthouseExecutionError } from './lighthouse-execution.error';

export interface ParsedLighthouseSnapshot {
  report: Omit<CreateLighthouseReportInput, 'scanId' | 'engineRunId'>;
  audits: CreateLighthouseAuditInput[];
  chromeVersion: string | null;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numericString(value: unknown, scale = 3): string | null {
  const number = readNumber(value);
  return number === null ? null : number.toFixed(scale);
}

function scoreString(value: unknown): string | null {
  const number = readNumber(value);
  if (number === null || number < 0 || number > 1) return null;
  return number.toFixed(4);
}

function timestamp(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function safeInteger(value: unknown): number | null {
  const number = readNumber(value);
  return number !== null && Number.isSafeInteger(number) && number >= 0
    ? number
    : null;
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      url.searchParams.set(key, '[redacted]');
    }
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return '[unparseable-url]';
  }
}

interface SanitizerBudget {
  nodes: number;
}

function sanitizeJsonValue(
  value: unknown,
  budget: SanitizerBudget,
  depth = 0,
  key = '',
): JsonValue | undefined {
  budget.nodes += 1;
  if (budget.nodes > 350 || depth > 6) return undefined;

  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (/^(data:|blob:)/i.test(value)) return '[omitted]';
    if (/url$/i.test(key) || key === 'url') return redactUrl(value).slice(0, 2_048);
    return value.slice(0, 2_048);
  }

  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const item of value.slice(0, 30)) {
      const sanitized = sanitizeJsonValue(item, budget, depth + 1);
      if (sanitized !== undefined) result.push(sanitized);
    }
    return result;
  }

  if (isRecord(value)) {
    const result: JsonObject = {};
    const entries = Object.entries(value).slice(0, 40);
    for (const [childKey, childValue] of entries) {
      if (/^(screenshot|screenshotdata|dataurl|trace|filmstrip|snippet|source|html|script|stack|cookie|set-cookie|authorization|proxy-authorization|token|password|secret|headers)$/i.test(childKey)) {
        continue;
      }
      const sanitized = sanitizeJsonValue(
        childValue,
        budget,
        depth + 1,
        childKey,
      );
      if (sanitized !== undefined) result[childKey] = sanitized;
    }
    return result;
  }

  return undefined;
}

function sanitizedObject(value: unknown): JsonObject {
  const sanitized = sanitizeJsonValue(value, { nodes: 0 });
  return isRecord(sanitized) ? (sanitized as JsonObject) : {};
}

@Injectable()
export class LighthouseReportParser {
  parse(lhrValue: unknown): ParsedLighthouseSnapshot {
    if (!isRecord(lhrValue)) {
      throw new LighthouseExecutionError(
        'LIGHTHOUSE_INVALID_REPORT',
        'Lighthouse returned an invalid report payload.',
      );
    }

    const lhr = lhrValue;
    const runtimeError = readRecord(lhr['runtimeError']);
    if (Object.keys(runtimeError).length > 0) {
      const code = readString(runtimeError['code']) ?? 'LIGHTHOUSE_RUNTIME_ERROR';
      throw new LighthouseExecutionError(
        'LIGHTHOUSE_RUNTIME_ERROR',
        `Lighthouse could not complete the audit (${code}).`,
      );
    }

    const auditsRecord = readRecord(lhr['audits']);
    const categoriesRecord = readRecord(lhr['categories']);
    const categoryRefsByAudit = new Map<string, LighthouseAuditCategoryRef[]>();
    const categoryDetails: JsonObject = {};

    for (const [categoryId, categoryValue] of Object.entries(categoriesRecord)) {
      const category = readRecord(categoryValue);
      const categoryScore = readNumber(category['score']);
      categoryDetails[categoryId] = {
        id: categoryId,
        title: readString(category['title']) ?? categoryId,
        description: readString(category['description']) ?? '',
        score: categoryScore,
      };

      const auditRefs = Array.isArray(category['auditRefs']) ? category['auditRefs'] : [];
      for (const auditRefValue of auditRefs) {
        const auditRef = readRecord(auditRefValue);
        const auditId = readString(auditRef['id']);
        if (!auditId) continue;
        const refs = categoryRefsByAudit.get(auditId) ?? [];
        refs.push({
          categoryId,
          weight: readNumber(auditRef['weight']) ?? 0,
          group: readString(auditRef['group']),
        });
        categoryRefsByAudit.set(auditId, refs);
      }
    }

    const auditSummaries: LighthouseAuditSummaries = {};
    const auditRows: CreateLighthouseAuditInput[] = [];

    for (const [auditId, auditValue] of Object.entries(auditsRecord)) {
      const audit = readRecord(auditValue);
      const title = readString(audit['title']) ?? auditId;
      const score = readNumber(audit['score']);
      const scoreDisplayMode = readString(audit['scoreDisplayMode']) ?? 'unknown';
      const displayValue = readString(audit['displayValue']);
      const numericValue = readNumber(audit['numericValue']);
      const numericUnit = readString(audit['numericUnit']);

      auditSummaries[auditId] = {
        id: auditId,
        title,
        score,
        ...(displayValue !== null ? { displayValue } : {}),
        ...(numericValue !== null ? { numericValue } : {}),
        ...(numericUnit !== null ? { numericUnit } : {}),
      };

      const warningValues = Array.isArray(audit['warnings']) ? audit['warnings'] : [];
      const warnings = warningValues
        .filter((item): item is string => typeof item === 'string')
        .slice(0, 20)
        .map((item) => item.slice(0, 500));

      auditRows.push({
        auditId,
        title: title.slice(0, 512),
        description: readString(audit['description'])?.slice(0, 8_000) ?? null,
        score: scoreString(score),
        scoreDisplayMode,
        displayValue: displayValue?.slice(0, 1_000) ?? null,
        numericValue: numericString(numericValue),
        numericUnit,
        categoryRefs: categoryRefsByAudit.get(auditId) ?? [],
        details: sanitizedObject(audit['details']),
        warnings,
        errorMessage: readString(audit['errorMessage'])?.slice(0, 2_000) ?? null,
      });
    }

    const configSettings = readRecord(lhr['configSettings']);
    const userAgent = readString(lhr['userAgent']);
    const chromeVersion = this.extractChromeVersion(userAgent);
    const runWarnings = Array.isArray(lhr['runWarnings'])
      ? lhr['runWarnings']
          .filter((item): item is string => typeof item === 'string')
          .slice(0, 50)
          .map((item) => item.slice(0, 1_000))
      : [];

    const report = {
      lighthouseVersion: readString(lhr['lighthouseVersion']),
      chromeVersion,
      formFactor: readString(configSettings['formFactor']),
      throttlingMethod: readString(configSettings['throttlingMethod']),
      requestedUrl: this.safeUrl(readString(lhr['requestedUrl'])),
      finalUrl: this.safeUrl(readString(lhr['finalDisplayedUrl']) ?? readString(lhr['finalUrl'])),
      fetchedAt: timestamp(lhr['fetchTime']),
      userAgent: userAgent?.slice(0, 512) ?? null,

      performanceScore: scoreString(readRecord(categoriesRecord['performance'])['score']),
      accessibilityScore: scoreString(readRecord(categoriesRecord['accessibility'])['score']),
      bestPracticesScore: scoreString(readRecord(categoriesRecord['best-practices'])['score']),
      seoScore: scoreString(readRecord(categoriesRecord['seo'])['score']),

      firstContentfulPaintMs: numericString(
        readRecord(auditsRecord['first-contentful-paint'])['numericValue'],
      ),
      largestContentfulPaintMs: numericString(
        readRecord(auditsRecord['largest-contentful-paint'])['numericValue'],
      ),
      speedIndexMs: numericString(
        readRecord(auditsRecord['speed-index'])['numericValue'],
      ),
      totalBlockingTimeMs: numericString(
        readRecord(auditsRecord['total-blocking-time'])['numericValue'],
      ),
      cumulativeLayoutShift: numericString(
        readRecord(auditsRecord['cumulative-layout-shift'])['numericValue'],
        6,
      ),
      timeToInteractiveMs: numericString(
        readRecord(auditsRecord['interactive'])['numericValue'],
      ),
      totalByteWeightBytes: safeInteger(
        readRecord(auditsRecord['total-byte-weight'])['numericValue'],
      ),
      networkRequests: safeInteger(
        readRecord(auditsRecord['network-requests'])['numericValue'],
      ),
      auditSummaries,
      categoryDetails,
      runWarnings,
    };

    return { report, audits: auditRows, chromeVersion };
  }

  private extractChromeVersion(userAgent: string | null): string | null {
    if (!userAgent) return null;
    const match = userAgent.match(/Chrome\/([0-9.]+)/i);
    return match?.[1] ?? null;
  }

  private safeUrl(value: string | null): string | null {
    if (!value) return null;
    return redactUrl(value).slice(0, 4_096);
  }
}

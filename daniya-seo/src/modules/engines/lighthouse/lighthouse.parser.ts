import { Injectable } from '@nestjs/common';

interface LighthouseRawAudit {
  title: string;
  description?: string;
  score: number | null;
  scoreDisplayMode: string;
  numericValue?: number;
  numericUnit?: string;
  displayValue?: string;
  explanation?: string;
  errorMessage?: string;
  warnings?: string[];
  details?: unknown;
}

interface LighthouseRawCategory {
  title: string;
  score: number | null;
  auditRefs: {
    id: string;
    weight: number;
    group?: string;
  }[];
}

interface LighthouseRawResult {
  requestedUrl?: string;
  mainDocumentUrl?: string;
  finalDisplayedUrl: string;
  fetchTime: string;
  lighthouseVersion: string;
  userAgent: string;
  environment?: {
    networkUserAgent?: string;
  };
  categories: Record<string, LighthouseRawCategory>;
  audits: Record<string, LighthouseRawAudit>;
  runWarnings?: string[];
  runtimeError?: {
    code: string;
    message: string;
  };
}

export interface LighthouseMetric {
  value: number | null;
  unit: string | null;
  displayValue: string | null;
}

export interface LighthouseParsedReport {
  metadata: {
    requestedUrl: string | null;
    mainDocumentUrl: string | null;
    finalDisplayedUrl: string;
    fetchTime: string;
    lighthouseVersion: string;
    userAgent: string;
    networkUserAgent: string | null;
  };
  categories: Record<
    string,
    {
      title: string;
      score: number | null;
      auditRefs: {
        id: string;
        weight: number;
        group: string | null;
      }[];
    }
  >;
  metrics: {
    firstContentfulPaint: LighthouseMetric | null;
    largestContentfulPaint: LighthouseMetric | null;
    totalBlockingTime: LighthouseMetric | null;
    cumulativeLayoutShift: LighthouseMetric | null;
    speedIndex: LighthouseMetric | null;
  };
  audits: Record<string, LighthouseRawAudit>;
  warnings: string[];
}

@Injectable()
export class LighthouseParser {
  parse(lhr: LighthouseRawResult): LighthouseParsedReport {
    if (lhr.runtimeError) {
      throw new Error(
        `Lighthouse runtime error: ${lhr.runtimeError.code} - ${lhr.runtimeError.message}`,
      );
    }

    const categories = Object.fromEntries(
      Object.entries(lhr.categories).map(([key, category]) => [
        key,
        {
          title: category.title,
          score: category.score,
          auditRefs: category.auditRefs.map((ref) => ({
            id: ref.id,
            weight: ref.weight,
            group: ref.group ?? null,
          })),
        },
      ]),
    );

    const getMetric = (auditId: string): LighthouseMetric | null => {
      const audit = lhr.audits[auditId];

      if (!audit) {
        return null;
      }

      return {
        value: audit.numericValue ?? null,
        unit: audit.numericUnit ?? null,
        displayValue: audit.displayValue ?? null,
      };
    };

    return {
      metadata: {
        requestedUrl: lhr.requestedUrl ?? null,
        mainDocumentUrl: lhr.mainDocumentUrl ?? null,
        finalDisplayedUrl: lhr.finalDisplayedUrl,
        fetchTime: lhr.fetchTime,
        lighthouseVersion: lhr.lighthouseVersion,
        userAgent: lhr.userAgent,
        networkUserAgent: lhr.environment?.networkUserAgent ?? null,
      },

      categories,

      metrics: {
        firstContentfulPaint: getMetric('first-contentful-paint'),
        largestContentfulPaint: getMetric('largest-contentful-paint'),
        totalBlockingTime: getMetric('total-blocking-time'),
        cumulativeLayoutShift: getMetric('cumulative-layout-shift'),
        speedIndex: getMetric('speed-index'),
      },

      audits: lhr.audits,

      warnings: lhr.runWarnings ?? [],
    };
  }
}
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DrizzleService } from '../infrastructure/database/drizzle.service';
import { WorkflowRepository } from '../modules/workflow/workflow.repository';
import type { StoredArtifact } from '../infrastructure/storage/artifact-storage.service';
import type { LighthouseParsedReport } from '../modules/engines/lighthouse/lighthouse.parser';

import { networkRuns } from '../infrastructure/database/schema/workflow/network-runs.schema';
import { lighthouseRuns } from '../infrastructure/database/schema/workflow/lighthouse-runs.schema';
import { reportArtifacts } from '../infrastructure/database/schema/workflow/report-artifacts.schema';

import { AccessService } from '../modules/access/services/access.service';

type ScanRecord = {
  id: string;
  cycleId: string;
  slotId: string;
};

type ArtifactInput = StoredArtifact;

function toJsonb(value: unknown) {
  const serialized = JSON.stringify(value);

  if (serialized === undefined) {
    throw new Error('Unable to serialize JSON data.');
  }

  return sql`${serialized}::jsonb`;
}

@Injectable()
export class ScanResultsRepository {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly workflowRepository: WorkflowRepository,
    private readonly accessService: AccessService,
  ) {}

  async saveLighthouse(input: {
    scan: ScanRecord;
    engineRunId: string;
    lockToken: string;
    report: LighthouseParsedReport;
    artifact: ArtifactInput;
  }): Promise<void> {
    const report = input.report;

    const auditSummaries = Object.fromEntries(
      Object.entries(report.audits).map(([id, audit]) => [
        id,
        {
          id,
          title: audit.title,
          score: audit.score,
          displayValue: audit.displayValue ?? null,
          numericValue: audit.numericValue ?? null,
          numericUnit: audit.numericUnit ?? null,
        },
      ]),
    );

    const metric = (value: number | null | undefined) =>
      value == null ? null : String(value);

    const score = (category: string) => {
      const value = report.categories[category]?.score;
      return value == null ? null : String(value);
    };

    const auditValue = (id: string) => {
      const value = report.audits[id]?.numericValue;

      return value != null && Number.isFinite(value)
        ? Math.trunc(value)
        : null;
    };

    await this.drizzle.db.transaction(async (tx) => {
      await tx.insert(lighthouseRuns).values({
        scanId: input.scan.id,
        engineRunId: input.engineRunId,

        lighthouseVersion: report.metadata.lighthouseVersion,
        requestedUrl: report.metadata.requestedUrl,
        finalUrl: report.metadata.finalDisplayedUrl,
        fetchedAt: new Date(report.metadata.fetchTime),
        userAgent: report.metadata.userAgent,

        performanceScore: score('performance'),
        accessibilityScore: score('accessibility'),
        bestPracticesScore: score('best-practices'),
        seoScore: score('seo'),

        firstContentfulPaintMs: metric(
          report.metrics.firstContentfulPaint?.value,
        ),
        largestContentfulPaintMs: metric(
          report.metrics.largestContentfulPaint?.value,
        ),
        speedIndexMs: metric(report.metrics.speedIndex?.value),
        totalBlockingTimeMs: metric(
          report.metrics.totalBlockingTime?.value,
        ),
        cumulativeLayoutShift: metric(
          report.metrics.cumulativeLayoutShift?.value,
        ),
        timeToInteractiveMs: metric(
          report.audits['interactive']?.numericValue,
        ),

        totalByteWeightBytes: auditValue('total-byte-weight'),
        networkRequests: auditValue('network-requests'),

        auditSummaries: toJsonb(auditSummaries),
        categoryDetails: report.categories,
        runWarnings: report.warnings,
      });

      await tx.insert(reportArtifacts).values({
        scanId: input.scan.id,
        engineRunId: input.engineRunId,
        ...input.artifact,
      });

      const succeeded =
        await this.workflowRepository.markScanEngineRunSucceeded(
          input.engineRunId,
          input.lockToken,
          tx,
        );

      if (!succeeded) {
        throw new Error('ENGINE_LEASE_LOST');
      }

      const slotConsumed =
        await this.workflowRepository.consumePageCycleSlot(
          input.scan.slotId,
          tx,
        );

      if (slotConsumed) {
        await this.accessService.commitPageQuota(
          input.scan.cycleId,
          tx,
        );
      }
    });
  }

  async saveNetwork(input: {
    scanId: string;
    engineRunId: string;
    lockToken: string;
    chromeVersion: string;
    targetUrl: string;
    finalUrl: string;
    startedAt: Date;
    finishedAt: Date;
    observationDurationMs: number;
    report: Record<string, unknown>;
    artifacts: ArtifactInput[];
  }): Promise<void> {
    const requestsValue = input.report['requests'];
    const findingsValue = input.report['findings'];

    const requests = Array.isArray(requestsValue)
      ? requestsValue.length
      : null;

    const findings = Array.isArray(findingsValue)
      ? findingsValue.length
      : null;

    await this.drizzle.db.transaction(async (tx) => {
      await tx.insert(networkRuns).values({
        scanId: input.scanId,
        engineRunId: input.engineRunId,
        chromeVersion: input.chromeVersion,
        requestedUrl: input.targetUrl,
        finalUrl: input.finalUrl,
        captureStartedAt: input.startedAt,
        captureFinishedAt: input.finishedAt,
        observationDurationMs: input.observationDurationMs,

        summary: toJsonb({
          requestCount: requests,
          findingCount: findings,
        }),

        fieldAvailability: toJsonb({
          netLog: 'available',
          requests: requests === null ? 'not_observed' : 'available',
          findings: findings === null ? 'not_observed' : 'available',
        }),
      });

      await tx.insert(reportArtifacts).values(
        input.artifacts.map((artifact) => ({
          scanId: input.scanId,
          engineRunId: input.engineRunId,
          ...artifact,
        })),
      );

      const succeeded =
        await this.workflowRepository.markScanEngineRunSucceeded(
          input.engineRunId,
          input.lockToken,
          tx,
        );

      if (!succeeded) {
        throw new Error('ENGINE_LEASE_LOST');
      }
    });
  }

  async saveEngineArtifact(input: {
    scanId: string;
    engineRunId: string;
    lockToken: string;
    artifact: ArtifactInput;
  }): Promise<void> {
    await this.drizzle.db.transaction(async (tx) => {
      await tx.insert(reportArtifacts).values({
        scanId: input.scanId,
        engineRunId: input.engineRunId,
        ...input.artifact,
      });

      const succeeded =
        await this.workflowRepository.markScanEngineRunSucceeded(
          input.engineRunId,
          input.lockToken,
          tx,
        );

      if (!succeeded) {
        throw new Error('ENGINE_LEASE_LOST');
      }
    });
  }
}
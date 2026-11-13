import { Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DrizzleService } from '../drizzle.service';
import {
  lighthouseAudits,
  lighthouseReports,
  reportArtifacts,
} from '../schema';

export type CreateLighthouseReportInput = Omit<
  typeof lighthouseReports.$inferInsert,
  'id' | 'createdAt'
>;

export type CreateLighthouseAuditInput = Omit<
  typeof lighthouseAudits.$inferInsert,
  'id' | 'createdAt' | 'reportId'
>;

export type CreateLighthouseArtifactInput = Omit<
  typeof reportArtifacts.$inferInsert,
  'id' | 'createdAt' | 'reportId'
>;

export type LighthouseReportRow = typeof lighthouseReports.$inferSelect;

export interface SaveLighthouseSnapshotInput {
  report: CreateLighthouseReportInput;
  audits: CreateLighthouseAuditInput[];
  artifacts: CreateLighthouseArtifactInput[];
  batchSize?: number;
}

@Injectable()
export class LighthouseReportsRepository {
  constructor(private readonly database: DrizzleService) {}

  /** Compatibility helper for callers from the earlier lighthouse_results repository. */
  async create(input: CreateLighthouseReportInput): Promise<LighthouseReportRow> {
    const rows = await this.database.db
      .insert(lighthouseReports)
      .values(input)
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Lighthouse report insert returned no row.');
    return row;
  }

  /**
   * Saves the normalized report, audit rows and artifact metadata atomically.
   * The files must already exist in private storage before this transaction.
   */
  async saveSnapshot(input: SaveLighthouseSnapshotInput): Promise<{
    report: LighthouseReportRow;
    auditCount: number;
    artifactCount: number;
  }> {
    const batchSize = Math.min(Math.max(input.batchSize ?? 100, 1), 250);

    return this.database.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(lighthouseReports)
        .values(input.report)
        .returning();

      const report = inserted[0];
      if (!report) {
        throw new Error('Lighthouse report insert returned no row.');
      }

      for (let offset = 0; offset < input.audits.length; offset += batchSize) {
        const batch = input.audits.slice(offset, offset + batchSize);
        await tx.insert(lighthouseAudits).values(
          batch.map((audit) => ({ ...audit, reportId: report.id })),
        );
      }

      if (input.artifacts.length > 0) {
        await tx.insert(reportArtifacts).values(
          input.artifacts,
        );
      }

      return {
        report,
        auditCount: input.audits.length,
        artifactCount: input.artifacts.length,
      };
    });
  }

  findByEngineRunId(
    engineRunId: string,
  ): Promise<LighthouseReportRow | undefined> {
    return this.database.db.query.lighthouseReports.findFirst({
      where: eq(lighthouseReports.engineRunId, engineRunId),
    });
  }

  findById(reportId: string): Promise<LighthouseReportRow | undefined> {
    return this.database.db.query.lighthouseReports.findFirst({
      where: eq(lighthouseReports.id, reportId),
    });
  }

  listByScanId(scanId: string): Promise<LighthouseReportRow[]> {
    return this.database.db
      .select()
      .from(lighthouseReports)
      .where(eq(lighthouseReports.scanId, scanId))
      .orderBy(desc(lighthouseReports.createdAt));
  }
}

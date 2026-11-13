import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DrizzleService } from '../drizzle.service';
import type { JsonObject } from '../schema/schema.types';
import { reportFindings, reports, scans } from '../schema';

export type CreateReportFindingInput = Omit<
  typeof reportFindings.$inferInsert,
  'id' | 'reportId' | 'createdAt'
>;

export interface SaveReportSnapshotInput {
  scanId: string;
  schemaVersion: string;
  summary: JsonObject;
  generatedAt?: Date;
  findings: CreateReportFindingInput[];
  batchSize?: number;
}

@Injectable()
export class ReportsRepository {
  constructor(private readonly database: DrizzleService) {}

  /**
   * Replaces the report snapshot and its findings atomically. The scan row is
   * locked to serialize concurrent report finalization for the same scan.
   */
  async saveSnapshot(input: SaveReportSnapshotInput) {
    const batchSize = Math.min(Math.max(input.batchSize ?? 500, 1), 500);

    return this.database.db.transaction(async (tx) => {
      const scanRows = await tx
        .select({ id: scans.id })
        .from(scans)
        .where(eq(scans.id, input.scanId))
        .for('update');

      if (!scanRows[0]) return undefined;

      const generatedAt = input.generatedAt ?? new Date();
      const reportRows = await tx
        .insert(reports)
        .values({
          scanId: input.scanId,
          schemaVersion: input.schemaVersion,
          summary: input.summary,
          generatedAt,
        })
        .onConflictDoUpdate({
          target: reports.scanId,
          set: {
            schemaVersion: input.schemaVersion,
            summary: input.summary,
            generatedAt,
            updatedAt: new Date(),
          },
        })
        .returning();

      const report = reportRows[0];
      if (!report) throw new Error('Report upsert returned no row.');

      await tx
        .delete(reportFindings)
        .where(eq(reportFindings.reportId, report.id));

      for (let offset = 0; offset < input.findings.length; offset += batchSize) {
        const batch = input.findings.slice(offset, offset + batchSize);
        const rows: (typeof reportFindings.$inferInsert)[] = batch.map(
          (finding) => ({
            ...finding,
            reportId: report.id,
          }),
        );

        await tx.insert(reportFindings).values(rows);
      }

      return report;
    });
  }

  findByScanId(scanId: string) {
    return this.database.db.query.reports.findFirst({
      where: eq(reports.scanId, scanId),
      with: {
        findings: true,
        artifacts: true,
      },
    });
  }

  findFindingByFingerprint(input: {
    reportId: string;
    fingerprint: string;
  }) {
    return this.database.db.query.reportFindings.findFirst({
      where: and(
        eq(reportFindings.reportId, input.reportId),
        eq(reportFindings.fingerprint, input.fingerprint),
      ),
    });
  }
}

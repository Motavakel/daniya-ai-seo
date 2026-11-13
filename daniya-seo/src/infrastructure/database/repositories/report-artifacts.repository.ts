import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNotNull, lte } from 'drizzle-orm';
import { DrizzleService } from '../drizzle.service';
import { reportArtifacts } from '../schema';

export type CreateReportArtifactInput = Omit<
  typeof reportArtifacts.$inferInsert,
  'id' | 'createdAt'
>;
export type ReportArtifactRow = typeof reportArtifacts.$inferSelect;

@Injectable()
export class ReportArtifactsRepository {
  constructor(private readonly database: DrizzleService) {}

  async create(input: CreateReportArtifactInput): Promise<ReportArtifactRow> {
    const rows = await this.database.db
      .insert(reportArtifacts)
      .values(input)
      .returning();

    const row = rows[0];
    if (!row) throw new Error('Artifact insert returned no row.');
    return row;
  }

  findById(artifactId: string): Promise<ReportArtifactRow | undefined> {
    return this.database.db.query.reportArtifacts.findFirst({
      where: eq(reportArtifacts.id, artifactId),
    });
  }

  async listByScanId(scanId: string): Promise<ReportArtifactRow[]> {
    return this.database.db
      .select()
      .from(reportArtifacts)
      .where(eq(reportArtifacts.scanId, scanId))
      .orderBy(asc(reportArtifacts.createdAt));
  }

  async listExpired(input?: {
    now?: Date;
    limit?: number;
  }): Promise<ReportArtifactRow[]> {
    const now = input?.now ?? new Date();
    const limit = Math.min(Math.max(input?.limit ?? 100, 1), 500);

    return this.database.db
      .select()
      .from(reportArtifacts)
      .where(
        and(
          isNotNull(reportArtifacts.expiresAt),
          lte(reportArtifacts.expiresAt, now),
        ),
      )
      .orderBy(asc(reportArtifacts.expiresAt))
      .limit(limit);
  }

  /** Call only after the corresponding private-storage object was deleted. */
  async deleteMetadataAfterStorageRemoval(
    artifactId: string,
  ): Promise<boolean> {
    const rows = await this.database.db
      .delete(reportArtifacts)
      .where(eq(reportArtifacts.id, artifactId))
      .returning({ id: reportArtifacts.id });

    return rows.length > 0;
  }
}

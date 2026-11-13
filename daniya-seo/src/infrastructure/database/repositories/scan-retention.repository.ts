import { Injectable } from '@nestjs/common';
import { and, eq, inArray, lte, notExists } from 'drizzle-orm';
import { DrizzleService } from '../drizzle.service';
import { reportArtifacts, scans } from '../schema';

@Injectable()
export class ScanRetentionRepository {
  constructor(private readonly database: DrizzleService) {}

  async deleteExpiredWithoutArtifacts(input?: {
    now?: Date;
    limit?: number;
  }): Promise<string[]> {
    const now = input?.now ?? new Date();
    const limit = Math.min(Math.max(input?.limit ?? 100, 1), 500);
    const expired = this.database.db
      .select({ id: scans.id })
      .from(scans)
      .where(and(
        lte(scans.expiresAt, now),
        notExists(
          this.database.db
            .select({ id: reportArtifacts.id })
            .from(reportArtifacts)
            .where(eq(reportArtifacts.scanId, scans.id)),
        ),
      ))
      .orderBy(scans.expiresAt)
      .limit(limit);

    const deleted = await this.database.db
      .delete(scans)
      .where(inArray(scans.id, expired))
      .returning({ id: scans.id });

    return deleted.map((row) => row.id);
  }
}

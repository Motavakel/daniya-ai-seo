import { Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { DrizzleService } from '../drizzle.service';
import { lighthouseAudits } from '../schema';

export type LighthouseAuditRow = typeof lighthouseAudits.$inferSelect;

@Injectable()
export class LighthouseAuditsRepository {
  constructor(private readonly database: DrizzleService) {}

  async listByReportId(input: {
    reportId: string;
    limit?: number;
  }): Promise<LighthouseAuditRow[]> {
    const limit = Math.min(Math.max(input.limit ?? 500, 1), 1_000);

    return this.database.db
      .select()
      .from(lighthouseAudits)
      .where(eq(lighthouseAudits.reportId, input.reportId))
      .orderBy(asc(lighthouseAudits.auditId))
      .limit(limit);
  }
}

import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database.module';
import { LighthouseReportsRepository } from './lighthouse-reports.repository';
import { LighthouseAuditsRepository } from './lighthouse-audits.repository';
import { NetworkCapturesRepository } from './network-captures.repository';
import { NetworkFindingsRepository } from './network-findings.repository';
import { OutboxEventsRepository } from './outbox-events.repository';
import { ReportArtifactsRepository } from './report-artifacts.repository';
import { ReportsRepository } from './reports.repository';
import { ScanEngineRunsRepository } from './scan-engine-runs.repository';
import { ScansRepository } from './scans.repository';
import { ScanRetentionRepository } from './scan-retention.repository';

@Module({
  imports: [DatabaseModule],
  providers: [
    ScansRepository,
    ScanRetentionRepository,
    ScanEngineRunsRepository,
    LighthouseReportsRepository,
    LighthouseAuditsRepository,
    NetworkCapturesRepository,
    NetworkFindingsRepository,
    ReportsRepository,
    ReportArtifactsRepository,
    OutboxEventsRepository,
  ],
  exports: [
    ScansRepository,
    ScanRetentionRepository,
    ScanEngineRunsRepository,
    LighthouseReportsRepository,
    LighthouseAuditsRepository,
    NetworkCapturesRepository,
    NetworkFindingsRepository,
    ReportsRepository,
    ReportArtifactsRepository,
    OutboxEventsRepository,
  ],
})
export class RepositoriesModule {}

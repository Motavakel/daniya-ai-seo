import { Module } from '@nestjs/common';

import { ConfigModule } from '../core/config/config.module';
import { DatabaseModule } from '../infrastructure/database/database.module';
import { QueueModule } from '../infrastructure/queue/queue.module';
import { OutboxModule } from '../infrastructure/outbox/outbox.module';
import { ArtifactStorageService } from '../infrastructure/storage/artifact-storage.service';

import { AccessModule } from '../modules/access/access.module';
import { WorkflowModule } from '../modules/workflow/workflow.module';
import { EnginesModule } from '../modules/engines/engines.module';

import { ScanProcessor } from './scan.processor';
import { ScanOrchestratorService } from './scan-orchestrator.service';
import { ScanResultsRepository } from './scan-results.repository';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    QueueModule,
    AccessModule,
    WorkflowModule,
    EnginesModule,
    OutboxModule,
  ],
  providers: [
    ScanProcessor,
    ScanOrchestratorService,
    ScanResultsRepository,
    ArtifactStorageService,
  ],
})
export class WorkerModule {}
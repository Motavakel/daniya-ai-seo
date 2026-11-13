import { Module } from '@nestjs/common';
import { ConfigModule } from '../core/config/config.module';
import { RepositoriesModule } from '../infrastructure/database/repositories/repositories.module';
import { QueueModule } from '../infrastructure/queue/queue.module';
import { WorkerQueuesModule } from '../infrastructure/queue/worker-queues.module';
import { DiagnosticsModule } from '../modules/diagnostics/application/diagnostics.module';
import { LighthouseEngineModule } from '../modules/lighthouse/application/lighthouse-engine.module';
import { NetworkEngineModule } from '../modules/network/application/network-engine.module';
import { WorkflowModule } from '../modules/workflow/application/workflow.module';
import { BrowserExecutionLockService } from '../modules/workflow/infrastructure/browser-execution-lock.service';
import { LighthouseProcessor } from '../modules/workflow/infrastructure/lighthouse.processor';
import { NetworkProcessor } from '../modules/workflow/infrastructure/network.processor';
import { OutboxPublisherService } from '../modules/workflow/infrastructure/outbox-publisher.service';
import { ArtifactRetentionService } from '../modules/workflow/infrastructure/artifact-retention.service';

@Module({
  imports: [
    ConfigModule,
    RepositoriesModule,
    QueueModule,
    WorkerQueuesModule,
    LighthouseEngineModule,
    NetworkEngineModule,
    DiagnosticsModule,
    WorkflowModule,
  ],
  providers: [
    BrowserExecutionLockService,
    OutboxPublisherService,
    ArtifactRetentionService,
    LighthouseProcessor,
    NetworkProcessor,
  ],
})
export class WorkerModule {}

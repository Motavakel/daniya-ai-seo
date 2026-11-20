import { Module } from '@nestjs/common';

import { ConfigModule } from '../../core/config/config.module';
import { DatabaseModule } from '../database/database.module';
import { QueueModule } from '../queue/queue.module';
import { WorkflowModule } from '../../modules/workflow/workflow.module';

import { OutboxPublisherService } from './outbox-publisher.service';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    QueueModule,
    WorkflowModule,
  ],
  providers: [OutboxPublisherService],
})
export class OutboxModule {}
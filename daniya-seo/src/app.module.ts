import { Module } from '@nestjs/common';

import { ConfigModule } from './core/config/config.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { OutboxModule } from './infrastructure/outbox/outbox.module';

import { AccessModule } from './modules/access/access.module';
import { ApiModule } from './modules/api/api.module';
import { ReportsModule } from './modules/reports/reports.module';
import { SecurityModule } from './modules/security/security.module';
import { WorkflowModule } from './modules/workflow/workflow.module';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    SecurityModule,
    AccessModule,
    WorkflowModule,
    ApiModule,
    ReportsModule,
    OutboxModule,
  ],
})
export class AppModule {}
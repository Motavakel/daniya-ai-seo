import { Module } from '@nestjs/common';
import { ConfigModule } from './core/config/config.module';
import { RepositoriesModule } from './infrastructure/database/repositories/repositories.module';
import { SecurityModule } from './modules/security/security.module';
import { WorkflowModule } from './modules/workflow/application/workflow.module';
import { WorkflowApiModule } from './modules/api/api.module';


@Module({
  imports: [
    ConfigModule,
    RepositoriesModule,
    SecurityModule,
    WorkflowModule,
    WorkflowApiModule,
  ],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { RepositoriesModule } from '../../../infrastructure/database/repositories/repositories.module';
import { WorkflowModule } from '../application/workflow.module';
import { GatewayContextGuard } from '../transport/gateway-context.guard';
import { ScanWorkflowController } from './scan-workflow.controller';

@Module({
  imports: [WorkflowModule, RepositoriesModule],
  controllers: [ScanWorkflowController],
  providers: [GatewayContextGuard],
})
export class WorkflowApiModule {}

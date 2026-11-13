import { Module } from '@nestjs/common';
import { ConfigModule } from '../../../core/config/config.module';
import { DatabaseModule } from '../../../infrastructure/database/database.module';
import { RepositoriesModule } from '../../../infrastructure/database/repositories/repositories.module';
import { SecurityModule } from '../../security/security.module';
import { ReportFinalizerService } from '../api/report-finalizer.service';
import { ScanWorkflowService } from './scan-workflow.service';
import { ScanWorkflowRepository } from '../../../infrastructure/database/repositories/scan-workflow.repository';

@Module({
  imports: [ConfigModule, DatabaseModule, RepositoriesModule, SecurityModule],
  providers: [ScanWorkflowRepository, ScanWorkflowService, ReportFinalizerService],
  exports: [ScanWorkflowService, ReportFinalizerService],
})
export class WorkflowModule {}

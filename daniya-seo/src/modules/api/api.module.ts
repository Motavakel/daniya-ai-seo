import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AccessModule } from '../access/access.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { ReportsModule } from '../reports/reports.module';
import { ReportController } from './controllers/report.controller';
import { AccountController } from './controllers/account.controller';
import { GatewayAuthGuard } from './gurds/gateway-auth.guard';
import { GatewayScopeGuard } from './gurds/gateway-scope.guard';
import { ScanController } from './controllers/scan-controller';


@Module({
  imports: [ConfigModule, WorkflowModule, ReportsModule, AccessModule],
  controllers: [ScanController, ReportController, AccountController],
  providers: [GatewayAuthGuard, GatewayScopeGuard],
})
export class ApiModule {}
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { ReportsRepository } from './reports.repository';
import { GatewayAuthGuard } from '../api/gurds/gateway-auth.guard';
import { GatewayScopeGuard } from '../api/gurds/gateway-scope.guard';

@Module({
  imports: [
    DatabaseModule,
  ],

  controllers: [
    ReportsController,
  ],

  providers: [
    ReportsService,
    ReportsRepository,
    GatewayAuthGuard,
    GatewayScopeGuard,
  ],

  exports: [
    ReportsService,
  ],
})
export class ReportsModule {}
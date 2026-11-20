import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../infrastructure/database/database.module';

import { GatewayAuthGuard } from '../api/guards/gateway-auth.guard';
import { GatewayScopeGuard } from '../api/guards/gateway-scope.guard';

import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { ReportsRepository } from './reports.repository';

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
import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';

import { CurrentPrincipal } from '../api/decorators/current-principal.decorator';
import { RequireGatewayScopes } from '../api/decorators/require-gateway-scopes.decorator';

import { GatewayAuthGuard } from '../api/guards/gateway-auth.guard';
import { GatewayScopeGuard } from '../api/guards/gateway-scope.guard';

import type { AuthenticatedPrincipal } from '../api/gateway-context';

import { ReportsService } from './reports.service';

@Controller('api/v1/reports')
@UseGuards(GatewayAuthGuard, GatewayScopeGuard)
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
  ) {}

  @Get(':scanId')
  @Header('Cache-Control', 'private, no-store')
  @RequireGatewayScopes('reports:read')
  async get(
    @CurrentPrincipal()
    principal: AuthenticatedPrincipal,

    @Param('scanId', ParseUUIDPipe)
    scanId: string,
  ) {
    return this.reportsService.getScanReport({
      scanId,
      customerId: principal.customerId,
    });
  }
}
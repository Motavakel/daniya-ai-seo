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
import type { AuthenticatedPrincipal } from '../api/gateway-context';
import { ReportsService } from './reports.service';
import { GatewayAuthGuard } from '../api/gurds/gateway-auth.guard';
import { GatewayScopeGuard } from '../api/gurds/gateway-scope.guard';

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
import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { CurrentPrincipal } from '../decorators/current-principal.decorator';
import { RequireGatewayScopes } from '../decorators/require-gateway-scopes.decorator';
import type { AuthenticatedPrincipal } from '../gateway-context';
import { ReportsService } from '../../reports/reports.service';
import { GatewayAuthGuard } from '../gurds/gateway-auth.guard';
import { GatewayScopeGuard } from '../gurds/gateway-scope.guard';

@Controller('api/v1/reports')
@UseGuards(GatewayAuthGuard, GatewayScopeGuard)
export class ReportController {
  constructor(private readonly reports: ReportsService) {}

  @Get(':scanId')
  @RequireGatewayScopes('reports:read')
  async get(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('scanId', new ParseUUIDPipe()) scanId: string,
  ) {
    return this.reports.getScanReport({
      scanId,
      customerId: principal.customerId,
    });
  }
}
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentPrincipal } from '../decorators/current-principal.decorator';
import { RequireGatewayScopes } from '../decorators/require-gateway-scopes.decorator';
import { CreateScanDto } from '../dto/create-scan.dto';
import type { AuthenticatedPrincipal } from '../gateway-context';
import { WorkflowService } from '../../workflow/workflow.service';
import { GatewayScopeGuard } from '../gurds/gateway-scope.guard';
import { GatewayAuthGuard } from '../gurds/gateway-auth.guard';
import { IdempotencyKey } from '../decorators/idempotency-key.decorator';

@Controller('api/v1/scans')
@UseGuards(GatewayAuthGuard, GatewayScopeGuard)
export class ScanController {
  constructor(private readonly workflow: WorkflowService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireGatewayScopes('scans:create')
  async create(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() dto: CreateScanDto,
    @IdempotencyKey() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.workflow.createScan({
      customerId: principal.customerId,
      pageUrl: dto.page_url,
      idempotencyKey,
      tokenId: principal.tokenId,
    });

    res.header('Location', `/api/v1/scans/${result.scanId}`);

    return {
      scanId: result.scanId,
      status: result.status,
      alreadyExisted: result.alreadyExisted,
      createdAt: result.createdAt.toISOString(),
    };
  }

  @Get(':scanId')
  @RequireGatewayScopes('scans:read')
  async getStatus(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('scanId', new ParseUUIDPipe()) scanId: string,
  ) {
    return this.workflow.getScanStatus({
      scanId,
      customerId: principal.customerId,
    });
  }
}

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
import { IdempotencyKey } from '../decorators/idempotency-key.decorator';
import { RequireGatewayScopes } from '../decorators/require-gateway-scopes.decorator';

import { CreateScanDto } from '../dto/create-scan.dto';
import type { AuthenticatedPrincipal } from '../gateway-context';


import { WorkflowService } from '../../workflow/services/workflow.service';
import { GatewayAuthGuard } from '../gurds/gateway-auth.guard';
import { GatewayScopeGuard } from '../gurds/gateway-scope.guard';

@Controller('api/v1/scans')
@UseGuards(GatewayAuthGuard, GatewayScopeGuard)
export class ScanController {
  constructor(
    private readonly workflowService: WorkflowService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireGatewayScopes('scans:create')
  async create(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() dto: CreateScanDto,
    @IdempotencyKey() idempotencyKey: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.workflowService.createScan({
      customerId: principal.customerId,
      gatewayTokenId: principal.tokenId,
      targetUrl: dto.page_url,
      idempotencyKey,
    });

    const statusUrl = `/api/v1/scans/${result.scanId}`;

    response.setHeader('Location', statusUrl);

    return {
      scanId: result.scanId,
      status: result.status,
      statusUrl,
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
    return this.workflowService.getScanStatus({
      scanId,
      customerId: principal.customerId,
    });
  }
}
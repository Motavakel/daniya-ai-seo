import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentPrincipal } from '../decorators/current-principal.decorator';
import { RequireGatewayScopes } from '../decorators/require-gateway-scopes.decorator';
import { RepurchaseDto } from '../dto/repurchase.dto';
import { UpgradePlanDto } from '../dto/upgrade-plan.dto';
import type { AuthenticatedPrincipal } from '../gateway-context';
import { CycleLifecycleService } from '../../access/cycle-lifecycle.service';
import { GatewayAuthGuard } from '../gurds/gateway-auth.guard';
import { GatewayScopeGuard } from '../gurds/gateway-scope.guard';

@Controller('api/v1/account')
@UseGuards(GatewayAuthGuard, GatewayScopeGuard)
export class AccountController {
  constructor(private readonly lifecycle: CycleLifecycleService) {}

  @Post('upgrade')
  @HttpCode(HttpStatus.OK)
  @RequireGatewayScopes('account:upgrade')
  async upgrade(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() dto: UpgradePlanDto,
  ) {
    const result = await this.lifecycle.upgradePlan({
      customerId: principal.customerId,
      targetPlan: dto.target_plan,
      tokenId: principal.tokenId,
    });

    return {
      cycleId: result.cycleId,
      cycleNo: result.cycleNo,
      planLevel: result.planLevel,
      pageLimit: result.pageLimit,
      pagesCommitted: result.pagesCommitted,
      pendingNewPages: result.pendingNewPages,
      upgradedAt: result.upgradedAt.toISOString(),
    };
  }

  @Post('repurchase')
  @HttpCode(HttpStatus.CREATED)
  @RequireGatewayScopes('account:repurchase')
  async repurchase(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() dto: RepurchaseDto,
  ) {
    const result = await this.lifecycle.repurchase({
      customerId: principal.customerId,
      plan: dto.plan,
      tokenId: principal.tokenId,
    });

    return {
      cycleId: result.cycleId,
      cycleNo: result.cycleNo,
      planLevel: result.planLevel,
      pageLimit: result.pageLimit,
      startedAt: result.startedAt.toISOString(),
    };
  }
}
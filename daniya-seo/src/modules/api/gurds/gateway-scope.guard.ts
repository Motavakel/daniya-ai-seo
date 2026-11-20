import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRED_GATEWAY_SCOPES } from '../decorators/require-gateway-scopes.decorator';
import type { RequestWithPrincipal } from '../gateway-context';

@Injectable()
export class GatewayScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredScopes =
      this.reflector.getAllAndOverride<string[]>(REQUIRED_GATEWAY_SCOPES, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    if (requiredScopes.length === 0) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<RequestWithPrincipal>();

    if (!request.principal) {
      throw new InternalServerErrorException(
        'AuthenticatedPrincipal is missing. ' +
          'Ensure GatewayAuthGuard runs before GatewayScopeGuard.',
      );
    }

    const granted = new Set(request.principal.scopes);
    const missing = requiredScopes.filter((scope) => !granted.has(scope));

    if (missing.length > 0) {
      throw new ForbiddenException(
        `Missing required scope(s): ${missing.join(', ')}.`,
      );
    }

    return true;
  }
}
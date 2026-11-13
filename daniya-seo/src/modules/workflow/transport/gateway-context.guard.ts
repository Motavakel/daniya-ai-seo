import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { isTrustedGatewayContext, type GatewayContextRequest } from './gateway-context';

@Injectable()
export class GatewayContextGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<GatewayContextRequest>();
    if (!isTrustedGatewayContext(request.gatewayContext)) {
      throw new ForbiddenException('Verified Gateway context is required.');
    }
    return true;
  }
}

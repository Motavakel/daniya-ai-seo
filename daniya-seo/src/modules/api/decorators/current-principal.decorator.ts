import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import type {
  AuthenticatedPrincipal,
  RequestWithPrincipal,
} from '../gateway-context';

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedPrincipal => {
    const request = ctx.switchToHttp().getRequest<RequestWithPrincipal>();

    if (!request.principal) {
      throw new InternalServerErrorException(
        'AuthenticatedPrincipal is not attached to the request. ' +
          'Ensure GatewayAuthGuard is registered on this route.',
      );
    }

    return request.principal;
  },
);
import { SetMetadata } from '@nestjs/common';
import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';

export const SCOPES_KEY = 'required_scopes';
export const RequireScopes = (...scopes: string[]) => SetMetadata(SCOPES_KEY, scopes);

export const PUBLIC_KEY = 'is_public';
export const Public = () => SetMetadata(PUBLIC_KEY, true);

export const CurrentClientId = createParamDecorator(
  (_: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<{
      authContext?: {
        clientId?: string;
      };
    }>();

    const clientId = request.authContext?.clientId;

    if (!clientId) {
      throw new UnauthorizedException();
    }

    return clientId;
  },
);
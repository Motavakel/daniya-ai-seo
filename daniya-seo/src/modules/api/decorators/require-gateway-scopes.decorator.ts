import { SetMetadata } from '@nestjs/common';

export const REQUIRED_GATEWAY_SCOPES = 'required_gateway_scopes';

export const RequireGatewayScopes = (...scopes: string[]) =>
  SetMetadata(REQUIRED_GATEWAY_SCOPES, scopes);
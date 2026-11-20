import type { Request } from 'express';

export interface AuthenticatedPrincipal {
  readonly customerId: string;
  readonly scopes: readonly string[];
  readonly tokenId: string;
}

export interface RequestWithPrincipal extends Request {
  readonly principal: AuthenticatedPrincipal;
}
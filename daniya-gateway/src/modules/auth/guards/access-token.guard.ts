import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthService } from '../auth.service';
import { sha256FingerprintToBase64Url } from '../mtls/cert-fingerprint';
import { PUBLIC_KEY, SCOPES_KEY } from '../../../common/decorators/common.decorator';

interface AuthenticatedRequest extends Request {
  authContext?: {
    clientId: string;
    certThumbprint: string;
    scopes: string[];
  };
}

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
    ]);

    if (isPublic) return true;

    const request = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;

    if (!authorization?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const token = authorization.slice('Bearer '.length).trim();
    const fingerprint = request.headers['x-client-cert-fingerprint-sha256'];

    if (typeof fingerprint !== 'string' || !fingerprint) {
      throw new UnauthorizedException('Missing client certificate fingerprint');
    }

    let certThumbprintX5t: string;
    try {
      certThumbprintX5t = sha256FingerprintToBase64Url(fingerprint);
    } catch {
      throw new UnauthorizedException('Invalid client certificate fingerprint');
    }

    const requiredScopes =
      this.reflector.getAllAndOverride<string[]>(SCOPES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    const result = await this.auth.validateAccessToken({
      bearerToken: token,
      certThumbprintX5t,
      requiredScopes,
    });

    request.authContext = {
      clientId: result.clientId,
      certThumbprint: certThumbprintX5t,
      scopes: result.scopes,
    };

    return true;
  }
}

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import {
  importSPKI,
  jwtVerify,
  type JWTVerifyResult,
  type JWTPayload,
} from 'jose';
import type { Request } from 'express';
import type {
  AuthenticatedPrincipal,
} from '../gateway-context';

const REQUIRED_CLAIMS = ['sub', 'iat', 'exp', 'jti', 'scope'];
const MAX_SUB_LENGTH = 128;
const CLOCK_TOLERANCE_SECONDS = 5;

interface VerifiedPayload extends JWTPayload {
  sub: string;
  scope: string;
  jti: string;
}

@Injectable()
export class GatewayAuthGuard implements CanActivate, OnModuleInit {
  private readonly publicKeyPem: string;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly expectedKid: string;
  private publicKey!: Awaited<ReturnType<typeof importSPKI>>;

  constructor(config: ConfigService) {
    this.publicKeyPem = readFileSync(
      config.getOrThrow<string>('SEO_GATEWAY_JWT_PUBLIC_KEY_FILE'),
      'utf8',
    );
    this.issuer = config.getOrThrow<string>('SEO_GATEWAY_JWT_ISSUER');
    this.audience = config.getOrThrow<string>('SEO_GATEWAY_JWT_AUDIENCE');
    this.expectedKid = config.getOrThrow<string>('SEO_GATEWAY_JWT_KID');
  }

  async onModuleInit(): Promise<void> {
    this.publicKey = await importSPKI(this.publicKeyPem, 'ES256');
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractBearerToken(request);
    const { payload, kid } = await this.verifyToken(token);

    if (kid !== this.expectedKid) {
      throw new UnauthorizedException('Untrusted Gateway signing key.');
    }

    const principal = this.buildPrincipal(payload);
    this.attachPrincipal(request, principal);

    return true;
  }

  private extractBearerToken(request: Request): string {
    const authorization = request.headers.authorization;
    if (!authorization) {
      throw new UnauthorizedException('Authorization header is required.');
    }

    const match = authorization.match(/^Bearer\s+(\S+)$/i);
    const token = match?.[1];
    if (!token) {
      throw new UnauthorizedException('Invalid authorization header.');
    }
    return token;
  }

  private async verifyToken(
    token: string,
  ): Promise<{ payload: VerifiedPayload; kid: string | undefined }> {
    let result: JWTVerifyResult & { protectedHeader: { kid?: string } };

    try {
      result = (await jwtVerify(token, this.publicKey, {
        algorithms: ['ES256'],
        issuer: this.issuer,
        audience: this.audience,
        requiredClaims: REQUIRED_CLAIMS,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      })) as JWTVerifyResult & { protectedHeader: { kid?: string } };
    } catch {
      throw new UnauthorizedException('Invalid or expired Gateway token.');
    }

    return {
      payload: result.payload as VerifiedPayload,
      kid: result.protectedHeader.kid,
    };
  }

  private buildPrincipal(payload: VerifiedPayload): AuthenticatedPrincipal {
    if (
      typeof payload.sub !== 'string' ||
      !payload.sub.trim() ||
      payload.sub.length > MAX_SUB_LENGTH
    ) {
      throw new UnauthorizedException('Invalid Gateway token subject.');
    }

    if (typeof payload.scope !== 'string') {
      throw new UnauthorizedException('Invalid Gateway scope claim.');
    }

    const scopes = Object.freeze(
      payload.scope.split(/\s+/).filter(Boolean),
    );

    return Object.freeze({
      customerId: payload.sub,
      scopes,
      tokenId: payload.jti,
    });
  }

  private attachPrincipal(
    request: Request,
    principal: AuthenticatedPrincipal,
  ): void {
    Object.defineProperty(request, 'principal', {
      value: principal,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
}
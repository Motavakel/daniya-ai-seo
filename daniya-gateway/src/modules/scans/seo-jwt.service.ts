import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

@Injectable()
export class SeoJwtService {
  private readonly privateKey: string;
  private readonly kid: string;
  private readonly iss: string;
  private readonly aud: string;
  private readonly ttl: number;

  constructor(cfg: ConfigService) {
    this.privateKey = readFileSync(cfg.getOrThrow<string>('GATEWAY_SEO_JWT_PRIVATE_KEY_FILE'), 'utf8');
    this.kid = cfg.getOrThrow<string>('GATEWAY_SEO_JWT_KID');
    this.iss = cfg.getOrThrow<string>('GATEWAY_SEO_JWT_ISSUER');
    this.aud = cfg.getOrThrow<string>('GATEWAY_SEO_JWT_AUDIENCE');
    this.ttl = cfg.getOrThrow<number>('GATEWAY_SEO_JWT_TTL_SECONDS');
  }

  sign(params: { sub: string; plan: 'free' | 'pro'; scope: string }): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'ES256', typ: 'JWT', kid: this.kid };
    const payload = {
      iss: this.iss,
      aud: this.aud,
      sub: params.sub,
      scope: params.scope,
      plan: params.plan,
      iat: now,
      exp: now + this.ttl,
      jti: randomUUID(),
    };
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const data = `${b64(header)}.${b64(payload)}`;
    const sig = sign('sha256', Buffer.from(data), {
      key: this.privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    return `${data}.${sig.toString('base64url')}`;
  }
}
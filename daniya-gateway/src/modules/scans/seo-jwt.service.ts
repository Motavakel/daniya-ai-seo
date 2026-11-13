import {
  Injectable,
  OnModuleInit,
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { importPKCS8, SignJWT } from 'jose';

@Injectable()
export class SeoJwtService implements OnModuleInit {
  private readonly privateKeyPem: string;
  private privateKey!: Awaited<ReturnType<typeof importPKCS8>>;

  private readonly kid: string;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly ttlSeconds: number;

  constructor(private readonly config: ConfigService) {
    this.privateKeyPem = readFileSync(
      config.getOrThrow<string>('GATEWAY_SEO_JWT_PRIVATE_KEY_FILE'),
      'utf8',
    );

    this.kid = config.getOrThrow<string>('GATEWAY_SEO_JWT_KID');
    this.issuer = config.getOrThrow<string>('GATEWAY_SEO_JWT_ISSUER');
    this.audience = config.getOrThrow<string>('GATEWAY_SEO_JWT_AUDIENCE');

    this.ttlSeconds = Number(
      config.getOrThrow<string>('GATEWAY_SEO_JWT_TTL_SECONDS'),
    );

    if (
      !Number.isInteger(this.ttlSeconds) ||
      this.ttlSeconds < 1 ||
      this.ttlSeconds > 300
    ) {
      throw new Error('Invalid SEO JWT TTL');
    }
  }

  async onModuleInit() {
    this.privateKey = await importPKCS8(this.privateKeyPem, 'ES256');
  }

  async createServiceToken(customerId: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);

    return new SignJWT({
      scope: 'scans:create',
    })
      .setProtectedHeader({
        alg: 'ES256',
        typ: 'JWT',
        kid: this.kid,
      })
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setSubject(customerId)
      .setIssuedAt(now)
      .setExpirationTime(now + this.ttlSeconds)
      .setJti(randomUUID())
      .sign(this.privateKey);
  }
}
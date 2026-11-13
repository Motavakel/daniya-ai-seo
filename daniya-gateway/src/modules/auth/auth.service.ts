import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull, lte, or } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import Redis from 'ioredis';
import * as schema from '../../database/schema';
import { ClientCertRepository } from './client-cert.repository';
import { REDIS } from '../../redis/redis.constants';
import { DB } from '../../database/database.constants';
import { CertificateAuthorityService } from '../certificate-authority/certificate-authority.service';

interface TokenRecord {
  clientId: string;
  thumbprint: string;
  scopes: string[];
  expiresAt: number;
}

const TOKEN_KEY_PREFIX = 'oauth:token:';

@Injectable()
export class AuthService {
  constructor(
    @Inject(REDIS)
    private readonly redis: Redis,
    private readonly certificateAuthority: CertificateAuthorityService,
    @Inject(DB)
    private readonly db: NodePgDatabase<typeof schema>,

    private readonly certRepo: ClientCertRepository,
    private readonly cfg: ConfigService,
  ) {}

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private secureCompare(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);

    return left.length === right.length && timingSafeEqual(left, right);
  }

  private getPositiveInteger(key: string, fallback: number): number {
    const value = Number(this.cfg.get<string | number>(key));

    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  }

  async createEnrollmentToken(params: { clientId: string }) {
    const [client] = await this.db
      .select({
        id: schema.oauthClients.id,
      })
      .from(schema.oauthClients)
      .where(
        and(
          eq(schema.oauthClients.clientId, params.clientId),
          eq(schema.oauthClients.isActive, true),
        ),
      )
      .limit(1);

    if (!client) {
      throw new NotFoundException('Active OAuth client not found');
    }

    const enrollmentToken = randomBytes(32).toString('base64url');
    const enrollmentTokenHash = this.hash(enrollmentToken);

    const ttl = this.getPositiveInteger(
      'OAUTH_ENROLLMENT_TOKEN_TTL_SECONDS',
      900,
    );

    const expiresAt = new Date(Date.now() + ttl * 1000);

    await this.db
      .update(schema.oauthClients)
      .set({
        enrollmentTokenHash: enrollmentTokenHash,
        enrollmentExpiresAt: expiresAt,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.oauthClients.id, client.id),
          eq(schema.oauthClients.isActive, true),
        ),
      );

    return {
      client_id: params.clientId,
      enrollment_token: enrollmentToken,
      expires_at: expiresAt.toISOString(),
      expires_in: ttl,
    };
  }

  async enrollClient(params: {
    clientId: string;
    enrollmentToken: string;
    csr: string;
  }) {
    const [client] = await this.db
      .select({
        id: schema.oauthClients.id,
        enrollmentTokenHash: schema.oauthClients.enrollmentTokenHash,
        enrollmentExpiresAt: schema.oauthClients.enrollmentExpiresAt,
      })
      .from(schema.oauthClients)
      .where(
        and(
          eq(schema.oauthClients.clientId, params.clientId),
          eq(schema.oauthClients.isActive, true),
        ),
      )
      .limit(1);

    const invalidEnrollment = () =>
      new UnauthorizedException('Invalid or expired enrollment credentials');

    if (!client?.enrollmentTokenHash || !client.enrollmentExpiresAt) {
      throw invalidEnrollment();
    }

    const now = new Date();

    if (client.enrollmentExpiresAt <= now) {
      throw invalidEnrollment();
    }

    const submittedHash = this.hash(params.enrollmentToken);

    if (!this.secureCompare(client.enrollmentTokenHash, submittedHash)) {
      throw invalidEnrollment();
    }

    await this.certificateAuthority.validateCsr(params.csr);

    const [consumed] = await this.db
      .update(schema.oauthClients)
      .set({
        enrollmentTokenHash: null,
        enrollmentExpiresAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.oauthClients.id, client.id),
          eq(schema.oauthClients.isActive, true),
          eq(schema.oauthClients.enrollmentTokenHash, submittedHash),
          gt(schema.oauthClients.enrollmentExpiresAt, now),
        ),
      )
      .returning({
        id: schema.oauthClients.id,
      });

    if (!consumed) {
      throw invalidEnrollment();
    }

    const issued = await this.certificateAuthority.createClientCertificate(
      params.csr,
    );

    const [certificate] = await this.db
      .insert(schema.oauthClientCertificates)
      .values({
        oauthClientId: client.id,
        certificateThumbprint: issued.thumbprint,
        status: 'active',
        validFrom: issued.validFrom,
        validUntil: issued.validUntil,
      })
      .onConflictDoNothing({
        target: schema.oauthClientCertificates.certificateThumbprint,
      })
      .returning({
        id: schema.oauthClientCertificates.id,
      });

    if (!certificate) {
      throw new ConflictException('Certificate is already registered');
    }

    return {
      certificate: issued.certificateChain,
    };
  }

  async issueClientCredentialsToken(params: {
    clientId: string;
    certThumbprintX5t: string;
  }) {
    const [client] = await this.db
      .select({
        id: schema.oauthClients.id,
        clientId: schema.oauthClients.clientId,
        isActive: schema.oauthClients.isActive,
        allowedScopes: schema.oauthClients.allowedScopes,
      })
      .from(schema.oauthClients)
      .where(eq(schema.oauthClients.clientId, params.clientId))
      .limit(1);

    if (!client?.isActive) {
      throw new UnauthorizedException('Invalid client');
    }

    const certificate = await this.certRepo.findActiveByThumbprint(
      params.certThumbprintX5t,
    );

    if (!certificate || certificate.client.clientId !== params.clientId) {
      throw new UnauthorizedException('Unknown or revoked certificate');
    }

    const scopes = client.allowedScopes;

    const token = randomBytes(32).toString('base64url');
    const tokenHash = this.hash(token);

    const ttl = this.getPositiveInteger('OAUTH_ACCESS_TOKEN_TTL_SECONDS', 600);

    const record: TokenRecord = {
      clientId: client.clientId,
      thumbprint: params.certThumbprintX5t,
      scopes,
      expiresAt: Date.now() + ttl * 1000,
    };

    await this.redis.set(
      `${TOKEN_KEY_PREFIX}${tokenHash}`,
      JSON.stringify(record),
      'EX',
      ttl,
    );

    return {
      access_token: token,
      token_type: 'Bearer' as const,
      expires_in: ttl,
      scope: scopes.join(' '),
    };
  }

  async validateAccessToken(params: {
    bearerToken: string;
    certThumbprintX5t: string;
    requiredScopes: string[];
  }): Promise<{ clientId: string; scopes: string[] }> {
    const tokenHash = this.hash(params.bearerToken);
    const key = `${TOKEN_KEY_PREFIX}${tokenHash}`;

    const raw = await this.redis.get(key);

    if (!raw) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.redis.del(key);
      throw new UnauthorizedException('Invalid token');
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as TokenRecord).clientId !== 'string' ||
      typeof (parsed as TokenRecord).thumbprint !== 'string' ||
      !Array.isArray((parsed as TokenRecord).scopes) ||
      !(parsed as TokenRecord).scopes.every(
        (scope) => typeof scope === 'string',
      ) ||
      !Number.isSafeInteger((parsed as TokenRecord).expiresAt)
    ) {
      await this.redis.del(key);
      throw new UnauthorizedException('Invalid token');
    }

    const record = parsed as TokenRecord;

    if (record.expiresAt <= Date.now()) {
      await this.redis.del(key);
      throw new UnauthorizedException('Token expired');
    }

    if (!this.secureCompare(record.thumbprint, params.certThumbprintX5t)) {
      throw new UnauthorizedException(
        'Token is bound to a different certificate',
      );
    }

    const [client] = await this.db
      .select({
        id: schema.oauthClients.id,
        isActive: schema.oauthClients.isActive,
      })
      .from(schema.oauthClients)
      .where(eq(schema.oauthClients.clientId, record.clientId))
      .limit(1);

    if (!client?.isActive) {
      await this.redis.del(key);
      throw new UnauthorizedException('Client is no longer active');
    }

    const now = new Date();

    const [cert] = await this.db
      .select({
        id: schema.oauthClientCertificates.id,
      })
      .from(schema.oauthClientCertificates)
      .where(
        and(
          eq(schema.oauthClientCertificates.oauthClientId, client.id),
          eq(
            schema.oauthClientCertificates.certificateThumbprint,
            params.certThumbprintX5t,
          ),
          eq(schema.oauthClientCertificates.status, 'active'),
          isNull(schema.oauthClientCertificates.revokedAt),
          lte(schema.oauthClientCertificates.validFrom, now),
          or(
            isNull(schema.oauthClientCertificates.validUntil),
            gt(schema.oauthClientCertificates.validUntil, now),
          ),
        ),
      )
      .limit(1);

    if (!cert) {
      await this.redis.del(key);
      throw new UnauthorizedException('Certificate is no longer active');
    }

    const missing = params.requiredScopes.filter(
      (scope) => !record.scopes.includes(scope),
    );

    if (missing.length > 0) {
      throw new ForbiddenException(`Missing scopes: ${missing.join(', ')}`);
    }

    return {
      clientId: record.clientId,
      scopes: record.scopes,
    };
  }

}

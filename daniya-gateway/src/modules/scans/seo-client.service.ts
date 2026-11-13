import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { Agent } from 'node:https';
import { SeoJwtService } from './seo-jwt.service';

interface SeoResponse {
  status: number;
  body: string;
}

@Injectable()
export class SeoClientService {
  private readonly logger = new Logger(SeoClientService.name);
  private readonly agent: Agent;
  private readonly baseUrl: string;

  constructor(cfg: ConfigService, private readonly jwt: SeoJwtService) {
    this.baseUrl = cfg.getOrThrow<string>('SEO_API_URL');
    this.agent = new Agent({
      ca: readFileSync(cfg.getOrThrow<string>('SEO_MTLS_CA_FILE')),
      cert: readFileSync(cfg.getOrThrow<string>('SEO_MTLS_CLIENT_CERT_FILE')),
      key: readFileSync(cfg.getOrThrow<string>('SEO_MTLS_CLIENT_KEY_FILE')),
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      keepAlive: true,
    });
  }

  async createScan(params: {
    customerId: string;
    plan: 'free' | 'pro';
    pageUrl: string;
    idempotencyKey: string;
  }): Promise<{ status: number; body: unknown }> {
    const token = this.jwt.sign({
      sub: params.customerId,
      plan: params.plan,
      scope: 'scans:create',
    });

    const payload = JSON.stringify({
      page_url: params.pageUrl,
      plan: params.plan,
    });

    const res = await this.send('/api/v1/scans', {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': params.idempotencyKey,
    }, payload);

    if (res.status >= 500) {
      this.logger.warn(`SEO returned ${res.status}`);
      throw new ServiceUnavailableException('SEO temporarily unavailable');
    }
    try {
      return { status: res.status, body: JSON.parse(res.body) };
    } catch {
      return { status: res.status, body: res.body };
    }
  }

  private send(path: string, headers: Record<string, string>, body: string): Promise<SeoResponse> {
    const url = new URL(path, this.baseUrl);
    return new Promise<SeoResponse>((resolve, reject) => {
      const req = request(
        {
          method: 'POST',
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname,
          headers: {
            ...headers,
            'content-length': Buffer.byteLength(body).toString(),
          },
          agent: this.agent,
          timeout: 10_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
          );
        },
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('SEO request timeout')));
      req.write(body);
      req.end();
    });
  }
}
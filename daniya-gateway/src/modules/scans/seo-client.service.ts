
import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';

import { readFileSync } from 'node:fs';
import { Agent, request } from 'node:https';

import { SeoJwtService } from './seo-jwt.service';

interface SeoResponse {
  statusCode: number;
  body: string;
}

@Injectable()
export class SeoClientService implements OnModuleDestroy {
  private readonly logger = new Logger(SeoClientService.name);
  private readonly agent: Agent;
  private readonly endpoint: URL;

  private readonly timeoutMs = 15_000;
  private readonly maxResponseSize = 1024 * 1024;

  constructor(
    config: ConfigService,
    private readonly jwt: SeoJwtService,
  ) {
    const baseUrl = new URL(
      config.getOrThrow<string>('SEO_API_URL'),
    );

    if (baseUrl.protocol !== 'https:') {
      throw new Error('SEO_API_URL must use HTTPS');
    }

    this.endpoint = new URL('/api/v1/scans', baseUrl);

    this.agent = new Agent({
      ca: readFileSync(
        config.getOrThrow<string>('SEO_MTLS_CA_FILE'),
      ),
      cert: readFileSync(
        config.getOrThrow<string>('SEO_MTLS_CLIENT_CERT_FILE'),
      ),
      key: readFileSync(
        config.getOrThrow<string>('SEO_MTLS_CLIENT_KEY_FILE'),
      ),
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      keepAlive: true,
    });
  }

  async createScan(params: {
    customerId: string;
    pageUrl: string;
    idempotencyKey: string;
  }): Promise<unknown> {
    const token = await this.jwt.createServiceToken(params.customerId);

    const body = Buffer.from(
      JSON.stringify({
        page_url: params.pageUrl,
      }),
      'utf8',
    );

    let response: SeoResponse;

    try {
      response = await this.send(
        body,
        token,
        params.idempotencyKey,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code === 'ETIMEDOUT') {
        throw new GatewayTimeoutException('SEO request timed out');
      }

      this.logger.error(
        'SEO service request failed',
        error instanceof Error ? error.stack : undefined,
      );

      throw new ServiceUnavailableException(
        'SEO service is temporarily unavailable',
      );
    }

    if (response.statusCode === 401 || response.statusCode === 403) {
      throw new BadGatewayException('SEO service authentication failed');
    }

    if (response.statusCode >= 500) {
      this.logger.warn(`SEO returned ${response.statusCode}`);

      throw new ServiceUnavailableException(
        'SEO service is temporarily unavailable',
      );
    }

    if (response.statusCode >= 400 && response.statusCode < 500) {
      throw new HttpException(
        {
          statusCode: response.statusCode,
          message: this.getErrorMessage(response.body),
        },
        response.statusCode,
      );
    }

    if (
      response.statusCode < 200 ||
      response.statusCode >= 300
    ) {
      throw new BadGatewayException('Invalid response from SEO service');
    }

    try {
      return JSON.parse(response.body);
    } catch {
      throw new BadGatewayException('Invalid response from SEO service');
    }
  }

  private send(
    body: Buffer,
    token: string,
    idempotencyKey: string,
  ): Promise<SeoResponse> {
    return new Promise((resolve, reject) => {
      const req = request(
        this.endpoint,
        {
          method: 'POST',
          agent: this.agent,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'content-length': body.length.toString(),
            'idempotency-key': idempotencyKey,
            accept: 'application/json',
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let totalSize = 0;

          res.on('data', (chunk: Buffer) => {
            totalSize += chunk.length;

            if (totalSize > this.maxResponseSize) {
              res.destroy(new Error('SEO response is too large'));
              return;
            }

            chunks.push(chunk);
          });

          res.on('end', () => {
            resolve({
              statusCode: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });

          res.on('error', reject);
        },
      );

      req.setTimeout(this.timeoutMs, () => {
        const error = new Error(
          'SEO request timed out',
        ) as NodeJS.ErrnoException;

        error.code = 'ETIMEDOUT';
        req.destroy(error);
      });

      req.on('error', reject);
      req.end(body);
    });
  }

  private getErrorMessage(body: string): string {
    try {
      const response = JSON.parse(body);
      const message = response?.message;

      if (typeof message === 'string') {
        return message.slice(0, 300);
      }

      if (Array.isArray(message)) {
        return message
          .filter((item): item is string => typeof item === 'string')
          .join(', ')
          .slice(0, 300);
      }
    } catch {
      // Ignore invalid error response.
    }

    return 'SEO service rejected the request';
  }

  onModuleDestroy() {
    this.agent.destroy();
  }
}

import { BadRequestException, Injectable } from '@nestjs/common';

import {
  WorkflowRepository,
  type DbTransaction,
} from '../workflow.repository';

@Injectable()
export class PageResolverService {
  constructor(
    private readonly workflowRepository: WorkflowRepository,
  ) {}

  async resolve(
    customerId: string,
    targetUrl: string,
    tx: DbTransaction,
  ) {
    const normalizedUrl = this.normalizeUrl(targetUrl);

    const page = await this.workflowRepository.findOrCreatePage(
      customerId,
      normalizedUrl,
      tx,
    );

    return {
      page,
      normalizedUrl,
    };
  }

  private normalizeUrl(value: string): string {
    let url: URL;

    try {
      url = new URL(value);
    } catch {
      throw new BadRequestException('Invalid URL.');
    }

    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new BadRequestException(
        'Only HTTP and HTTPS URLs are supported.',
      );
    }

    if (url.username || url.password) {
      throw new BadRequestException(
        'URLs containing credentials are not supported.',
      );
    }

    // Remove fragment.
    url.hash = '';

    // Remove tracking query parameters.
    const trackingParams = new Set([
      'gclid',
      'dclid',
      'fbclid',
      'msclkid',
      'gbraid',
      'wbraid',
      'mc_cid',
      'mc_eid',
      'igshid',
      'gad_source',
      'gad_campaignid',
      'srsltid',
      '_ga',
      '_gl',
    ]);

    for (const key of [...url.searchParams.keys()]) {
      const normalizedKey = key.toLowerCase();

      if (
        normalizedKey.startsWith('utm_') ||
        trackingParams.has(normalizedKey)
      ) {
        url.searchParams.delete(key);
      }
    }

    return url.toString();
  }
}
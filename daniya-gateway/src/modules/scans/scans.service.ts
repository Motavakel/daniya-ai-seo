import { Injectable } from '@nestjs/common';

import { CustomersService } from '../customers/customers.service';
import { SeoClientService } from './seo-client.service';

@Injectable()
export class ScansService {
  constructor(
    private readonly customers: CustomersService,
    private readonly seoClient: SeoClientService,
  ) {}

  async create(params: {
    clientId: string;
    portalUserId: number;
    pageUrl: string;
    idempotencyKey: string;
  }) {
    const customer = await this.customers.findOrCreateIdentity(
      params.clientId,
      String(params.portalUserId),
    );

    return this.seoClient.createScan({
      customerId: String(customer.id),
      pageUrl: params.pageUrl,
      idempotencyKey: params.idempotencyKey,
    });
  }
}
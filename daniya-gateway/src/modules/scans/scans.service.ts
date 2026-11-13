import { Injectable } from '@nestjs/common';
import { CustomersService } from '../customers/customers.service';
import { SeoClientService } from './seo-client.service';
import { CreateScanDto } from './dto/create-scan.dto';

@Injectable()
export class ScansService {
  constructor(
    private readonly customers: CustomersService,
    private readonly seo: SeoClientService,
  ) {}

  async create(params: {
    clientId: string;
    dto: CreateScanDto;
    idempotencyKey: string;
  }) {
    const customer = await this.customers.findOrCreateIdentity(
      params.clientId,
      params.dto.portal_user_id,
    );

    // هیچ داده‌ای از اشتراک در Gateway ذخیره نمی‌شود؛
    // plan مستقیماً از دامنه WordPress (پشت mTLS + Bearer) به SEO فوروارد می‌شود.
    return this.seo.createScan({
      customerId: customer.id,
      plan: params.dto.effective_plan,
      pageUrl: params.dto.page_url,
      idempotencyKey: params.idempotencyKey,
    });
  }
}
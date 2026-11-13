import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';


import { CreateScanDto } from './dto/create-scan.dto';
import { ScansService } from './scans.service';
import { CurrentClientId, RequireScopes } from '../../common/decorators/common.decorator';

@Controller('scans')
export class ScansController {
  constructor(private readonly scans: ScansService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireScopes('scans:create')
  async create(
    @CurrentClientId() clientId: string,
    @Body() dto: CreateScanDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const key = idempotencyKey?.trim();

    if (!key || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) {
      throw new BadRequestException('A valid Idempotency-Key header is required');
    }

    return this.scans.create({
      clientId,
      portalUserId: dto.portal_user_id,
      pageUrl: dto.page_url,
      idempotencyKey: key,
    });
  }
}
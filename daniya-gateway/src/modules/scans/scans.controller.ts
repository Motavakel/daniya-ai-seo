import { BadRequestException, Body, Controller, Headers, Post } from '@nestjs/common';
import { ClientCert } from '../common/decorators/client-cert.decorator';
import { RequireScopes } from '../common/decorators/scopes.decorator';
import { CreateScanDto } from './dto/create-scan.dto';
import { ScansService } from './scans.service';

@Controller('scans')
export class ScansController {
  constructor(private readonly scans: ScansService) {}

  @Post()
  @RequireScopes('scans:create')
  async create(
    @Body() dto: CreateScanDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @ClientCert() clientId: string,
  ) {
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new BadRequestException('Idempotency-Key header is required');
    }
    if (idempotencyKey.length > 128) {
      throw new BadRequestException('Idempotency-Key is too long');
    }
    return this.scans.create({ clientId, dto, idempotencyKey });
  }
}
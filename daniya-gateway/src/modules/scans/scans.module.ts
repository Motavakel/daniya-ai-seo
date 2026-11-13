import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { CustomersModule } from '../customers/customers.module';

import { ScansController } from './scans.controller';
import { ScansService } from './scans.service';
import { SeoClientService } from './seo-client.service';
import { SeoJwtService } from './seo-jwt.service';

@Module({
  imports: [
    ConfigModule,
    CustomersModule,
  ],
  controllers: [
    ScansController,
  ],
  providers: [
    ScansService,
    SeoClientService,
    SeoJwtService,
  ],
})
export class ScansModule {}
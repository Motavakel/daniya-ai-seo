// src/support/dto/create-support-request.dto.ts
import { IsBoolean, IsIn, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class CreateSupportRequestDto {
  @IsString()
  @IsIn(['homepage', 'blog', 'product'])
  service_type!: 'homepage' | 'blog' | 'product';

  @IsUrl({ require_tld: true, require_protocol: true })
  page_url!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsBoolean()
  consent!: boolean;
}
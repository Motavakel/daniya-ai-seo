import { IsString, IsUrl, Length } from 'class-validator';

export class CreateScanDto {
  @IsString()
  @Length(8, 2048)
  @IsUrl({
    protocols: ['http', 'https'],
    require_protocol: true,
  })
  targetUrl!: string;
}
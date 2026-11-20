import { Transform } from 'class-transformer';
import { IsUrl, Length } from 'class-validator';

export class CreateScanDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsUrl(
    {
      protocols: ['https'],
      require_protocol: true,
      require_tld: true,
    },
    {
      message:
        'page_url must be a valid HTTPS URL. HTTP is not accepted; ' +
        'please provide an HTTPS address.',
    },
  )
  @Length(1, 2048, {
    message: 'page_url must be between 1 and 2048 characters.',
  })
  page_url!: string;
}
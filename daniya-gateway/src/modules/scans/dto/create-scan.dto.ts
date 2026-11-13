import { IsIn, IsNotEmpty, IsString, IsUrl } from 'class-validator';

export class CreateScanDto {
  @IsString()
  @IsNotEmpty()
  portal_user_id!: string;

  @IsUrl({ require_tld: true, require_protocol: true })
  page_url!: string;

  /**
   * پلن مؤثر کاربر — فقط مقدار استخراج‌شده در سرور WordPress (پشت mTLS + Token)
   * قابل اعتماد است. Gateway خودش تصمیم‌گیرنده نیست.
   */
  @IsString()
  @IsIn(['free', 'pro'])
  effective_plan!: 'free' | 'pro';
}
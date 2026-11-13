import { Module } from '@nestjs/common';
import { ConfigModule } from '../../core/config/config.module';
import { TargetUrlValidator } from './target-url.validator';

@Module({
  imports: [ConfigModule],
  providers: [TargetUrlValidator],
  exports: [TargetUrlValidator],
})
export class SecurityModule {}

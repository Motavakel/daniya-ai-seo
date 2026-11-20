import { Module } from '@nestjs/common';

import { TargetUrlValidator } from './target-url.validator';

@Module({
  providers: [TargetUrlValidator],
  exports: [TargetUrlValidator],
})
export class SecurityModule {}
import { Module } from '@nestjs/common';
import { CertificateAuthorityService } from './certificate-authority.service';

@Module({
  providers: [CertificateAuthorityService],
  exports: [CertificateAuthorityService],
})
export class CertificateAuthorityModule {}
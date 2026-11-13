import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ClientCertRepository } from './client-cert.repository';
import { CertificateAuthorityService } from './certificate-authority.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService, ClientCertRepository, CertificateAuthorityService],
  exports: [AuthService],
})
export class AuthModule {}

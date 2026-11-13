import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ClientCertRepository } from './client-cert.repository';
import { CertificateAuthorityModule } from '../certificate-authority/certificate-authority.module';

@Module({
  imports: [CertificateAuthorityModule],
  controllers: [AuthController],
  providers: [AuthService, ClientCertRepository],
  exports: [AuthService],
})
export class AuthModule {}
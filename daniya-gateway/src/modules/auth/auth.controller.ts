import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common';
import { EnrollClientDto } from './dto/enroll-client.dto';
import { ClientCredentialsDto } from './dto/token-request.dto';
import { AuthService } from './auth.service';
import { Public } from '../../common/decorators/common.decorator';
import { AccessTokenGuard } from './guards/access-token.guard';
import { sha256FingerprintToBase64Url } from '../../common/mtls/cert-fingerprint';

@UseGuards(AccessTokenGuard)
@Controller('oauth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('enroll')
  @HttpCode(HttpStatus.OK)
  enroll(@Body() body: EnrollClientDto) {
    return this.authService.enrollClient({
      clientId: body.client_id,
      enrollmentToken: body.enrollment_token,
      csr: body.csr,
    });
  }

  @Post('token')
  @HttpCode(HttpStatus.OK)
  token(
    @Body() body: ClientCredentialsDto,
    @Headers('x-client-cert-fingerprint-sha256') fingerprint?: string,
  ) {
    if (!fingerprint) {
      throw new UnauthorizedException('Client certificate required');
    }

    let certThumbprintX5t: string;
    try {
      certThumbprintX5t = sha256FingerprintToBase64Url(fingerprint);
    } catch {
      throw new UnauthorizedException('Invalid client certificate fingerprint');
    }

    return this.authService.issueClientCredentialsToken({
      clientId: body.client_id,
      certThumbprintX5t,
    });
  }
}

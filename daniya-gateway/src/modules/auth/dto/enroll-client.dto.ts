import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

export class EnrollClientDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  client_id!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  enrollment_token!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(16384)
  @Matches(/^-----BEGIN CERTIFICATE REQUEST-----[\s\S]+-----END CERTIFICATE REQUEST-----\s*$/)
  csr!: string;
}

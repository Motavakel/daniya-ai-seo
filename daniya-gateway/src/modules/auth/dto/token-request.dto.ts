import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ClientCredentialsDto {
  @IsIn(['client_credentials'])
  grant_type!: 'client_credentials';

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  client_id!: string;
}

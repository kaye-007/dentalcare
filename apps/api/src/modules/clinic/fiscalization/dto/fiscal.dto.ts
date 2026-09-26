import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

/** Business unit, cash register and operator codes as the authority issues them. */
const CODE = /^[a-z]{2}[0-9]{3}[a-z]{2}[0-9]{3}$/;
const CODE_MESSAGE = 'Codes are written as issued by the tax authority, e.g. ab123ab123';

export class UpdateFiscalSettingsDto {
  @IsOptional() @IsBoolean()
  enabled?: boolean;

  @IsOptional() @IsIn(['test', 'production'])
  environment?: 'test' | 'production';

  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(CODE, { message: CODE_MESSAGE })
  businessUnitCode?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(CODE, { message: CODE_MESSAGE })
  tcrCode?: string | null;

  @IsOptional() @IsBoolean()
  isIssuerInVat?: boolean;

  /** The exemption reason printed on lines without VAT, e.g. TYPE_1 for medical services. */
  @IsOptional() @Matches(/^TYPE_[0-9]{1,2}$/, { message: 'An exemption is written as TYPE_1, TYPE_2 …' })
  vatExemptionCode?: string;
}

/**
 * The signing certificate, one of two ways:
 *
 *   p12Base64 + password   the .p12/.pfx file exactly as the authority issued
 *                          it. What the settings screen sends.
 *   pem                    the private key and certificate as PEM, for a key
 *                          someone has already converted.
 */
export class InstallCertificateDto {
  @ValidateIf((o: InstallCertificateDto) => o.p12Base64 === undefined)
  @IsString() @MinLength(100) @MaxLength(40_000)
  pem?: string;

  /** A PKCS#12 file is a few kilobytes; 64 KB of base64 leaves room for a CA chain. */
  @ValidateIf((o: InstallCertificateDto) => o.pem === undefined)
  @IsString() @MinLength(64) @MaxLength(64_000)
  @Matches(/^[A-Za-z0-9+/]+={0,2}$/, { message: 'The certificate file must be sent as base64' })
  p12Base64?: string;

  /** Never stored, never logged. May be empty: some exports have no password. */
  @ValidateIf((o: InstallCertificateDto) => o.p12Base64 !== undefined)
  @IsString() @MaxLength(256)
  password?: string;
}

export class OperatorCodeDto {
  @ValidateIf((_, v) => v !== null) @Matches(CODE, { message: CODE_MESSAGE })
  operatorCode!: string | null;
}

export class CashDepositDto {
  @IsIn(['INITIAL', 'WITHDRAW'])
  operation!: 'INITIAL' | 'WITHDRAW';

  /** Minor units. The opening float may be zero. */
  @IsInt() @Min(0) @Max(100_000_000_00)
  amount!: number;

  @IsOptional() @IsString() @MaxLength(200)
  note?: string;
}

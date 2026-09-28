import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** A lab or a supplier: a name, and a way to reach them. */
export class CreatePartnerDto {
  @IsString()
  @MinLength(2, { message: 'Give it a name' })
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class UpdatePartnerDto {
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'Give it a name' })
  @MaxLength(120)
  name?: string;

  /** An empty string clears it. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  /** Retired partners stay on the work that names them; they are just not offered. */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

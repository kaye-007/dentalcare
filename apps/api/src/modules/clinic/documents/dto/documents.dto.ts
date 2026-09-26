import { DOCUMENT_KINDS, DocumentKind } from '../documents.types';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';


/* ══════════════════════════ DTOs ══════════════════════════ */

/** How a clinical photo relates to treatment (0009). Declared before the decorators that read it. */
export const PHOTO_TAGS = ['before', 'after', 'progress'] as const;
export type PhotoTag = (typeof PHOTO_TAGS)[number];

/**
 * Multipart fields arrive as strings, so numeric and optional values are
 * normalised before validation rather than after.
 */
export class UploadDocumentDto {
  @IsOptional() @IsIn(DOCUMENT_KINDS, {
    message: `Kind must be one of: ${DOCUMENT_KINDS.join(', ')}`,
  })
  kind?: DocumentKind;

  @IsOptional()
  @Transform(({ value }) =>
    value === '' || value === undefined || value === null ? undefined : Number(value),
  )
  @IsInt({ message: 'Tooth must be an FDI number' })
  @Min(11) @Max(85)
  tooth?: number;

  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsISO8601({}, { message: 'Taken-on must be a valid date' })
  takenOn?: string;

  @IsOptional() @IsString() @MaxLength(300)
  caption?: string;

  /** Before / after / progress, on clinical photos only. */
  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsIn([...PHOTO_TAGS])
  photoTag?: PhotoTag;
}

export class UpdateDocumentDto {
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsIn([...PHOTO_TAGS])
  photoTag?: PhotoTag | null;

  @IsOptional() @IsIn(DOCUMENT_KINDS)
  kind?: DocumentKind;

  @IsOptional() @IsInt() @Min(11) @Max(85)
  tooth?: number | null;

  @IsOptional() @IsISO8601()
  takenOn?: string | null;

  @IsOptional() @IsString() @MaxLength(300)
  caption?: string | null;
}

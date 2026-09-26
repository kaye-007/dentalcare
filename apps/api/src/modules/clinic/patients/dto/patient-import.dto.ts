import { IMPORT_BATCH_LIMIT, IMPORT_DATE_FORMATS, type ImportDateFormat } from '@dentalcare/shared';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * One batch of an import. A file larger than IMPORT_BATCH_LIMIT rows is sent
 * in several; each batch commits on its own and is recorded on its own.
 *
 * `rows` are plain objects keyed by system field (firstName, phone, …) with
 * the text from the file. Their contents are checked by the shared
 * normalizeImportRow, not by decorators, so that the preview and the commit
 * apply exactly one set of rules.
 */
export class ImportBatchDto {
  @IsString() @MinLength(1) @MaxLength(200)
  fileName!: string;

  /** Where the data came from, for the record: "Excel", "DentalSoft 4". */
  @IsOptional() @IsString() @MaxLength(80)
  sourceLabel?: string;

  @IsIn([...IMPORT_DATE_FORMATS])
  dateFormat!: ImportDateFormat;

  /**
   * Rows matching an existing patient by phone are skipped unless this is
   * false. A national ID match is always skipped: the database holds one
   * record per ID.
   */
  @IsBoolean()
  skipDuplicates!: boolean;

  /** Rows before this batch, so errors name the line in the file. */
  @IsInt() @Min(0) @Max(1_000_000)
  rowOffset!: number;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(IMPORT_BATCH_LIMIT)
  @IsObject({ each: true })
  rows!: Record<string, unknown>[];
}

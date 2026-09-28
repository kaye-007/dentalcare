import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  META_LANGUAGE_CODE,
  META_TEMPLATE_NAME,
  WHATSAPP_BATCH_LIMIT,
} from '@dentalcare/shared';

const META_ID = /^[0-9]{5,30}$/;

/**
 * The clinic's WhatsApp Cloud API account. The token is write-only: sent to
 * save or test, never sent back. Omitted when saving, the stored one is kept.
 */
export class ConnectionDto {
  @IsOptional()
  @IsString()
  @MinLength(20)
  @MaxLength(1024)
  @Matches(/^[A-Za-z0-9_\-.|]+$/, {
    message: 'That does not look like a WhatsApp access token',
  })
  accessToken?: string;

  @Matches(META_ID, {
    message: 'The Phone Number ID is the long number from WhatsApp Manager → API Setup',
  })
  phoneNumberId!: string;

  @Matches(META_ID, {
    message: 'The WhatsApp Business Account ID is the long number from WhatsApp Manager',
  })
  wabaId!: string;
}

/** Testing may use the form as typed, or — with nothing given — what is saved. */
export class TestConnectionDto {
  @IsOptional()
  @IsString()
  @MinLength(20)
  @MaxLength(1024)
  @Matches(/^[A-Za-z0-9_\-.|]+$/, {
    message: 'That does not look like a WhatsApp access token',
  })
  accessToken?: string;

  @IsOptional()
  @Matches(META_ID, { message: 'The Phone Number ID is a long number' })
  phoneNumberId?: string;

  @IsOptional()
  @Matches(META_ID, { message: 'The WhatsApp Business Account ID is a long number' })
  wabaId?: string;
}

export class TemplateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  displayName!: string;

  @Matches(META_TEMPLATE_NAME, {
    message: 'Meta template names use lowercase letters, digits and _',
  })
  metaTemplateName!: string;

  @Matches(META_LANGUAGE_CODE, {
    message: 'Use a WhatsApp language code, e.g. sq or en_US',
  })
  languageCode!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  previewBody!: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateTemplateDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  displayName?: string;

  @IsOptional()
  @Matches(META_TEMPLATE_NAME, {
    message: 'Meta template names use lowercase letters, digits and _',
  })
  metaTemplateName?: string;

  @IsOptional()
  @Matches(META_LANGUAGE_CODE, {
    message: 'Use a WhatsApp language code, e.g. sq or en_US',
  })
  languageCode?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  previewBody?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class ReminderDayQueryDto {
  /** YYYY-MM-DD in the clinic's zone. Omitted: tomorrow. */
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;
}

export class SendRemindersDto {
  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date!: string;

  @IsUUID()
  templateId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(WHATSAPP_BATCH_LIMIT)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  appointmentIds!: string[];
}

export class HistoryQueryDto {
  @IsOptional()
  @IsUUID()
  batchId?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  status?: string;
}

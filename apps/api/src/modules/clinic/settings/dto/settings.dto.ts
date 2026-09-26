import { WorkingDay } from '../settings.types';
import {
  CURRENCIES,
  REMINDER_CHANNELS,
  REMINDER_HOURS_OPTIONS,
  REMINDER_LOCALES,
  type CurrencyCode,
  type ReminderChannelId,
  type ReminderLocale,
} from '@dentalcare/shared';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export const PAYMENT_KINDS = ['cash', 'card', 'bank'] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

/**
 * A clinic's own name for a way of being paid. `kind` is what billing, the
 * reports and the tax authority understand; `label` is what the receptionist
 * picks and what the invoice prints.
 */
export class PaymentMethodDto {
  @Matches(/^[a-z0-9-]{1,40}$/, { message: 'A payment method id is lowercase letters, digits and hyphens' })
  id!: string;

  @IsString() @MinLength(1) @MaxLength(60)
  label!: string;

  @IsIn([...PAYMENT_KINDS])
  kind!: PaymentKind;

  @IsBoolean()
  active!: boolean;
}

export class UpdateSettingsDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120)
  clinicName?: string;

  @IsOptional() @IsString() @MaxLength(200)
  address?: string;

  @IsOptional() @IsString() @MaxLength(80)
  city?: string;

  @IsOptional() @IsString() @MaxLength(40)
  phone?: string;

  @IsOptional() @IsEmail({}, { message: 'Enter a valid clinic email' })
  email?: string;

  @IsOptional() @IsArray()
  workingHours?: WorkingDay[];

  @IsOptional() @IsInt() @Min(15) @Max(240)
  defaultAppointmentDuration?: number;

  @IsOptional() @IsBoolean()
  remindersEnabled?: boolean;

  /** 12 or 24 hours before the appointment (0009). */
  @IsOptional() @IsIn([...REMINDER_HOURS_OPTIONS], { message: 'Reminders go out 12 or 24 hours before' })
  reminderHoursBefore?: number;

  /** The clinic's default channel; a patient may choose another. */
  @IsOptional() @IsIn([...REMINDER_CHANNELS])
  reminderChannel?: ReminderChannelId;

  /* ── registration and branding ── */

  /** The registered business name, when it differs from the name patients know. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(160)
  legalName?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(60)
  registrationNumber?: string | null;

  /**
   * NIPT in Albania: a letter, eight digits, a letter (L12345678A). Other
   * countries' tax numbers are accepted in a looser form; fiscalization
   * checks the Albanian shape separately.
   */
  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== '')
  @Matches(/^[A-Za-z0-9 -]{5,20}$/, { message: 'Enter the tax number (NIPT) as printed, e.g. L12345678A' })
  taxNumber?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null && v !== '')
  @Matches(/^https?:\/\/\S{3,200}$/, { message: 'Enter the website as a full address, e.g. https://clinic.al' })
  website?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null)
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'Brand colour must be a hex colour such as #4b57e3' })
  brandColor?: string | null;

  /* ── money ── */

  @IsOptional()
  @Matches(/^[A-Za-z0-9/_.-]{0,12}$/, {
    message: 'Invoice prefix: up to 12 letters, digits, / _ . or -',
  })
  invoicePrefix?: string;

  /** Default VAT in basis points: 2000 is 20%. */
  @IsOptional() @IsInt() @Min(0) @Max(10000)
  vatRateBp?: number;

  @IsOptional() @IsInt() @Min(0) @Max(365)
  paymentTermsDays?: number;

  @IsOptional() @IsArray() @ArrayMaxSize(20)
  @ValidateNested({ each: true }) @Type(() => PaymentMethodDto)
  paymentMethods?: PaymentMethodDto[];

  @IsOptional() @IsBoolean()
  payrollLoggingEnabled?: boolean;

  /**
   * Require two-step sign-in for every role, not only administrators (for whom
   * it is always required). Takes effect at each person's next sign-in.
   */
  @IsOptional() @IsBoolean()
  mfaRequiredForAll?: boolean;

  /**
   * The clinic's one currency. Settable only until the clinic records a price
   * or any money; after that the database refuses the change (0006) and the
   * API answers 409.
   */
  @IsOptional() @IsIn(CURRENCIES as unknown as string[])
  currency?: CurrencyCode;

  /**
   * A second currency printed on estimates, for patients from abroad, or null
   * for none. Never the clinic's own currency; nothing is booked in it.
   */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsIn(CURRENCIES as unknown as string[])
  quoteCurrency?: CurrencyCode | null;

  /** 'live': the day's published rate. 'fixed': the clinic's own rate below. */
  @IsOptional() @IsIn(['live', 'fixed'])
  fxRateSource?: 'live' | 'fixed';

  /**
   * What the payment screen preselects when money is taken: the fiscal
   * invoice (the compliant default), the internal receipt, or neither, so
   * the choice is always deliberate.
   */
  @IsOptional() @IsIn(['internal', 'fiscal', 'ask'])
  defaultCheckoutMode?: 'internal' | 'fiscal' | 'ask';

  /** Off for a clinic that fiscalizes everything: the option disappears. */
  @IsOptional() @IsBoolean()
  internalReceiptsEnabled?: boolean;

  /** Clinic-currency units for ONE unit of the quote currency, e.g. 100.5 lek per euro. */
  @IsOptional() @ValidateIf((_, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 6 }) @Min(0.000001) @Max(100_000_000)
  fxFixedRate?: number | null;

  /** IANA zone the clinic's reminders are written in. Checked in the service. */
  @IsOptional() @IsString() @MaxLength(64)
  timezone?: string;

  @IsOptional() @IsIn(REMINDER_LOCALES as unknown as string[])
  reminderLocale?: ReminderLocale;

  /**
   * The clinic's own reminder wording. Null or empty goes back to the
   * built-in message; unknown placeholders are refused in the service.
   */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(480)
  reminderTemplate?: string | null;

  /** Calling code for numbers written the local way, without + or 00. */
  @IsOptional()
  @Matches(/^[1-9]\d{0,2}$/, { message: 'Enter the country calling code without + or 00, e.g. 355' })
  phoneCountryCode?: string;
}

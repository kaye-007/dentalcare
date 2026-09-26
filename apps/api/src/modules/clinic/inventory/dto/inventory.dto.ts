import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { MAX_QUANTITY, MOVEMENT_KINDS } from '../stock-engine';

/** Two decimal places, matching numeric(12,2). */
const TWO_PLACES = { maxDecimalPlaces: 2 } as const;

/** Shape only; lot-engine's isIsoDate decides whether it is a real date. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = 'Enter the date as YYYY-MM-DD';

export class CreateInventoryItemDto {
  @IsString()
  @MinLength(2, { message: 'Give the item a name' })
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

  /** Box, piece, ml, metre — whatever the clinic counts this in. */
  @IsString()
  @MinLength(1, { message: 'Say what this is counted in' })
  @MaxLength(20)
  unit!: string;

  /** Opening stock. Optional: an item can exist before anything arrives. */
  @IsOptional()
  @IsNumber(TWO_PLACES)
  @Min(0)
  @Max(MAX_QUANTITY)
  quantity?: number;

  /** The reorder level. At or below it, the item is flagged. */
  @IsOptional()
  @IsNumber(TWO_PLACES)
  @Min(0)
  @Max(MAX_QUANTITY)
  minimumQuantity?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  /** Record lot numbers and expiry dates for this item (0007). */
  @IsOptional()
  @IsBoolean()
  trackLots?: boolean;

  /** How many days before a lot's expiry it starts being flagged. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(730)
  expiryWarningDays?: number;

  /** The lot the opening stock belongs to. Required with opening stock of a tracked item. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  lotNumber?: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: DATE_MESSAGE })
  expiresOn?: string;
}

/**
 * Everything editable about an item EXCEPT its quantity.
 *
 * The running total is deliberately absent. It only ever moves through
 * `POST /inventory/:id/movements`, so every change to a shelf carries a kind,
 * a person and a time. A PATCH that could quietly set `quantity = 40` would
 * make the movement history a partial record — and a history you cannot trust
 * to be complete is worse than none, because it still looks like one.
 */
export class UpdateInventoryItemDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  unit?: string;

  @IsOptional()
  @IsNumber(TWO_PLACES)
  @Min(0)
  @Max(MAX_QUANTITY)
  minimumQuantity?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsOptional()
  @IsIn(['active', 'archived'])
  status?: 'active' | 'archived';

  /**
   * Turning it on keeps the stock already on the shelf as one lot with no
   * expiry date. Turning it off is refused once any lot exists.
   */
  @IsOptional()
  @IsBoolean()
  trackLots?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(730)
  expiryWarningDays?: number;
}

/**
 * One movement.
 *
 * `amount` for receipt, usage and write-off — always positive, because the
 * kind carries the direction. `countedQuantity` for an adjustment, because a
 * stock count is a statement about what is on the shelf, not about the
 * difference from what was expected. See stock-engine.ts for why that
 * distinction is worth two fields.
 *
 * `reason` is typed here and REQUIRED in the service for write-offs and
 * adjustments. It is not conditionally validated: `@ValidateIf` turning false
 * skips every validator on the property, which would leave `reason`
 * unvalidated — and therefore any shape at all — on a receipt. Validating the
 * type unconditionally and the requirement in one place is both safer and
 * easier to read than a decorator that changes what it enforces.
 *
 * For a lot-tracked item: a receipt names its lot by `lotNumber` (created on
 * first arrival, with `expiresOn`) or `lotId`; a usage may name `lotId` or let
 * the service pick the earliest expiry; a write-off or count must name
 * `lotId`. `patientId` and `procedureId` are for usage only.
 */
export class RecordMovementDto {
  @IsIn([...MOVEMENT_KINDS], {
    message: `Kind must be one of: ${MOVEMENT_KINDS.join(', ')}`,
  })
  kind!: (typeof MOVEMENT_KINDS)[number];

  @ValidateIf((o: RecordMovementDto) => o.kind !== 'adjustment')
  @IsNumber(TWO_PLACES, { message: 'Enter a quantity' })
  @Min(0.01, { message: 'Enter a quantity greater than zero' })
  @Max(MAX_QUANTITY)
  amount?: number;

  @ValidateIf((o: RecordMovementDto) => o.kind === 'adjustment')
  @IsNumber(TWO_PLACES, { message: 'Enter the quantity you counted' })
  @Min(0)
  @Max(MAX_QUANTITY)
  countedQuantity?: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;

  @IsOptional()
  @IsUUID()
  lotId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  lotNumber?: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: DATE_MESSAGE })
  expiresOn?: string;

  @IsOptional()
  @IsUUID()
  patientId?: string;

  @IsOptional()
  @IsUUID()
  procedureId?: string;
}

export class RecallLotDto {
  @IsString()
  @MinLength(3, { message: 'Say why the lot is being recalled' })
  @MaxLength(300)
  reason!: string;
}

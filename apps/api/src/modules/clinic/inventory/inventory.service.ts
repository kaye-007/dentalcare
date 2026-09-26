import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { ClinicAuditActor, ClinicAuditService } from '@/core/audit/clinic-audit.service';
import {
  CreateInventoryItemDto,
  RecordMovementDto,
  UpdateInventoryItemDto,
} from './dto/inventory.dto';
import {
  MovementKind,
  deltaFor,
  isLowStock,
  isOutOfStock,
  nextQuantity,
  parseQuantity,
} from './stock-engine';
import {
  LotCandidate,
  LotStatus,
  expiryState,
  isIsoDate,
  pickLot,
  usageBlocker,
} from './lot-engine';

/* ── rows and shapes ─────────────────────────────────────── */

interface ItemRow {
  id: string;
  name: string;
  category: string | null;
  unit: string;
  quantity: string;
  minimum_quantity: string;
  notes: string | null;
  status: string;
  track_lots: boolean;
  expiry_warning_days: number;
  /** Present on reads through ITEM_READ only. */
  next_expiry?: string | null;
  created_at: Date;
  updated_at: Date;
}

interface MovementRow {
  id: string;
  item_id: string;
  item_name: string;
  unit: string;
  kind: string;
  quantity_delta: string;
  quantity_after: string;
  reason: string | null;
  created_at: Date;
  actor_name: string | null;
  lot_id: string | null;
  lot_number: string | null;
  patient_id: string | null;
  patient_name: string | null;
}

interface LotRow {
  id: string;
  item_id: string;
  item_name: string;
  unit: string;
  expiry_warning_days: number;
  lot_number: string;
  expires_on: string | null;
  quantity: string;
  received_on: string;
  status: LotStatus;
  recalled_at: Date | null;
  recall_reason: string | null;
  recalled_by_name: string | null;
  created_at: Date;
}

interface LotUseRow {
  id: string;
  created_at: Date;
  quantity_delta: string;
  patient_id: string | null;
  patient_name: string | null;
  procedure_id: string | null;
  procedure_description: string | null;
  performed_on: string | null;
  actor_name: string | null;
}

const ITEM_COLS = `id, name, category, unit, quantity, minimum_quantity,
                   notes, status, track_lots, expiry_warning_days, created_at, updated_at`;

/**
 * ITEM_COLS plus the earliest expiry among lots still holding stock. For
 * SELECTs from inventory_items; writes RETURN ITEM_COLS and re-read.
 */
const ITEM_READ = `${ITEM_COLS},
  (SELECT min(l.expires_on)::text FROM inventory_lots l
    WHERE l.item_id = inventory_items.id
      AND l.quantity > 0 AND l.expires_on IS NOT NULL) AS next_expiry`;

const MOVEMENT_SELECT = `
  SELECT m.id, m.item_id, i.name AS item_name, i.unit,
         m.kind, m.quantity_delta, m.quantity_after, m.reason, m.created_at,
         u.full_name AS actor_name,
         m.lot_id, l.lot_number,
         m.patient_id, p.first_name || ' ' || p.last_name AS patient_name
    FROM stock_movements m
    JOIN inventory_items i ON i.id = m.item_id
    LEFT JOIN users u ON u.id = m.created_by
    LEFT JOIN inventory_lots l ON l.id = m.lot_id
    LEFT JOIN patients p ON p.id = m.patient_id`;

const LOT_SELECT = `
  SELECT l.id, l.item_id, i.name AS item_name, i.unit, i.expiry_warning_days,
         l.lot_number, l.expires_on::text AS expires_on, l.quantity,
         l.received_on::text AS received_on, l.status, l.recalled_at,
         l.recall_reason, u.full_name AS recalled_by_name, l.created_at
    FROM inventory_lots l
    JOIN inventory_items i ON i.id = l.item_id
    LEFT JOIN users u ON u.id = l.recalled_by`;

/** What stock already on the shelf becomes when an item starts tracking lots. */
const PRE_TRACKING_LOT = 'Before lot tracking';

function mapItem(r: ItemRow, today: string) {
  const quantity = parseQuantity(r.quantity);
  const minimumQuantity = parseQuantity(r.minimum_quantity);
  const nextExpiry = r.next_expiry ?? null;
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    unit: r.unit,
    quantity,
    minimumQuantity,
    notes: r.notes,
    status: r.status,
    // Resolved here rather than in the browser so the list, the badge and the
    // alerts endpoint can never disagree about what "low" means.
    lowStock: isLowStock({ quantity, minimumQuantity, status: r.status }),
    outOfStock: isOutOfStock({ quantity, status: r.status }),
    trackLots: r.track_lots,
    expiryWarningDays: r.expiry_warning_days,
    // The earliest expiry of stock still on the shelf, and what that means —
    // resolved here for the same reason "low" is.
    nextExpiry,
    expiry:
      r.status === 'active' ? expiryState(nextExpiry, today, r.expiry_warning_days) : 'none',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapMovement(r: MovementRow) {
  return {
    id: r.id,
    itemId: r.item_id,
    itemName: r.item_name,
    unit: r.unit,
    kind: r.kind as MovementKind,
    quantityDelta: parseQuantity(r.quantity_delta),
    quantityAfter: parseQuantity(r.quantity_after),
    reason: r.reason,
    createdAt: r.created_at,
    actorName: r.actor_name,
    lotId: r.lot_id,
    lotNumber: r.lot_number,
    patientId: r.patient_id,
    patientName: r.patient_name,
  };
}

function mapLot(r: LotRow, today: string) {
  return {
    id: r.id,
    itemId: r.item_id,
    itemName: r.item_name,
    unit: r.unit,
    lotNumber: r.lot_number,
    expiresOn: r.expires_on,
    receivedOn: r.received_on,
    quantity: parseQuantity(r.quantity),
    status: r.status,
    recalledAt: r.recalled_at,
    recallReason: r.recall_reason,
    recalledByName: r.recalled_by_name,
    expiry: expiryState(r.expires_on, today, r.expiry_warning_days),
    createdAt: r.created_at,
  };
}

function toCandidate(r: LotRow): LotCandidate {
  return {
    id: r.id,
    lotNumber: r.lot_number,
    expiresOn: r.expires_on,
    receivedOn: r.received_on,
    quantity: parseQuantity(r.quantity),
    status: r.status,
  };
}

/** Whole hundredths, for comparisons that must match numeric(12,2). */
const hundredths = (q: number) => Math.round(q * 100);

/** Reasons a movement has to carry one. Both make stock vanish unused. */
const REASON_REQUIRED: readonly MovementKind[] = ['write_off', 'adjustment'];

/** Past tense, for the audit line and the movement list. */
const KIND_VERB: Readonly<Record<MovementKind, string>> = Object.freeze({
  receipt: 'received',
  usage: 'used',
  write_off: 'wrote off',
  adjustment: 'recounted',
});

/* ── service ─────────────────────────────────────────────── */

@Injectable()
export class InventoryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
    private readonly audit: ClinicAuditService,
  ) {}

  private tx<T>(fn: (c: PoolClient) => Promise<T>) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), fn);
  }

  /**
   * The database's date. Every expiry decision uses it, so the list, the
   * alerts and the refusal to use an expired lot agree with each other
   * whatever clock the browser has.
   */
  private async today(client: PoolClient): Promise<string> {
    const { rows } = await client.query<{ today: string }>('SELECT CURRENT_DATE::text AS today');
    return rows[0]!.today;
  }

  /**
   * The stock list.
   *
   * `lowOnly` exists because it is the question the page opens on. Ordering
   * puts what needs attention first — low items, then alphabetical — so the
   * useful rows are visible without sorting or scrolling. `expiringOnly` is
   * the other question: which items hold a lot inside its warning window.
   */
  list(opts: {
    q?: string;
    status?: string;
    category?: string;
    lowOnly?: boolean;
    expiringOnly?: boolean;
  }) {
    return this.tx(async (client) => {
      const where: string[] = [];
      const params: unknown[] = [];

      if (opts.status === 'active' || opts.status === 'archived') {
        params.push(opts.status);
        where.push(`status = $${params.length}`);
      } else {
        where.push(`status = 'active'`);
      }
      if (opts.q?.trim()) {
        params.push(`%${opts.q.trim()}%`);
        where.push(
          `(name ILIKE $${params.length} OR coalesce(category,'') ILIKE $${params.length})`,
        );
      }
      if (opts.category?.trim()) {
        params.push(opts.category.trim());
        where.push(`category = $${params.length}`);
      }
      if (opts.lowOnly) {
        where.push(`quantity <= minimum_quantity`);
      }
      if (opts.expiringOnly) {
        where.push(`EXISTS (SELECT 1 FROM inventory_lots l
                             WHERE l.item_id = inventory_items.id
                               AND l.quantity > 0
                               AND l.expires_on <= CURRENT_DATE + inventory_items.expiry_warning_days)`);
      }

      const today = await this.today(client);
      const { rows } = await client.query<ItemRow>(
        `SELECT ${ITEM_READ} FROM inventory_items
          WHERE ${where.join(' AND ')}
          ORDER BY (quantity <= minimum_quantity) DESC, lower(name)`,
        params,
      );
      return rows.map((r) => mapItem(r, today));
    });
  }

  /** Distinct categories in use, so the filter offers real values only. */
  categories() {
    return this.tx(async (client) => {
      const { rows } = await client.query<{ category: string }>(
        `SELECT DISTINCT category FROM inventory_items
          WHERE category IS NOT NULL AND btrim(category) <> ''
          ORDER BY category`,
      );
      return rows.map((r) => r.category);
    });
  }

  /**
   * What needs attention, and counts for the dashboard.
   *
   * Deliberately available to every role that can see stock: the person who
   * notices the gloves are gone is the person at the front desk. Three kinds
   * of attention: items at or below their reorder level; lots close to or
   * past their expiry date; and recalled lots still holding stock, which
   * somebody has to take off the shelf.
   */
  alerts() {
    return this.tx(async (client) => {
      const today = await this.today(client);
      const { rows } = await client.query<ItemRow>(
        `SELECT ${ITEM_READ} FROM inventory_items
          WHERE status = 'active' AND quantity <= minimum_quantity
          ORDER BY (quantity = 0) DESC, lower(name)`,
      );
      const items = rows.map((r) => mapItem(r, today));

      const { rows: lotRows } = await client.query<LotRow>(
        `${LOT_SELECT}
          WHERE i.status = 'active' AND l.quantity > 0
            AND (l.status = 'recalled'
                 OR l.expires_on <= CURRENT_DATE + i.expiry_warning_days)
          ORDER BY l.expires_on NULLS LAST, lower(i.name)`,
      );
      const lots = lotRows.map((r) => mapLot(r, today));
      const expiringLots = lots.filter((l) => l.status === 'active');

      return {
        items,
        lowCount: items.length,
        outOfStockCount: items.filter((i) => i.outOfStock).length,
        expiringLots,
        expiringCount: expiringLots.filter((l) => l.expiry === 'expiring').length,
        expiredCount: expiringLots.filter((l) => l.expiry === 'expired').length,
        recalledLots: lots.filter((l) => l.status === 'recalled'),
      };
    });
  }

  getById(id: string) {
    return this.tx(async (client) => {
      const item = await this.requireItem(client, id);
      return mapItem(item, await this.today(client));
    });
  }

  /** Movements for one item, newest first. */
  movementsFor(itemId: string, limit = 100) {
    return this.tx(async (client) => {
      await this.requireItem(client, itemId);
      const { rows } = await client.query<MovementRow>(
        `${MOVEMENT_SELECT} WHERE m.item_id = $1 ORDER BY m.created_at DESC LIMIT $2`,
        [itemId, Math.min(Math.max(limit, 1), 500)],
      );
      return rows.map(mapMovement);
    });
  }

  /** Everything that moved recently, across items. */
  recentMovements(limit = 100) {
    return this.tx(async (client) => {
      const { rows } = await client.query<MovementRow>(
        `${MOVEMENT_SELECT} ORDER BY m.created_at DESC LIMIT $1`,
        [Math.min(Math.max(limit, 1), 500)],
      );
      return rows.map(mapMovement);
    });
  }

  /** An item's lots: those with stock first, earliest expiry first. */
  lots(itemId: string) {
    return this.tx(async (client) => {
      await this.requireItem(client, itemId);
      const today = await this.today(client);
      const { rows } = await client.query<LotRow>(
        `${LOT_SELECT} WHERE l.item_id = $1
          ORDER BY (l.quantity > 0) DESC, l.expires_on NULLS LAST, l.received_on,
                   lower(l.lot_number)`,
        [itemId],
      );
      return rows.map((r) => mapLot(r, today));
    });
  }

  /**
   * Who received a lot — the list a recall needs.
   *
   * Every usage of the lot, with the patient and procedure where they were
   * recorded, and how much was used without either. That last number is the
   * honest limit of the answer: stock recorded as used without a patient
   * cannot be traced, and a recall list that hid it would read as complete.
   */
  lotUsage(lotId: string) {
    return this.tx(async (client) => {
      const today = await this.today(client);
      const { rows } = await client.query<LotRow>(`${LOT_SELECT} WHERE l.id = $1`, [lotId]);
      const lot = rows[0];
      if (!lot) throw new NotFoundException('Lot not found');

      const { rows: useRows } = await client.query<LotUseRow>(
        `SELECT m.id, m.created_at, m.quantity_delta, m.patient_id,
                p.first_name || ' ' || p.last_name AS patient_name,
                m.procedure_id, cp.description AS procedure_description,
                cp.performed_on::text AS performed_on, u.full_name AS actor_name
           FROM stock_movements m
           LEFT JOIN patients p ON p.id = m.patient_id
           LEFT JOIN clinical_procedures cp ON cp.id = m.procedure_id
           LEFT JOIN users u ON u.id = m.created_by
          WHERE m.lot_id = $1 AND m.kind = 'usage'
          ORDER BY m.created_at DESC`,
        [lotId],
      );
      const uses = useRows.map((u) => ({
        id: u.id,
        createdAt: u.created_at,
        quantity: Math.abs(parseQuantity(u.quantity_delta)),
        patientId: u.patient_id,
        patientName: u.patient_name,
        procedureId: u.procedure_id,
        procedureDescription: u.procedure_description,
        performedOn: u.performed_on,
        actorName: u.actor_name,
      }));

      return {
        lot: mapLot(lot, today),
        uses,
        patientCount: new Set(uses.flatMap((u) => (u.patientId ? [u.patientId] : []))).size,
        unattributedQuantity:
          uses
            .filter((u) => !u.patientId)
            .reduce((sum, u) => sum + hundredths(u.quantity), 0) / 100,
      };
    });
  }

  async create(dto: CreateInventoryItemDto, actor: ClinicAuditActor) {
    const tenantId = this.tenant.getRequiredTenantId();
    const opening = dto.quantity ?? 0;
    const trackLots = dto.trackLots ?? false;
    const lotNumber = dto.lotNumber?.trim() || null;
    const expiresOn = dto.expiresOn ?? null;

    if (!trackLots && (lotNumber || expiresOn)) {
      throw new BadRequestException(
        'A lot number and expiry date only apply to an item that tracks lots',
      );
    }
    if (trackLots && opening > 0 && !lotNumber) {
      throw new BadRequestException(
        'Opening stock of a lot-tracked item needs the lot number printed on it',
      );
    }
    if (lotNumber && opening <= 0) {
      throw new BadRequestException(
        'A lot is recorded when its stock arrives. Enter the opening quantity, or leave the lot out.',
      );
    }

    return this.db.withTenant(tenantId, async (client) => {
      const today = await this.today(client);
      if (expiresOn) this.assertReceivable(expiresOn, today);

      let item: ItemRow;
      try {
        const { rows } = await client.query<ItemRow>(
          `INSERT INTO inventory_items
             (tenant_id, name, category, unit, quantity, minimum_quantity, notes, created_by,
              track_lots, expiry_warning_days)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, coalesce($10::int, 60))
           RETURNING ${ITEM_COLS}`,
          [
            tenantId,
            dto.name.trim(),
            dto.category?.trim() || null,
            dto.unit.trim(),
            opening,
            dto.minimumQuantity ?? 0,
            dto.notes?.trim() || null,
            actor.userId,
            trackLots,
            dto.expiryWarningDays ?? null,
          ],
        );
        item = rows[0]!;
      } catch (err: unknown) {
        if ((err as { code?: string }).code === '23505') {
          throw new ConflictException(
            `"${dto.name.trim()}" is already on the stock list`,
          );
        }
        throw err;
      }

      // Opening stock is a receipt like any other. Creating an item with 20
      // boxes and no movement would make the history start with a number
      // nobody can account for. For a lot-tracked item it is also its first
      // lot, so the item and its lots agree from the first commit.
      let lotId: string | null = null;
      if (opening > 0) {
        if (trackLots) {
          const { rows: lot } = await client.query<{ id: string }>(
            `INSERT INTO inventory_lots
               (tenant_id, item_id, lot_number, expires_on, quantity, created_by)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [tenantId, item.id, lotNumber, expiresOn, opening, actor.userId],
          );
          lotId = lot[0]!.id;
        }
        await client.query(
          `INSERT INTO stock_movements
             (tenant_id, item_id, kind, quantity_delta, quantity_after, reason, created_by,
              lot_id, lot_quantity_after)
           VALUES ($1,$2,'receipt',$3,$3,$4,$5,$6,$7)`,
          [
            tenantId,
            item.id,
            opening,
            'Opening stock',
            actor.userId,
            lotId,
            lotId ? opening : null,
          ],
        );
      }

      await this.audit.record(client, actor, {
        action: 'inventory.item_created',
        entityType: 'inventory_item',
        entityId: item.id,
        summary: `Added "${item.name}" to the stock list${
          opening > 0 ? ` with ${opening} ${item.unit}` : ''
        }${lotId ? ` (lot ${lotNumber})` : ''}`,
        metadata: {
          name: item.name,
          unit: item.unit,
          openingQuantity: opening,
          minimumQuantity: parseQuantity(item.minimum_quantity),
          trackLots,
          ...(lotId ? { lotId, lotNumber, expiresOn } : {}),
        },
      });

      return mapItem(await this.requireItem(client, item.id), today);
    });
  }

  async update(id: string, dto: UpdateInventoryItemDto, actor: ClinicAuditActor) {
    const cols: Record<string, string> = {
      name: 'name',
      category: 'category',
      unit: 'unit',
      minimumQuantity: 'minimum_quantity',
      notes: 'notes',
      status: 'status',
      trackLots: 'track_lots',
      expiryWarningDays: 'expiry_warning_days',
    };

    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, col] of Object.entries(cols)) {
      const value = (dto as unknown as Record<string, unknown>)[key];
      if (value === undefined) continue;
      params.push(typeof value === 'string' && value.trim() === '' ? null : value);
      sets.push(`${col} = $${params.length}`);
    }

    return this.tx(async (client) => {
      const today = await this.today(client);
      // Locked: switching lot tracking on reads the quantity it has to carry
      // into a lot, and a movement landing in between would leave the two
      // disagreeing at commit.
      const before = await this.requireItem(client, id, true);
      if (sets.length === 0) return mapItem(before, today);

      const enabling = dto.trackLots === true && !before.track_lots;
      const disabling = dto.trackLots === false && before.track_lots;

      if (disabling) {
        const { rows } = await client.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM inventory_lots WHERE item_id = $1',
          [id],
        );
        if (Number(rows[0]!.n) > 0) {
          throw new ConflictException(
            `Lots are already recorded for "${before.name}". Lot tracking stays on, so ` +
              'their history — and who received them — is kept.',
          );
        }
      }

      params.push(id);
      let after: ItemRow;
      try {
        const { rows } = await client.query<ItemRow>(
          `UPDATE inventory_items SET ${sets.join(', ')}, updated_at = now()
            WHERE id = $${params.length} RETURNING ${ITEM_COLS}`,
          params,
        );
        after = rows[0]!;
      } catch (err: unknown) {
        if ((err as { code?: string }).code === '23505') {
          throw new ConflictException('Another item already has that name');
        }
        throw err;
      }

      // Stock already on the shelf does not vanish because the clinic started
      // writing lot numbers down. It becomes one lot with no expiry date,
      // named for what it is, so the item and its lots agree at commit.
      const carried = enabling ? parseQuantity(before.quantity) : 0;
      if (carried > 0) {
        await client.query(
          `INSERT INTO inventory_lots (tenant_id, item_id, lot_number, quantity, created_by)
           VALUES ($1,$2,$3,$4,$5)`,
          [this.tenant.getRequiredTenantId(), id, PRE_TRACKING_LOT, carried, actor.userId],
        );
      }

      // Archiving, starting lot tracking and moving a reorder level are the
      // changes worth their own audit line: they change which warnings fire.
      const archived = before.status !== 'archived' && after.status === 'archived';
      const restored = before.status === 'archived' && after.status === 'active';
      const minimumMoved =
        parseQuantity(before.minimum_quantity) !== parseQuantity(after.minimum_quantity);

      await this.audit.record(client, actor, {
        action: archived
          ? 'inventory.item_archived'
          : enabling
            ? 'inventory.lot_tracking_enabled'
            : 'inventory.item_updated',
        entityType: 'inventory_item',
        entityId: id,
        summary: archived
          ? `Archived "${after.name}"`
          : enabling
            ? `Started tracking lots and expiry dates for "${after.name}"${
                carried > 0
                  ? ` — the ${carried} ${after.unit} already on the shelf is kept as one lot with no expiry date`
                  : ''
              }`
            : restored
              ? `Restored "${after.name}" to the stock list`
              : minimumMoved
                ? `Set the reorder level for "${after.name}" from ` +
                  `${parseQuantity(before.minimum_quantity)} to ` +
                  `${parseQuantity(after.minimum_quantity)} ${after.unit}`
                : `Updated "${after.name}"`,
        metadata: {
          name: after.name,
          ...(minimumMoved
            ? {
                minimumFrom: parseQuantity(before.minimum_quantity),
                minimumTo: parseQuantity(after.minimum_quantity),
              }
            : {}),
          ...(archived || restored ? { status: after.status } : {}),
          ...(enabling ? { trackLots: true, carriedQuantity: carried } : {}),
          ...(disabling ? { trackLots: false } : {}),
        },
      });

      return mapItem(await this.requireItem(client, id), today);
    });
  }

  /**
   * Record a movement and move the running total, in one transaction.
   *
   * `SELECT ... FOR UPDATE` is the load-bearing line. Two people recording
   * usage of the same item at the same moment would otherwise both read 10,
   * both write 9, and one box would vanish from the record while staying on
   * the shelf. The lock makes the second wait for the first, so it reads 9 and
   * writes 8.
   *
   * The engine decides the arithmetic, the database re-checks it: the delta's
   * sign must match the kind, and neither the item nor the movement may leave
   * the total below zero. Both are CHECK constraints in migration 0002, so a
   * mistake here fails at the write rather than at the next stock count.
   *
   * For a lot-tracked item the lot moves with the item, and 0007 checks at
   * commit that the item still equals the sum of its lots.
   */
  async recordMovement(itemId: string, dto: RecordMovementDto, actor: ClinicAuditActor) {
    const tenantId = this.tenant.getRequiredTenantId();
    const reason = dto.reason?.trim() || null;

    if (REASON_REQUIRED.includes(dto.kind) && (!reason || reason.length < 3)) {
      throw new BadRequestException(
        dto.kind === 'write_off'
          ? 'Say why this stock is being written off'
          : 'Say why the count differs — that note is the only record of what happened',
      );
    }
    if ((dto.patientId || dto.procedureId) && dto.kind !== 'usage') {
      throw new BadRequestException('Only stock used in treatment is recorded against a patient');
    }

    return this.db.withTenant(tenantId, async (client) => {
      const today = await this.today(client);
      const { rows: locked } = await client.query<ItemRow>(
        `SELECT ${ITEM_COLS} FROM inventory_items WHERE id = $1 FOR UPDATE`,
        [itemId],
      );
      const item = locked[0];
      if (!item) throw new NotFoundException('Item not found');
      if (item.status !== 'active') {
        throw new ConflictException(
          `"${item.name}" is archived. Restore it before recording stock against it.`,
        );
      }
      if (!item.track_lots && (dto.lotId || dto.lotNumber || dto.expiresOn)) {
        throw new BadRequestException(
          `"${item.name}" does not track lots. Turn on lot tracking for it first.`,
        );
      }

      const { patientId, procedureId } = await this.resolvePatient(client, dto);
      const lot = item.track_lots
        ? await this.resolveLot(client, item, dto, today, actor)
        : null;

      const current = parseQuantity(item.quantity);
      const lotBefore = lot ? parseQuantity(lot.quantity) : null;

      let delta: number;
      let after: number;
      let lotAfter: number | null = null;
      try {
        // A stock count of a lot-tracked item counts one lot, so its
        // difference is taken against that lot.
        delta = deltaFor(
          {
            kind: dto.kind,
            amount: dto.amount,
            countedQuantity: dto.countedQuantity,
          },
          lotBefore ?? current,
        );
        if (lot && lotBefore !== null) {
          if (hundredths(lotBefore) + hundredths(delta) < 0) {
            throw new RangeError(
              `Lot ${lot.lot_number} has only ${lotBefore} ${item.unit} on record. ` +
                'Choose another lot, or record it in parts.',
            );
          }
          lotAfter = nextQuantity(lotBefore, delta);
        }
        after = nextQuantity(current, delta);
      } catch (err: unknown) {
        // The engine's refusals are all things a person did, phrased for
        // a person. A 400 with that sentence is more use than a 500.
        if (err instanceof RangeError) throw new BadRequestException(err.message);
        throw err;
      }

      if (lot) {
        await client.query(
          `UPDATE inventory_lots SET quantity = $1, updated_at = now() WHERE id = $2`,
          [lotAfter, lot.id],
        );
      }

      const { rows: movementRows } = await client.query<{ id: string }>(
        `INSERT INTO stock_movements
           (tenant_id, item_id, kind, quantity_delta, quantity_after, reason, created_by,
            lot_id, lot_quantity_after, patient_id, procedure_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id`,
        [
          tenantId,
          itemId,
          dto.kind,
          delta,
          after,
          reason,
          actor.userId,
          lot?.id ?? null,
          lotAfter,
          patientId,
          procedureId,
        ],
      );

      await client.query(
        `UPDATE inventory_items SET quantity = $1, updated_at = now() WHERE id = $2`,
        [after, itemId],
      );

      const magnitude = Math.abs(delta);
      const lotNote = lot ? ` (lot ${lot.lot_number})` : '';
      await this.audit.record(client, actor, {
        action: 'inventory.movement_recorded',
        entityType: 'inventory_item',
        entityId: itemId,
        summary:
          dto.kind === 'adjustment'
            ? `Recounted "${item.name}"${lotNote}: ${lotBefore ?? current} → ` +
              `${lotAfter ?? after} ${item.unit} (${reason})`
            : `${KIND_VERB[dto.kind]} ${magnitude} ${item.unit} of "${item.name}"${lotNote}` +
              `${patientId ? ' for a patient' : ''} (${after} left)`,
        metadata: {
          movementId: movementRows[0]!.id,
          name: item.name,
          kind: dto.kind,
          delta,
          quantityBefore: current,
          quantityAfter: after,
          ...(reason ? { reason } : {}),
          ...(lot
            ? { lotId: lot.id, lotNumber: lot.lot_number, lotQuantityAfter: lotAfter }
            : {}),
          ...(patientId ? { patientId } : {}),
          ...(procedureId ? { procedureId } : {}),
        },
      });

      return {
        item: mapItem(await this.requireItem(client, itemId), today),
        movement: {
          id: movementRows[0]!.id,
          kind: dto.kind,
          quantityDelta: delta,
          quantityAfter: after,
          reason,
          lotId: lot?.id ?? null,
          lotNumber: lot?.lot_number ?? null,
          lotQuantityAfter: lotAfter,
          patientId,
        },
      };
    });
  }

  /**
   * Recall a lot.
   *
   * Permanent: 0007 refuses to un-recall a lot or rewrite the record of its
   * recall. The stock stays on the shelf, and on the books, until someone
   * writes it off — recalling it does not make it physically disappear.
   */
  recallLot(lotId: string, reason: string, actor: ClinicAuditActor) {
    return this.tx(async (client) => {
      const today = await this.today(client);
      const { rows } = await client.query<LotRow>(
        `${LOT_SELECT} WHERE l.id = $1 FOR UPDATE OF l`,
        [lotId],
      );
      const lot = rows[0];
      if (!lot) throw new NotFoundException('Lot not found');
      if (lot.status === 'recalled') {
        throw new ConflictException(`Lot ${lot.lot_number} is already recalled`);
      }

      await client.query(
        `UPDATE inventory_lots
            SET status = 'recalled', recalled_at = now(), recalled_by = $2,
                recall_reason = $3, updated_at = now()
          WHERE id = $1`,
        [lotId, actor.userId, reason.trim()],
      );

      const { rows: reach } = await client.query<{ patients: string }>(
        `SELECT count(DISTINCT patient_id)::text AS patients
           FROM stock_movements
          WHERE lot_id = $1 AND kind = 'usage' AND patient_id IS NOT NULL`,
        [lotId],
      );
      const patientsAffected = Number(reach[0]!.patients);

      await this.audit.record(client, actor, {
        action: 'inventory.lot_recalled',
        entityType: 'inventory_item',
        entityId: lot.item_id,
        summary:
          `Recalled lot ${lot.lot_number} of "${lot.item_name}" — ${reason.trim()} ` +
          `(${patientsAffected} ${patientsAffected === 1 ? 'patient' : 'patients'} received it)`,
        metadata: {
          lotId,
          lotNumber: lot.lot_number,
          name: lot.item_name,
          reason: reason.trim(),
          quantityOnShelf: parseQuantity(lot.quantity),
          patientsAffected,
        },
      });

      const { rows: fresh } = await client.query<LotRow>(`${LOT_SELECT} WHERE l.id = $1`, [
        lotId,
      ]);
      return { lot: mapLot(fresh[0]!, today), patientsAffected };
    });
  }

  /* ── helpers ───────────────────────────────────────────── */

  /**
   * The patient a usage is recorded against. A procedure implies its patient;
   * naming both requires them to agree. Both lookups go through RLS, so an id
   * from another clinic is a 404 — and 0007's composite keys would refuse it
   * even if this check were skipped.
   */
  private async resolvePatient(
    client: PoolClient,
    dto: RecordMovementDto,
  ): Promise<{ patientId: string | null; procedureId: string | null }> {
    let patientId = dto.patientId ?? null;
    const procedureId = dto.procedureId ?? null;

    if (procedureId) {
      const { rows } = await client.query<{ patient_id: string }>(
        `SELECT patient_id FROM clinical_procedures
          WHERE id = $1 AND entered_in_error_at IS NULL`,
        [procedureId],
      );
      if (!rows[0]) throw new NotFoundException('Procedure not found');
      if (patientId && patientId !== rows[0].patient_id) {
        throw new BadRequestException('That procedure belongs to a different patient');
      }
      patientId = rows[0].patient_id;
    } else if (patientId) {
      const { rowCount } = await client.query('SELECT 1 FROM patients WHERE id = $1', [
        patientId,
      ]);
      if (!rowCount) throw new NotFoundException('Patient not found');
    }
    return { patientId, procedureId };
  }

  /**
   * The lot a movement of a lot-tracked item applies to, locked for the rest
   * of the transaction so a recall cannot land between the check and the
   * write.
   *
   *   receipt     names its lot: an existing one by id or number, or a new
   *               one by number (and expiry date) on first arrival
   *   usage       names its lot, or takes the earliest-expiring usable one
   *   write-off   must name it — somebody is holding the box
   *   count       must name it — a count is of one lot
   */
  private async resolveLot(
    client: PoolClient,
    item: ItemRow,
    dto: RecordMovementDto,
    today: string,
    actor: ClinicAuditActor,
  ): Promise<LotRow> {
    if (dto.kind === 'receipt') {
      if (dto.lotId) {
        const lot = await this.lockLot(client, item.id, dto.lotId);
        this.assertRestockable(lot, dto.expiresOn, today);
        return lot;
      }

      const lotNumber = dto.lotNumber?.trim();
      if (!lotNumber) {
        throw new BadRequestException('Enter the lot number printed on the packaging');
      }
      const { rows: existing } = await client.query<LotRow>(
        `${LOT_SELECT}
          WHERE l.item_id = $1 AND lower(btrim(l.lot_number)) = lower($2::text)
          FOR UPDATE OF l`,
        [item.id, lotNumber],
      );
      if (existing[0]) {
        this.assertRestockable(existing[0], dto.expiresOn, today);
        return existing[0];
      }

      if (dto.expiresOn) this.assertReceivable(dto.expiresOn, today);
      const { rows: created } = await client.query<{ id: string }>(
        `INSERT INTO inventory_lots (tenant_id, item_id, lot_number, expires_on, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [
          this.tenant.getRequiredTenantId(),
          item.id,
          lotNumber,
          dto.expiresOn ?? null,
          actor.userId,
        ],
      );
      return this.lockLot(client, item.id, created[0]!.id);
    }

    if (dto.lotId) {
      const lot = await this.lockLot(client, item.id, dto.lotId);
      if (dto.kind === 'usage') {
        const blocked = usageBlocker(toCandidate(lot), today);
        if (blocked) throw new ConflictException(blocked);
      }
      return lot;
    }

    if (dto.kind === 'usage') {
      const { rows } = await client.query<LotRow>(
        `${LOT_SELECT} WHERE l.item_id = $1 AND l.quantity > 0 FOR UPDATE OF l`,
        [item.id],
      );
      try {
        const picked = pickLot(rows.map(toCandidate), dto.amount ?? 0, today);
        return rows.find((r) => r.id === picked.id)!;
      } catch (err: unknown) {
        if (err instanceof RangeError) throw new ConflictException(err.message);
        throw err;
      }
    }

    throw new BadRequestException(
      dto.kind === 'write_off'
        ? 'Choose which lot is being written off'
        : 'A stock count of a lot-tracked item is taken per lot — choose the lot you counted',
    );
  }

  private async lockLot(client: PoolClient, itemId: string, lotId: string): Promise<LotRow> {
    const { rows } = await client.query<LotRow>(
      `${LOT_SELECT} WHERE l.id = $1 AND l.item_id = $2 FOR UPDATE OF l`,
      [lotId, itemId],
    );
    if (!rows[0]) throw new NotFoundException('Lot not found for this item');
    return rows[0];
  }

  /** An expiry date a new lot can be received with: real, and not already past. */
  private assertReceivable(expiresOn: string, today: string) {
    if (!isIsoDate(expiresOn)) {
      throw new BadRequestException(`${expiresOn} is not a date`);
    }
    if (expiresOn < today) {
      throw new BadRequestException(
        `That lot expired on ${expiresOn}. Stock past its date should not be received — ` +
          'return it to the supplier.',
      );
    }
  }

  /** More of a lot already on record: not recalled, not expired, same date. */
  private assertRestockable(lot: LotRow, expiresOn: string | undefined, today: string) {
    if (lot.status === 'recalled') {
      throw new ConflictException(
        `Lot ${lot.lot_number} has been recalled and cannot be restocked`,
      );
    }
    if (expiresOn && expiresOn !== lot.expires_on) {
      throw new ConflictException(
        `Lot ${lot.lot_number} is already recorded as expiring ` +
          `${lot.expires_on ?? 'with no date'}. One lot has one expiry date — check the packaging.`,
      );
    }
    if (lot.expires_on && lot.expires_on < today) {
      throw new BadRequestException(
        `Lot ${lot.lot_number} expired on ${lot.expires_on}. Stock past its date should not be received.`,
      );
    }
  }

  /**
   * Read an item or 404.
   *
   * No `tenant_id` in the WHERE clause, deliberately, and that is the whole
   * isolation model: RLS applies the tenant filter in the database, so an id
   * belonging to another clinic returns no row and becomes a 404 — the same
   * answer as an id that does not exist, which is the answer that leaks
   * nothing.
   */
  private async requireItem(client: PoolClient, id: string, lock = false): Promise<ItemRow> {
    const { rows } = await client.query<ItemRow>(
      `SELECT ${ITEM_READ} FROM inventory_items WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [id],
    );
    if (!rows[0]) throw new NotFoundException('Item not found');
    return rows[0];
  }
}

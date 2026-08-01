import {
  Body,
  ConflictException,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../core/database/database.service';
import { TenantContextService } from '../../core/tenancy/tenant-context';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { OwnerGuard } from '../auth/owner.guard';
import { AuthModule } from '../auth/auth.module';

/* ── DTOs ────────────────────────────────────────────────── */
export class CreateTreatmentDto {
  @IsString() @MinLength(2, { message: 'Treatment name is required' })
  name!: string;

  @IsInt() @Min(0) @Max(10_000_000)
  price!: number;

  @IsInt() @Min(5) @Max(600)
  durationMinutes!: number;

  @IsOptional() @IsIn(['single', 'multiple'])
  visitType?: 'single' | 'multiple' | null;

  @IsOptional() @IsIn(['active', 'inactive'])
  status?: 'active' | 'inactive';
}

export class UpdateTreatmentDto {
  @IsOptional() @IsString() @MinLength(2)
  name?: string;

  @IsOptional() @IsInt() @Min(0) @Max(10_000_000)
  price?: number;

  @IsOptional() @IsInt() @Min(5) @Max(600)
  durationMinutes?: number;

  @IsOptional() @IsIn(['single', 'multiple'])
  visitType?: 'single' | 'multiple' | null;

  @IsOptional() @IsIn(['active', 'inactive'])
  status?: 'active' | 'inactive';
}

/* ── service ─────────────────────────────────────────────── */
interface Row {
  id: string;
  name: string;
  price: number;
  duration_minutes: number;
  visit_type: string | null;
  status: string;
}
const FULL = 'id, name, price, duration_minutes, visit_type, status';
const map = (r: Row) => ({
  id: r.id,
  name: r.name,
  price: r.price,
  durationMinutes: r.duration_minutes,
  visitType: r.visit_type,
  status: r.status,
});

@Injectable()
export class TreatmentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
  ) {}

  private tx<T>(fn: (c: PoolClient) => Promise<T>) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), fn);
  }

  list(opts: { q?: string; status?: string }) {
    return this.tx(async (client) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (opts.status === 'active' || opts.status === 'inactive') {
        params.push(opts.status);
        where.push(`status = $${params.length}`);
      }
      if (opts.q?.trim()) {
        params.push(`%${opts.q.trim()}%`);
        where.push(`name ILIKE $${params.length}`);
      }
      const { rows } = await client.query<Row>(
        `SELECT ${FULL} FROM treatments
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY name`,
        params,
      );
      return rows.map(map);
    });
  }

  create(dto: CreateTreatmentDto) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      try {
        const { rows } = await client.query<Row>(
          `INSERT INTO treatments (tenant_id, name, price, duration_minutes, visit_type, status)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${FULL}`,
          [tenantId, dto.name, dto.price, dto.durationMinutes, dto.visitType ?? null, dto.status ?? 'active'],
        );
        return map(rows[0]!);
      } catch (err: unknown) {
        if ((err as { code?: string }).code === '23505') {
          throw new ConflictException('A treatment with that name already exists');
        }
        throw err;
      }
    });
  }

  update(id: string, dto: UpdateTreatmentDto) {
    const cols: Record<string, string> = {
      name: 'name',
      price: 'price',
      durationMinutes: 'duration_minutes',
      visitType: 'visit_type',
      status: 'status',
    };
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [k, col] of Object.entries(cols)) {
      const v = (dto as unknown as Record<string, unknown>)[k];
      if (v !== undefined) {
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      }
    }
    return this.tx(async (client) => {
      if (!sets.length) {
        const r = await client.query<Row>(`SELECT ${FULL} FROM treatments WHERE id = $1`, [id]);
        if (!r.rows[0]) throw new NotFoundException('Treatment not found');
        return map(r.rows[0]);
      }
      params.push(id);
      const { rows } = await client.query<Row>(
        `UPDATE treatments SET ${sets.join(', ')}, updated_at = now()
          WHERE id = $${params.length} RETURNING ${FULL}`,
        params,
      );
      if (!rows[0]) throw new NotFoundException('Treatment not found');
      return map(rows[0]);
    });
  }
}

/* ── controller ──────────────────────────────────────────── */
@Controller('treatments')
@UseGuards(JwtAuthGuard)
export class TreatmentsController {
  constructor(private readonly treatments: TreatmentsService) {}

  @Get()
  list(@Query('q') q?: string, @Query('status') status?: string) {
    return this.treatments.list({ q, status });
  }

  @Post()
  @UseGuards(OwnerGuard)
  create(@Body() dto: CreateTreatmentDto) {
    return this.treatments.create(dto);
  }

  @Patch(':id')
  @UseGuards(OwnerGuard)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTreatmentDto) {
    return this.treatments.update(id, dto);
  }
}

@Module({
  imports: [AuthModule],
  controllers: [TreatmentsController],
  providers: [TreatmentsService, OwnerGuard],
})
export class TreatmentsModule {}

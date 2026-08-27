import { PERIO_SITES, PerioSite } from './perio.types';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '@/core/database/database.service';
import { TenantContextService } from '@/core/tenancy/tenant-context';
import { isValidTooth } from '@/modules/clinic/charting';
import { CreatePerioExamDto, SaveMeasurementsDto } from './dto/perio.dto';

/** Clinical attachment loss = probing depth + recession. */
export function attachmentLoss(
  probingDepth: number | null,
  recession: number | null,
): number | null {
  if (probingDepth === null) return null;
  return probingDepth + (recession ?? 0);
}

/* ═════════════════════════ service ═════════════════════════ */

interface ExamRow {
  id: string;
  patient_id: string;
  examined_on: string;
  clinician_id: string | null;
  clinician_name: string | null;
  note: string | null;
  created_at: string;
}

const EXAM_SELECT = `
  SELECT e.id, e.patient_id, e.examined_on::text AS examined_on,
         e.clinician_id, u.full_name AS clinician_name, e.note, e.created_at
    FROM perio_exams e
    LEFT JOIN users u ON u.id = e.clinician_id`;

@Injectable()
export class PerioService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tenant: TenantContextService,
  ) {}

  private tx<T>(fn: (c: PoolClient) => Promise<T>) {
    return this.db.withTenant(this.tenant.getRequiredTenantId(), fn);
  }

  async listExams(patientId: string) {
    return this.tx(async (client) => {
      const { rowCount } = await client.query(
        'SELECT 1 FROM patients WHERE id = $1', [patientId],
      );
      if (!rowCount) throw new NotFoundException('Patient not found');

      const { rows } = await client.query<ExamRow & { site_count: string; bleeding_count: string }>(
        `${EXAM_SELECT.replace('FROM perio_exams e', `,
                (SELECT count(*)::text FROM perio_measurements m WHERE m.exam_id = e.id) AS site_count,
                (SELECT count(*)::text FROM perio_measurements m
                  WHERE m.exam_id = e.id AND m.bleeding) AS bleeding_count
           FROM perio_exams e`)}
          WHERE e.patient_id = $1
          ORDER BY e.examined_on DESC, e.created_at DESC`,
        [patientId],
      );
      return rows.map((r) => ({
        id: r.id,
        patientId: r.patient_id,
        examinedOn: r.examined_on,
        clinicianId: r.clinician_id,
        clinicianName: r.clinician_name,
        note: r.note,
        createdAt: r.created_at,
        siteCount: Number(r.site_count),
        bleedingCount: Number(r.bleeding_count),
        bleedingPercent:
          Number(r.site_count) > 0
            ? Math.round((Number(r.bleeding_count) / Number(r.site_count)) * 100)
            : 0,
      }));
    });
  }

  /** One exam with every measurement and per-tooth finding. */
  async getExam(examId: string) {
    return this.tx(async (client) => {
      const { rows } = await client.query<ExamRow>(
        `${EXAM_SELECT} WHERE e.id = $1`, [examId],
      );
      const exam = rows[0];
      if (!exam) throw new NotFoundException('Perio exam not found');

      const { rows: measurements } = await client.query<{
        id: string; tooth: number; site: PerioSite;
        probing_depth: number | null; recession: number | null;
        bleeding: boolean; suppuration: boolean; plaque: boolean;
      }>(
        `SELECT id, tooth, site, probing_depth, recession, bleeding, suppuration, plaque
           FROM perio_measurements WHERE exam_id = $1 ORDER BY tooth, site`,
        [examId],
      );

      const { rows: findings } = await client.query<{
        id: string; tooth: number; mobility: number | null;
        furcation: number | null; note: string | null;
      }>(
        `SELECT id, tooth, mobility, furcation, note
           FROM perio_tooth_findings WHERE exam_id = $1 ORDER BY tooth`,
        [examId],
      );

      const mapped = measurements.map((m) => ({
        id: m.id,
        tooth: m.tooth,
        site: m.site,
        probingDepth: m.probing_depth,
        recession: m.recession,
        bleeding: m.bleeding,
        suppuration: m.suppuration,
        plaque: m.plaque,
        // Derived, never stored: CAL is a function of the two readings and
        // storing it would let it disagree with them.
        attachmentLoss: attachmentLoss(m.probing_depth, m.recession),
      }));

      const withDepth = mapped.filter((m) => m.probingDepth !== null);
      const deepSites = withDepth.filter((m) => (m.probingDepth ?? 0) >= 5);

      return {
        id: exam.id,
        patientId: exam.patient_id,
        examinedOn: exam.examined_on,
        clinicianId: exam.clinician_id,
        clinicianName: exam.clinician_name,
        note: exam.note,
        createdAt: exam.created_at,
        measurements: mapped,
        findings: findings.map((f) => ({
          id: f.id,
          tooth: f.tooth,
          mobility: f.mobility,
          furcation: f.furcation,
          note: f.note,
        })),
        summary: {
          sitesRecorded: mapped.length,
          bleedingSites: mapped.filter((m) => m.bleeding).length,
          suppurationSites: mapped.filter((m) => m.suppuration).length,
          plaqueSites: mapped.filter((m) => m.plaque).length,
          bleedingPercent: mapped.length
            ? Math.round((mapped.filter((m) => m.bleeding).length / mapped.length) * 100)
            : 0,
          /** Sites at or beyond 5 mm — the usual threshold for concern. */
          deepPocketSites: deepSites.length,
          maxProbingDepth: withDepth.length
            ? Math.max(...withDepth.map((m) => m.probingDepth ?? 0))
            : null,
          meanProbingDepth: withDepth.length
            ? Math.round(
                (withDepth.reduce((s, m) => s + (m.probingDepth ?? 0), 0) /
                  withDepth.length) * 10,
              ) / 10
            : null,
          teethWithMobility: findings.filter((f) => (f.mobility ?? 0) > 0).length,
        },
      };
    });
  }

  async createExam(patientId: string, dto: CreatePerioExamDto, userId: string) {
    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const { rowCount } = await client.query(
        'SELECT 1 FROM patients WHERE id = $1', [patientId],
      );
      if (!rowCount) throw new NotFoundException('Patient not found');

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO perio_exams
           (tenant_id, patient_id, examined_on, clinician_id, note, created_by)
         VALUES ($1,$2,coalesce($3::date, CURRENT_DATE),$4,$5,$6) RETURNING id`,
        [
          tenantId, patientId, dto.examinedOn ?? null,
          dto.clinicianId ?? userId, dto.note ?? null, userId,
        ],
      );
      return this.getExam(rows[0].id);
    });
  }

  /**
   * Upsert a batch of readings. Idempotent per (exam, tooth, site) so a
   * clinician can correct a number and re-save without creating duplicates,
   * and so an interrupted save can simply be repeated.
   */
  async saveMeasurements(examId: string, dto: SaveMeasurementsDto) {
    if (!dto.measurements.length && !dto.findings?.length) {
      throw new BadRequestException('Nothing to save');
    }
    for (const m of dto.measurements) {
      if (!isValidTooth(m.tooth)) {
        throw new BadRequestException(`Tooth ${m.tooth} is not a valid FDI number`);
      }
    }

    const tenantId = this.tenant.getRequiredTenantId();
    return this.db.withTenant(tenantId, async (client) => {
      const { rowCount } = await client.query(
        'SELECT 1 FROM perio_exams WHERE id = $1', [examId],
      );
      if (!rowCount) throw new NotFoundException('Perio exam not found');

      // One statement for the whole batch: 192 readings in a single round trip,
      // inside the transaction the caller is already in, so a full-mouth chart
      // either lands completely or not at all.
      if (dto.measurements.length) {
        await client.query(
          `INSERT INTO perio_measurements
             (tenant_id, exam_id, tooth, site, probing_depth, recession,
              bleeding, suppuration, plaque)
           SELECT $1, $2, t.tooth, t.site, t.depth, t.recession,
                  t.bleeding, t.suppuration, t.plaque
             FROM unnest(
                    $3::smallint[], $4::text[], $5::smallint[], $6::smallint[],
                    $7::boolean[], $8::boolean[], $9::boolean[]
                  ) AS t(tooth, site, depth, recession, bleeding, suppuration, plaque)
           ON CONFLICT (exam_id, tooth, site) DO UPDATE
             SET probing_depth = EXCLUDED.probing_depth,
                 recession     = EXCLUDED.recession,
                 bleeding      = EXCLUDED.bleeding,
                 suppuration   = EXCLUDED.suppuration,
                 plaque        = EXCLUDED.plaque`,
          [
            tenantId,
            examId,
            dto.measurements.map((m) => m.tooth),
            dto.measurements.map((m) => m.site),
            dto.measurements.map((m) => m.probingDepth ?? null),
            dto.measurements.map((m) => m.recession ?? null),
            dto.measurements.map((m) => m.bleeding ?? false),
            dto.measurements.map((m) => m.suppuration ?? false),
            dto.measurements.map((m) => m.plaque ?? false),
          ],
        );
      }

      if (dto.findings?.length) {
        await client.query(
          `INSERT INTO perio_tooth_findings
             (tenant_id, exam_id, tooth, mobility, furcation, note)
           SELECT $1, $2, t.tooth, t.mobility, t.furcation, t.note
             FROM unnest($3::smallint[], $4::smallint[], $5::smallint[], $6::text[])
                    AS t(tooth, mobility, furcation, note)
           ON CONFLICT (exam_id, tooth) DO UPDATE
             SET mobility  = EXCLUDED.mobility,
                 furcation = EXCLUDED.furcation,
                 note      = EXCLUDED.note`,
          [
            tenantId,
            examId,
            dto.findings.map((f) => f.tooth),
            dto.findings.map((f) => f.mobility ?? null),
            dto.findings.map((f) => f.furcation ?? null),
            dto.findings.map((f) => f.note ?? null),
          ],
        );
      }

      return this.getExam(examId);
    });
  }

  async updateExam(examId: string, dto: CreatePerioExamDto) {
    const sets: string[] = [];
    const params: unknown[] = [examId];
    const push = (frag: string, v: unknown) => {
      params.push(v);
      sets.push(frag.replace('$$', `$${params.length}`));
    };
    if (dto.examinedOn !== undefined) push('examined_on = $$::date', dto.examinedOn);
    if (dto.clinicianId !== undefined) push('clinician_id = $$', dto.clinicianId ?? null);
    if (dto.note !== undefined) push('note = $$', dto.note || null);
    if (!sets.length) throw new BadRequestException('Nothing to update');

    return this.tx(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE perio_exams SET ${sets.join(', ')} WHERE id = $1`, params,
      );
      if (!rowCount) throw new NotFoundException('Perio exam not found');
      return this.getExam(examId);
    });
  }

  async deleteExam(examId: string) {
    return this.tx(async (client) => {
      const { rowCount } = await client.query(
        'DELETE FROM perio_exams WHERE id = $1', [examId],
      );
      if (!rowCount) throw new NotFoundException('Perio exam not found');
      return { deleted: true as const };
    });
  }
}

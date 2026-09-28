import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '@/core/database/database.service';
import { StorageService } from '@/core/storage/storage.service';

/**
 * What each clinic is actually consuming.
 *
 * The tenants list already carries headline counts. This answers the next
 * question, the one that decides infrastructure spend and support attention:
 * WHERE is it going, and which clinics are outliers.
 *
 * Every figure here is counted live rather than kept in a counter table. At
 * fleet sizes this console is built for, a scan is cheaper than the bug class
 * that comes with counters that drift from what they count.
 */

interface UsageRow {
  tenant_id: string;
  name: string;
  subdomain: string;
  status: string;
  plan_name: string | null;
  created_at: Date;
  users: number;
  patients: number;
  appointments: number;
  appointments_30d: number;
  invoices: number;
  documents: number;
  storage_bytes: string;
  last_activity: Date | null;
}

function mapUsage(r: UsageRow) {
  return {
    tenantId: r.tenant_id,
    name: r.name,
    subdomain: r.subdomain,
    status: r.status,
    planName: r.plan_name,
    createdAt: r.created_at,
    users: r.users,
    patients: r.patients,
    appointments: r.appointments,
    appointments30d: r.appointments_30d,
    invoices: r.invoices,
    documents: r.documents,
    storageBytes: Number(r.storage_bytes),
    lastActivity: r.last_activity,
  };
}

/**
 * Storage is the one resource with a real marginal cost, so it gets counted
 * twice: by clinic, and by what the bytes actually are.
 */
const PER_TENANT = `
  SELECT t.id AS tenant_id, t.name, t.subdomain, t.status, t.created_at,
         p.name AS plan_name,
         (SELECT count(*) FROM users u
           WHERE u.tenant_id = t.id AND u.status = 'active')::int AS users,
         (SELECT count(*) FROM patients x
           WHERE x.tenant_id = t.id AND x.status <> 'archived')::int AS patients,
         (SELECT count(*) FROM appointments a WHERE a.tenant_id = t.id)::int AS appointments,
         (SELECT count(*) FROM appointments a
           WHERE a.tenant_id = t.id AND a.starts_at >= now() - interval '30 days')::int
           AS appointments_30d,
         (SELECT count(*) FROM invoices i WHERE i.tenant_id = t.id)::int AS invoices,
         (SELECT count(*) FROM patient_documents d
           WHERE d.tenant_id = t.id AND d.deleted_at IS NULL)::int AS documents,
         (SELECT coalesce(sum(d.byte_size), 0) FROM patient_documents d
           WHERE d.tenant_id = t.id AND d.deleted_at IS NULL)::bigint AS storage_bytes,
         -- "Is anyone still using this?" Sessions are the truest signal: an
         -- appointment can be booked months ahead, a session is someone at a
         -- keyboard. issued_at is a date, hence the explicit cast — greatest()
         -- across date and timestamptz would otherwise resolve by surprise.
         greatest(
           (SELECT max(s.last_used_at) FROM user_sessions s WHERE s.tenant_id = t.id),
           (SELECT max(a.created_at)   FROM appointments a  WHERE a.tenant_id = t.id),
           (SELECT max(i.issued_at)::timestamptz FROM invoices i WHERE i.tenant_id = t.id)
         ) AS last_activity
    FROM tenants t
    LEFT JOIN plans p ON p.id = t.plan_id
   WHERE t.deleted_at IS NULL`;

@Injectable()
export class PlatformUsageService {
  constructor(private readonly db: DatabaseService, private readonly storage: StorageService) {}

  /** Every clinic's consumption, heaviest first. */
  async fleet() {
    const { rows } = await this.db.adminQuery<UsageRow>(
      `${PER_TENANT} ORDER BY storage_bytes DESC, patients DESC`,
    );
    const tenants = rows.map(mapUsage);

    const totals = tenants.reduce(
      (acc, t) => ({
        clinics: acc.clinics + 1,
        users: acc.users + t.users,
        patients: acc.patients + t.patients,
        appointments: acc.appointments + t.appointments,
        invoices: acc.invoices + t.invoices,
        documents: acc.documents + t.documents,
        storageBytes: acc.storageBytes + t.storageBytes,
      }),
      { clinics: 0, users: 0, patients: 0, appointments: 0, invoices: 0, documents: 0, storageBytes: 0 },
    );

    const { rows: kinds } = await this.db.adminQuery<{
      kind: string;
      files: number;
      bytes: string;
    }>(
      `SELECT kind, count(*)::int AS files, coalesce(sum(byte_size), 0)::bigint AS bytes
         FROM patient_documents
        WHERE deleted_at IS NULL
        GROUP BY kind
        ORDER BY bytes DESC`,
    );

    // Deleted but not yet purged: storage the vendor still pays for and no
    // clinic can see. Worth a number of its own.
    const { rows: reclaim } = await this.db.adminQuery<{ files: number; bytes: string }>(
      `SELECT count(*)::int AS files, coalesce(sum(byte_size), 0)::bigint AS bytes
         FROM patient_documents WHERE deleted_at IS NOT NULL`,
    );

    return {
      totals,
      tenants,
      storageByKind: kinds.map((k) => ({ kind: k.kind, files: k.files, bytes: Number(k.bytes) })),
      reclaimable: { files: reclaim[0]!.files, bytes: Number(reclaim[0]!.bytes) },
      backend: await this.storage.status(),
    };
  }

  async forTenant(tenantId: string) {
    const { rows } = await this.db.adminQuery<UsageRow>(
      `${PER_TENANT} AND t.id = $1`,
      [tenantId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundException('No such clinic.');

    const { rows: kinds } = await this.db.adminQuery<{
      kind: string;
      files: number;
      bytes: string;
    }>(
      `SELECT kind, count(*)::int AS files, coalesce(sum(byte_size), 0)::bigint AS bytes
         FROM patient_documents
        WHERE tenant_id = $1 AND deleted_at IS NULL
        GROUP BY kind
        ORDER BY bytes DESC`,
      [tenantId],
    );

    const { rows: months } = await this.db.adminQuery<{
      month: string;
      appointments: number;
      invoices: number;
      revenue: string;
    }>(
      `WITH m AS (
         SELECT to_char(generate_series(
           date_trunc('month', now()) - interval '5 months',
           date_trunc('month', now()), interval '1 month'), 'YYYY-MM') AS month
       )
       SELECT m.month,
              (SELECT count(*)::int FROM appointments a
                WHERE a.tenant_id = $1 AND to_char(a.starts_at, 'YYYY-MM') = m.month)
                AS appointments,
              (SELECT count(*)::int FROM invoices i
                WHERE i.tenant_id = $1 AND to_char(i.issued_at, 'YYYY-MM') = m.month)
                AS invoices,
              (SELECT coalesce(sum(i.total), 0)::bigint FROM invoices i
                WHERE i.tenant_id = $1 AND to_char(i.issued_at, 'YYYY-MM') = m.month)
                AS revenue
         FROM m ORDER BY m.month`,
      [tenantId],
    );

    return {
      ...mapUsage(row),
      storageByKind: kinds.map((k) => ({ kind: k.kind, files: k.files, bytes: Number(k.bytes) })),
      months: months.map((x) => ({
        month: x.month,
        appointments: x.appointments,
        invoices: x.invoices,
        revenue: Number(x.revenue),
      })),
    };
  }
}

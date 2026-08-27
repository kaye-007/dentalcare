import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';

export interface AuthUserRow {
  id: string;
  tenant_id: string;
  email: string;
  password_hash: string;
  full_name: string;
  /** Raw DB value. Pass through normalizeRole() before trusting it. */
  role: string;
  user_status: 'active' | 'disabled';
  /** Matches the tenants_status_check constraint set by migration 0004. */
  tenant_status: 'active' | 'suspended' | 'archived';
  clinic_name: string;
  subdomain: string;
  /** Google's subject id, once this account has signed in with Google. */
  google_sub: string | null;
}

const SELECT = `
  SELECT u.id, u.tenant_id, u.email, u.password_hash, u.full_name, u.role,
         u.status AS user_status, u.google_sub,
         t.status AS tenant_status,
         t.name   AS clinic_name,
         t.subdomain AS subdomain
    FROM users u
    JOIN tenants t ON t.id = u.tenant_id`;

@Injectable()
export class UsersService {
  constructor(private readonly db: DatabaseService) {}

  /** Look up a user by email WITHIN the given tenant (RLS-scoped). */
  async findForAuthByEmail(
    tenantId: string,
    email: string,
  ): Promise<AuthUserRow | null> {
    return this.db.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<AuthUserRow>(
        `${SELECT} WHERE lower(u.email) = lower($1) LIMIT 1`,
        [email],
      );
      return rows[0] ?? null;
    });
  }

  /** Look up a user by id WITHIN the given tenant (RLS-scoped). */
  async findForAuthById(
    tenantId: string,
    id: string,
  ): Promise<AuthUserRow | null> {
    return this.db.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<AuthUserRow>(
        `${SELECT} WHERE u.id = $1 LIMIT 1`,
        [id],
      );
      return rows[0] ?? null;
    });
  }

  /** Replace a user's password hash WITHIN the given tenant (RLS-scoped). */
  async updatePasswordHash(
    tenantId: string,
    id: string,
    passwordHash: string,
  ): Promise<boolean> {
    return this.db.withTenant(tenantId, async (client) => {
      const res = await client.query(
        'UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1',
        [id, passwordHash],
      );
      return res.rowCount === 1;
    });
  }
}

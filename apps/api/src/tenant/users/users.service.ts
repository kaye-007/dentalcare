import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';

export interface AuthUserRow {
  id: string;
  tenant_id: string;
  email: string;
  password_hash: string;
  full_name: string;
  role: 'owner' | 'frontdesk';
  user_status: 'active' | 'disabled';
  tenant_status: 'trial' | 'active' | 'suspended' | 'cancelled';
  clinic_name: string;
  subdomain: string;
}

const SELECT = `
  SELECT u.id, u.tenant_id, u.email, u.password_hash, u.full_name, u.role,
         u.status AS user_status,
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
}

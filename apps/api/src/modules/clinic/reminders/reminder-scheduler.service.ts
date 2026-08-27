import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '@/core/database/database.service';
import { RemindersService } from './reminders.service';

/* ════════ scheduler ════════
 * Scans every active tenant with reminders enabled and creates + delivers the
 * automatic reminders that have come due.
 *
 * WHO CALLS tick() DEPENDS ON THE RUNTIME:
 *
 *   node    — this service owns a setInterval, as it always has. That is what
 *             a long-running container should do.
 *   workers — nothing here runs it. A Worker has no resident process between
 *             requests to hold a timer, so the hourly Cron Trigger declared in
 *             wrangler.jsonc calls tick() through the scheduled handler in
 *             apps/api/worker/index.ts.
 *
 * Either way the scan is idempotent — a partial unique index on automatic
 * reminders means a duplicate or overlapping pass claims nothing and delivers
 * nothing — so nothing about the schema or the logic changes between the
 * two runtimes. */
@Injectable()
export class ReminderSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReminderSchedulerService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly reminders: RemindersService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('RUNTIME') === 'workers') {
      this.logger.log(
        'reminder scheduler idle in-process — driven by the Cloudflare Cron Trigger',
      );
      return;
    }
    const interval = this.config.get<number>('REMINDER_SCAN_INTERVAL_MS') ?? 60_000;
    this.timer = setInterval(() => void this.tick(), interval);
    this.logger.log(`reminder scheduler started (every ${interval}ms, channel: internal log)`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return; // never overlap scans
    this.running = true;
    try {
      const tenants = await this.db.adminQuery<{
        id: string;
        reminder_hours_before: number;
      }>(
        `SELECT t.id, cs.reminder_hours_before
           FROM tenants t
           JOIN clinic_settings cs ON cs.tenant_id = t.id
          WHERE t.status = 'active' AND cs.reminders_enabled = true`,
      );
      for (const t of tenants.rows) {
        const sent = await this.reminders.scanTenant(t.id, t.reminder_hours_before);
        if (sent > 0) this.logger.log(`tenant ${t.id}: ${sent} automatic reminder(s) sent`);
      }
    } catch (err: unknown) {
      this.logger.error(`scan failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.running = false;
    }
  }
}

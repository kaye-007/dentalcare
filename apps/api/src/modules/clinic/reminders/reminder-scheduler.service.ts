import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '@/core/database/database.service';
import { ChannelRegistry } from './channels/registry';
import { RemindersService } from './reminders.service';

/* ════════ scheduler ════════
 * Scans every active clinic with reminders enabled, claiming and delivering
 * the automatic reminders that have come due and retrying the ones waiting.
 *
 * WHO CALLS tick() DEPENDS ON THE RUNTIME:
 *
 *   node    — this service owns a setInterval. That is what a long-running
 *             container should do.
 *   workers — nothing here runs it. A Worker has no resident process between
 *             requests to hold a timer, so the Cron Trigger in wrangler.jsonc
 *             calls tick() through the scheduled handler in worker/index.ts.
 *
 * FAIRNESS. A pass has a time budget, and clinics are visited in the order
 * they were last scanned, oldest first — stamped BEFORE each scan, so a clinic
 * whose scan throws or runs long goes to the back of the queue instead of
 * being first again next time and starving everyone behind it. One clinic's
 * failure is logged and the pass moves on.
 *
 * Either way the scan is idempotent — the partial unique index on automatic
 * reminders means a duplicate or overlapping pass claims nothing twice. */
@Injectable()
export class ReminderSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReminderSchedulerService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly reminders: RemindersService,
    private readonly registry: ChannelRegistry,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const channel = this.registry.active().label;
    if (this.config.get<string>('RUNTIME') === 'workers') {
      this.logger.log(
        `reminder scheduler idle in-process — driven by the Cloudflare Cron Trigger (channel: ${channel})`,
      );
      return;
    }
    const interval = this.config.get<number>('REMINDER_SCAN_INTERVAL_MS') ?? 60_000;
    this.timer = setInterval(() => void this.tick(), interval);
    this.logger.log(
      `reminder scheduler started (every ${interval}ms, channel: ${channel})`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return; // never overlap scans
    this.running = true;
    const started = Date.now();
    const budget = this.config.get<number>('REMINDER_SCAN_BUDGET_MS') ?? 45_000;

    try {
      const tenants = await this.db.adminQuery<{ id: string }>(
        `SELECT t.id
           FROM tenants t
           JOIN clinic_settings cs ON cs.tenant_id = t.id
          WHERE t.status = 'active' AND cs.reminders_enabled = true
          ORDER BY cs.reminders_last_scan_at NULLS FIRST, t.id`,
      );

      let visited = 0;
      for (const t of tenants.rows) {
        if (Date.now() - started > budget) {
          this.logger.warn(
            `reminder pass out of time after ${visited} of ${tenants.rows.length} clinic(s); ` +
              'the rest are first in line next pass',
          );
          break;
        }
        visited += 1;
        try {
          await this.db.withTenant(t.id, (client) =>
            client.query(
              'UPDATE clinic_settings SET reminders_last_scan_at = now() WHERE tenant_id = $1',
              [t.id],
            ),
          );
          const r = await this.reminders.scanTenant(t.id);
          if (r.sent + r.failed + r.retrying + r.skipped > 0) {
            this.logger.log(
              `tenant ${t.id}: ${r.sent} sent, ${r.retrying} to retry, ${r.failed} failed, ${r.skipped} skipped`,
            );
          }
        } catch (err: unknown) {
          this.logger.error(
            `tenant ${t.id}: reminder scan failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    } catch (err: unknown) {
      this.logger.error(
        `reminder pass failed: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      this.running = false;
    }
  }
}

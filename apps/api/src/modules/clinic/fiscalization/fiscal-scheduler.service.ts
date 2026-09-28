import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '@/core/database/database.service';
import { FiscalService } from './fiscal.service';

/**
 * Sends fiscal invoices that were issued while the tax authority could not be
 * reached. The law allows a subsequent delivery within 48 hours; this pass
 * runs well inside that.
 *
 * Driven the same way as the reminder scheduler: its own interval on Node,
 * the Cron Trigger on Workers (worker/index.ts). Each delivery leases its row,
 * so two passes never send one invoice at the same time.
 */
@Injectable()
export class FiscalSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FiscalSchedulerService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly fiscal: FiscalService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('RUNTIME') === 'workers') return;
    if (!this.config.get<string>('FISCAL_SOFTWARE_CODE')) return;
    this.timer = setInterval(() => void this.tick(), 5 * 60_000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running || !this.config.get<string>('FISCAL_SOFTWARE_CODE')) return;
    this.running = true;
    const started = Date.now();
    try {
      const { rows } = await this.db.adminQuery<{ tenant_id: string }>(
        `SELECT DISTINCT f.tenant_id
           FROM fiscal_invoices f
           JOIN tenants t ON t.id = f.tenant_id
          WHERE f.status = 'pending' AND f.next_attempt_at <= now() AND t.status = 'active'`,
      );
      for (const { tenant_id } of rows) {
        if (Date.now() - started > 40_000) break;
        try {
          const sent = await this.fiscal.deliverDue(tenant_id);
          if (sent)
            this.logger.log(`tenant ${tenant_id}: ${sent} fiscal invoice(s) re-sent`);
        } catch (err) {
          this.logger.error(
            `tenant ${tenant_id}: fiscal delivery failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        `fiscal pass failed: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      this.running = false;
    }
  }
}

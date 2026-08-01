import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async check() {
    const dbUp = await this.db.ping();
    return {
      status: dbUp ? 'ok' : 'degraded',
      service: 'dentalcare-api',
      checks: {
        database: dbUp ? 'up' : 'down',
      },
      timestamp: new Date().toISOString(),
    };
  }
}

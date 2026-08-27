import { Controller, Get, UseGuards } from '@nestjs/common';
import { DatabaseService } from '@/core/database/database.service';
import { PlatformJwtGuard } from '@/modules/platform/auth';

@Controller('platform/plans')
@UseGuards(PlatformJwtGuard)
export class PlansController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async list() {
    const { rows } = await this.db.adminQuery(
      `SELECT id, code, name, price_monthly
         FROM plans WHERE is_active = true ORDER BY price_monthly`,
    );
    return rows;
  }
}

import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import { PlatformAuthModule } from '../platform-auth/platform-auth.module';
import { PlatformJwtGuard } from '../platform-auth/platform-jwt.guard';

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

@Module({
  imports: [PlatformAuthModule],
  controllers: [PlansController],
})
export class PlansModule {}

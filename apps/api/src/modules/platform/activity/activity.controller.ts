import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { PlatformJwtGuard } from '@/modules/platform/auth';
import {
  ACTIVITY_CATEGORIES,
  ActivityCategory,
  PlatformActivityService,
} from './activity.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('platform/activity')
@UseGuards(PlatformJwtGuard)
export class PlatformActivityController {
  constructor(private readonly activity: PlatformActivityService) {}

  /**
   * `?category=clinics|billing|plans`, `?limit=1..100` (default 50), and the
   * cursor from the last page: `?before=<created_at>&beforeId=<id>`.
   */
  @Get()
  list(
    @Query('category') category?: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('beforeId') beforeId?: string,
  ) {
    if (category !== undefined && !(category in ACTIVITY_CATEGORIES)) {
      throw new BadRequestException(
        `category must be one of ${Object.keys(ACTIVITY_CATEGORIES).join(', ')}`,
      );
    }
    const n = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      throw new BadRequestException('limit must be an integer from 1 to 100');
    }
    if ((before === undefined) !== (beforeId === undefined)) {
      throw new BadRequestException('before and beforeId go together');
    }
    if (
      before !== undefined &&
      (Number.isNaN(Date.parse(before)) || !UUID.test(beforeId!))
    ) {
      throw new BadRequestException('before must be a timestamp and beforeId an id');
    }
    return this.activity.list({
      category: category as ActivityCategory | undefined,
      limit: n,
      before: before !== undefined ? { at: before, id: beforeId! } : undefined,
    });
  }
}

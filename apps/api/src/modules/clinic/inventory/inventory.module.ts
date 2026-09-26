import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/clinic/auth';
import { InventoryController } from './inventory.controller';
import { ItemMovementsController } from './item-movements.controller';
import { InventoryService } from './inventory.service';

@Module({
  imports: [AuthModule],
  controllers: [InventoryController, ItemMovementsController],
  providers: [InventoryService],
})
export class InventoryModule {}

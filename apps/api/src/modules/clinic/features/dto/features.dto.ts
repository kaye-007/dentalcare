import { IsBoolean } from 'class-validator';

export class SetFeatureDto {
  @IsBoolean()
  enabled!: boolean;
}

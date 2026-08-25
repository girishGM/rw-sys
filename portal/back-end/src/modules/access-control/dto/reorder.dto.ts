/**
 * T-033 — `PATCH /admin/access-control/nav/:role/reorder` and `.../widgets/:role/reorder`
 * (implementation note 7): a single bulk `sort_order` update, not the N `PATCH` calls a
 * drag-and-drop UI would otherwise issue one per moved row.
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class ReorderItemDto {
  /** `navKey` or `widgetKey`, depending on the route. */
  @IsString()
  @MinLength(1)
  key!: string;

  @IsInt()
  @Min(0)
  sortOrder!: number;
}

export class ReorderDto {
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ReorderItemDto)
  order!: ReorderItemDto[];
}

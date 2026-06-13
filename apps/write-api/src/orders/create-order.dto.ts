import { Type } from "class-transformer";
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsString,
  Min,
  ValidateNested,
} from "class-validator";

export class OrderItemDto {
  @IsString() sku!: string;
  @IsInt() @Min(1) qty!: number;
  @IsInt() @Min(0) price!: number;
}

export class CreateOrderDto {
  @IsString() orderId!: string;
  @IsString() customerId!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];

  @IsInt() @Min(0) totalAmount!: number;
}

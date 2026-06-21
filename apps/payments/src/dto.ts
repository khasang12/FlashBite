import { IsInt, IsString, Min } from "class-validator";

export class AuthorizeDto {
  @IsString() tenantId!: string;
  @IsString() orderId!: string;
  @IsInt() @Min(0) amount!: number;
  @IsString() idempotencyKey!: string;
}

export class CaptureVoidDto {
  @IsString() tenantId!: string;
  @IsString() orderId!: string;
  @IsString() idempotencyKey!: string;
}

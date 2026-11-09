import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";

const INTERVALS = ["monthly", "annual"] as const;
const CARDS = [
  "success",
  "decline",
  "insufficient_funds",
  "requires_3ds",
  "renewal_failure",
] as const;

export class CheckoutDto {
  @IsString() @MaxLength(40) planId: string;
  @IsIn(INTERVALS) interval: "monthly" | "annual";
  @IsOptional() @IsString() @MaxLength(40) promoCode?: string;
}

export class PlanTargetDto {
  @IsString() @MaxLength(40) planId: string;
  @IsIn(INTERVALS) interval: "monthly" | "annual";
}

export class ChangePlanDto extends PlanTargetDto {
  @IsOptional() @IsInt() @Min(0) expectedAmountDue?: number;
  @IsOptional() @IsNumber() prorationDate?: number;
}

export class PromoPreviewDto extends PlanTargetDto {
  @IsString() @MaxLength(40) code: string;
}

export class FakeCardDto {
  @IsIn(CARDS) card: (typeof CARDS)[number];
}

export class FakeApproveDto {
  @IsBoolean() approve: boolean;
}

export class FakeAdvanceDto {
  @IsOptional() @IsNumber() @Min(0) @Max(3660) days?: number;
  @IsOptional() @IsISO8601() to?: string;
}

export class CreatePromoDto {
  @IsString() @MaxLength(40) code: string;
  @IsOptional() @IsInt() @Min(1) @Max(100) percentOff?: number;
  @IsOptional() @IsInt() @Min(1) amountOff?: number;
  @IsIn(["once", "repeating", "forever"]) duration:
    "once" | "repeating" | "forever";
  @IsOptional() @IsInt() @Min(1) @Max(36) durationInMonths?: number;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  appliesToPlans?: string[];
  @IsOptional()
  @IsArray()
  @IsIn(INTERVALS, { each: true })
  appliesToIntervals?: Array<"monthly" | "annual">;
  @IsOptional() @IsISO8601() expiresAt?: string;
  @IsOptional() @IsInt() @Min(1) maxRedemptions?: number;
  @IsOptional() @IsBoolean() firstTimeOnly?: boolean;
}

export class PriceChangeNoticeDto extends PlanTargetDto {
  @IsInt() @Min(1) newAmount: number;
  @IsISO8601() effectiveAt: string;
}

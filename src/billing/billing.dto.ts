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
  MinLength,
  Matches,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

const INTERVALS = ["monthly", "annual"] as const;
const CARDS = [
  "success",
  "decline",
  "insufficient_funds",
  "requires_3ds",
  "renewal_failure",
] as const;

export class RegionDto {
  @IsString() @Matches(/^[A-Z]{2}$/) country: string;
  @IsOptional() @IsString() @MaxLength(40) state?: string | null;
  @IsOptional() @IsString() @MaxLength(12) postalCode?: string | null;
}

export class AddressDto extends RegionDto {
  @IsString() @MinLength(1) @MaxLength(200) line1: string;
  @IsOptional() @IsString() @MaxLength(200) line2?: string | null;
  @IsString() @MinLength(1) @MaxLength(100) city: string;
}

export class BillingDetailsDto {
  @IsString() @MinLength(1) @MaxLength(200) name: string;
  @ValidateNested() @Type(() => AddressDto) address: AddressDto;
}

export class ConsentDto {
  @IsBoolean() accepted: boolean;
  @IsString() @MaxLength(40) version: string;
}

export class CheckoutPreviewDto {
  @IsString() @MaxLength(40) planId: string;
  @IsIn(INTERVALS) interval: "monthly" | "annual";
  @IsOptional() @IsString() @MaxLength(40) promoCode?: string;
  @IsOptional() @ValidateNested() @Type(() => RegionDto) region?: RegionDto;
}

export class CheckoutDto {
  @IsString() @MaxLength(40) planId: string;
  @IsIn(INTERVALS) interval: "monthly" | "annual";
  @IsOptional() @IsString() @MaxLength(40) promoCode?: string;
  /** The renewal consent checkbox (required, unticked by default). */
  @ValidateNested() @Type(() => ConsentDto) consent: ConsentDto;
  /** Optional "Text me product updates" (stored with a timestamp; nothing is sent). */
  @IsOptional() @IsBoolean() marketingOptIn?: boolean;
  @ValidateNested() @Type(() => BillingDetailsDto) billing: BillingDetailsDto;
}

export class PlanTargetDto {
  @IsString() @MaxLength(40) planId: string;
  @IsIn(INTERVALS) interval: "monthly" | "annual";
}

export class ChangePlanDto extends PlanTargetDto {
  @IsOptional() @IsInt() @Min(0) expectedAmountDue?: number;
  /** Downgrades: the credit the preview showed (must match exactly). */
  @IsOptional() @IsInt() @Min(0) expectedCredit?: number;
  @IsOptional() @IsNumber() prorationDate?: number;
  /**
   * Every change (Stripe): the payment method the customer just entered in
   * the Payment Element for this change. It pays anything due now and the new
   * plan from its start — never a card on file. A Stripe id (pm_…), never card data.
   */
  @IsOptional() @IsString() @Matches(/^pm_[A-Za-z0-9]+$/) paymentMethodId?: string;
  /** Name and billing address from the payment step (required with Stripe). */
  @IsOptional() @ValidateNested() @Type(() => BillingDetailsDto) billing?: BillingDetailsDto;
  /** The renewal consent for the new plan (required with Stripe). */
  @IsOptional() @ValidateNested() @Type(() => ConsentDto) consent?: ConsentDto;
}

export class PromoPreviewDto extends PlanTargetDto {
  @IsString() @MaxLength(40) code: string;
}

export class ReferralClaimDto {
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

export class ContactDto {
  @IsOptional() @IsBoolean() marketingOptIn?: boolean;
}

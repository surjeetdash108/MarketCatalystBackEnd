import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";

/**
 * The investor-profile fields a user may set on `users/{uid}`, and nothing
 * else. Mirrors `InvestorProfile` in MarketCatalystUI/app/profile/profile-fields.tsx
 * minus `email`, which comes from the verified Firebase Auth account.
 *
 * Plan, subscription, Stripe, feature-flag and identity fields are absent on
 * purpose: they are written only by the server (and, for billing, only by the
 * Stripe webhook). The global ValidationPipe strips anything not declared here.
 */
export const PROFILE_FIELDS = [
  "profile_image",
  "name",
  "mobileNumber",
  "age",
  "incomeRange",
  "investmentExperience",
  "investmentGoals",
  "riskTolerance",
  "investmentHorizon",
  "currentPortfolioValue",
  "preferredAssetClasses",
] as const;

export type ProfileField = (typeof PROFILE_FIELDS)[number];

const SHORT = 200;

export class InvestorProfilePatchDto {
  /** A data: URL from the avatar picker; capped at Firestore's 1 MiB document limit. */
  @IsOptional() @IsString() @MaxLength(1_000_000) profile_image?: string;
  @IsOptional() @IsString() @MaxLength(SHORT) name?: string;
  @IsOptional() @IsString() @MaxLength(40) mobileNumber?: string;
  @IsOptional() @IsString() @MaxLength(SHORT) age?: string;
  @IsOptional() @IsString() @MaxLength(SHORT) incomeRange?: string;
  @IsOptional() @IsString() @MaxLength(SHORT) investmentExperience?: string;
  @IsOptional() @IsString() @MaxLength(SHORT) investmentGoals?: string;
  @IsOptional() @IsString() @MaxLength(SHORT) riskTolerance?: string;
  @IsOptional() @IsString() @MaxLength(SHORT) investmentHorizon?: string;
  @IsOptional() @IsString() @MaxLength(SHORT) currentPortfolioValue?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(SHORT, { each: true })
  preferredAssetClasses?: string[];
}

/**
 * Copies only allowlisted profile fields. Defence in depth behind the
 * ValidationPipe: even if the pipe were removed or misconfigured, the write
 * below could still never carry a server-owned field.
 */
export function pickProfileFields(
  body: Partial<Record<string, unknown>> | null | undefined,
): Partial<Record<ProfileField, unknown>> {
  const out: Partial<Record<ProfileField, unknown>> = {};
  for (const k of PROFILE_FIELDS) {
    if (body && body[k] !== undefined) out[k] = body[k];
  }
  return out;
}

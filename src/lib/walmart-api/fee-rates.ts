/**
 * Walmart fee estimation for orders not yet in settlement.
 * Uses exact referral fee rates by category and WFS fee schedule.
 * These estimates are replaced with actuals when the recon report arrives (~14 days).
 */

/** Walmart referral fee rates by contract category */
const REFERRAL_RATES: Record<string, number | ((price: number) => number)> = {
  'Personal Computers': 0.06,
  'Consumer Electronics': 0.08,
  'Video Game Consoles': 0.08,
  'Major Appliances': 0.08,
  'Automotive & Powersports': 0.12,
  'Books': 0.15,
  'Home, Kitchen, Decor & Garden': 0.15,
  'Pet Supplies': 0.15,
  'Software & Computer Video Games': 0.15,
  'Tools & Home Improvement': 0.15,
  'Toys & Games': 0.15,
  'Everything Else': 0.15,
  // Tiered categories
  'Baby Products': (price: number) => price <= 10 ? 0.08 : 0.15,
  'Beauty, Health & Personal Care': (price: number) => price <= 10 ? 0.08 : 0.15,
  'Electronics Accessories': (price: number) => price <= 100 ? 0.15 : 0.08,
  'Grocery': (price: number) => price <= 15 ? 0.08 : 0.15,
  'Jewelry & Precious Metals': 0.20,
};

/** Default referral rate when category is unknown */
const DEFAULT_REFERRAL_RATE = 0.15;

/**
 * Get the referral fee rate for a category and price.
 * Returns a decimal (e.g., 0.15 = 15%).
 */
export function getReferralRate(category: string, priceInDollars: number): number {
  const rate = REFERRAL_RATES[category];
  if (!rate) return DEFAULT_REFERRAL_RATE;
  if (typeof rate === 'function') return rate(priceInDollars);
  return rate;
}

/**
 * Calculate estimated referral fee in cents.
 */
export function estimateReferralFee(category: string, priceInCents: number): number {
  const rate = getReferralRate(category, priceInCents / 100);
  return Math.round(priceInCents * rate);
}

/**
 * WFS fulfillment fee by shipping weight in pounds.
 */
export function estimateWfsFee(weightLbs: number, options?: {
  isApparel?: boolean;
  isHazmat?: boolean;
  priceUnder10?: boolean;
}): number {
  let baseFee: number;

  if (weightLbs <= 1) baseFee = 345;
  else if (weightLbs <= 2) baseFee = 495;
  else if (weightLbs <= 3) baseFee = 545;
  else if (weightLbs <= 20) baseFee = 575 + Math.ceil(weightLbs - 4) * 40;
  else if (weightLbs <= 30) baseFee = 1555 + Math.ceil(weightLbs - 21) * 40;
  else if (weightLbs <= 50) baseFee = 1455 + Math.ceil(weightLbs - 31) * 40;
  else baseFee = 1755 + Math.ceil(weightLbs - 51) * 40;

  // Surcharges
  if (options?.isApparel) baseFee += 50;
  if (options?.isHazmat) baseFee += 50;
  if (options?.priceUnder10) baseFee += 100;

  return baseFee; // cents
}

/**
 * WFS storage fee per unit per month in cents.
 * Based on cubic feet. Returns monthly cost in cents.
 */
export function estimateWfsStorageFee(
  lengthIn: number, widthIn: number, heightIn: number,
  isPeakSeason: boolean = false,
  storedOver30Days: boolean = false,
): number {
  const cubicFeet = (lengthIn * widthIn * heightIn) / 1728;

  // $0.75/cu ft standard, $2.25/cu ft peak season over 30 days
  const ratePerCuFt = (isPeakSeason && storedOver30Days) ? 225 : 75; // cents
  return Math.round(cubicFeet * ratePerCuFt);
}

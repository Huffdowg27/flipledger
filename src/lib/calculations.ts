/**
 * calculations.ts — SINGLE SOURCE OF TRUTH for all financial math.
 *
 * All monetary values are INTEGER CENTS internally.
 * Only convert to dollars for display via formatters.ts.
 * Never round intermediate calculations.
 */

/** Profit = Revenue - COGS - Fees - Shipping + Fee Clawbacks */
export function calculateProfit(
  revenue: number,
  cogs: number,
  totalFees: number,
  shippingCost: number = 0,
  feeClawbacks: number = 0
): number {
  return revenue - cogs - totalFees - shippingCost + feeClawbacks;
}

/** ROI = Profit / COGS × 100 (NOT profit / revenue — that's margin) */
export function calculateROI(profit: number, cogs: number): number {
  if (cogs === 0) return 0;
  return (profit / cogs) * 100;
}

/** Margin = Profit / Revenue × 100 */
export function calculateMargin(profit: number, revenue: number): number {
  if (revenue === 0) return 0;
  return (profit / revenue) * 100;
}

/** Sum an array of cent values */
export function sumCents(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

/** Average of cent values */
export function avgCents(values: number[]): number {
  if (values.length === 0) return 0;
  return sumCents(values) / values.length;
}

/** Net impact of a refund = refund amount - fee clawback */
export function calculateRefundNetImpact(refundAmount: number, feeClawback: number): number {
  return refundAmount - feeClawback;
}

/** Shipping profit for MFN orders = shipping charged to customer - actual shipping cost */
export function calculateShippingProfit(shippingCharged: number, shippingCost: number): number {
  return shippingCharged - shippingCost;
}

/** Expected profit for inventory = (list price - estimated fees - COGS) × quantity */
export function calculateExpectedProfit(
  listPrice: number,
  estimatedFees: number,
  cogs: number,
  quantity: number
): number {
  return (listPrice - estimatedFees - cogs) * quantity;
}

/** Percent change between two values */
export function calculatePercentChange(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return ((current - previous) / Math.abs(previous)) * 100;
}

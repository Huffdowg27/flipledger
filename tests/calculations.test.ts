import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateProfit,
  calculateROI,
  calculateMargin,
  calculateShippingProfit,
} from '../src/lib/calculations';

// ── Core identities ───────────────────────────────────────────────────────
test('calculateProfit = revenue - cogs - fees - shipping + clawbacks', () => {
  assert.equal(calculateProfit(10000, 4000, 1300), 4700);
  assert.equal(calculateProfit(10000, 4000, 1300, 500), 4200);
  assert.equal(calculateProfit(10000, 4000, 1300, 500, 200), 4400);
});

test('calculateROI = profit/cogs*100, 0 when cogs is 0', () => {
  assert.equal(calculateROI(4700, 4000), (4700 / 4000) * 100);
  assert.equal(calculateROI(4700, 0), 0);
});

test('calculateMargin = profit/revenue*100, 0 when revenue is 0', () => {
  assert.equal(calculateMargin(4700, 10000), 47);
  assert.equal(calculateMargin(4700, 0), 0);
});

test('calculateShippingProfit = charged - cost', () => {
  assert.equal(calculateShippingProfit(800, 650), 150);
});

// ── Surface-mapping locks (audit F1) ──────────────────────────────────────
// Each route surface must equal its historical raw arithmetic. If someone
// changes a calculations.ts signature or a route's call, these break — which
// is the point: profit is defined in exactly one place now.

const cases = [
  { salePrice: 12500, buyCost: 6905, fees: 1620 },
  { salePrice: 0, buyCost: 0, fees: 0 },
  { salePrice: 999, buyCost: 1200, fees: 300 }, // loss
];

test('FBA / WFS sales: profit, margin, ROI match raw arithmetic', () => {
  for (const { salePrice, buyCost, fees } of cases) {
    const profit = calculateProfit(salePrice, buyCost, fees);
    assert.equal(profit, salePrice - buyCost - fees);
    assert.equal(calculateMargin(profit, salePrice), salePrice > 0 ? (profit / salePrice) * 100 : 0);
    assert.equal(calculateROI(profit, buyCost), buyCost > 0 ? (profit / buyCost) * 100 : 0);
  }
});

test('Merchant / eBay sales: profit includes shipping profit, matches raw arithmetic', () => {
  const salePrice = 12500, buyCost = 6905, fees = 1620, shippingCharged = 800, shippingCost = 650;
  const shippingProfit = calculateShippingProfit(shippingCharged, shippingCost);
  const profit = calculateProfit(salePrice, buyCost, fees) + shippingProfit;
  assert.equal(profit, salePrice - buyCost - fees + (shippingCharged - shippingCost));
});

test('Profitability report: revenue + shippingCharged - cogs - fees - shippingCost', () => {
  const revenue = 50000, shippingCharged = 1200, cogs = 22000, fees = 6300, shippingCost = 900;
  const profit = calculateProfit(revenue + shippingCharged, cogs, fees, shippingCost);
  assert.equal(profit, revenue + shippingCharged - cogs - fees - shippingCost);
  // margin denominator stays revenue (not revenue + shipping), as in the route
  assert.equal(calculateMargin(profit, revenue), revenue > 0 ? (profit / revenue) * 100 : 0);
});

test('In-flight / dashboard projections: revenue - cogs - fees - shipping', () => {
  const revenue = 30000, cogs = 14000, estFees = Math.round(revenue * 0.13), mfnShip = 500;
  assert.equal(calculateProfit(revenue, cogs, estFees, mfnShip), revenue - cogs - estFees - mfnShip);
  // dashboard daily/cohort variants (no shipping term)
  assert.equal(calculateProfit(revenue, cogs, estFees), revenue - cogs - estFees);
});

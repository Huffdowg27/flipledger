import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaxSchedule } from '../src/lib/tax-schedule';

test('tax schedule reconciles to the authoritative P&L buckets', () => {
  const schedule = buildTaxSchedule({
    grossReceipts: 16_896_101,
    returnsAndAllowances: 1_779_956,
    recognizedCogs: 8_581_701,
    inventoryWriteoff: 122_176,
    reimbursements: 282_117,
    otherIncome: 0,
    feeClawbacks: 272_006,
    restockingFees: 10_389,
    marketplaceFees: 4_760_058,
    promotionalRebates: 77_823,
    shippingCosts: 233_233,
    otherExpenses: 0,
    inboundShipping: 0,
  });

  assert.equal(schedule.line4_cogs, 8_703_877);
  assert.equal(schedule.line6_otherIncome, 564_512);
  assert.equal(schedule.line31_netProfit, 1_905_666);
});

test('marketplace-facilitator tax is not an income or deduction input', () => {
  const input = {
    grossReceipts: 10_000,
    returnsAndAllowances: 1_000,
    recognizedCogs: 2_000,
    inventoryWriteoff: 0,
    reimbursements: 0,
    otherIncome: 0,
    feeClawbacks: 0,
    restockingFees: 0,
    marketplaceFees: 500,
    promotionalRebates: 100,
    shippingCosts: 200,
    otherExpenses: 0,
    inboundShipping: 0,
  };

  assert.equal(buildTaxSchedule(input).line31_netProfit, 6_200);
  assert.equal('salesTax' in buildTaxSchedule(input).deductions, false);
});

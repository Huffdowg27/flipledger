export interface TaxScheduleInputs {
  grossReceipts: number;
  returnsAndAllowances: number;
  recognizedCogs: number;
  inventoryWriteoff: number;
  reimbursements: number;
  otherIncome: number;
  feeClawbacks: number;
  restockingFees: number;
  marketplaceFees: number;
  promotionalRebates: number;
  shippingCosts: number;
  otherExpenses: number;
  inboundShipping: number;
}

/**
 * Build the annual business-income schedule from the same accounting buckets
 * used by P&L. Marketplace-facilitator sales tax is deliberately absent: it is
 * pass-through money and belongs only in the report's reference section.
 */
export function buildTaxSchedule(input: TaxScheduleInputs) {
  const line1_grossReceipts = input.grossReceipts;
  const line2_returnsAllowances = input.returnsAndAllowances;
  const line3_netReceipts = line1_grossReceipts - line2_returnsAllowances;
  const line4_cogs = input.recognizedCogs + input.inventoryWriteoff;
  const line5_grossProfit = line3_netReceipts - line4_cogs;
  const line6_otherIncome = input.reimbursements
    + input.otherIncome
    + input.feeClawbacks
    + input.restockingFees;
  const line7_grossIncome = line5_grossProfit + line6_otherIncome;
  const deductions = {
    amazonFees: input.marketplaceFees,
    promotionalRebates: input.promotionalRebates,
    shippingCosts: input.shippingCosts,
    otherExpenses: input.otherExpenses,
    inboundShipping: input.inboundShipping,
  };
  const totalDeductions = Object.values(deductions).reduce((sum, value) => sum + value, 0);

  return {
    line1_grossReceipts,
    line2_returnsAllowances,
    line3_netReceipts,
    line4_cogs,
    line5_grossProfit,
    line6_otherIncome,
    line7_grossIncome,
    deductions,
    totalDeductions,
    line31_netProfit: line7_grossIncome - totalDeductions,
  };
}

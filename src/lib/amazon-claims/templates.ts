/**
 * Templates and helpers for filing Amazon FBA reimbursement claims.
 *
 * Amazon's GET_LEDGER_DETAIL_VIEW_DATA report uses single-letter "reason"
 * codes that aren't documented publicly. Combined with a "disposition"
 * column, they tell us what kind of inventory event happened.
 */

/** Map Amazon's single-letter reason codes to human-readable labels. */
export function reasonCodeLabel(code: string): string {
  switch (code.toUpperCase()) {
    case 'M': return 'Missing / Lost';
    case 'Q': return 'Quantity adjustment';
    case 'E': return 'Error adjustment';
    case 'F': return 'Found (units added back)';
    case 'N': return 'New receipt';
    case 'P': return 'Process adjustment';
    case 'A': return 'Auto-reconciliation';
    case 'C': return 'Customer return processed';
    case 'R': return 'Return processed';
    default: return code;
  }
}

/** Higher-level explanation for the (reason + disposition) combination. */
export function classifyClaim(reason: string, disposition: string | null): {
  category: string;
  explanation: string;
  amazonShouldAutoReimburse: boolean;
} {
  const r = reason.toUpperCase();
  const d = (disposition || '').toUpperCase();

  if (r === 'M' && d === 'SELLABLE') {
    return {
      category: 'FC Lost — Sellable',
      explanation: 'Inventory was lost in the Amazon fulfillment center while in sellable condition. This is the most common reimbursable case. Amazon should auto-reimburse within 30 days; if not, file a case.',
      amazonShouldAutoReimburse: true,
    };
  }
  if (r === 'M' && d.includes('DAMAGED')) {
    return {
      category: 'FC Lost — Damaged',
      explanation: 'Inventory was lost AND damaged in the FC. Reimbursement is at the original list price minus damage assessment. File if not auto-reimbursed.',
      amazonShouldAutoReimburse: true,
    };
  }
  if (r === 'Q' && d.includes('DAMAGED')) {
    return {
      category: 'Warehouse Damaged',
      explanation: 'Amazon damaged units while handling. Reimbursable as a warehouse-side issue.',
      amazonShouldAutoReimburse: true,
    };
  }
  if (r === 'E' && d === 'SELLABLE') {
    return {
      category: 'Adjustment Error',
      explanation: 'Amazon corrected an inventory miscount. May or may not be reimbursable depending on direction. Worth reviewing.',
      amazonShouldAutoReimburse: false,
    };
  }
  return {
    category: `${reasonCodeLabel(reason)} (${disposition || 'no disposition'})`,
    explanation: 'Manually review this adjustment to determine if it warrants a reimbursement claim.',
    amazonShouldAutoReimburse: false,
  };
}

/**
 * Build a claim-details summary the user can paste into Amazon's case form.
 * Amazon's "Open a case" UI asks for these facts; the formatted text saves
 * the user from having to re-enter each one.
 */
export interface AmazonClaimVars {
  asin: string;
  sku: string;
  fnsku: string;
  fcId: string;
  productName: string;
  adjustmentDate: string;     // formatted, e.g. "Mar 21, 2026"
  quantity: number;            // absolute units lost
  estimatedValue: string;      // formatted, e.g. "$26.88"
  reason: string;              // raw reason code, e.g. "M"
  disposition: string;         // raw disposition, e.g. "SELLABLE"
}

export function buildClaimMessage(v: AmazonClaimVars): string {
  const { category, explanation, amazonShouldAutoReimburse } = classifyClaim(v.reason, v.disposition);
  return (
`Hi Amazon FBA Support,

I'm requesting reimbursement for inventory lost in your fulfillment center.

CLAIM DETAILS
Product: ${v.productName}
ASIN: ${v.asin}
FNSKU: ${v.fnsku}
MSKU: ${v.sku}
Fulfillment Center: ${v.fcId}
Adjustment Date: ${v.adjustmentDate}
Units Affected: ${v.quantity}
Estimated Value: ${v.estimatedValue}
Reason Code: ${v.reason} (${category})
Disposition: ${v.disposition}

WHAT HAPPENED
${explanation}

REQUEST
${amazonShouldAutoReimburse
  ? 'This adjustment occurred more than 30 days ago and has not yet been auto-reimbursed. Please investigate and reimburse this loss per FBA inventory reimbursement policy.'
  : 'Please investigate this adjustment and determine reimbursement eligibility.'}

Thank you,`
  );
}

export const FILING_INSTRUCTIONS = [
  'Sign in to Seller Central → Help → Get Support',
  'Choose "Selling on Amazon" → "Fulfillment by Amazon"',
  'On the issue list, click "Inventory lost in FBA warehouse" (NOT "Submit a reimbursement claim dispute" — that\'s for re-evaluating already-processed claims)',
  'Paste the claim message below into the case description',
  'Submit. Amazon usually responds within 1-3 business days.',
  'When Amazon credits you, return here and click "Received" on this row.',
];

/**
 * Templates for Amazon SAFE-T claim disputes. Same structure as
 * walmart-disputes/templates.ts. Each template targets a specific
 * customer return reason and frames the dispute around customer
 * fault rather than seller/Amazon fault.
 */

export interface DisputeTemplate {
  title: string;
  reasons: string[];
  body: string;
  evidenceChecklist: string[];
  confidence: 'high' | 'medium' | 'low';
}

const TEMPLATES: DisputeTemplate[] = [
  {
    title: 'Never arrived — carrier confirmed delivery',
    reasons: ['NEVER_ARRIVED'],
    body:
`Hi Amazon team,

I'm filing a SAFE-T claim for order {orderId} (refunded {refundDate}, item: {productName}, ASIN: {asin}, refund amount: {refundAmount}).

The customer claimed the item never arrived. The carrier's tracking confirms successful delivery to the customer's address. Carrier-confirmed delivery means the package physically arrived at the address — any subsequent loss is not seller responsibility (porch piracy, customer claim error, household member taking the package, etc.).

I'm requesting reimbursement of {refundAmount}.

Thank you,`,
    evidenceChecklist: [
      'Carrier proof of delivery (POD) — screenshot from carrier site',
      'Tracking history showing the delivery scan',
      'GPS coordinates or scan location if available',
      'Any customer messages referencing the delivery',
    ],
    confidence: 'high',
  },
  {
    title: 'Customer ordered the wrong item',
    reasons: ['ORDERED_WRONG_ITEM'],
    body:
`Hi Amazon team,

I'm filing a SAFE-T claim for order {orderId} (refunded {refundDate}, item: {productName}, ASIN: {asin}, refund amount: {refundAmount}).

The customer admitted they ordered the wrong item. The unit shipped matches the listing exactly — there was no error on the seller side. Customer remorse from selecting the wrong product is not a covered return reason for seller refund.

I'm requesting reimbursement of {refundAmount}.

Thank you,`,
    evidenceChecklist: [
      'Listing screenshot showing the exact product ordered',
      'Order detail confirming the customer ordered the listed item',
      'Customer message admitting the mistake (if available)',
    ],
    confidence: 'high',
  },
  {
    title: 'Missing parts — item shipped sealed',
    reasons: ['MISSING_PARTS'],
    body:
`Hi Amazon team,

I'm filing a SAFE-T claim for order {orderId} (refunded {refundDate}, item: {productName}, ASIN: {asin}, refund amount: {refundAmount}).

The customer claims parts were missing. This unit shipped in its original sealed manufacturer packaging. Missing parts on arrival would indicate either customer-side claim error or post-purchase tampering — neither of which are seller responsibility.

I'm requesting reimbursement of {refundAmount}.

Thank you,`,
    evidenceChecklist: [
      'Manufacturer packaging photos (sealed condition)',
      'Inbound shipment record showing unit was sent unopened',
      'Listing description specifying what is included',
    ],
    confidence: 'high',
  },
  {
    title: 'Listing matches description',
    reasons: ['NOT_AS_DESCRIBED'],
    body:
`Hi Amazon team,

I'm filing a SAFE-T claim for order {orderId} (refunded {refundDate}, item: {productName}, ASIN: {asin}, refund amount: {refundAmount}).

The customer claims the item was not as described. The listing accurately reflects the manufacturer's product details, photos, and specifications. The unit shipped exactly matches the listed product.

I'm requesting reimbursement of {refundAmount}.

Thank you,`,
    evidenceChecklist: [
      'Listing screenshot (full product details, photos, spec table)',
      'Manufacturer page link',
      'Customer message describing the alleged discrepancy',
    ],
    confidence: 'medium',
  },
  {
    title: 'Defective claim — passed inspection',
    reasons: ['DEFECTIVE'],
    body:
`Hi Amazon team,

I'm filing a SAFE-T claim for order {orderId} (refunded {refundDate}, item: {productName}, ASIN: {asin}, refund amount: {refundAmount}).

The customer claimed the item was defective. The unit passed our inbound quality inspection in fully working condition. If the item became non-functional in the customer's possession, that suggests customer misuse rather than a manufacturing defect.

I'm requesting reimbursement of {refundAmount}.

Thank you,`,
    evidenceChecklist: [
      'Inbound QC log or supplier shipment confirmation',
      'Manufacturer warranty terms (if applicable)',
      'Return inspection notes (if FBA returned an inspection report)',
    ],
    confidence: 'low',
  },
  {
    title: 'Compatibility — customer error',
    reasons: ['NOT_COMPATIBLE'],
    body:
`Hi Amazon team,

I'm filing a SAFE-T claim for order {orderId} (refunded {refundDate}, item: {productName}, ASIN: {asin}, refund amount: {refundAmount}).

The customer returned the item claiming compatibility issues. The product listing clearly specifies its intended use, dimensions, and compatible products/devices. Compatibility errors stemming from customer mismatching the product to their needs are not a seller-fault return.

I'm requesting reimbursement of {refundAmount}.

Thank you,`,
    evidenceChecklist: [
      'Listing screenshot showing compatibility specifications',
      'Manufacturer compatibility chart',
      'Customer message describing the device they tried to use it with',
    ],
    confidence: 'medium',
  },
  {
    title: 'Quality acceptable — listing accurate',
    reasons: ['QUALITY_UNACCEPTABLE'],
    body:
`Hi Amazon team,

I'm filing a SAFE-T claim for order {orderId} (refunded {refundDate}, item: {productName}, ASIN: {asin}, refund amount: {refundAmount}).

The customer found the quality unacceptable. This is a subjective judgment — the unit shipped is identical to what's described and pictured in the listing. Customer dissatisfaction with manufacturer quality (when listing accurately represents the product) is not a seller-fault return.

I'm requesting reimbursement of {refundAmount}.

Thank you,`,
    evidenceChecklist: [
      'Listing screenshot showing all photos and quality descriptors',
      'Manufacturer specifications',
    ],
    confidence: 'low',
  },
  {
    title: 'Undeliverable — carrier issue',
    reasons: ['UNDELIVERABLE_UNKNOWN'],
    body:
`Hi Amazon team,

I'm filing a SAFE-T claim for order {orderId} (refunded {refundDate}, item: {productName}, ASIN: {asin}, refund amount: {refundAmount}).

This package was returned to sender as undeliverable. The address provided was used as-given by the customer; any inability to deliver was a carrier or customer-address issue, not a seller fault.

I'm requesting reimbursement of {refundAmount}.

Thank you,`,
    evidenceChecklist: [
      'Carrier tracking history showing the undeliverable status',
      'Order detail confirming the address used',
    ],
    confidence: 'medium',
  },
];

const FALLBACK: DisputeTemplate = {
  title: 'General SAFE-T claim',
  reasons: [],
  body:
`Hi Amazon team,

I'm filing a SAFE-T claim for order {orderId} (refunded {refundDate}, item: {productName}, ASIN: {asin}, refund amount: {refundAmount}).

The return reason "{reason}" does not match a covered seller-fault return category. Please review and reimburse {refundAmount}.

Thank you,`,
  evidenceChecklist: [
    'Order detail showing the listing accurately matched the product',
    'Customer messages or return reason if available',
  ],
  confidence: 'low',
};

export function getTemplateForReason(reason: string): DisputeTemplate {
  return TEMPLATES.find((t) => t.reasons.includes(reason)) || FALLBACK;
}

export type RecoveryPath = 'safet' | 'fba_reimbursement_case';

export function renderTemplate(
  template: DisputeTemplate,
  vars: { orderId: string; refundDate: string; refundAmount: string; productName: string; asin: string; sku: string; reason: string },
  path: RecoveryPath = 'safet'
): string {
  let out = template.body;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{${k}}`, v);
  }

  // Rewrite SAFE-T-specific phrasing when this is an FBA reimbursement
  // claim case. The body of every template was originally written for
  // SAFE-T; for FBA we re-frame as a reimbursement claim dispute since
  // FBA orders aren't SAFE-T eligible.
  if (path === 'fba_reimbursement_case') {
    out = out
      .replaceAll(/SAFE-T claim/gi, 'reimbursement claim')
      .replaceAll(/SAFE-T/gi, 'reimbursement claim');
  }

  return out;
}

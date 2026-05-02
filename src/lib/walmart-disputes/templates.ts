/**
 * Dispute templates per Walmart return reason. Each template is the
 * starting text the user pastes into Walmart's Returns Reimbursement
 * dispute form. Templates are factual and reference real WFS terms —
 * the user is expected to edit before submitting and add any
 * order-specific evidence (photos, tracking, customer messages).
 *
 * Placeholders {orderId}, {refundDate}, {refundAmount}, {productName},
 * {asin}, {sku} get substituted at render time.
 */

export interface DisputeTemplate {
  /** Short label shown in the modal header */
  title: string;
  /** Reasons this template applies to */
  reasons: string[];
  /** The dispute body. Use {placeholders} for substitution. */
  body: string;
  /** Bullet points the user should attach as evidence */
  evidenceChecklist: string[];
  /** Confidence level. Affects which color the chip is. */
  confidence: 'high' | 'medium' | 'low';
}

const TEMPLATES: DisputeTemplate[] = [
  {
    title: 'Damaged on arrival (WFS responsibility)',
    reasons: ['DAMAGED'],
    body:
`Hi Walmart Reimbursements team,

I'm disputing the refund issued for order {orderId} on {refundDate} ({refundAmount}, item: {productName}).

The customer reported the item arrived damaged. This item was fulfilled through WFS, which means Walmart was responsible for storage, handling, and shipping. Per WFS terms, damage that occurs in the warehouse or in transit through a Walmart-contracted carrier is Walmart's responsibility, not the seller's.

The item was received into WFS in sellable condition (verified by inbound inspection). I'm requesting full reimbursement of {refundAmount}.

Thank you,`,
    evidenceChecklist: [
      'Inbound shipment ID showing item entered WFS in sellable condition',
      'Photos of original packaging/condition before shipment to WFS (if available)',
      'Carrier tracking showing the package was handled by Walmart logistics',
    ],
    confidence: 'high',
  },
  {
    title: 'Wrong item received (WFS pick error)',
    reasons: ['INCORRECT_ITEM'],
    body:
`Hi Walmart Reimbursements team,

I'm disputing the refund issued for order {orderId} on {refundDate} ({refundAmount}, item: {productName}, ASIN/Item: {asin}).

The customer claims they received an incorrect item. This order was fulfilled through WFS, which means Walmart picked, packed, and shipped the unit from their warehouse. If the customer received the wrong item, the error occurred at the WFS pick/pack stage — not on the seller side.

I'm requesting reimbursement of {refundAmount} for this WFS fulfillment error.

Thank you,`,
    evidenceChecklist: [
      'Listing screenshot showing correct item details (title, image, brand)',
      'WFS inbound receipt confirming the correct SKU was sent into the warehouse',
      'Customer message screenshots if they describe what they received',
    ],
    confidence: 'high',
  },
  {
    title: 'Lost after delivery (carrier/customer responsibility)',
    reasons: ['LOST_AFTER_DELIVERY'],
    body:
`Hi Walmart Reimbursements team,

I'm disputing the refund issued for order {orderId} on {refundDate} ({refundAmount}, item: {productName}).

The customer claims the package was lost after the carrier confirmed delivery. Carrier-confirmed delivery means the package arrived at the customer's address — any loss after that point is either a carrier reporting issue, theft, or a misplaced delivery, none of which are seller responsibility.

This was a WFS-fulfilled order, so Walmart's contracted carrier handled delivery. I'm requesting reimbursement of {refundAmount}.

Thank you,`,
    evidenceChecklist: [
      'Carrier delivery confirmation (proof of delivery / POD)',
      'Tracking history showing successful delivery',
      'GPS / scan data if available',
    ],
    confidence: 'high',
  },
  {
    title: 'Lost in transit (carrier responsibility)',
    reasons: ['LOST_IN_TRANSIT'],
    body:
`Hi Walmart Reimbursements team,

I'm disputing the refund issued for order {orderId} on {refundDate} ({refundAmount}, item: {productName}).

This package was lost in transit by Walmart's contracted carrier. As a WFS-fulfilled order, Walmart handled both warehousing and shipping logistics. A loss that occurs between the warehouse leaving and customer delivery is the carrier's (and Walmart's) responsibility, not the seller's.

I'm requesting full reimbursement of {refundAmount}.

Thank you,`,
    evidenceChecklist: [
      'Tracking history showing the package was scanned out of WFS',
      'Last known carrier scan location',
      'Carrier loss confirmation if available',
    ],
    confidence: 'high',
  },
  {
    title: 'Late arrival (WFS shipping responsibility)',
    reasons: ['ARRIVED_LATE'],
    body:
`Hi Walmart Reimbursements team,

I'm disputing the refund issued for order {orderId} on {refundDate} ({refundAmount}, item: {productName}).

The customer received the item after Walmart's promised delivery date. As a WFS-fulfilled order, Walmart controlled the entire shipping pipeline — pick time, pack time, carrier selection, and transit. A late arrival is a WFS service failure, not a seller failure.

I'm requesting reimbursement of {refundAmount}.

Thank you,`,
    evidenceChecklist: [
      'Order timeline showing promised delivery date vs. actual delivery date',
      'Tracking data showing where delays occurred (warehouse vs carrier)',
    ],
    confidence: 'medium',
  },
  {
    title: 'Defective claim — item passed inbound inspection',
    reasons: ['DEFECTIVE'],
    body:
`Hi Walmart Reimbursements team,

I'm disputing the refund issued for order {orderId} on {refundDate} ({refundAmount}, item: {productName}).

The customer claims the item is defective. This unit passed Walmart's inbound inspection when received into WFS. If the unit became non-functional between WFS storage and customer delivery, that's a handling issue covered by WFS terms. If the customer caused the damage through misuse, the defect claim is invalid.

I'm requesting reimbursement of {refundAmount}.

Thank you,`,
    evidenceChecklist: [
      'WFS inbound receipt confirming sellable condition',
      'Customer return inspection report (if available)',
      'Manufacturer warranty terms if relevant',
    ],
    confidence: 'low',
  },
  {
    title: 'Listing matches description',
    reasons: ['NOT_AS_DESCRIBED_PICTURED'],
    body:
`Hi Walmart Reimbursements team,

I'm disputing the refund issued for order {orderId} on {refundDate} ({refundAmount}, item: {productName}).

The customer claims the item was not as described. The listing accurately reflects the manufacturer's product details, photos, and specifications. The unit shipped was the exact item listed.

I'm requesting reimbursement of {refundAmount}.

Thank you,`,
    evidenceChecklist: [
      'Listing screenshot showing description, photos, and specs',
      'Manufacturer page link',
      'Customer message detailing the discrepancy',
    ],
    confidence: 'medium',
  },
  {
    title: 'Missing parts — item sealed at WFS',
    reasons: ['MISSING_PARTS'],
    body:
`Hi Walmart Reimbursements team,

I'm disputing the refund issued for order {orderId} on {refundDate} ({refundAmount}, item: {productName}).

The customer claims parts were missing from the package. This unit was shipped from WFS in its original sealed manufacturer packaging. If parts were missing on arrival, that indicates either WFS handling damage (opened/repacked) or a customer-side claim error — neither of which are seller responsibility.

I'm requesting reimbursement of {refundAmount}.

Thank you,`,
    evidenceChecklist: [
      'Manufacturer packaging photos (showing original seal)',
      'Inbound shipment confirmation that unit was sent unopened',
    ],
    confidence: 'medium',
  },
];

const FALLBACK: DisputeTemplate = {
  title: 'General WFS dispute',
  reasons: [],
  body:
`Hi Walmart Reimbursements team,

I'm disputing the refund issued for order {orderId} on {refundDate} ({refundAmount}, item: {productName}).

This was a WFS-fulfilled order. The return reason ({reason}) does not match a customer fault category that should result in a seller refund. I'm requesting that this refund be reversed and reimbursement issued.

Thank you,`,
  evidenceChecklist: [
    'Any WFS records showing the item was fulfilled by Walmart',
    'Customer messages or order history if relevant',
  ],
  confidence: 'low',
};

export function getTemplateForReason(reason: string): DisputeTemplate {
  return TEMPLATES.find((t) => t.reasons.includes(reason)) || FALLBACK;
}

export function renderTemplate(
  template: DisputeTemplate,
  vars: { orderId: string; refundDate: string; refundAmount: string; productName: string; asin: string; sku: string; reason: string }
): string {
  let out = template.body;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{${k}}`, v);
  }
  return out;
}

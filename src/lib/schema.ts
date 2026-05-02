import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

// ─── Settings ───────────────────────────────────────────────────────────────
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
});

// ─── Sync Log ───────────────────────────────────────────────────────────────
export const syncLog = sqliteTable('sync_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  syncType: text('sync_type').notNull(), // 'financial_events', 'orders', 'inventory', etc.
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
  status: text('status').notNull().default('running'), // 'running', 'success', 'error'
  error: text('error'),
  recordsFetched: integer('records_fetched').default(0),
});

// ─── Products ───────────────────────────────────────────────────────────────
export const products = sqliteTable('products', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  asin: text('asin').notNull(),
  sku: text('sku'),
  name: text('name'),
  category: text('category'),
  imageUrl: text('image_url'),
  marketplace: text('marketplace').default('amazon'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ─── Suppliers ──────────────────────────────────────────────────────────────
export const suppliers = sqliteTable('suppliers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  createdAt: text('created_at').notNull(),
});

// ─── Orders ─────────────────────────────────────────────────────────────────
export const orders = sqliteTable('orders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  orderId: text('order_id').notNull().unique(),
  purchaseDate: text('purchase_date').notNull(),
  status: text('status').notNull(), // 'Shipped', 'Pending', 'Cancelled', etc.
  marketplace: text('marketplace').default('amazon'),
  fulfillmentChannel: text('fulfillment_channel').notNull(), // 'FBA' or 'MFN'
  isEstimated: integer('is_estimated', { mode: 'boolean' }).default(true),
  createdAt: text('created_at').notNull(),
});

// ─── Order Items ────────────────────────────────────────────────────────────
// Monetary values stored as INTEGER CENTS
export const orderItems = sqliteTable('order_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  orderId: text('order_id').notNull(),
  asin: text('asin').notNull(),
  sku: text('sku'),
  quantity: integer('quantity').notNull().default(1),
  pricePerUnit: integer('price_per_unit').notNull(), // cents
  totalPrice: integer('total_price').notNull(), // cents
  shippingCharged: integer('shipping_charged').default(0), // cents — MFN shipping charged to customer
  shippingCost: integer('shipping_cost').default(0), // cents — actual shipping label cost
});

// ─── Financial Events ───────────────────────────────────────────────────────
export const financialEvents = sqliteTable('financial_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  eventType: text('event_type').notNull(), // 'ShipmentEvent', 'RefundEvent', 'ServiceFeeEvent', etc.
  postedDate: text('posted_date').notNull(),
  orderId: text('order_id'),
  asin: text('asin'),
  sku: text('sku'),
  marketplace: text('marketplace').default('amazon'),
  totalAmount: integer('total_amount').notNull(), // cents — net of this event
  rawData: text('raw_data'), // full API response for re-parsing
  createdAt: text('created_at').notNull(),
});

// ─── Fee Details ────────────────────────────────────────────────────────────
// Every fee Amazon charges, broken out individually. NOT a single total_fees column.
export const feeDetails = sqliteTable('fee_details', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  financialEventId: integer('financial_event_id').notNull(),
  orderId: text('order_id'),
  asin: text('asin'),
  feeType: text('fee_type').notNull(), // raw Amazon string: 'FBAPerUnitFulfillmentFee', 'Commission', etc.
  feeCategory: text('fee_category'), // grouped: 'Selling Fees', 'FBA Transaction Fees', etc.
  amount: integer('amount').notNull(), // cents — negative = charge, positive = credit
  postedDate: text('posted_date').notNull(),
});

// ─── Inventory Ledger (COGS tracking with FIFO) ────────────────────────────
export const inventoryLedger = sqliteTable('inventory_ledger', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  asin: text('asin').notNull(),
  sku: text('sku'),
  buyPrice: integer('buy_price').notNull(), // cents per unit
  quantity: integer('quantity').notNull(), // original quantity purchased
  quantityRemaining: integer('quantity_remaining').notNull(), // remaining for FIFO
  supplierId: integer('supplier_id'),
  datePurchased: text('date_purchased').notNull(),
  notes: text('notes'),
  createdAt: text('created_at').notNull(),
});

// ─── Refunds ────────────────────────────────────────────────────────────────
export const refunds = sqliteTable('refunds', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  orderId: text('order_id').notNull(),
  refundDate: text('refund_date').notNull(),
  asin: text('asin'),
  sku: text('sku'),
  quantity: integer('quantity').default(1),
  refundAmount: integer('refund_amount').notNull(), // cents — amount refunded to customer
  reason: text('reason'),
  itemReturned: integer('item_returned', { mode: 'boolean' }).default(false),
  feeClawback: integer('fee_clawback').default(0), // cents — fees Amazon returns to seller
  marketplace: text('marketplace').default('amazon'),
  createdAt: text('created_at').notNull(),
});

// ─── Reimbursements ─────────────────────────────────────────────────────────
export const reimbursements = sqliteTable('reimbursements', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  reimbursementId: text('reimbursement_id'),
  reimbursementDate: text('reimbursement_date').notNull(),
  asin: text('asin'),
  sku: text('sku'),
  reason: text('reason'),
  amount: integer('amount').notNull(), // cents — money back to seller
  quantity: integer('quantity').default(1),
  status: text('status').default('Approved'), // 'Pending', 'Approved', 'Paid'
  marketplace: text('marketplace').default('amazon'),
  createdAt: text('created_at').notNull(),
});

// ─── Removals ───────────────────────────────────────────────────────────────
export const removals = sqliteTable('removals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  removalOrderId: text('removal_order_id').notNull(),
  asin: text('asin'),
  sku: text('sku'),
  quantity: integer('quantity').notNull(),
  removalType: text('removal_type').notNull(), // 'Return', 'Disposal'
  reason: text('reason'), // 'Unfulfillable', 'CustomerReturn', 'Voluntary', etc.
  status: text('status').default('Pending'), // 'Pending', 'Completed'
  dateRequested: text('date_requested').notNull(),
  dateCompleted: text('date_completed'),
  fee: integer('fee').default(0), // cents
  marketplace: text('marketplace').default('amazon'),
  createdAt: text('created_at').notNull(),
});

// ─── Inbound Shipments ──────────────────────────────────────────────────────
export const inboundShipments = sqliteTable('inbound_shipments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  shipmentId: text('shipment_id').notNull(),
  dateShipped: text('date_shipped').notNull(),
  carrier: text('carrier'),
  tracking: text('tracking'),
  boxes: integer('boxes').default(1),
  weight: real('weight'), // pounds
  cost: integer('cost').notNull(), // cents
  totalUnits: integer('total_units').notNull(),
  status: text('status').default('In Transit'), // 'In Transit', 'Delivered', 'Receiving', 'Closed'
  marketplace: text('marketplace').default('amazon'),
  createdAt: text('created_at').notNull(),
});

// ─── Inbound Shipment Items ─────────────────────────────────────────────────
export const inboundShipmentItems = sqliteTable('inbound_shipment_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  shipmentId: text('shipment_id').notNull(),
  asin: text('asin').notNull(),
  sku: text('sku'),
  quantity: integer('quantity').notNull(),
});

// ─── Other Expenses ─────────────────────────────────────────────────────────
export const expenses = sqliteTable('expenses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  date: text('date').notNull(),
  category: text('category').notNull(), // 'Supplies', 'Mileage', 'Subscriptions', 'Storage', 'Packaging', 'Labels', 'Equipment', 'Insurance', 'Other'
  amount: integer('amount').notNull(), // cents
  description: text('description'),
  recurring: text('recurring').default('one-time'), // 'monthly', 'one-time'
  createdAt: text('created_at').notNull(),
});

// ─── Other Income ───────────────────────────────────────────────────────────
export const otherIncome = sqliteTable('other_income', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  date: text('date').notNull(),
  incomeType: text('income_type').notNull(), // 'Liquidation', 'ShippingCredit', 'PromotionalCredit', etc.
  amount: integer('amount').notNull(), // cents
  description: text('description'),
  marketplace: text('marketplace').default('amazon'),
  createdAt: text('created_at').notNull(),
});

// ─── Sales Tax ──────────────────────────────────────────────────────────────
export const salesTax = sqliteTable('sales_tax', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  orderId: text('order_id'),
  state: text('state').notNull(),
  taxCollected: integer('tax_collected').notNull(), // cents
  marketplaceFacilitatorTax: integer('marketplace_facilitator_tax').default(0), // cents
  postedDate: text('posted_date').notNull(),
  marketplace: text('marketplace').default('amazon'),
});

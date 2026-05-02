export interface WalmartCredentials {
  clientId: string;
  clientSecret: string;
}

export interface WalmartTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number; // 900 seconds (15 min)
}

export interface WalmartOrder {
  purchaseOrderId: string;
  customerOrderId: string;
  customerEmailId?: string;
  orderDate: string;
  shippingInfo: {
    phone: string;
    estimatedDeliveryDate: string;
    estimatedShipDate: string;
    methodCode: string;
    postalAddress: {
      name: string;
      address1: string;
      address2?: string;
      city: string;
      state: string;
      postalCode: string;
      country: string;
    };
  };
  orderLines: {
    orderLine: WalmartOrderLine[];
  };
}

export interface WalmartOrderLine {
  lineNumber: string;
  item: {
    productName: string;
    sku: string;
    upc?: string;
  };
  charges: {
    charge: WalmartCharge[];
  };
  quantity: {
    unitOfMeasurement: string;
    amount: string;
  };
  orderLineQuantity: {
    unitOfMeasurement: string;
    amount: string;
  };
  statusDate: string;
  orderLineStatuses?: {
    orderLineStatus: {
      status: string;
      statusQuantity: {
        unitOfMeasurement: string;
        amount: string;
      };
    }[];
  };
  fulfillment?: {
    fulfillmentOption: string;
    shipMethod: string;
  };
}

export interface WalmartCharge {
  chargeType: 'PRODUCT' | 'SHIPPING';
  chargeName: string;
  chargeAmount: {
    currency: string;
    amount: number;
  };
  tax?: {
    taxName: string;
    taxAmount: {
      currency: string;
      amount: number;
    };
  };
}

export interface WalmartReturn {
  returnOrderId: string;
  customerEmailId?: string;
  customerName?: {
    firstName: string;
    lastName: string;
  };
  returnOrderDate: string;
  returnOrderLines: WalmartReturnLine[];
}

export interface WalmartReturnLine {
  returnOrderLineNumber: number;
  salesOrderLineNumber: number;
  item: {
    productName: string;
    sku: string;
    upc?: string;
  };
  charges: {
    charge: WalmartCharge[];
  };
  quantity: {
    unitOfMeasurement: string;
    amount: string;
  };
  returnReason: string;
  purchaseOrderId: string;
  purchaseOrderLineNumber: number;
}

export interface WalmartReconEntry {
  transactionKey: string;
  partnerOrderId: string;
  customerOrderId?: string;
  purchaseOrderId?: string;
  partnerItemId: string; // SKU
  itemName: string;
  gtin?: string;
  transactionType: string;
  transactionPostedTimestamp: string;
  amount: number;
  amountType: string; // 'ItemPrice', 'Commission', 'WFS Fulfillment Fee', etc.
  commissionRate?: number;
  contractCategory?: string;
  fulfillmentType?: string;
  shipToState?: string;
  periodStartDate?: string;
  periodEndDate?: string;
}

export interface SyncResult {
  syncType: string;
  recordsFetched: number;
  errors: string[];
  duration: number;
}

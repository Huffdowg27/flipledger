/**
 * eBay Marketplace API types.
 */

export interface EbayCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface EbayTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

// Fulfillment API types
export interface EbayOrder {
  orderId: string;
  legacyOrderId?: string;
  creationDate: string;
  orderFulfillmentStatus: string;
  orderPaymentStatus: string;
  lineItems: EbayLineItem[];
  pricingSummary: {
    total: { value: string; currency: string };
    deliveryCost?: { value: string; currency: string };
    tax?: { value: string; currency: string };
  };
  fulfillmentStartInstructions?: {
    shippingStep?: {
      shipTo?: {
        contactAddress?: {
          stateOrProvince?: string;
          countryCode?: string;
        };
      };
    };
  }[];
  buyer?: { username?: string };
  cancelStatus?: { cancelState?: string };
}

export interface EbayLineItem {
  lineItemId: string;
  legacyItemId: string;
  sku: string;
  title: string;
  quantity: number;
  lineItemCost: { value: string; currency: string };
  deliveryCost?: {
    shippingCost?: { value: string; currency: string };
  };
  taxes?: { amount: { value: string; currency: string }; taxType: string }[];
  lineItemFulfillmentStatus: string;
}

// Finances API types
export interface EbayTransaction {
  transactionId: string;
  transactionType: string; // SALE, REFUND, CREDIT, NON_SALE_CHARGE, SHIPPING_LABEL, TRANSFER, etc.
  transactionDate: string;
  transactionStatus: string;
  amount: { value: string; currency: string };
  orderId?: string;
  buyer?: { username?: string };
  orderLineItems?: {
    lineItemId: string;
    feeBasisAmount?: { value: string; currency: string };
    marketplaceFees?: EbayFeeDetail[];
  }[];
  totalFeeBasisAmount?: { value: string; currency: string };
  totalMarketplaceFee?: { value: string; currency: string };
  references?: { referenceId: string; referenceType: string }[];
}

export interface EbayFeeDetail {
  feeType: string; // FINAL_VALUE_FEE, AD_FEE, INTERNATIONAL_FEE, etc.
  amount: { value: string; currency: string };
}

export interface SyncResult {
  syncType: string;
  recordsFetched: number;
  errors: string[];
  duration: number;
}

export interface EbaySyncStatus {
  running: boolean;
  results: SyncResult[];
  totalErrors: string[];
  startedAt: string;
  completedAt?: string;
}

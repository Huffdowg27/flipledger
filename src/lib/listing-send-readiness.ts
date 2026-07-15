export interface ListingSendReadinessItem {
  sku: string;
  listingMode?: string | null;
  listingStatus?: string | null;
  fnsku?: string | null;
}

export function getUnpreparedFbaSkus(items: ListingSendReadinessItem[]): string[] {
  return items
    .filter((item) => {
      const isReplenishment = item.listingMode === 'REPLENISH_EXISTING';
      const hasFnsku = !!item.fnsku;
      return !isReplenishment && !hasFnsku;
    })
    .map((item) => item.sku);
}

export function isFbaSendReady(items: ListingSendReadinessItem[]): boolean {
  return getUnpreparedFbaSkus(items).length === 0;
}

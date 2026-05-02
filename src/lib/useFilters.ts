'use client';

import { useState, useCallback } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { type DateRange, createDateRange } from '@/components/ui/DateRangePicker';

/**
 * Shared hook for marketplace + date range filters.
 * Persists to URL search params so filters survive refresh.
 */
export function useFilters(defaultPreset: string = '30d') {
  const router = useRouter();
  const pathname = usePathname();

  // Read initial values from URL on mount (client-side only)
  const getInitialParams = () => {
    if (typeof window === 'undefined') return { preset: defaultPreset, startDate: '', endDate: '', marketplace: 'all', dateBasis: 'posted' };
    const params = new URLSearchParams(window.location.search);
    return {
      preset: params.get('preset') || defaultPreset,
      startDate: params.get('startDate') || '',
      endDate: params.get('endDate') || '',
      marketplace: params.get('marketplace') || 'all',
      dateBasis: params.get('dateBasis') || 'posted',
    };
  };

  const initial = getInitialParams();
  const initialPreset = initial.preset;
  const initialStartDate = initial.startDate || '';
  const initialEndDate = initial.endDate || '';
  const initialMarketplace = initial.marketplace;
  const initialDateBasis = initial.dateBasis;

  const [marketplace, setMarketplaceState] = useState(initialMarketplace);
  const [dateBasis, setDateBasisState] = useState(initialDateBasis);
  const [dateRange, setDateRangeState] = useState<DateRange>(() => {
    if (initialStartDate && initialEndDate) {
      return { preset: initialPreset, startDate: initialStartDate, endDate: initialEndDate };
    }
    return createDateRange(initialPreset);
  });

  // Update URL when filters change
  const updateUrl = useCallback((newDateRange: DateRange, newMarketplace: string, newDateBasis: string) => {
    const params = new URLSearchParams();
    params.set('preset', newDateRange.preset);
    params.set('startDate', newDateRange.startDate);
    params.set('endDate', newDateRange.endDate);
    if (newMarketplace !== 'all') {
      params.set('marketplace', newMarketplace);
    }
    if (newDateBasis !== 'posted') {
      params.set('dateBasis', newDateBasis);
    }
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [router, pathname]);

  const setDateRange = useCallback((range: DateRange) => {
    setDateRangeState(range);
    updateUrl(range, marketplace, dateBasis);
  }, [marketplace, dateBasis, updateUrl]);

  const setMarketplace = useCallback((mkt: string) => {
    setMarketplaceState(mkt);
    updateUrl(dateRange, mkt, dateBasis);
  }, [dateRange, dateBasis, updateUrl]);

  const setDateBasis = useCallback((basis: string) => {
    setDateBasisState(basis);
    updateUrl(dateRange, marketplace, basis);
  }, [dateRange, marketplace, updateUrl]);

  // Build query params for fetch URLs
  const marketplaceParam = marketplace !== 'all' ? `&marketplace=${marketplace}` : '';
  const dateBasisParam = dateBasis !== 'posted' ? `&dateBasis=${dateBasis}` : '';

  return {
    dateRange,
    setDateRange,
    marketplace,
    setMarketplace,
    marketplaceParam,
    dateBasis,
    setDateBasis,
    dateBasisParam,
  };
}

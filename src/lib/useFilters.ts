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

  type InitialFilters = {
    preset: string;
    startDate: string;
    endDate: string;
    marketplace: string;
    dateBasis: string;
    channel: 'fba' | 'mfn' | null;
    localDays: boolean;
    salesMetric: 'orderTotal' | null;
  };

  // Read initial values from URL on mount (client-side only)
  const getInitialParams = (): InitialFilters => {
    if (typeof window === 'undefined') {
      return {
        preset: defaultPreset,
        startDate: '',
        endDate: '',
        marketplace: 'all',
        dateBasis: 'posted',
        channel: null as 'fba' | 'mfn' | null,
        localDays: false,
        salesMetric: null as 'orderTotal' | null,
      };
    }
    const params = new URLSearchParams(window.location.search);
    const rawChannel = params.get('channel');
    return {
      preset: params.get('preset') || defaultPreset,
      startDate: params.get('startDate') || '',
      endDate: params.get('endDate') || '',
      marketplace: params.get('marketplace') || 'all',
      dateBasis: params.get('dateBasis') || 'posted',
      channel: rawChannel === 'fba' || rawChannel === 'mfn' ? rawChannel : null,
      localDays: params.get('localDays') === '1',
      salesMetric: params.get('salesMetric') === 'orderTotal' ? 'orderTotal' as const : null,
    };
  };

  const initial = getInitialParams();
  const initialPreset = initial.preset;
  const initialStartDate = initial.startDate || '';
  const initialEndDate = initial.endDate || '';
  const initialMarketplace = initial.marketplace;
  const initialDateBasis = initial.dateBasis;
  const channel = initial.channel;
  const localDays = initial.localDays;
  const salesMetric = initial.salesMetric;

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
    if (channel) params.set('channel', channel);
    if (localDays) params.set('localDays', '1');
    if (salesMetric) params.set('salesMetric', salesMetric);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [router, pathname, channel, localDays, salesMetric]);

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
  const channelParam = channel ? `&channel=${channel}` : '';
  const localDaysParam = localDays ? '&localDays=1' : '';

  return {
    dateRange,
    setDateRange,
    marketplace,
    setMarketplace,
    marketplaceParam,
    dateBasis,
    setDateBasis,
    dateBasisParam,
    channel,
    channelParam,
    localDays,
    localDaysParam,
    salesMetric,
  };
}

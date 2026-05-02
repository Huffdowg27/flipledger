'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { type ColumnDef } from '@tanstack/react-table';
import StatCard from '@/components/ui/StatCard';
import PageHeader from '@/components/ui/PageHeader';
import { type DateRange } from '@/components/ui/DateRangePicker';
import { useFilters } from '@/lib/useFilters';
import DataTable from '@/components/tables/DataTable';
import { formatCurrency, formatDate, formatNumber } from '@/lib/formatters';

interface ShipmentRow {
  shipmentId: string;
  dateShipped: string;
  carrier: string;
  tracking: string;
  boxes: number;
  weight: number;
  cost: number;
  totalUnits: number;
  status: string;
}

export default function InboundShippingPage() {
  const [rows, setRows] = useState<ShipmentRow[]>([]);
  const [totals, setTotals] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const { dateRange, setDateRange, marketplace, setMarketplace, marketplaceParam } = useFilters();

  const fetchData = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/data/inbound-shipping?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}${marketplaceParam}`);
    const data = await res.json();
    setRows(data.items || data.rows || []);
    setTotals(data.totals || null);
    setLoading(false);
  }, [dateRange, marketplace]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const columns = useMemo<ColumnDef<ShipmentRow, any>[]>(() => [
    { id: 'dateShipped', header: 'Date', accessorKey: 'dateShipped', cell: ({ getValue }) => <span className="font-mono text-sm text-text-secondary">{formatDate(getValue() as string)}</span>, size: 110 },
    { id: 'shipmentId', header: 'Shipment ID', accessorKey: 'shipmentId', cell: ({ getValue }) => <span className="font-mono text-sm text-accent">{getValue() as string}</span>, size: 150 },
    { id: 'carrier', header: 'Carrier', accessorKey: 'carrier', cell: ({ getValue }) => <span className="text-sm text-text-primary">{getValue() as string}</span>, size: 160 },
    { id: 'tracking', header: 'Tracking', accessorKey: 'tracking', cell: ({ getValue }) => <span className="font-mono text-xs text-text-tertiary">{getValue() as string}</span>, size: 150 },
    { id: 'totalUnits', header: 'Units', accessorKey: 'totalUnits', cell: ({ getValue }) => <span className="font-mono">{formatNumber(getValue() as number)}</span>, size: 70 },
    {
      id: 'status', header: 'Status', accessorKey: 'status',
      cell: ({ getValue }) => {
        const v = getValue() as string;
        const styles = v === 'Closed' ? 'bg-positive-muted text-positive' : v === 'Delivered' || v === 'Receiving' ? 'bg-accent-muted text-accent' : 'bg-warning-muted text-warning';
        return <span className={`text-xs font-medium px-2 py-0.5 rounded ${styles}`}>{v}</span>;
      }, size: 100,
    },
  ], []);

  if (loading) return <div className="space-y-4"><div className="skeleton h-6 w-40" /><div className="skeleton h-[400px] w-full" /></div>;

  return (
    <div>
      <PageHeader title="Inbound Shipping" subtitle="Bookkeeping > Inbound Shipping" dateRange={dateRange} onDateRangeChange={setDateRange}
        marketplace={marketplace}
        onMarketplaceChange={setMarketplace} />
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        <StatCard label="Total Shipments" value={totals?.totalShipments || 0} format="number" />
        <StatCard label="Total Units" value={totals?.totalUnits || 0} format="number" />
      </div>
      <DataTable data={rows} columns={columns} searchPlaceholder="Search by shipment ID or carrier..." />
    </div>
  );
}

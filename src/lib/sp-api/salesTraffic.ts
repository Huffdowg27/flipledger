/**
 * Amazon Sales & Traffic report.
 *
 * This is the Seller Central-style source for "today so far" ordered sales.
 * Orders/order-items can hide totals while payment is pending; this report gives
 * the operational sales pulse and we keep order-items for itemized economics.
 */

import Database from 'better-sqlite3';
import path from 'path';
import { downloadReport } from './reports';
import { getAccessToken, getEndpoint } from './auth';
import type { SPAPICredentials } from './types';

interface SalesTrafficSnapshot {
  day: string;
  orderedProductSales: number;
  unitsOrdered: number;
  orderItems: number;
  reportId: string;
  syncedAt?: string;
  cached?: boolean;
  stale?: boolean;
}

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

function pacificDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value || '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    dateString: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

function pacificDayUtcBounds(dayString?: string) {
  const parts = dayString
    ? (() => {
        const [year, month, day] = dayString.split('-').map(Number);
        return { year, month, day, dateString: dayString };
      })()
    : pacificDateParts();

  // Current account is US/Pacific. May is PDT (-07:00), but this also works
  // safely for today's operational dashboard. Historical DST precision is not
  // important for this one-day sales pulse.
  const start = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 7, 0, 0));
  const end = new Date(start.getTime() + 86400000);
  return { day: parts.dateString, startIso: start.toISOString(), endIso: end.toISOString() };
}

async function createSalesTrafficReport(
  credentials: SPAPICredentials,
  startIso: string,
  endIso: string
): Promise<string> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const accessToken = await getAccessToken(credentials);
  const response = await fetch(`${endpoint}/reports/2021-06-30/reports`, {
    method: 'POST',
    headers: {
      'x-amz-access-token': accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      reportType: 'GET_SALES_AND_TRAFFIC_REPORT',
      marketplaceIds: [credentials.marketplaceId],
      dataStartTime: startIso,
      dataEndTime: endIso,
      reportOptions: { dateGranularity: 'DAY', asinGranularity: 'SKU' },
    }),
  });

  if (!response.ok) {
    throw new Error(`SalesTraffic createReport ${response.status}: ${await response.text()}`);
  }
  const data = await response.json();
  if (!data?.reportId) throw new Error('SalesTraffic createReport: missing reportId');
  return data.reportId;
}

async function waitForReport(
  credentials: SPAPICredentials,
  reportId: string,
  maxWaitMs = 180_000
): Promise<string> {
  const endpoint = getEndpoint(credentials.marketplaceId);
  const startedAt = Date.now();

  while (Date.now() - startedAt < maxWaitMs) {
    await new Promise(r => setTimeout(r, 5000));
    const accessToken = await getAccessToken(credentials);
    const response = await fetch(`${endpoint}/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`, {
      headers: {
        'x-amz-access-token': accessToken,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`SalesTraffic getReport ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    if (data.processingStatus === 'DONE') {
      if (!data.reportDocumentId) throw new Error('SalesTraffic report DONE without document id');
      return data.reportDocumentId;
    }
    if (data.processingStatus === 'FATAL' || data.processingStatus === 'CANCELLED') {
      throw new Error(`SalesTraffic report ${data.processingStatus}: ${JSON.stringify(data)}`);
    }
  }

  throw new Error(`SalesTraffic report ${reportId} did not complete within ${maxWaitMs}ms`);
}

function parseSnapshot(content: string, fallbackDay: string, reportId: string): SalesTrafficSnapshot {
  const data = JSON.parse(content);
  const byDate = data.salesAndTrafficByDate?.[0] || {};
  const sales = byDate.salesByDate || {};
  return {
    day: byDate.date || fallbackDay,
    orderedProductSales: Math.round((sales.orderedProductSales?.amount || 0) * 100),
    unitsOrdered: Number(sales.unitsOrdered || 0),
    orderItems: Number(sales.totalOrderItems || 0),
    reportId,
  };
}

function getCachedSnapshot(db: Database.Database, day: string): SalesTrafficSnapshot | null {
  const row = db.prepare(`
    SELECT
      day,
      ordered_product_sales as orderedProductSales,
      units_ordered as unitsOrdered,
      order_items as orderItems,
      report_id as reportId,
      synced_at as syncedAt
    FROM sales_traffic_daily
    WHERE day = ? AND marketplace = 'amazon'
  `).get(day) as SalesTrafficSnapshot | undefined;

  return row || null;
}

export async function syncSalesTrafficDaily(
  credentials: SPAPICredentials,
  dayString?: string,
  options: { force?: boolean; minAgeMs?: number } = {}
): Promise<SalesTrafficSnapshot> {
  const { day, startIso, endIso } = pacificDayUtcBounds(dayString);
  const db = getDb();
  try {
    const cached = getCachedSnapshot(db, day);
    const minAgeMs = options.minAgeMs ?? 90 * 60 * 1000;
    const cachedAgeMs = cached?.syncedAt ? Date.now() - new Date(cached.syncedAt).getTime() : Infinity;
    if (!options.force && cached && cachedAgeMs >= 0 && cachedAgeMs < minAgeMs) {
      return { ...cached, cached: true };
    }

    let snapshot: SalesTrafficSnapshot;
    try {
      const reportId = await createSalesTrafficReport(credentials, startIso, endIso);
      const documentId = await waitForReport(credentials, reportId);
      const content = await downloadReport(credentials, documentId);
      snapshot = parseSnapshot(content, day, reportId);
    } catch (error) {
      // Amazon rate-limits this report type aggressively. A stale Seller Central
      // pulse is better than throwing away the last good dashboard value.
      if (cached) return { ...cached, cached: true, stale: true };
      throw error;
    }

    const syncedAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO sales_traffic_daily
        (day, marketplace, ordered_product_sales, units_ordered, order_items, report_id, synced_at)
      VALUES (?, 'amazon', ?, ?, ?, ?, ?)
      ON CONFLICT(day, marketplace) DO UPDATE SET
        ordered_product_sales = excluded.ordered_product_sales,
        units_ordered = excluded.units_ordered,
        order_items = excluded.order_items,
        report_id = excluded.report_id,
        synced_at = excluded.synced_at
    `).run(
      snapshot.day,
      snapshot.orderedProductSales,
      snapshot.unitsOrdered,
      snapshot.orderItems,
      snapshot.reportId,
      syncedAt
    );
    snapshot.syncedAt = syncedAt;
    snapshot.cached = false;
    snapshot.stale = false;
    return snapshot;
  } finally {
    db.close();
  }
}

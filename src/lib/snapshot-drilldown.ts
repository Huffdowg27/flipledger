export type SnapshotChannel = 'fba' | 'mfn' | null;

const SNAPSHOT_PRESET_BY_KEY: Record<string, string> = {
  today: 'today',
  '7d': '7d',
  mtd: 'this-month',
};

export function buildSnapshotDrilldownHref(input: {
  key: string;
  start: string;
  end: string;
  dateBasis: string;
  channel: SnapshotChannel;
}): string {
  const params = new URLSearchParams({
    preset: SNAPSHOT_PRESET_BY_KEY[input.key] || 'custom',
    startDate: input.start,
    endDate: input.end,
  });
  if (input.dateBasis !== 'posted') params.set('dateBasis', input.dateBasis);
  if (input.channel) params.set('channel', input.channel);
  params.set('localDays', '1');
  if (input.dateBasis === 'purchase') params.set('salesMetric', 'orderTotal');
  return `/analyze/profitloss?${params.toString()}`;
}

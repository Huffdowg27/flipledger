import { runSettlementDripBackfillFromProdDb } from '../lib/sp-api/settlement-drip-backfill';

async function main(): Promise<void> {
  const result = await runSettlementDripBackfillFromProdDb();
  console.log(JSON.stringify(result, null, 2));
}

void main().catch((error) => {
  console.error('[SettlementDrip] Fatal:', error);
  process.exit(1);
});

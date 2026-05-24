'use client';

import Link from 'next/link';
import MfnBatchReceiveWorkflow from '@/components/mfn/MfnBatchReceiveWorkflow';

// Scratch tray. Mounts the workflow with no batchId — items live only in
// React state and saved lots persist with batch_id = NULL. For a persisted,
// indexed batch with totals on /list, create a Merchant Fulfilled batch from
// /list instead — the same workflow renders there with batchId set.
export default function MfnBatchPage() {
  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">MFN Quick Tray</h1>
          <p className="text-sm text-text-tertiary mt-0.5">
            Session-only scratch surface · for a persisted batch, use{' '}
            <Link href="/list" className="text-accent hover:underline">Batches → New Batch → Merchant Fulfilled</Link>
          </p>
        </div>
      </div>
      <MfnBatchReceiveWorkflow />
    </div>
  );
}

'use client';

import MfnBatchReceiveWorkflow from '@/components/mfn/MfnBatchReceiveWorkflow';

// Standalone MFN receive surface. Mounts the workflow component with no
// batchId — tray is session-only (matches the original /mfn/batch behavior
// before consolidation). The same component is mounted inside /list/[id] for
// persisted MFN batches with batchId set.
export default function MfnBatchPage() {
  return <MfnBatchReceiveWorkflow />;
}

export type ListingBatchChannel = 'FBA' | 'MFN';

interface ManualBatchTransition {
  from: string;
  to: string;
  channel: ListingBatchChannel;
}

/**
 * Generic batch edits may archive a terminal workflow or restore a closed MFN
 * worklist. Operational states are owned by their dedicated workflow routes.
 */
export function manualBatchTransitionError({
  from,
  to,
  channel,
}: ManualBatchTransition): string | null {
  if (from === to && to === 'closed') return null;

  if (to === 'closed') {
    const allowedFrom = channel === 'FBA'
      ? ['ready', 'failed', 'shipping']
      : ['draft', 'ready', 'failed'];
    if (allowedFrom.includes(from)) return null;
  }

  if (to === 'failed' && channel === 'MFN' && from === 'sending') {
    return null;
  }

  if (to === 'draft' && channel === 'MFN' && from === 'closed') {
    return null;
  }

  return `Manual batch transition ${from} → ${to} is not allowed`;
}

interface TimeoutAdvanceContext {
  status: string;
  channel: ListingBatchChannel;
  elapsedMs: number;
  inboundPlanId: string | null;
  anyListingFailed: boolean;
  operationFailed: boolean;
}

interface TimeoutFailureContext {
  status: string;
  channel: ListingBatchChannel;
  elapsedMs: number;
  unverifiedSkus: string[];
  anyListingFailed: boolean;
  operationFailed: boolean;
}

const FBA_SENDING_TIMEOUT_MS = 15 * 60 * 1000;
const MFN_SENDING_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * FBA can proceed once Amazon has created the inbound plan; its offer cannot
 * become BUYABLE until inventory arrives. MFN has no equivalent shortcut:
 * readiness requires the authoritative BUYABLE status.
 */
export function shouldTimeoutAdvanceBatch({
  status,
  channel,
  elapsedMs,
  inboundPlanId,
  anyListingFailed,
  operationFailed,
}: TimeoutAdvanceContext): boolean {
  return status === 'sending'
    && channel === 'FBA'
    && !!inboundPlanId
    && elapsedMs > FBA_SENDING_TIMEOUT_MS
    && !anyListingFailed
    && !operationFailed;
}

/**
 * MFN has no safe "ready" shortcut because BUYABLE is the customer-visible
 * proof. After the verification window expires, fail the batch and keep item
 * rows PROCESSING so operators can see which SKUs never became BUYABLE.
 */
export function getTimeoutFailureMessage({
  status,
  channel,
  elapsedMs,
  unverifiedSkus,
  anyListingFailed,
  operationFailed,
}: TimeoutFailureContext): string | null {
  if (
    status !== 'sending'
    || channel !== 'MFN'
    || elapsedMs < MFN_SENDING_TIMEOUT_MS
    || unverifiedSkus.length === 0
    || anyListingFailed
    || operationFailed
  ) {
    return null;
  }

  const mins = Math.round(elapsedMs / 60_000);
  return `MFN listing verification timed out after ${mins} min. Listings never reached BUYABLE: ${unverifiedSkus.join(', ')}.`;
}

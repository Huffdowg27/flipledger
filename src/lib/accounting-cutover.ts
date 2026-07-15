/**
 * Imported transaction reports own every Amazon accounting period before this
 * date. Synced SP-API tables own periods on and after it; the two sources must
 * never overlap in financial or integrity reporting.
 */
export const HISTORY_CUTOVER = '2026-01-01';

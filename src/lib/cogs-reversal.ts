/**
 * Quantity-aware SELLABLE-return COGS reversal (single source of truth).
 *
 * When Amazon confirms a SELLABLE customer return, the returned unit is back in
 * inventory and its COGS will be charged again when it resells — so the P&L must
 * reverse COGS for the RETURNED units only. The prior implementation reversed the
 * WHOLE order line, which over-reversed COGS on multi-unit orders where only some
 * units came back (units sold-for-good then had their cost dropped entirely).
 *
 *   recognized COGS = cogs_per_unit × (line_qty − min(line_qty, confirmed_sellable_return_qty))
 *
 * amzn.gr.* resales are recognized at $0 (a regraded unit's cost was expensed on
 * its first sale). Both the P&L summary COGS and the sales-detail COGS/net-profit
 * use the SAME fragment below so they can never diverge.
 *
 * NOTE: this task keys the reversal on the confirmed-return signal
 * (disposition='SELLABLE' AND item_returned=1). It deliberately does NOT redefine
 * item_returned or key accounting to FIFO-restoration success — that is a
 * separate, later task.
 */

/** Pure reference implementation (integer cents); the SQL below mirrors this exactly. */
export function recognizedCogsCents(
  cogsPerUnit: number,
  lineQty: number,
  confirmedReturnQty: number,
  isAmznGr: boolean,
): number {
  if (isAmznGr) return 0;
  const reversed = Math.min(lineQty, Math.max(0, confirmedReturnQty || 0));
  return cogsPerUnit * (lineQty - reversed);
}

/**
 * LEFT JOIN that aggregates confirmed SELLABLE-return quantity per (order_id, sku).
 * Produces alias `sr(order_id, sku, ret_qty)`. `oiAlias` is the order_items alias.
 */
export function sellableReturnJoin(oiAlias: string): string {
  return `
    LEFT JOIN (
      SELECT order_id, COALESCE(sku,'') AS sku, SUM(quantity) AS ret_qty
      FROM refunds
      WHERE disposition = 'SELLABLE' AND item_returned = 1 AND marketplace = 'amazon' AND quantity > 0
      GROUP BY order_id, COALESCE(sku,'')
    ) sr ON sr.order_id = ${oiAlias}.order_id AND sr.sku = COALESCE(${oiAlias}.sku,'')`;
}

/**
 * SQL expression for recognized COGS cents of a single order line.
 * `oiAlias` = order_items alias; `srAlias` = the aggregated-returns alias (default 'sr').
 * Requires `sellableReturnJoin(oiAlias)` to be present in the query.
 */
export function recognizedCogsExpr(oiAlias: string, srAlias = 'sr'): string {
  return `CASE
    WHEN ${oiAlias}.sku LIKE 'amzn.gr%' THEN 0
    ELSE ${oiAlias}.cogs_per_unit * (${oiAlias}.quantity - MIN(${oiAlias}.quantity, COALESCE(${srAlias}.ret_qty, 0)))
  END`;
}

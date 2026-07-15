export interface OrderFeeAllocationOptions {
  realFeesOnly: boolean;
}

/**
 * CTEs that allocate each order's fee total across its item lines.
 *
 * Revenue is the primary weight. Zero-revenue orders fall back to quantity,
 * then equal line weights. Integer truncation can leave a few cents; the
 * deterministic first line receives that residual so every order remains
 * penny-exact.
 */
export function orderFeeAllocationCtes(
  options: OrderFeeAllocationOptions,
): string {
  const realFeesOnly = options.realFeesOnly
    ? 'AND fd.financial_event_id != 0'
    : '';

  return `
    order_fee_totals AS (
      SELECT fd.order_id, SUM(fd.amount) AS total_fees
      FROM fee_details fd
      LEFT JOIN financial_events src ON fd.financial_event_id = src.id
      WHERE fd.order_id IS NOT NULL AND fd.order_id != ''
        AND NOT (src.event_type = 'RefundEvent' AND fd.amount > 0)
        ${realFeesOnly}
      GROUP BY fd.order_id
    ),
    fee_weighted_lines AS (
      SELECT
        oi.id,
        oi.order_id,
        COALESCE(oft.total_fees, 0) AS total_fees,
        ROW_NUMBER() OVER (
          PARTITION BY oi.order_id ORDER BY oi.id
        ) AS line_number,
        CASE
          WHEN SUM(MAX(oi.total_price, 0)) OVER (
            PARTITION BY oi.order_id
          ) > 0
            THEN MAX(oi.total_price, 0)
          WHEN SUM(MAX(oi.quantity, 0)) OVER (
            PARTITION BY oi.order_id
          ) > 0
            THEN MAX(oi.quantity, 0)
          ELSE 1
        END AS fee_weight,
        CASE
          WHEN SUM(MAX(oi.total_price, 0)) OVER (
            PARTITION BY oi.order_id
          ) > 0
            THEN SUM(MAX(oi.total_price, 0)) OVER (
              PARTITION BY oi.order_id
            )
          WHEN SUM(MAX(oi.quantity, 0)) OVER (
            PARTITION BY oi.order_id
          ) > 0
            THEN SUM(MAX(oi.quantity, 0)) OVER (
              PARTITION BY oi.order_id
            )
          ELSE COUNT(*) OVER (PARTITION BY oi.order_id)
        END AS total_fee_weight
      FROM order_items oi
      LEFT JOIN order_fee_totals oft ON oft.order_id = oi.order_id
    ),
    fee_base_lines AS (
      SELECT
        id,
        order_id,
        total_fees,
        line_number,
        CAST(
          total_fees * 1.0 * fee_weight / NULLIF(total_fee_weight, 0)
          AS INTEGER
        ) AS base_fee
      FROM fee_weighted_lines
    ),
    allocated_order_fees AS (
      SELECT
        id,
        base_fee + CASE
          WHEN line_number = 1 THEN total_fees
            - SUM(base_fee) OVER (PARTITION BY order_id)
          ELSE 0
        END AS allocated_fee
      FROM fee_base_lines
    )
  `;
}

/**
 * A scalar product-name lookup cannot multiply a sales-detail row, even if a
 * future migration temporarily leaves duplicate product records.
 */
export function productNameExpr(
  orderItemAlias = 'oi',
  orderAlias = 'o',
): string {
  return `COALESCE(
    (
      SELECT p.name
      FROM products p
      WHERE p.asin = ${orderItemAlias}.asin
        AND p.marketplace = ${orderAlias}.marketplace
      ORDER BY p.id
      LIMIT 1
    ),
    (
      SELECT p.name
      FROM products p
      WHERE p.asin = ${orderItemAlias}.asin
      ORDER BY p.id
      LIMIT 1
    ),
    ${orderItemAlias}.asin
  )`;
}

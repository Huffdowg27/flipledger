# FlipLedger

Multi-marketplace profit tracking and bookkeeping for Amazon, Walmart, and eBay
resellers. Self-hosted, single-user, runs on your own machine. Pulls live
financial data from the marketplaces' APIs, applies FIFO COGS, and gives you
an accurate cash-basis P&L per marketplace and across your whole business.

> **Status:** Active development. Used in production by the author for tax
> filing and daily operations. Stable but expect rough edges.

---

## What it does

- **Amazon** — Orders, financial events (sales / fees / refunds / reimbursements),
  FBA inventory, settlement reports, FBA reimbursements report.
- **Walmart** — Orders (WFS + Seller Fulfilled), returns, recon reports for
  exact fee data, WFS inventory + inbound shipments, dispute candidate
  detection.
- **eBay** — Orders + per-order marketplace fees via the Fulfillment API.
- **Multi-lot FIFO COGS** — track multiple buy lots per SKU at different costs;
  FIFO depletes oldest first.
- **P&L** — full income / expense breakdown by marketplace, with a cash/accrual
  toggle, date range, and CSV export.
- **Dashboard** — revenue, profit, ROI, top/worst products, expense breakdown.
- **Tax Report** — Form 1120-S layout with IRS line numbers, per-section CSV
  exports.
- **Reimbursement / dispute helpers** — surfaces FBA inventory losses Amazon
  hasn't reimbursed yet, Walmart returns you may be able to dispute, and Amazon
  reimbursements you may want to re-evaluate.
- **Listing tool** — multi-marketplace listing creation (Amazon + MFN), inbound
  plan creation, FNSKU / box label printing.

The numbers reconcile to within a few dollars per marketplace against Walmart
Seller Center, Amazon Seller Central, and Sellerboard — see [`CLAUDE.md`](CLAUDE.md)
for accuracy notes.

---

## Stack

- Next.js (App Router) + TypeScript
- SQLite via better-sqlite3
- TanStack Table, Recharts, Tailwind CSS
- Single-user, no auth — data lives on your machine

---

## Setup

### Prerequisites

- Node 20+
- npm
- Marketplace API credentials (see below)

### Install + run

```bash
git clone https://github.com/parkermorgan/flipledger.git
cd flipledger
npm install

# (optional) seed with realistic sample data so the UI isn't empty
npx tsx src/lib/seed.ts

npm run dev
# → http://localhost:3000
```

### First-run configuration

1. Open [http://localhost:3000/settings](http://localhost:3000/settings).
2. Paste your marketplace credentials (Amazon / Walmart / eBay). Each section
   has a "Test Connection" button.
3. Click "Sync Now" — first sync may take 5-15 minutes depending on order
   volume.
4. Once data is in, fill in COGS for your SKUs on the Products page.

### Getting marketplace credentials

This is the hardest part of setup. Each marketplace has its own developer
flow — **you have to register your own developer app**; you can't reuse anyone
else's credentials.

- **Amazon SP-API**: register at [developer-docs.amazon.com/sp-api](https://developer-docs.amazon.com/sp-api).
  You'll need: Client ID, Client Secret, Refresh Token (from the LWA OAuth flow),
  Marketplace ID (e.g. `ATVPDKIKX0DER` for the US).
- **Walmart Marketplace API**: register at [developer.walmart.com](https://developer.walmart.com).
  You'll need: Client ID, Client Secret.
- **eBay Developer**: register at [developer.ebay.com](https://developer.ebay.com).
  You'll need: Client ID, Client Secret, Refresh Token.

### What's in `data/`

The SQLite DB lives at `data/flipledger.db`. The entire `data/` directory is
in `.gitignore`. Don't commit it — it has your sales, fees, and credentials.

Backups are recommended before any major change. The author's preferred
pattern:

```bash
cp data/flipledger.db data/flipledger.db.bak-$(date +%Y%m%d-%H%M%S)
```

---

## Architecture

```
src/
├── app/
│   ├── api/                         # Internal data + sync endpoints
│   │   ├── data/                    # Read endpoints (P&L, dashboard, lookup, etc.)
│   │   └── sync/                    # Triggered sync endpoints (manual + auto)
│   ├── analyze/                     # Profit & loss, ROI, etc.
│   ├── bookkeep/                    # Refunds, reimbursements, disputes
│   ├── inventory/                   # FBA / WFS / MFN stock
│   ├── list/                        # Listing tool
│   ├── lookup/[id]/                 # Unified order detail view
│   ├── products/                    # Products & COGS (multi-lot)
│   ├── settings/                    # Credential entry + sync controls
│   └── tax-report/                  # Form 1120-S layout
├── components/                      # UI components (tables, charts, ui)
├── lib/
│    ├── sp-api/                     # Amazon SP-API clients + sync orchestration
│   ├── walmart-api/                 # Walmart Marketplace API clients
│   ├── ebay-api/                    # eBay API clients
│   ├── db.ts                        # Schema + initialization
│   ├── fifo.ts                      # Multi-lot FIFO COGS engine
│   ├── calculations.ts              # Profit / ROI / margin (single source of truth)
│   └── recurring-expenses.ts        # Auto-generates monthly expense rows
└── data/
    └── flipledger.db                # Your DB. Gitignored.
```

---

## Architecture decisions worth knowing

### Cash basis by default
The P&L counts revenue / fees / refunds when the marketplace **actually
settles** the transaction (Amazon ShipmentEvent, Walmart recon report posted),
not when the customer places the order. This matches your bank deposits and
your tax-reportable income.

The Cash/Accrual toggle on the P&L page lets you switch to purchase-date basis
if you want to compare against tools that count earlier (like InventoryLab).

### Multi-lot FIFO
Each SKU can have multiple inventory lots at different costs. FIFO depletes
the oldest lot first. To retroactively lower COGS for a SKU you re-bought at
a clearance price, click "Lots" on the Products page and add a new lot dated
before the existing lot.

### Self-healing dedup
Several upstream APIs assign different IDs to the same logical event (e.g.
Amazon's Adjustment events vs. its FBA Reimbursements Report — same payment,
different IDs). FlipLedger runs a post-sync sweep that consolidates these
rather than relying on insert-time prevention. See `src/lib/sp-api/dedupReimbursements.ts`
and `src/lib/walmart-api/dedupRecon.ts`.

### Settlement-only Walmart refunds
Walmart's Returns API surfaces refunds at customer-initiation time, but the
seller debit lags 1-3 weeks. The P&L only counts Walmart refunds that have a
corresponding `WalmartRefundEvent` in the recon report (proof Walmart actually
debited you). Same pattern as cash-basis revenue.

---

## Limitations / known caveats

- **Walmart Orders API only returns ~6 months** of history. Recon (fees) goes
  back ~18 months. So months older than 6mo will have all the fees but no
  order revenue, making them look severely negative. File those via your
  prior tool / Sellerboard.
- **Amazon settlement timing** — orders shipped in the last 1-3 days may not
  have ShipmentEvents posted yet. They appear on cash-basis P&L once Amazon
  posts them.
- **Amazon SAFE-T claims, Walmart disputes, reimbursement re-evaluations** —
  FlipLedger surfaces candidates and provides templates, but does not file
  them. Marketplace dispute APIs are gated. You file in Seller Central and
  click "mark filed" in FlipLedger.
- **Listing tool Phase 3+** — boxing UI works, but `setPackingInformation` is
  blocked by an account-level SP-API entitlement. Use Seller Central to
  finish boxing and click "Sync from Amazon" to re-import. Phase 4 (label
  printing) is wired but only partially tested against real Amazon.

---

## Contributing

The code is the way it is because of one user's needs. PRs welcome but
opinionated — read [`CLAUDE.md`](CLAUDE.md) first for design philosophy and
gotchas.

---

## License

MIT — see [`LICENSE`](LICENSE).

---

## Acknowledgments

Built for resellers, by a reseller. The marketplace API quirks documented in
this code base were earned the hard way (often at 2am during tax season).

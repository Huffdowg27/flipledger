# Claude Report — MFN Visual Polish + COGS Audit Checkpoint

_Last updated: 2026-05-17. Covers commits 28f2efa through 8e0fe05._

---

## ⚠️ Critical Warnings for Next Agent

1. **COGS repair has NOT been executed.** Plan documents exist (see below) but
   no data has been touched. Do not assume COGS numbers are correct.

2. **Keep MFN UI work strictly separate from COGS/P&L work.** These are two
   independent threads. Do not mix them in a single task or commit.

3. **Do not stage or commit `CLAUDE.md`, `docs/agent-control/`, or
   `docs/design-reference/` unless Jamie explicitly asks.**

---

## Thread A — MFN Visual Polish (COMPLETE through 8e0fe05)

### Commits in this session (UI-only, newest first)

| Commit | Summary |
|---|---|
| `8e0fe05` | Secondary form fields de-emphasized: Bin/Est.Shipping h-7 + dim labels; Shipping Template label dim; Qty/Price/Condition unchanged |
| `e732cf4` | Card header compressed: image w-14→w-8, title text-sm line-clamp-2→text-xs line-clamp-1, standalone SKU line removed, items-start→items-center |
| `490a58e` | Inset elevation fix: info chips/UpcChip/overflow badge bg-slate-900/60, profit strip bg-slate-900/40, image placeholders bg-slate-700/40, drawer Close button bg-slate-900/40 |
| `30b46c2` | Full token pass: purple/indigo accent → blue-400/500/600 throughout; bg-bg-elevated→bg-slate-800; bg-bg-surface→bg-slate-800; page container bg-slate-900; purple ChannelBadge→slate |
| `a10e426` | Stale comments updated after Not inspected demotion (comment-only) |
| `ce28b26` | Not inspected chip: blocker(red) → warn(amber). Push gating unchanged in activation-push and activation-preview routes |
| `883febe` | Card layout: removed helper banner, tightened profit strip, 3-col grid (Qty/Price/Condition row 1; BuyCost/Bin/Shipping row 2), full Enter chain with primaryActionRef on both Save buttons |
| `12e0f17` | No condition: warn→info (gray/muted). No longer drives needsWork |
| `4bbcd62` | Removed operator-facing "lot" wording from all visible strings |
| `28f2efa` | Calmed unsaved workflow: added info ChipTone, Fee unknown→info, saved row green left accent only (no glow), unsaved count muted |

### What changed visually
- **Palette**: Navy/slate workbench (bg-slate-900 floor, bg-slate-800 panels). Blue primary actions. No purple/indigo accent anywhere.
- **Warning hierarchy**: Red = true blockers (No price, Not inspected now demoted). Amber = push-readiness warnings (Not inspected, Stale status). Gray = metadata caveats (Fee unknown, No condition).
- **Unsaved card**: Compact header (32px image, 1-line title), 3-col input grid, secondary fields visually de-emphasized.
- **Saved rows**: Dense 40px rows with green left accent. No glow backgrounds.
- **Language**: "Save item" / "Save changes" — no "lot" terminology in the UI.

### What behavior was intentionally NOT changed
- Save/create flow (`onCreateLot`, `onSave`, `/create-mfn-local-lot` API)
- Activation preview and push (`activation-preview/route.ts`, `activation-push/route.ts`)
- SP-API writes of any kind
- Shipping template sync logic
- Fee math, profit math, COGS, FIFO, P&L, accounting
- Orders, FBA, labels, schema, `inventory_ledger.quantity_remaining`
- `inspected_at` push gating in both activation routes (unchanged)
- Enter keyboard chain and all form refs

### Known remaining UI issues (not yet addressed)
1. **Expanded unsaved card is still tall (~300–350px) vs saved rows (40px).** The header is now compressed but the 6-field form + profit strip + save button still create a large card. Closing this gap requires a drawer or inline-row editing approach — scoped separately.
2. **`+N` overflow badge on saved rows**: `bg-slate-900/60` blends with `bg-slate-900` page floor. Only visible via hairline border. Edge case (requires 2+ warn chips simultaneously); acceptable for now.
3. **Search dropdown result rows** have no per-row separator when multiple results appear — all `bg-slate-800` on `bg-slate-800` dropdown. Low priority.

### Verification (all passing as of 8e0fe05)
- `npm run build`: ✓ clean
- `/mfn/batch`: ✓ 200
- `/analyze/merchant-inventory`: ✓ 200
- All commits: only `src/app/mfn/batch/page.tsx` changed

---

## Thread B — COGS Gap Audit (PLAN ONLY — NO REPAIR EXECUTED)

### Commits
| Commit | Summary |
|---|---|
| `4621326` | COGS canary repair plan (5-SKU dry-run approach) |
| `dcdbc0d` | Tier 1 COGS gap dry-run repair plan |
| `bd62fe7` | Read-only COGS gap audit |

### Status
- A read-only COGS gap audit was run. A ~$20 discrepancy vs InventoryLab was identified.
- A tiered repair plan and a 5-SKU canary repair plan were committed as docs.
- **No data has been modified.** `data/flipledger.db` is untouched by these commits.
- The canary repair (5-SKU sample) is the next approved step, but has NOT been run yet.

### Before running the canary repair, next agent must
1. Read the plan docs in `docs/agent-control/` (the COGS audit and repair plan files).
2. Back up `data/flipledger.db` first.
3. Run the dry-run/canary on 5 SKUs only — verify P&L delta before expanding.
4. Do NOT touch MFN UI code in the same session.

---

## Guardrails Confirmed (as of this session)

- SP-API writes: none made
- Accounting / P&L / COGS / FIFO: untouched
- Orders / FBA / labels: untouched
- Schema: untouched
- `inventory_ledger.quantity_remaining`: untouched

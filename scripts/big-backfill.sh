#!/bin/bash
# Big historical backfill: 2021 → present
# Step 1: Full orders + financial events sync from 2021-01-01 (covers everything including recent 90 days)
# Step 2: Year-by-year financial events backfill 2021-2025 (catches anything the sync missed)
# Logs to /Users/jamiehuff/flipledger/data/backfill.log

LOG=/Users/jamiehuff/flipledger/data/backfill.log
BASE=http://localhost:3002

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

log "=== Big backfill started ==="

# Wait for any in-progress sync to finish
log "Waiting for any running sync to finish..."
for i in $(seq 1 60); do
  STATUS=$(curl -s "$BASE/api/sync" | grep -o '"running":true' || true)
  if [ -z "$STATUS" ]; then break; fi
  log "  Sync running, waiting 30s... (attempt $i)"
  sleep 30
done

# Step 1: Full sync from 2021 — orders + financial events
log "Starting full sync from 2021-01-01 (orders + financials)..."
curl -s -X POST "$BASE/api/sync" \
  -H "Content-Type: application/json" \
  -d '{"startDate":"2021-01-01T00:00:00Z"}' >> "$LOG"
echo "" >> "$LOG"

# Wait for it to finish
log "Waiting for full sync to complete (this may take 1-2 hours)..."
sleep 60
for i in $(seq 1 180); do
  STATUS=$(curl -s "$BASE/api/sync" | grep -o '"running":true' || true)
  if [ -z "$STATUS" ]; then
    log "Full sync complete."
    break
  fi
  log "  Still syncing... (${i}m elapsed)"
  sleep 60
done

# Stamp lastSync so auto-sync stays idle during backfill
sqlite3 /Users/jamiehuff/flipledger/data/flipledger.db \
  "INSERT OR REPLACE INTO settings (key,value) VALUES ('lastSync', datetime('now'));"
log "Auto-sync timer stamped."

# Step 2: Year-by-year financial events backfill 2021-2025
for YEAR in 2021 2022 2023 2024 2025; do
  log "--- Backfilling financial events: $YEAR ---"
  RESULT=$(curl -s -X POST "$BASE/api/sync/backfill" \
    -H "Content-Type: application/json" \
    -d "{\"year\":$YEAR}" \
    --max-time 1800)
  echo "$RESULT" >> "$LOG"
  echo "" >> "$LOG"
  EVENTS=$(echo "$RESULT" | grep -o '"totalEvents":[0-9]*' | grep -o '[0-9]*' || echo "?")
  log "$YEAR done: $EVENTS events"
  sqlite3 /Users/jamiehuff/flipledger/data/flipledger.db \
    "INSERT OR REPLACE INTO settings (key,value) VALUES ('lastSync', datetime('now'));"
done

log "=== Big backfill complete. Check $BASE for results. ==="

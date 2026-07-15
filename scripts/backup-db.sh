#!/bin/bash
# Nightly FlipLedger database backup.
#
# Uses SQLite's online .backup command (safe against a live WAL database —
# never raw-copy flipledger.db while the app is running). Produces a gzipped,
# dated snapshot locally and mirrors it to iCloud Drive when available.
#
# Retention: 30 days local, 14 days in iCloud.
# Schedule via cron, e.g.:  30 2 * * * /Users/jamiehuff/flipledger/scripts/backup-db.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DB="$REPO_DIR/data/flipledger.db"
LOCAL_DIR="$HOME/FlipLedgerBackups"
ICLOUD_DIR="$HOME/Library/Mobile Documents/com~apple~CloudDocs/FlipLedgerBackups"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$LOCAL_DIR/flipledger-$STAMP.db"

[ -f "$DB" ] || { echo "ERROR: database not found at $DB" >&2; exit 1; }
mkdir -p "$LOCAL_DIR"

# Consistent online snapshot, then verify it is a readable SQLite db.
/usr/bin/sqlite3 "$DB" ".backup '$OUT'"
CHECK="$(/usr/bin/sqlite3 "$OUT" 'PRAGMA integrity_check;' | head -1)"
if [ "$CHECK" != "ok" ]; then
  echo "ERROR: backup failed integrity_check: $CHECK" >&2
  rm -f "$OUT"
  exit 1
fi

rm -f "$OUT-wal" "$OUT-shm"
gzip -f "$OUT"
echo "$(date '+%F %T') backup ok: $OUT.gz ($(du -h "$OUT.gz" | cut -f1))"

# Off-machine copy via iCloud Drive (best effort).
if [ -d "$(dirname "$ICLOUD_DIR")" ]; then
  mkdir -p "$ICLOUD_DIR"
  cp "$OUT.gz" "$ICLOUD_DIR/"
  echo "$(date '+%F %T') mirrored to iCloud"
fi

# Retention sweeps.
find "$LOCAL_DIR" -name 'flipledger-*.db.gz' -mtime +30 -delete
[ -d "$ICLOUD_DIR" ] && find "$ICLOUD_DIR" -name 'flipledger-*.db.gz' -mtime +14 -delete

exit 0

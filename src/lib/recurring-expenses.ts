/**
 * Auto-generates expense rows from recurring_expenses templates.
 * Call this during sync or on page load to ensure all months are filled in.
 * Generates expenses from each template's start_date through the current month.
 * Skips months that already have an expense row for that category.
 */

import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

export function generateRecurringExpenses(): { generated: number; skipped: number } {
  const db = getDb();
  let generated = 0;
  let skipped = 0;

  try {
    const templates = db.prepare(
      'SELECT * FROM recurring_expenses WHERE active = 1'
    ).all() as {
      id: number;
      category: string;
      amount: number;
      description: string;
      start_date: string;
    }[];

    if (templates.length === 0) return { generated: 0, skipped: 0 };

    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const insertStmt = db.prepare(`
      INSERT INTO expenses (date, category, amount, description, recurring, created_at)
      VALUES (?, ?, ?, ?, 'monthly', datetime('now'))
    `);

    const checkStmt = db.prepare(`
      SELECT 1 FROM expenses WHERE category = ? AND strftime('%Y-%m', date) = ? LIMIT 1
    `);

    for (const template of templates) {
      // Walk from start_date to current month
      // Parse YYYY-MM-DD directly to avoid timezone issues
      const [startYear, startMonth] = template.start_date.split('-').map(Number);
      let year = startYear;
      let month = startMonth - 1; // 0-indexed

      while (true) {
        const monthStr = `${year}-${String(month + 1).padStart(2, '0')}`;
        if (monthStr > currentMonth) break;

        const exists = checkStmt.get(template.category, monthStr);
        if (!exists) {
          const dateStr = `${monthStr}-01`;
          insertStmt.run(dateStr, template.category, template.amount, template.description);
          generated++;
        } else {
          skipped++;
        }

        // Next month
        month++;
        if (month > 11) {
          month = 0;
          year++;
        }
      }
    }
  } finally {
    db.close();
  }

  return { generated, skipped };
}

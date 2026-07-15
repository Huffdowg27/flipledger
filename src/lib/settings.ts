import type Database from 'better-sqlite3';
import type { SPAPICredentials } from './sp-api/types';

export type SettingsMap = Record<string, string>;

export function readSettings(db: Database.Database, keys?: readonly string[]): SettingsMap {
  if (keys && keys.length === 0) return {};

  const rows = keys
    ? db.prepare(
        `SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(', ')})`
      ).all(...keys)
    : db.prepare('SELECT key, value FROM settings').all();

  const settings: SettingsMap = {};
  for (const row of rows as { key: string; value: string | null }[]) {
    settings[row.key] = row.value ?? '';
  }
  return settings;
}

export function getSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string | null } | undefined;
  return row ? row.value ?? '' : null;
}

export function upsertSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

export function upsertSettings(db: Database.Database, updates: Array<[string, string]>): void {
  const upsert = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const saveSettings = db.transaction((pairs: Array<[string, string]>) => {
    for (const [key, value] of pairs) {
      upsert.run(key, value);
    }
  });
  saveSettings(updates);
}

export function getAmazonCredentials(db: Database.Database): SPAPICredentials | null {
  const settings = readSettings(db, ['clientId', 'clientSecret', 'refreshToken', 'marketplaceId']);
  if (!settings.clientId || !settings.clientSecret || !settings.refreshToken) return null;

  return {
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    refreshToken: settings.refreshToken,
    marketplaceId: settings.marketplaceId || 'ATVPDKIKX0DER',
  };
}

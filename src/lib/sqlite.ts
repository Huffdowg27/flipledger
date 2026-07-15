import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export interface OpenFlipLedgerDbOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
  dbPath?: string;
  foreignKeys?: boolean;
}

export function getFlipLedgerDbPath(cwd: string = process.cwd()): string {
  return path.join(cwd, 'data', 'flipledger.db');
}

export function openFlipLedgerDb(options: OpenFlipLedgerDbOptions = {}): Database.Database {
  const dbPath = options.dbPath || getFlipLedgerDbPath();

  if (!options.readonly && dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const databaseOptions: Database.Options = {};
  if (options.readonly !== undefined) databaseOptions.readonly = options.readonly;
  if (options.fileMustExist !== undefined) databaseOptions.fileMustExist = options.fileMustExist;

  const db = new Database(dbPath, databaseOptions);
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');
  if (options.foreignKeys ?? true) db.pragma('foreign_keys = ON');
  return db;
}

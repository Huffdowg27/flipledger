import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

function listTypeScriptFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(fullPath);
    return entry.isFile() && fullPath.endsWith('.ts') ? [fullPath] : [];
  });
}

test('every listing-workflow SQLite connection enforces foreign keys', () => {
  const root = path.join(process.cwd(), 'src', 'app', 'api', 'list');
  const offenders = listTypeScriptFiles(root).filter((file) => {
    const source = fs.readFileSync(file, 'utf8');
    if (!source.includes('new Database(')) return false;
    return !source.includes("db.pragma('foreign_keys = ON')");
  });

  assert.deepEqual(
    offenders.map((file) => path.relative(process.cwd(), file)),
    [],
    'Direct listing-workflow database connections must enable foreign keys',
  );
});

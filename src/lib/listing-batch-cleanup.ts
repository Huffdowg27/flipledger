import type Database from 'better-sqlite3';

export function deleteListingBatchItemChildren(db: Database.Database, itemId: number): void {
  db.prepare('DELETE FROM listing_batch_box_items WHERE item_id = ?').run(itemId);
  db.prepare('DELETE FROM listing_batch_pack_group_items WHERE item_id = ?').run(itemId);
}

export function deleteListingBatchChildren(db: Database.Database, batchId: number): void {
  db.prepare('DELETE FROM listing_batch_box_items WHERE box_id IN (SELECT id FROM listing_batch_boxes WHERE batch_id = ?)').run(batchId);
  db.prepare('DELETE FROM listing_batch_boxes WHERE batch_id = ?').run(batchId);
  db.prepare('DELETE FROM listing_batch_pack_group_items WHERE pack_group_id IN (SELECT id FROM listing_batch_pack_groups WHERE batch_id = ?)').run(batchId);
  db.prepare('DELETE FROM listing_batch_pack_groups WHERE batch_id = ?').run(batchId);
}

/**
 * Where the rich menu ids live between syncs.
 *
 * LINE assigns a new id every time a menu is created, and a menu cannot be
 * edited — so the ids are not constants and cannot be derived. They are written
 * by the sync and read on the login path, which must not depend on a second API
 * call succeeding: a login that fails because the menu lookup timed out would be
 * a worse bug than a stale panel.
 */

import { eq } from "drizzle-orm";
import { db } from "./db";
import { richMenu } from "./schema";
import type { RichMenuKey } from "./rich-menu";

export type StoredMenuIds = Partial<Record<RichMenuKey, string>>;

export function readMenuIds(): StoredMenuIds {
  const rows = db.select().from(richMenu).all();
  const ids: StoredMenuIds = {};
  for (const row of rows) {
    ids[row.key as RichMenuKey] = row.richMenuId;
  }
  return ids;
}

export function saveMenuIds(ids: Record<RichMenuKey, string>, at: Date = new Date()): void {
  for (const [key, richMenuId] of Object.entries(ids)) {
    db.insert(richMenu)
      .values({ key, richMenuId, syncedAt: at })
      .onConflictDoUpdate({
        target: richMenu.key,
        set: { richMenuId, syncedAt: at }
      })
      .run();
  }
}

export function readMenuSyncTime(): Date | null {
  const row = db.select().from(richMenu).where(eq(richMenu.key, "default")).get();
  return row ? row.syncedAt : null;
}

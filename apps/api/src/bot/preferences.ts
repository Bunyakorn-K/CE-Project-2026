/**
 * What the chat remembers about one person.
 *
 * WHY. A manager of one branch was typing the branch name into every question, or
 * answering "สาขาไหน" before getting an answer. Saying it once should be enough.
 *
 * ONLY WHAT WAS SAID OUT LOUD. A preference is stored when the person sets it — a
 * button, a command — never inferred from what they usually ask. An inferred setting
 * is invisible, so the day the guess is wrong the answer is about the wrong branch and
 * nobody can see why. `listPreferences` is also what the help text reads back, so what
 * is remembered is always something the person can look at and clear.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { chatPreference } from "../schema";

export const PREFERENCE_KEYS = ["branch", "language"] as const;
export type PreferenceKey = (typeof PREFERENCE_KEYS)[number];

export type Preference = { key: PreferenceKey; value: string; updatedAt: number };

function isKey(key: string): key is PreferenceKey {
  return (PREFERENCE_KEYS as readonly string[]).includes(key);
}

export function listPreferences(lineUserId: string): Preference[] {
  return db
    .select()
    .from(chatPreference)
    .where(eq(chatPreference.lineUserId, lineUserId))
    .all()
    .filter((row) => isKey(row.key))
    .map((row) => ({ key: row.key as PreferenceKey, value: row.value, updatedAt: Number(row.updatedAt) }));
}

export function readPreference(lineUserId: string, key: PreferenceKey): string | null {
  const row = db
    .select()
    .from(chatPreference)
    .where(and(eq(chatPreference.lineUserId, lineUserId), eq(chatPreference.key, key)))
    .get();
  return row?.value ?? null;
}

export function setPreference(lineUserId: string, key: PreferenceKey, value: string): Preference {
  const now = new Date();
  db.insert(chatPreference)
    .values({ lineUserId, key, value, updatedAt: now })
    .onConflictDoUpdate({
      target: [chatPreference.lineUserId, chatPreference.key],
      set: { value, updatedAt: now }
    })
    .run();
  return { key, value, updatedAt: now.getTime() };
}

export function clearPreference(lineUserId: string, key?: PreferenceKey): number {
  const before = listPreferences(lineUserId).length;
  if (key) {
    db.delete(chatPreference)
      .where(and(eq(chatPreference.lineUserId, lineUserId), eq(chatPreference.key, key)))
      .run();
  } else {
    db.delete(chatPreference).where(eq(chatPreference.lineUserId, lineUserId)).run();
  }
  return before - listPreferences(lineUserId).length;
}

/**
 * The line the assistant is told about, e.g. `สาขาประจำ: แม่โจ้ (b1)`.
 *
 * It is phrased as something the person said, not as an instruction, so the model
 * treats it as context for the question rather than as an order to answer only about
 * that branch — a question about another branch must still work.
 */
export function rememberedLine(lineUserId: string, branchNameOf: (id: string) => string | null): string | null {
  const preferences = listPreferences(lineUserId);
  if (preferences.length === 0) return null;
  const parts = preferences.map((preference) => {
    if (preference.key === "branch") {
      const name = branchNameOf(preference.value);
      return `สาขาประจำ: ${name ?? preference.value}${name ? ` (${preference.value})` : ""}`;
    }
    return `${preference.key}: ${preference.value}`;
  });
  return parts.join(" · ");
}

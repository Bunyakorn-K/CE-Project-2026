import { beforeEach, describe, expect, it } from "vitest";
import { db, initializeDatabase } from "../db";
import { chatPreference } from "../schema";
import { clearPreference, listPreferences, readPreference, rememberedLine, setPreference } from "./preferences";

const USER = "U-pref-user";

function nameOf(id: string): string | null {
  return id === "b1" ? "แม่โจ้" : null;
}

beforeEach(() => {
  initializeDatabase();
  db.delete(chatPreference).run();
});

describe("preferences", () => {
  it("keeps one value per key", () => {
    setPreference(USER, "branch", "b1");
    setPreference(USER, "branch", "b2");
    expect(readPreference(USER, "branch")).toBe("b2");
    expect(listPreferences(USER)).toHaveLength(1);
  });

  it("keeps people apart", () => {
    setPreference(USER, "branch", "b1");
    setPreference("U-other", "branch", "b2");
    expect(readPreference(USER, "branch")).toBe("b1");
  });

  it("forgets one key or all of them", () => {
    setPreference(USER, "branch", "b1");
    setPreference(USER, "language", "en");
    expect(clearPreference(USER, "branch")).toBe(1);
    expect(listPreferences(USER).map((row) => row.key)).toEqual(["language"]);
    expect(clearPreference(USER)).toBe(1);
    expect(listPreferences(USER)).toEqual([]);
  });

  it("says nothing when nothing is remembered", () => {
    expect(rememberedLine(USER, nameOf)).toBeNull();
  });

  it("phrases the remembered branch as the person own words", () => {
    setPreference(USER, "branch", "b1");
    expect(rememberedLine(USER, nameOf)).toBe("สาขาประจำ: แม่โจ้ (b1)");
  });

  it("falls back to the id when the warehouse cannot name it", () => {
    setPreference(USER, "branch", "b9");
    expect(rememberedLine(USER, nameOf)).toBe("สาขาประจำ: b9");
  });
});

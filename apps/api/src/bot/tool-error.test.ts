import { describe, expect, it } from "vitest";
import { looksLikeToolError } from "./conversation";

describe("looksLikeToolError", () => {
  it("sees an MCP error envelope", () => {
    expect(looksLikeToolError('{"error":{"code":"revenue_disabled","message":"…"}}')).toBe(true);
  });

  it("does not mistake data for an error", () => {
    expect(looksLikeToolError('{"meta":{"dataSource":"real"},"rows":[]}')).toBe(false);
    expect(looksLikeToolError("plain text")).toBe(false);
    expect(looksLikeToolError("[1,2]")).toBe(false);
  });
});

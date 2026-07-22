import config from "./vite.config";
import { describe, expect, it } from "vitest";

describe("development API proxy", () => {
  it("forwards health checks to the API", () => {
    expect(config.server?.proxy).toMatchObject({
      "/health": "http://localhost:8787"
    });
  });
});

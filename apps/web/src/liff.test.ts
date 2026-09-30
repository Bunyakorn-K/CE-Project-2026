import { describe, expect, it } from "vitest";
import { missingIdTokenMessage } from "./liff";

describe("missingIdTokenMessage", () => {
  it("blames the console when the LIFF app has no openid scope", () => {
    // The reported case: login works, the profile resolves, and only the ID
    // token is missing because the app was never given the scope.
    const message = missingIdTokenMessage({ appScopes: ["profile"], grantedScopes: ["profile"] });
    expect(message).toContain("LINE Developers Console");
    expect(message).toContain("openid");
  });

  it("blames consent when the app has openid but the user has not granted it", () => {
    const message = missingIdTokenMessage({ appScopes: ["profile", "openid"], grantedScopes: ["profile"] });
    expect(message).toContain("ยังไม่ได้อนุญาต");
    expect(message).not.toContain("LINE Developers Console");
  });

  it("keeps the console message when both the scope and the consent are absent", () => {
    // App scope first: the console fix is the one that has to happen before a
    // consent prompt can even exist.
    expect(missingIdTokenMessage({ appScopes: [], grantedScopes: [] })).toContain("LINE Developers Console");
  });

  it("does not conclude the scope is missing when the scopes could not be read", () => {
    // null means "LIFF threw", not "the list was empty". Reading it as empty
    // would send the operator to the console for a setting that is already set.
    const message = missingIdTokenMessage({ appScopes: null, grantedScopes: null });
    expect(message).not.toContain("LINE Developers Console");
    expect(message).toContain("ตรวจสอบ");
  });

  it("still says the scope to check when only the granted list is readable", () => {
    const message = missingIdTokenMessage({ appScopes: null, grantedScopes: [] });
    expect(message).toContain("ยังไม่ได้อนุญาต");
  });
});
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import { alertNotification } from "../schema";
import { approvalText, notifyAccessApproved } from "./notify";
import { eq } from "drizzle-orm";

// These rows are real notifications, and another suite counts every row in the
// table to prove a gas sweep sent nothing. Cleaning up is the test's job, not that
// suite's.
afterEach(() => {
  db.$client.prepare("DELETE FROM alert_notification WHERE iris_alert_id LIKE 'access:%'").run();
});

function rowFor(requestId: string) {
  return db.select().from(alertNotification).where(eq(alertNotification.irisAlertId, `access:${requestId}`)).get();
}

describe("approvalText", () => {
  it("names the role and the branch in the shop's words", () => {
    const text = approvalText({ requestId: "r1", lineUserId: "U1", role: "manager", branchName: "ตลาดโซนเหลือง" });
    expect(text).toContain("อนุมัติสิทธิ์เข้าใช้งานแล้ว");
    expect(text).toContain("บทบาท: ผู้จัดการสาขา");
    expect(text).toContain("ขอบเขต: สาขา ตลาดโซนเหลือง");
  });

  it("says every branch when there is no branch", () => {
    const text = approvalText({ requestId: "r1", lineUserId: "U1", role: "owner", branchName: null });
    expect(text).toContain("เจ้าของ (ทุกสาขา)");
    expect(text).toContain("ทุกสาขาที่คุณดูแล");
  });

  it("carries no markdown, because LINE renders it literally", () => {
    const text = approvalText({ requestId: "r1", lineUserId: "U1", role: "technician", branchName: "A" });
    expect(text).not.toMatch(/\*\*|__|##/);
  });
});

describe("notifyAccessApproved", () => {
  it("pushes once and records the send", async () => {
    const push = vi.fn().mockResolvedValue(undefined);
    const id = `r-${Date.now()}-sent`;
    const outcome = await notifyAccessApproved(
      { requestId: id, lineUserId: `U-${id}`, role: "manager", branchName: "หลิ่งมื่น" },
      { push }
    );

    expect(outcome).toBe("sent");
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][1]).toContain("ผู้จัดการสาขา");
    expect(rowFor(id)?.status).toBe("sent");
    expect(rowFor(id)?.severity).toBe("info");
  });

  it("records a failure without throwing", async () => {
    const push = vi.fn().mockRejectedValue(new Error("blocked by user"));
    const id = `r-${Date.now()}-failed`;
    const outcome = await notifyAccessApproved(
      { requestId: id, lineUserId: `U-${id}`, role: "technician", branchName: null },
      { push }
    );

    expect(outcome).toBe("failed");
    expect(rowFor(id)?.status).toBe("failed");
    expect(rowFor(id)?.error).toContain("blocked by user");
  });

  it("says skipped, and writes nothing, when the deployment cannot push", async () => {
    const id = `r-${Date.now()}-skipped`;
    const outcome = await notifyAccessApproved(
      { requestId: id, lineUserId: `U-${id}`, role: "manager", branchName: "A" },
      { token: undefined }
    );

    expect(outcome).toBe("skipped");
    expect(rowFor(id)).toBeUndefined();
  });

  it("does not send the same approval twice", async () => {
    const push = vi.fn().mockResolvedValue(undefined);
    const id = `r-${Date.now()}-dupe`;
    const notice = { requestId: id, lineUserId: `U-${id}`, role: "manager", branchName: "A" };

    expect(await notifyAccessApproved(notice, { push })).toBe("sent");
    expect(await notifyAccessApproved(notice, { push })).toBe("skipped");
    expect(push).toHaveBeenCalledTimes(1);
  });
});

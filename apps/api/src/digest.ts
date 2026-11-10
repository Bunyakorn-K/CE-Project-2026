/**
 * The daily digest: one message a day that says how yesterday went.
 *
 * WHY NOT MORE ALERTS. The alert rules fire on conditions — pressure falling, a
 * machine failing — and in practice that is a dozen messages a day for one person
 * on a single rule. A digest is the other half of the same idea: the shop's day in
 * one message, at a time the owner picks, and only if somebody asked for it.
 *
 * OFF BY DEFAULT, NO RECIPIENTS. A bot that starts talking on its own is the shop's
 * decision, not a deploy's. `enabled=false` with an empty recipient list means this
 * whole module is inert until an owner turns it on and names who receives it.
 *
 * NO MODEL. Every number comes from the same ClickHouse query the dashboards use and
 * the same alert rows the card came from, so a digest can be checked against the
 * screens it summarises. Running it through the assistant would cost a model call a
 * day and make the numbers unverifiable.
 */

import { randomUUID } from "node:crypto";
import { and, eq, gte, lt } from "drizzle-orm";
import { db } from "./db";
import {
  accessGrant,
  alertAcknowledgement,
  alertNotification,
  auditLog,
  digestRecipient,
  digestSent,
  digestSettings,
  liffIdentity
} from "./schema";
import { mayViewRevenue } from "./access-policy";
import type { ClickHouseExecutor } from "./analytics/clickhouse";
import { queryDailyRevenue } from "./analytics/queries";
import { shapeAnswer } from "./bot/shape";
import type { PlatformAdapter } from "./bot/adapter";

const SHOP_TZ = "Asia/Bangkok";
export const DIGEST_DEFAULT_HOUR = 7;
export const DIGEST_DEFAULT_MINUTE = 0;

export type DigestSettingsPublic = {
  enabled: boolean;
  sendHour: number;
  sendMinute: number;
  updatedAt: number | null;
  /** `default` until someone saves a row, so the UI can say "ยังไม่ตั้งค่า". */
  source: "stored" | "default";
};

export function readDigestSettings(): DigestSettingsPublic {
  const row = db.select().from(digestSettings).where(eq(digestSettings.id, "default")).get();
  if (!row) {
    return {
      enabled: false,
      sendHour: DIGEST_DEFAULT_HOUR,
      sendMinute: DIGEST_DEFAULT_MINUTE,
      updatedAt: null,
      source: "default"
    };
  }
  return {
    enabled: row.enabled,
    sendHour: row.sendHour,
    sendMinute: row.sendMinute,
    updatedAt: Number(row.updatedAt),
    source: "stored"
  };
}

export type DigestSettingsInput = { enabled?: boolean; sendHour?: number; sendMinute?: number };

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function saveDigestSettings(input: DigestSettingsInput, actorUserId: string | null = null): DigestSettingsPublic {
  const current = readDigestSettings();
  const next = {
    enabled: input.enabled ?? current.enabled,
    sendHour: clampInt(input.sendHour ?? current.sendHour, 0, 23),
    sendMinute: clampInt(input.sendMinute ?? current.sendMinute, 0, 59)
  };
  const now = new Date();

  db.insert(digestSettings)
    .values({
      id: "default",
      enabled: next.enabled,
      sendHour: next.sendHour,
      sendMinute: next.sendMinute,
      updatedByUserId: actorUserId,
      updatedAt: now,
      createdAt: now
    })
    .onConflictDoUpdate({
      target: digestSettings.id,
      set: { ...next, updatedByUserId: actorUserId, updatedAt: now }
    })
    .run();

  db.insert(auditLog)
    .values({
      id: randomUUID(),
      actorUserId,
      action: "digest.settings.updated",
      target: "digest_settings",
      detail: JSON.stringify(next),
      createdAt: now
    })
    .run();

  return readDigestSettings();
}

// ---- recipients ----

export type LineUserView = {
  lineUserId: string;
  /** The account behind the LINE link — the grants hang off this id. */
  userId: string;
  displayName: string | null;
  roles: string[];
};

/** Everyone with a LINE link — the pool an owner picks digest recipients from. */
export function listLineUsers(): LineUserView[] {
  const identities = db.select().from(liffIdentity).all();
  const grants = db.select().from(accessGrant).all();
  return identities
    .map((identity) => ({
      lineUserId: identity.lineUserId,
      userId: identity.userId,
      displayName: identity.displayName,
      roles: [
        ...new Set(
          grants
            .filter((grant) => grant.userId === identity.userId && grant.revokedAt === null)
            .map((grant) => grant.role)
        )
      ]
    }))
    .sort((a, b) => (a.displayName ?? a.lineUserId).localeCompare(b.displayName ?? b.lineUserId));
}

export type DigestRecipientView = LineUserView & { addedAt: number };

export function listDigestRecipients(): DigestRecipientView[] {
  const rows = db.select().from(digestRecipient).all();
  const people = new Map(listLineUsers().map((person) => [person.lineUserId, person]));
  return rows
    .map((row) => {
      const person = people.get(row.lineUserId);
      return {
        lineUserId: row.lineUserId,
        userId: person?.userId ?? "",
        // Someone removed from access still shows, so the owner can see the stale
        // entry instead of wondering why the count is off.
        displayName: person?.displayName ?? null,
        roles: person?.roles ?? [],
        addedAt: Number(row.addedAt)
      };
    })
    .sort((a, b) => (a.displayName ?? a.lineUserId).localeCompare(b.displayName ?? b.lineUserId));
}

export type AddRecipientResult = { ok: true } | { ok: false; reason: "not-linked" | "no-access" };

/**
 * Only people who already have a LINE link *and* a grant may be added: the digest
 * carries revenue, and sending it to an account with no role would put the day's
 * takings in front of someone the shop never approved.
 */
export function addDigestRecipient(lineUserId: string, actorUserId: string | null = null): AddRecipientResult {
  const person = listLineUsers().find((candidate) => candidate.lineUserId === lineUserId);
  if (!person) return { ok: false, reason: "not-linked" };
  if (person.roles.length === 0) return { ok: false, reason: "no-access" };

  db.insert(digestRecipient)
    .values({ lineUserId, addedByUserId: actorUserId, addedAt: new Date() })
    .onConflictDoNothing()
    .run();
  return { ok: true };
}

export function removeDigestRecipient(lineUserId: string): boolean {
  const before = listDigestRecipients().length;
  db.delete(digestRecipient).where(eq(digestRecipient.lineUserId, lineUserId)).run();
  return listDigestRecipients().length < before;
}

// ---- shop days ----

function bangkok(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SHOP_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
}

/** `YYYY-MM-DD` in the shop's timezone. */
export function shopDay(now: Date = new Date()): string {
  return bangkok(now);
}

export function previousShopDay(now: Date = new Date()): string {
  return bangkok(new Date(now.getTime() - 24 * 60 * 60 * 1000));
}

/** The instant today's digest is due, in the shop's timezone. */
export function digestDueAt(now: Date, hour: number, minute: number): Date {
  const pad = (value: number) => String(value).padStart(2, "0");
  return new Date(`${shopDay(now)}T${pad(hour)}:${pad(minute)}:00+07:00`);
}

// ---- content ----

export type DigestStats = {
  revenueBaht: number | null;
  cycles: number | null;
  avgMinutes: number | null;
  branches: { branchId: string; branchName: string; revenueBaht: number; cycles: number }[];
  alerts: { total: number; unacknowledged: number; byRule: { rule: string; count: number }[] };
  /** "ok" when the warehouse answered; "unavailable" when it did not. */
  source: "ok" | "unavailable";
};

function thaiDayLabel(day: string): string {
  const date = new Date(`${day}T12:00:00+07:00`);
  return new Intl.DateTimeFormat("th-TH", { timeZone: SHOP_TZ, day: "numeric", month: "short" }).format(date);
}

function baht(satang: number): string {
  return (satang / 100).toLocaleString("th-TH", { maximumFractionDigits: 0 });
}

/** Alerts sent that day, within the recipient's branches, and how many were acked. */
function alertSummary(day: string, allowedBranches: string[] | null): DigestStats["alerts"] {
  const start = new Date(`${day}T00:00:00+07:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const rows = db
    .select()
    .from(alertNotification)
    .where(
      and(
        eq(alertNotification.status, "sent"),
        gte(alertNotification.deliveredAt, start),
        lt(alertNotification.deliveredAt, end)
      )
    )
    .all()
    .filter((row) => allowedBranches === null || (row.branchId !== null && allowedBranches.includes(row.branchId)));

  const acked = new Set(
    db
      .select()
      .from(alertAcknowledgement)
      .all()
      .map((row) => row.irisAlertId)
  );

  const byRule = new Map<string, number>();
  for (const row of rows) {
    const rule = row.irisAlertId.split(":")[0] ?? "other";
    byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
  }

  return {
    total: rows.length,
    unacknowledged: rows.filter((row) => !acked.has(row.irisAlertId)).length,
    byRule: [...byRule.entries()]
      .map(([rule, count]) => ({ rule, count }))
      .sort((a, b) => b.count - a.count)
  };
}

const RULE_LABEL: Record<string, string> = {
  gas: "แรงดันแก๊ส",
  temperature: "อุณหภูมิ",
  machine: "เครื่องซักผ้า",
  weather: "สภาพอากาศ"
};

export async function buildDigest(input: {
  day: string;
  /** `null` = every branch the tenant has. */
  allowedBranches: string[] | null;
  maySeeRevenue: boolean;
  clickhouse?: ClickHouseExecutor;
}): Promise<{ text: string; stats: DigestStats }> {
  const stats: DigestStats = {
    revenueBaht: null,
    cycles: null,
    avgMinutes: null,
    branches: [],
    alerts: alertSummary(input.day, input.allowedBranches),
    source: "unavailable"
  };

  if (input.clickhouse) {
    try {
      const branchIds = input.allowedBranches ?? [""];
      const collected: DigestStats["branches"] = [];
      for (const branchId of branchIds) {
        const result = await queryDailyRevenue(input.clickhouse, {
          from: input.day,
          to: input.day,
          branchId
        });
        for (const row of result.rows) {
          collected.push({
            branchId: row.branchId,
            branchName: row.branchName,
            revenueBaht: row.revenueSatang / 100,
            cycles: row.cycles
          });
        }
      }
      // `queryDailyRevenue` carries revenue and cycles per branch; average duration
      // lives in `queryDailyCycles` and is not part of this message.
      stats.branches = collected.sort((a, b) => b.revenueBaht - a.revenueBaht);
      stats.cycles = collected.reduce((sum, row) => sum + row.cycles, 0);
      stats.revenueBaht = collected.reduce((sum, row) => sum + row.revenueBaht, 0);
      stats.avgMinutes = null;
      stats.source = "ok";
    } catch {
      // A digest with yesterday's alerts and no revenue is still worth sending: the
      // alternative is silence on the day the warehouse happened to be down.
      stats.source = "unavailable";
    }
  }

  const lines: string[] = [];
  lines.push(`☀️ สรุปวัน ${thaiDayLabel(input.day)}`);

  if (stats.source === "ok") {
    if (stats.branches.length === 0) {
      lines.push("ยังไม่มีข้อมูลของวันนี้ในคลัง (ข้อมูลมักล่าช้า ~24 ชม.)");
    } else if (input.maySeeRevenue) {
      lines.push(`💰 รายได้ ${baht(Math.round((stats.revenueBaht ?? 0) * 100))} บาท · ${stats.cycles ?? 0} รอบซัก`);
      for (const branch of stats.branches.slice(0, 4)) {
        lines.push(`   • ${branch.branchName}: ${baht(Math.round(branch.revenueBaht * 100))} บาท · ${branch.cycles} รอบ`);
      }
    } else {
      lines.push(`🧺 ${stats.cycles ?? 0} รอบซัก`);
      for (const branch of stats.branches.slice(0, 4)) {
        lines.push(`   • ${branch.branchName}: ${branch.cycles} รอบ`);
      }
    }
  } else {
    lines.push("⚠️ ดึงข้อมูลคลังไม่สำเร็จในรอบนี้ — ตัวเลขรายได้ยังไม่มี");
  }

  if (stats.alerts.total > 0) {
    lines.push(
      `🔔 แจ้งเตือน ${stats.alerts.total} ครั้ง · ยังไม่รับทราบ ${stats.alerts.unacknowledged}`
    );
    for (const entry of stats.alerts.byRule.slice(0, 3)) {
      lines.push(`   • ${RULE_LABEL[entry.rule] ?? entry.rule} ×${entry.count}`);
    }
  } else {
    lines.push("🔔 ไม่มีการแจ้งเตือนเมื่อวาน");
  }

  lines.push("พิมพ์ถามต่อได้เลย เช่น \"ภาพรวมสัปดาห์นี้\"");

  // A digest must be one message: `shapeAnswer` is the same guard the chat uses, so
  // an unusual day cannot turn this into a wall of text.
  const shaped = shapeAnswer(lines.join("\n"), 900, 1);
  return { text: shaped.parts[0] ?? lines[0], stats };
}

/** What went out today, so the console can say "sent at 07:00" instead of guessing. */
export function digestSentToday(now: Date = new Date()): { lineUserId: string; status: string; sentAt: number }[] {
  const day = shopDay(now);
  return db
    .select()
    .from(digestSent)
    .all()
    .filter((row) => row.day === day)
    .map((row) => ({ lineUserId: row.lineUserId, status: row.status, sentAt: Number(row.sentAt) }));
}

// ---- running ----

export type DigestRunSummary = {
  /** `disabled` | `not-yet` | `no-recipients` | `ran` */
  state: "disabled" | "not-yet" | "no-recipients" | "ran";
  day: string;
  dryRun: boolean;
  sent: number;
  skipped: number;
  failed: number;
  preview: { lineUserId: string; text: string }[];
};

/**
 * Only a successful send closes the day. A `failed` row must not: it would turn one
 * LINE outage into a silently skipped digest, and the retry would have nothing to do.
 */
function alreadySent(day: string, lineUserId: string): boolean {
  return (
    db
      .select()
      .from(digestSent)
      .where(
        and(eq(digestSent.day, day), eq(digestSent.lineUserId, lineUserId), eq(digestSent.status, "sent"))
      )
      .all().length > 0
  );
}

export async function runDigest(input: {
  adapter: PlatformAdapter;
  clickhouse?: ClickHouseExecutor;
  now?: Date;
  dryRun?: boolean;
  /** Skip the "is it time yet" check — used by a test and by an owner's "ส่งเลยวันนี้". */
  force?: boolean;
}): Promise<DigestRunSummary> {
  const now = input.now ?? new Date();
  const settings = readDigestSettings();
  const day = previousShopDay(now);
  const summary: DigestRunSummary = {
    state: "ran",
    day,
    dryRun: input.dryRun === true,
    sent: 0,
    skipped: 0,
    failed: 0,
    preview: []
  };

  if (!settings.enabled) return { ...summary, state: "disabled" };

  const due = digestDueAt(now, settings.sendHour, settings.sendMinute);
  if (!input.force && now.getTime() < due.getTime()) return { ...summary, state: "not-yet" };

  const recipients = listDigestRecipients();
  if (recipients.length === 0) return { ...summary, state: "no-recipients" };

  // Built once per distinct scope: two managers of the same branch get the same text,
  // and the warehouse is asked once.
  const cache = new Map<string, string>();

  for (const recipient of recipients) {
    if (alreadySent(day, recipient.lineUserId)) {
      summary.skipped += 1;
      continue;
    }

    const grants = db
      .select()
      .from(accessGrant)
      .where(eq(accessGrant.userId, recipient.userId))
      .all();
    const activeGrants = grants.filter((grant) => grant.revokedAt === null);
    const seesEverything = activeGrants.some((grant) => grant.role === "owner" || grant.branchId === null);
    const branches = seesEverything
      ? null
      : [...new Set(activeGrants.flatMap((grant) => (grant.branchId ? [grant.branchId] : [])))];
    const scopeKey = branches === null ? "all" : branches.sort().join(",");

    let text = cache.get(scopeKey);
    if (!text) {
      const built = await buildDigest({
        day,
        allowedBranches: branches,
        // A technician sees the day's cycles but not the takings.
        maySeeRevenue: mayViewRevenue(activeGrants),
        clickhouse: input.clickhouse
      });
      text = built.text;
      cache.set(scopeKey, text);
    }

    summary.preview.push({ lineUserId: recipient.lineUserId, text });

    if (input.dryRun) continue;

    try {
      await input.adapter.sendText(recipient.lineUserId, text);
      db.insert(digestSent)
        .values({
          id: `${day}:${recipient.lineUserId}`,
          day,
          lineUserId: recipient.lineUserId,
          status: "sent",
          detail: null,
          sentAt: new Date()
        })
        // A failed row from an earlier attempt is replaced, not duplicated: the day
        // is closed by the send that worked.
        .onConflictDoUpdate({
          target: digestSent.id,
          set: { status: "sent", detail: null, sentAt: new Date() }
        })
        .run();
      summary.sent += 1;
    } catch (error) {
      db.insert(digestSent)
        .values({
          id: `${day}:${recipient.lineUserId}`,
          day,
          lineUserId: recipient.lineUserId,
          status: "failed",
          detail: error instanceof Error ? error.message.slice(0, 200) : "unknown",
          sentAt: new Date()
        })
        .onConflictDoUpdate({
          target: digestSent.id,
          set: {
            status: "failed",
            detail: error instanceof Error ? error.message.slice(0, 200) : "unknown",
            sentAt: new Date()
          }
        })
        .run();
      summary.failed += 1;
    }
  }

  return summary;
}

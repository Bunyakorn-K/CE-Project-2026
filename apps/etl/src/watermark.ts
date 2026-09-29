// Incremental watermark store. Persists the last successfully loaded source
// position per dataset so the ETL only pulls rows newer than the last commit.
// Stored as a JSON file with an atomic rename to avoid a torn write on crash.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type UsageCursor = {
  /** last loaded created_at (UTC) */
  at: string;
  /** last loaded machine_usage.id — makes the cursor strict so rows sharing a created_at are not skipped */
  id: string;
};

/**
 * Last loaded `machine_temperature_sample.occurred_at` (UTC), with `seq` and
 * `event_id` as tie-breakers.
 *
 * `key` is a format marker, not data: it records which source column `at` is
 * bound to. Watermarks written before 2026-09-29 keyed the temperature read on
 * `ingested_at`, which has no index in IRIS and gets no partition pruning; those
 * are loaded as `IngestedTemperatureCursor` and re-anchored once, never
 * reinterpreted in place (an `ingested_at` value used as an `occurred_at`
 * boundary would skip every row between the two positions).
 */
export type TemperatureCursor = {
  key: "occurred_at";
  /** last loaded occurred_at (UTC) */
  at: string;
  /** last loaded machine_temperature_sample.seq */
  seq: string;
  /** last loaded machine_temperature_sample.event_id — breaks ties between rows with equal (at, seq) */
  id: string;
};

/** Pre-2026-09-29 temperature cursor: `at` was the last loaded `ingested_at`. */
export type IngestedTemperatureCursor = {
  at: string;
  seq: string;
  id: string;
};

export type Watermark = {
  /** @deprecated single-column usage cutoff, retained for backward compatibility */
  usageCreatedAt: string | null;
  /** @deprecated single-column temperature cutoff, retained for backward compatibility */
  temperatureIngestedAt: string | null;
  /** strict composite usage cursor */
  usage: UsageCursor | null;
  /** strict composite temperature cursor, keyed on `occurred_at` */
  temperature: TemperatureCursor | null;
  /**
   * Strict composite temperature cursor keyed on `ingested_at`, from a watermark
   * written before 2026-09-29. Held only so the ETL can re-anchor it onto the
   * indexed `occurred_at` keyset; cleared once that succeeds.
   */
  temperatureIngestedCursor: IngestedTemperatureCursor | null;
};

export type FileIo = {
  read(path: string): string | null;
  write(path: string, data: string): void;
};

const defaultIo: FileIo = {
  read(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  write(path, data) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  },
};

export class WatermarkStore {
  constructor(
    private readonly path: string,
    private readonly io: FileIo = defaultIo
  ) {}

  load(): Watermark {
    const raw = this.io.read(this.path);
    if (!raw) return { ...EMPTY_WATERMARK };
    try {
      const parsed = JSON.parse(raw) as Partial<Watermark>;
      const usageCreatedAt = typeof parsed.usageCreatedAt === "string" ? parsed.usageCreatedAt : null;
      const temperatureIngestedAt = typeof parsed.temperatureIngestedAt === "string" ? parsed.temperatureIngestedAt : null;
      // A deprecated single-column timestamp cannot be made strict (we don't
      // know its tie-breaker id), so it does not populate the composite cursors.
      // The next run re-reads from the composite boundary and the strict filter
      // picks up any rows the old `>` cutoff previously skipped.
      const usage = isUsageCursor(parsed.usage) ? parsed.usage : null;
      // `temperature` is honoured only when it declares the source column it is
      // bound to. An unlabelled (or differently labelled) object is a
      // pre-2026-09-29 `ingested_at` cursor: kept for one-time re-anchoring,
      // never used as an `occurred_at` boundary (that would skip every row
      // between the two positions).
      const temperature = isTemperatureCursor(parsed.temperature) ? parsed.temperature : null;
      const legacy = temperature === null ? parsed.temperature : null;
      const temperatureIngestedCursor = isIngestedTemperatureCursor(legacy)
        ? { at: legacy.at, seq: legacy.seq, id: legacy.id }
        : null;
      return { usageCreatedAt, temperatureIngestedAt, usage, temperature, temperatureIngestedCursor };
    } catch {
      return { ...EMPTY_WATERMARK };
    }
  }

  save(next: Watermark): void {
    this.io.write(this.path, JSON.stringify(next, null, 2));
  }
}

const EMPTY_WATERMARK: Watermark = {
  usageCreatedAt: null,
  temperatureIngestedAt: null,
  usage: null,
  temperature: null,
  temperatureIngestedCursor: null,
};

function isUsageCursor(v: unknown): v is UsageCursor {
  return !!v && typeof v === "object" && typeof (v as UsageCursor).at === "string" && typeof (v as UsageCursor).id === "string";
}

function isTemperatureCursor(v: unknown): v is TemperatureCursor {
  const c = v as TemperatureCursor | null;
  return (
    !!c &&
    typeof c === "object" &&
    c.key === "occurred_at" &&
    typeof c.at === "string" &&
    typeof c.seq === "string" &&
    typeof c.id === "string"
  );
}

function isIngestedTemperatureCursor(v: unknown): v is IngestedTemperatureCursor {
  const c = v as IngestedTemperatureCursor | null;
  return (
    !!c &&
    typeof c === "object" &&
    typeof c.at === "string" &&
    typeof c.seq === "string" &&
    typeof c.id === "string"
  );
}

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

export type TemperatureCursor = {
  /** last loaded ingested_at (UTC) */
  at: string;
  /** last loaded machine_temperature_sample.seq */
  seq: string;
  /** last loaded machine_temperature_sample.event_id — breaks ties between rows with equal (at, seq) */
  id: string;
};

export type Watermark = {
  /** @deprecated single-column usage cutoff, retained for backward compatibility */
  usageCreatedAt: string | null;
  /** @deprecated single-column temperature cutoff, retained for backward compatibility */
  temperatureIngestedAt: string | null;
  /** strict composite usage cursor */
  usage: UsageCursor | null;
  /** strict composite temperature cursor */
  temperature: TemperatureCursor | null;
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
    if (!raw) return { usageCreatedAt: null, temperatureIngestedAt: null, usage: null, temperature: null };
    try {
      const parsed = JSON.parse(raw) as Partial<Watermark>;
      const usageCreatedAt = typeof parsed.usageCreatedAt === "string" ? parsed.usageCreatedAt : null;
      const temperatureIngestedAt = typeof parsed.temperatureIngestedAt === "string" ? parsed.temperatureIngestedAt : null;
      // A deprecated single-column timestamp cannot be made strict (we don't
      // know its tie-breaker id), so it does not populate the composite cursors.
      // The next run re-reads from the composite boundary and the strict filter
      // picks up any rows the old `>` cutoff previously skipped.
      const usage = isUsageCursor(parsed.usage) ? parsed.usage : null;
      const temperature = isTemperatureCursor(parsed.temperature) ? parsed.temperature : null;
      return { usageCreatedAt, temperatureIngestedAt, usage, temperature };
    } catch {
      return { usageCreatedAt: null, temperatureIngestedAt: null, usage: null, temperature: null };
    }
  }

  save(next: Watermark): void {
    this.io.write(this.path, JSON.stringify(next, null, 2));
  }
}

function isUsageCursor(v: unknown): v is UsageCursor {
  return !!v && typeof v === "object" && typeof (v as UsageCursor).at === "string" && typeof (v as UsageCursor).id === "string";
}

function isTemperatureCursor(v: unknown): v is TemperatureCursor {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as TemperatureCursor).at === "string" &&
    typeof (v as TemperatureCursor).seq === "string" &&
    typeof (v as TemperatureCursor).id === "string"
  );
}

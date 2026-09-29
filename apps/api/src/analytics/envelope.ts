/** `unverifiable` is for fact tables that carry no provenance marker at all, so
 *  synthetic-vs-real cannot be determined. Reporting `real` there would assert
 *  measurements the warehouse cannot prove; reporting `synthetic` would assert
 *  the opposite. The honest answer is that provenance is unknown. */
export type DataSourceTag = "synthetic" | "real" | "mixed" | "empty" | "unverifiable";

/** Set when a server-side row cap dropped part of the requested range. The
 *  presence of this key is the signal; consumers must not present the returned
 *  rows as a complete description of `meta.range` while it is set. Additive:
 *  endpoints that never truncate omit it entirely. */
export type AnalyticsTruncation = {
  /** Rows actually returned in `data`. */
  returnedRows: number;
  /** Rows the query matched across the whole requested range, before the cap. */
  totalRowsInRange: number;
  /** The cap that was applied. */
  limit: number;
  /** Which end of the range the cap kept. `newest` is the useful end: the
   *  consumer describes recent behaviour, and an ascending cap would keep the
   *  oldest rows and hide everything since. */
  kept: "newest";
};

export type AnalyticsMeta = {
  range: { from: string; to: string };
  branchId: string | null;
  dataSource: DataSourceTag;
  method?: string;
  rules?: Record<string, unknown>;
  caveats?: string[];
  truncation?: AnalyticsTruncation;
};

export function dataSourceFromCounts(totalRows: number, syntheticRows: number): DataSourceTag {
  if (totalRows === 0) return "empty";
  if (syntheticRows === 0) return "real";
  if (syntheticRows === totalRows) return "synthetic";
  return "mixed";
}

export function analyticsEnvelope<T>(meta: AnalyticsMeta, data: T[]) {
  return { meta, data };
}

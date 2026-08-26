export type DataSourceTag = "synthetic" | "real" | "mixed" | "empty";

export type AnalyticsMeta = {
  range: { from: string; to: string };
  branchId: string | null;
  dataSource: DataSourceTag;
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

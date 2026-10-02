import { Card } from "@heroui/react";
import { useState } from "react";
import {
  metricValue,
  shortDay,
  trendGeometry,
  trendState,
  TREND_METRICS,
  TREND_METRIC_LABELS,
  CHART_HEIGHT,
  CHART_PADDING,
  CHART_WIDTH,
  type TrendDay,
  type TrendInput,
  type TrendMetricId
} from "../dashboard-trend";

/**
 * The dashboard's daily trend.
 *
 * Inline SVG rather than a charting dependency. The shapes needed here are one
 * polyline, a baseline and five ticks, and the decisions that matter — where the
 * line breaks, what the axis claims, what is drawn when the source cannot answer
 * — all live in `dashboard-trend` and are tested without a browser. A library
 * would own the gap rule and the empty state, which is precisely the part of a
 * chart this repository refuses to delegate.
 *
 * THE LABELS ARE HTML, NOT SVG. The plot is fluid in width and fixed in height,
 * so `preserveAspectRatio="none"` stretches x and leaves y alone — correct for
 * geometry, wrong for text, because Thai glyphs at 2x horizontal stretch are
 * unreadable. So the SVG carries only the marks, and every label is a real DOM
 * node in the app's own font: legible, selectable, translatable, and checkable by
 * a test that counts `.trend-axis-label` rather than by parsing an attribute.
 *
 * The `viewBox` therefore starts at the plot's left edge rather than at zero,
 * which is what makes the fluid x-mapping land exactly where the HTML labels
 * are positioned.
 */
export function TrendChart({
  trend,
  presence,
  from,
  to,
  mayViewRevenue
}: {
  trend: TrendInput;
  /** The same presence signal the rest of the page uses, so a window with no
   *  usage at all cannot read as a chart of nothing. */
  presence: "empty" | "present" | "unknown";
  from: string;
  to: string;
  /** Whether this principal may see revenue at all. A series that is entirely
   *  withheld is not offered as a control — a switch whose every value is
   *  missing reads as a broken control, not as a permission boundary. */
  mayViewRevenue: boolean;
}) {
  const state = trendState({ trend, presence, from, to });
  const [requested, setRequested] = useState<TrendMetricId>("cycles");
  // Defensive as well as reactive: a principal whose grant changed mid-session
  // lands back on the measured series rather than on an empty plot.
  const metric = requested === "revenue" && !mayViewRevenue ? "cycles" : requested;

  return (
    <Card variant="transparent" className="surface-card trend-card">
      <Card.Content>
        <div className="section-heading trend-card-head">
          <div>
            <h2>แนวโน้มรายวัน</h2>
            <p className="section-description">
              {TREND_METRICS[metric].label}จากแถว usage รายวัน · {from} — {to}
            </p>
          </div>
          <div className="trend-metric-switch" role="group" aria-label="เลือกข้อมูลที่แสดง">
            {(Object.keys(TREND_METRIC_LABELS) as TrendMetricId[]).map((id) => (
              <button
                key={id}
                type="button"
                className={`secondary-button${metric === id ? " secondary-button--active" : ""}`}
                aria-pressed={metric === id}
                disabled={id === "revenue" && !mayViewRevenue}
                title={id === "revenue" && !mayViewRevenue ? "ไม่มีสิทธิ์ดูรายได้" : undefined}
                onClick={() => setRequested(id)}
              >
                {TREND_METRIC_LABELS[id]}
              </button>
            ))}
          </div>
        </div>

        {state.kind === "chart" ? (
          <>
            <TrendPlot days={state.days} metric={metric} />
            {state.note && <p className="trend-note">{state.note}</p>}
          </>
        ) : (
          // Never an empty plot area. "This source cannot say" and "there was
          // nothing in this window" are different sentences, and collapsing them
          // is how an unmeasurable source becomes a branch that did no business.
          <p className="state-message trend-placeholder" role="status">
            {state.message}
          </p>
        )}
      </Card.Content>
    </Card>
  );
}

function TrendPlot({ days, metric }: { days: TrendDay[]; metric: TrendMetricId }) {
  const geometry = trendGeometry(days, metric);
  const config = TREND_METRICS[metric];

  // The days are on the axis, but this metric has no value on any of them —
  // revenue withheld, or a source that reports cycles without amounts. An empty
  // plot frame with no labels would read as "measured, and it was nothing", so
  // the frame says which of the two it is instead of implying either.
  if (!geometry.hasValues) {
    return (
      <figure className="trend-figure">
        <p className="state-message trend-placeholder" role="status">
          {`${config.label}ไม่พร้อมใช้งาน · ไม่มีค่าของ${config.label}สำหรับช่วงเวลานี้`}
        </p>
      </figure>
    );
  }

  const plotLeft = CHART_PADDING.left;
  const plotWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
  const plotHeight = geometry.baselineY - CHART_PADDING.top;
  const step = days.length > 1 ? geometry.plotWidth / (days.length - 1) : 0;
  const yOf = (value: number) => geometry.baselineY - (value / geometry.maxValue) * plotHeight;

  return (
    <figure className="trend-figure">
      <div className="trend-plot" style={{ paddingLeft: CHART_PADDING.left }}>
        {/* The y-axis labels sit outside the plot area, each centred on its own
            gridline. They are HTML, so they stay Thai-shaped at any width. */}
        <ul className="trend-axis trend-axis--y" aria-hidden="true">
          {geometry.ticks.map((tick) => (
            <li key={tick} className="trend-axis-label" style={{ top: yOf(tick) }}>
              {config.format(tick)}
            </li>
          ))}
        </ul>

        <svg
          className="trend-svg"
          viewBox={`0 0 ${plotWidth} ${CHART_HEIGHT}`}
          height={CHART_HEIGHT}
          preserveAspectRatio="none"
          role="presentation"
          aria-hidden="true"
        >
          {geometry.ticks.map((tick) => (
            <line key={tick} className="trend-gridline" x1={0} x2={plotWidth} y1={yOf(tick)} y2={yOf(tick)} />
          ))}

          {/* A gap is a neutral tick on the baseline, and the line simply stops
              either side of it. That is what "no evidence here" looks like — a
              break, not a dip to zero. */}
          {geometry.gaps.map((gap) => (
            <line
              key={gap.date}
              className="trend-gap"
              x1={gap.x - plotLeft}
              x2={gap.x - plotLeft}
              y1={geometry.baselineY - 5}
              y2={geometry.baselineY}
            />
          ))}

          {geometry.segments.map((segment) =>
            segment.kind === "point" ? (
              <circle
                key={segment.points[0].date}
                className="trend-dot"
                cx={segment.points[0].x - plotLeft}
                cy={segment.points[0].y}
                r={3}
              />
            ) : (
              <polyline
                key={segment.points[0].date}
                className="trend-line"
                points={segment.points.map((point) => `${point.x - plotLeft},${point.y}`).join(" ")}
              />
            )
          )}
        </svg>

        {/* The hit targets. A 3px dot is not aimable on a phone, so each day gets
            a transparent column whose <title> carries the exact number —
            readable by keyboard and by assistive tech, and usable on a touch
            screen where there is no hover at all. */}
        <ul className="trend-days">
          {days.map((day, index) => (
            <li key={day.date} className="trend-day">
              <svg
                className="trend-day-svg"
                viewBox={`0 0 ${plotWidth} ${CHART_HEIGHT}`}
                height={CHART_HEIGHT}
                preserveAspectRatio="none"
                role="img"
                aria-label={dayLabel(day, metric)}
              >
                <rect
                  x={index * step - step / 2}
                  y={CHART_PADDING.top}
                  width={step || plotWidth}
                  height={plotHeight}
                >
                  <title>{dayLabel(day, metric)}</title>
                </rect>
              </svg>
            </li>
          ))}
        </ul>
      </div>

      {/* The x-axis is a separate row so the dates are anchored to the plot's own
          left and right edges rather than to their own intrinsic widths. */}
      <div className="trend-axis trend-axis--x" style={{ marginLeft: CHART_PADDING.left }} aria-hidden="true">
        {geometry.xLabels.map((label, index) => (
          <span
            key={label.date}
            className="trend-axis-label"
            style={{ justifySelf: index === 0 ? "start" : "end" }}
          >
            {label.text}
          </span>
        ))}
      </div>

      {/* The series is also stated as text. A chart that exists only as pixels is
          unreadable to a screen reader, unverifiable by a test, and useless to
          the owner who wants one number rather than a shape. */}
      <figcaption className="trend-caption">{trendCaption(days, metric)}</figcaption>

      {/* The SVG marks are decorative above; this is the line a screen reader
          reads for the chart as a whole. */}
      <p className="sr-only">{chartSummary(days, metric)}</p>
    </figure>
  );
}

function dayLabel(day: TrendDay, metric: TrendMetricId): string {
  if (day.gap) return `${day.date} — ไม่มีแถว usage ที่รายงาน`;
  const value = metricValue(day, metric);
  if (value === null) return `${day.date} — ${TREND_METRICS[metric].label}ไม่พร้อมใช้งาน`;
  return `${day.date} — ${TREND_METRICS[metric].label} ${TREND_METRICS[metric].format(value)}`;
}

function chartSummary(days: TrendDay[], metric: TrendMetricId): string {
  const label = TREND_METRICS[metric].label;
  const measured = measuredDays(days, metric);
  const gaps = days.length - measured.length;
  return [
    `กราฟแนวโน้ม${label}รายวัน`,
    `มีข้อมูล ${measured.length} วันจากทั้งหมด ${days.length} วัน`,
    gaps > 0 ? `ไม่มีข้อมูล ${gaps} วัน แสดงเป็นช่วงที่เส้นขาด` : "",
    trendCaption(days, metric)
  ]
    .filter(Boolean)
    .join(" · ");
}

function measuredDays(days: TrendDay[], metric: TrendMetricId): Array<{ day: TrendDay; value: number }> {
  return days
    .map((day) => ({ day, value: metricValue(day, metric) }))
    .filter((entry): entry is { day: TrendDay; value: number } => entry.value !== null);
}

/**
 * Peak, total and daily mean over the days that actually have a value.
 *
 * The count is stated alongside the total, and the mean is qualified as "per
 * measured day", because otherwise the average is quietly divided by all the
 * days on the axis — presenting a day the warehouse could not measure as
 * though it were an ordinary low one.
 */
function trendCaption(days: TrendDay[], metric: TrendMetricId): string {
  const format = TREND_METRICS[metric].format;
  const measured = measuredDays(days, metric);

  if (measured.length === 0) {
    return `ไม่มีค่าที่รายงานสำหรับ${TREND_METRICS[metric].label}ในช่วงเวลานี้`;
  }

  const peak = measured.reduce((best, entry) => (entry.value > best.value ? entry : best), measured[0]);
  const total = measured.reduce((sum, entry) => sum + entry.value, 0);
  const gaps = days.length - measured.length;

  return [
    `สูงสุด ${format(peak.value)} ในวันที่ ${peak.day.date}`,
    `รวม ${format(total)} จาก ${measured.length.toLocaleString("th-TH")} วันที่มีข้อมูล`,
    `เฉลี่ย ${format(Math.round(total / measured.length))} ต่อวันที่มีข้อมูล`,
    ...(gaps > 0 ? [`ไม่รวม ${gaps.toLocaleString("th-TH")} วันที่ไม่มีแถว usage`] : [])
  ].join(" · ");
}
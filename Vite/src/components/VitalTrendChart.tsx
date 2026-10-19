import { useState } from "react";
import type { VitalCard } from "../api";

// Line chart for one vital sign:
//   - a value axis on the left whose numbers fit that vital's readings and units
//     (e.g. 60–140 mmHg for blood pressure, 97.0–99.5 °F for temperature)
//   - hover (or arrow keys) shows the day and the value(s) of the nearest point
// Each point is an average: per day for week/month views, per month for year/all.

const W = 360, H = 170;
const M = { top: 12, right: 14, bottom: 26, left: 46 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;
// blue + orange: passes the colorblind-separation check; the second line is also dashed
const COLORS = ["#1769aa", "#c2621a"];

// "Nice" axis ticks (1, 2, 2.5, 5 × 10^n steps) covering lo..hi, about `count` of them
function niceTicks(lo: number, hi: number, count = 4) {
  if (lo === hi) { const pad = Math.max(Math.abs(lo) * 0.05, 1); lo -= pad; hi += pad; }
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9) + (step / mag === 2.5 ? 1 : 0));
  return { ticks, min: start, max: end, decimals };
}

// Buckets are calendar dates (UTC). Read the Y-M-D directly so the label doesn't
// shift a day in time zones behind UTC (Florida would otherwise show the day before).
function bucketDate(value: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(value);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function VitalTrendChart({ card, bucket }: { card: VitalCard; bucket: "day" | "month" }) {
  const [active, setActive] = useState<number | null>(null);
  const points = card.series;
  if (!points.length) return <p>No readings in this period.</p>;

  const dual = points.some((p) => p.secondary != null);
  const values = points.flatMap((p) => (p.secondary == null ? [p.value] : [p.value, p.secondary]));
  const axis = niceTicks(Math.min(...values), Math.max(...values));
  const places = card.decimal_places ?? axis.decimals;
  const fmt = (v: number) => v.toFixed(Math.max(places, 0));
  const tickFmt = (v: number) => v.toFixed(axis.decimals);

  const x = (i: number) => M.left + (points.length === 1 ? PLOT_W / 2 : (i * PLOT_W) / (points.length - 1));
  const y = (v: number) => M.top + PLOT_H - ((v - axis.min) / (axis.max - axis.min || 1)) * PLOT_H;
  const path = (key: "value" | "secondary") =>
    points.map((p, i) => (p[key] == null ? null : `${x(i)},${y(p[key] as number)}`)).filter(Boolean).join(" ");

  const dateLabel = (p: (typeof points)[number]) => {
    const d = bucketDate(p.bucket_start);
    return bucket === "month"
      ? d.toLocaleDateString(undefined, { month: "long", year: "numeric" })
      : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  };
  const shortDate = (p: (typeof points)[number]) => {
    const d = bucketDate(p.bucket_start);
    return bucket === "month"
      ? d.toLocaleDateString(undefined, { month: "short", year: "2-digit" })
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  const primaryLabel = card.value_label || card.display_name;
  const secondaryLabel = card.secondary_label || "Second value";

  // pointer → nearest point (the whole plot is the hover target, not just the dots)
  function pick(event: React.PointerEvent<SVGRectElement>) {
    const box = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const svgX = ((event.clientX - box.left) / box.width) * W;
    let best = 0;
    points.forEach((_, i) => { if (Math.abs(x(i) - svgX) < Math.abs(x(best) - svgX)) best = i; });
    setActive(best);
  }
  function onKey(event: React.KeyboardEvent<SVGSVGElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setActive((cur) => {
      const i = cur ?? (event.key === "ArrowLeft" ? points.length : -1);
      return Math.min(points.length - 1, Math.max(0, i + (event.key === "ArrowRight" ? 1 : -1)));
    });
  }

  const p = active != null ? points[active] : null;
  // keep the tooltip inside the card: flip to the left of the line past the midpoint
  const tipLeftPct = active != null ? (x(active) / W) * 100 : 0;
  const tipSide = tipLeftPct > 55 ? "left" : "right";

  return (
    <div className="chart-wrap vital-chart">
      {dual && (
        <div className="vital-legend" aria-hidden="true">
          <span><i className="key" style={{ borderColor: COLORS[0] }} />{primaryLabel}</span>
          <span><i className="key dashed" style={{ borderColor: COLORS[1] }} />{secondaryLabel}</span>
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} role="img" tabIndex={0} onKeyDown={onKey} onBlur={() => setActive(null)}
        aria-label={`${card.display_name} trend in ${card.unit}. Use left and right arrow keys to read each ${bucket}.`}>
        {/* value axis: gridlines + numbers on the left */}
        {axis.ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} className="vital-grid" />
            <text x={M.left - 6} y={y(t)} className="vital-tick" textAnchor="end" dominantBaseline="middle">{tickFmt(t)}</text>
          </g>
        ))}
        <text x={4} y={M.top - 2} className="vital-unit">{card.unit}</text>

        {/* first and last date under the plot */}
        <text x={x(0)} y={H - 6} className="vital-tick" textAnchor={points.length === 1 ? "middle" : "start"}>{shortDate(points[0])}</text>
        {points.length > 1 && <text x={x(points.length - 1)} y={H - 6} className="vital-tick" textAnchor="end">{shortDate(points[points.length - 1])}</text>}

        {/* lines */}
        <polyline points={path("value")} fill="none" stroke={COLORS[0]} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {dual && <polyline points={path("secondary")} fill="none" stroke={COLORS[1]} strokeWidth="2" strokeDasharray="5 4" strokeLinecap="round" strokeLinejoin="round" />}
        {points.length <= 31 && points.map((pt, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(pt.value)} r={active === i ? 4.5 : 2.5} fill={COLORS[0]} className="vital-dot" />
            {pt.secondary != null && <circle cx={x(i)} cy={y(pt.secondary)} r={active === i ? 4.5 : 2.5} fill={COLORS[1]} className="vital-dot" />}
          </g>
        ))}

        {/* crosshair for the hovered point */}
        {p && active != null && (
          <g pointerEvents="none">
            <line x1={x(active)} x2={x(active)} y1={M.top} y2={M.top + PLOT_H} className="vital-crosshair" />
            {points.length > 31 && <circle cx={x(active)} cy={y(p.value)} r="4.5" fill={COLORS[0]} className="vital-dot" />}
            {points.length > 31 && p.secondary != null && <circle cx={x(active)} cy={y(p.secondary)} r="4.5" fill={COLORS[1]} className="vital-dot" />}
          </g>
        )}

        {/* invisible hover layer over the whole plot */}
        <rect x={M.left - 8} y={M.top} width={PLOT_W + 16} height={PLOT_H} fill="transparent"
          onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => setActive(null)} />
      </svg>

      {p && active != null && (
        <div className={`vital-tooltip ${tipSide}`} style={{ left: `${tipLeftPct}%` }} role="status">
          <div className="vital-tip-date">{dateLabel(p)}</div>
          <div className="vital-tip-row">
            <i className="key" style={{ borderColor: COLORS[0] }} />
            <strong>{fmt(p.value)} {card.unit}</strong>{dual && <span>{primaryLabel}</span>}
          </div>
          {p.secondary != null && (
            <div className="vital-tip-row">
              <i className="key dashed" style={{ borderColor: COLORS[1] }} />
              <strong>{fmt(p.secondary)} {card.unit}</strong><span>{secondaryLabel}</span>
            </div>
          )}
          {p.reading_count != null && (
            <div className="vital-tip-note">
              {p.reading_count > 1 ? `Average of ${p.reading_count} readings` : "1 reading"}
            </div>
          )}
        </div>
      )}

      <small>
        {dateLabel(points[0])} – {dateLabel(points[points.length - 1])} · {points.length} {bucket === "month" ? "months" : "days"} with readings · hover for details
      </small>
    </div>
  );
}

export default VitalTrendChart;

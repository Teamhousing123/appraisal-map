// Small stats helpers for scenario aggregation.
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] === undefined) return sorted[base];
  return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
}

export function describe(values) {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return { n: 0 };
  return {
    n: sorted.length,
    median: round(quantile(sorted, 0.5)),
    p95: round(quantile(sorted, 0.95)),
    p99: round(quantile(sorted, 0.99)),
    mean: round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    max: round(sorted[sorted.length - 1]),
  };
}

export function frameSummary(frames) {
  const sorted = frames.filter((d) => Number.isFinite(d) && d > 0).sort((a, b) => a - b);
  if (!sorted.length) return { n: 0 };
  return {
    n: sorted.length,
    p50: round(quantile(sorted, 0.5)),
    p95: round(quantile(sorted, 0.95)),
    p99: round(quantile(sorted, 0.99)),
    over16_7: sorted.filter((d) => d > 16.7).length,
    over33: sorted.filter((d) => d > 33).length,
    over100: sorted.filter((d) => d > 100).length,
  };
}

export function longtaskSummary(longtasks) {
  if (!longtasks.length) return { count: 0, total: 0, max: 0 };
  return {
    count: longtasks.length,
    total: round(longtasks.reduce((a, b) => a + b.d, 0)),
    max: round(Math.max(...longtasks.map((t) => t.d))),
  };
}

export function eventSummary(events) {
  if (!events.length) return { count: 0 };
  const durations = events.map((e) => e.d).sort((a, b) => a - b);
  return {
    count: events.length,
    p50: round(quantile(durations, 0.5)),
    p95: round(quantile(durations, 0.95)),
    max: round(durations[durations.length - 1]),
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}
